import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export type FastFailResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'SOLD_OUT' | 'ALREADY_PURCHASED' | 'LOCKED' | 'TOO_MANY_REQUESTS';
    };

// Atomic fast-fail guard + per-user in-flight lock + stock DECR in a single
// Lua call. The whole sequence is atomic, so concurrent API requests cannot
// observe intermediate state.
//
//   1. Same-user cooldown (user:cooldown:{u}:{p}). Set by THIS Lua on the OK
//      path. Short TTL (3s). Closes the race window where a VU's iter 2
//      arrives in the ~10ms gap between worker COMMIT (which sets
//      purchasedKey) and Lua check. Without cooldown, iter 2 passes Lua,
//      gets 202, then fails at worker as ALREADY_PURCHASED — wasting a job.
//      With cooldown, iter 2 within 3s is rejected at the API layer.
//   2. Sticky sold-out flag check (product:soldout:{id}). Set by the worker
//      in-tx when PG remainingStock reaches 0, or by ProductsService
//      hydration when a cold-start read finds remainingStock=0. TTL 24h.
//   3. stock:{id} value check. Catches negative values produced by a DECR
//      that overflowed past zero. COLD-START PROTECTION: if BOTH stockKey
//      and soldoutKey are missing (e.g. right after Redis flush, or stockKey
//      TTL expired before any read hydration), we treat the request as
//      SOLD_OUT to avoid flooding the queue. The worker PG guard would
//      still catch oversells, but this prevents thousands of wasted jobs.
//      ProductsService hydration (which runs on the first GET) will populate
//      the stockKey on the next read.
//   4. Idempotency flag (order:purchased:{u}:{p}). Set by worker in-tx
//      before INSERT. TTL 24h.
//   5. Per-user in-flight lock (order:lock:{u}:{p}). Acquired here, released
//      by worker in finally. TTL 60s.
//   6. ⚡ DECR stock:{id}. Atomic overflow protection: if the counter goes
//      below zero, we roll back (INCR + DEL lock + DEL cooldown) and return
//      'TOO_MANY_REQUESTS' so the user can retry shortly. If stockKey is
//      missing, DECR is skipped — the worker's PG guard is authoritative.
//
//   KEYS[1] = cooldownKey   (user:cooldown:{userId}:{productId})
//   KEYS[2] = soldOutKey   (product:soldout:{productId})
//   KEYS[3] = stockKey     (stock:{productId})
//   KEYS[4] = purchasedKey (order:purchased:{userId}:{productId})
//   KEYS[5] = lockKey      (order:lock:{userId}:{productId})
//   ARGV[1] = lockTtlSeconds
//   ARGV[2] = cooldownTtlSeconds
//
// Returns:
//   'OK' on success
//   'SOLD_OUT' / 'ALREADY_PURCHASED' / 'LOCKED' / 'TOO_MANY_REQUESTS' on fast-fail
const FAST_FAIL_LUA = `
local cooldown   = KEYS[1]
local soldOut    = KEYS[2]
local stock      = KEYS[3]
local purchased  = KEYS[4]
local lock       = KEYS[5]
local lockTtl    = tonumber(ARGV[1])
local cooldownTtl = tonumber(ARGV[2])

-- 1. Cooldown: blocks same-user duplicate within the short TTL window
if redis.call('GET', cooldown) then return 'ALREADY_PURCHASED' end

-- 2. Sold-out flag
if redis.call('GET', soldOut) then return 'SOLD_OUT' end

-- 3. Stock counter (with cold-start protection)
local stockVal = redis.call('GET', stock)
if stockVal == false then return 'SOLD_OUT' end
if tonumber(stockVal) <= 0 then return 'SOLD_OUT' end

-- 4. Idempotency (24h)
if redis.call('GET', purchased) then return 'ALREADY_PURCHASED' end

-- 5. Per-user in-flight lock
if redis.call('SET', lock, '1', 'EX', lockTtl, 'NX') == nil then
  return 'LOCKED'
end

-- 6. Set cooldown BEFORE DECR so we capture both success and overflow paths.
--    If DECR overflows below zero, we DEL the cooldown (rollback) below.
redis.call('SET', cooldown, '1', 'EX', cooldownTtl)

-- 7. DECR with overflow rollback
if stockVal ~= false then
  local newStock = redis.call('DECR', stock)
  if newStock < 0 then
    redis.call('INCR', stock)
    redis.call('DEL', lock)
    redis.call('DEL', cooldown)
    return 'TOO_MANY_REQUESTS'
  end
end

return 'OK'
`;

@Injectable()
export class RedisService {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = this.serialize(value);
    if (ttlSeconds) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }

  async mset(entries: Array<{ key: string; value: unknown; ttlSeconds?: number }>): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.client.pipeline();
    for (const entry of entries) {
      const payload = this.serialize(entry.value);
      if (entry.ttlSeconds) {
        pipeline.set(entry.key, payload, 'EX', entry.ttlSeconds);
      } else {
        pipeline.set(entry.key, payload);
      }
    }

    await pipeline.exec();
  }

  async mgetStrings(keys: string[]): Promise<Array<string | null>> {
    if (keys.length === 0) return [];
    return this.client.mget(...keys);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(key, ...values);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(
      key,
      this.serialize(value),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async incrCacheHit(): Promise<number> {
    // Atomic Redis counter: safe across tens of thousands of concurrent requests.
    return this.client.incr('cache:hits:products');
  }

  async incrCacheMiss(): Promise<number> {
    return this.client.incr('cache:misses:products');
  }

  // Atomically increment the miss counter by an arbitrary count. Used so a single
  // cold-start batch fallback registers one miss per distinct missing product,
  // rather than one miss per request.
  async incrCacheMissBy(count: number): Promise<number> {
    return this.client.incrby('cache:misses:products', count);
  }

  async recordFragmentCacheHit(): Promise<number> {
    return this.incrCacheHit();
  }

  async recordFragmentCacheMiss(count = 1): Promise<number> {
    return this.incrCacheMissBy(count);
  }

  async getCacheStats(): Promise<{
    hits: number;
    misses: number;
    total: number;
    hitRatio: number;
  }> {
    const [hits, misses] = await Promise.all([
      this.client.get('cache:hits:products'),
      this.client.get('cache:misses:products'),
    ]);
    const h = Number(hits ?? 0);
    const m = Number(misses ?? 0);
    const total = h + m;
    return {
      hits: h,
      misses: m,
      total,
      hitRatio: total > 0 ? h / total : 0,
    };
  }

  raw(): Redis {
    return this.client;
  }

  async tryFastFail(
    cooldownKey: string,
    soldOutKey: string,
    stockKey: string,
    purchasedKey: string,
    lockKey: string,
    lockTtlSeconds: number,
    cooldownTtlSeconds: number,
  ): Promise<FastFailResult> {
    const result = await this.client.eval(
      FAST_FAIL_LUA,
      5,
      cooldownKey,
      soldOutKey,
      stockKey,
      purchasedKey,
      lockKey,
      String(lockTtlSeconds),
      String(cooldownTtlSeconds),
    );

    switch (result) {
      case 'OK':
        return { ok: true };
      case 'SOLD_OUT':
        return { ok: false, reason: 'SOLD_OUT' };
      case 'ALREADY_PURCHASED':
        return { ok: false, reason: 'ALREADY_PURCHASED' };
      case 'LOCKED':
        return { ok: false, reason: 'LOCKED' };
      case 'TOO_MANY_REQUESTS':
        return { ok: false, reason: 'TOO_MANY_REQUESTS' };
      default:
        throw new Error(`Unexpected Lua fast-fail result: ${String(result)}`);
    }
  }

  // Compensating INCR for a DECR that was successfully performed by the
  // Lua fast-fail but whose enqueue step subsequently failed. Brings the
  // counter back to its pre-DECR value.
  async incrStock(stockKey: string): Promise<number> {
    return this.client.incr(stockKey);
  }

  private serialize(value: unknown): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
}