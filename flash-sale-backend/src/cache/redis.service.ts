import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

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

  async trackCacheKey(key: string): Promise<void> {
    await this.client.sadd('cache:tracked:products', key);
  }

  async invalidateProductsCache(): Promise<number> {
    const keys = await this.client.smembers('cache:tracked:products');
    if (keys.length === 0) return 0;
    const deleted = await this.client.del(...keys);
    await this.client.del('cache:tracked:products');
    return deleted;
  }

  async incrCacheHit(): Promise<number> {
    return this.client.incr('cache:hits:products');
  }

  async incrCacheMiss(): Promise<number> {
    return this.client.incr('cache:misses:products');
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

  async safeDecrIfExists(key: string): Promise<{ changed: boolean; value: number }> {
    // Safe DECR: only decrement if the key already exists. This avoids a thundering herd
    // race where a cold cache miss creates a missing stock key that is then decremented by mistake.
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 1 then
        return redis.call('DECR', KEYS[1])
      end
      return 0
    `;

    const result = await this.client.eval(script, 1, key);
    const value = Number(result ?? 0);
    return {
      changed: value !== 0,
      value,
    };
  }

  raw(): Redis {
    return this.client;
  }

  private serialize(value: unknown): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
}