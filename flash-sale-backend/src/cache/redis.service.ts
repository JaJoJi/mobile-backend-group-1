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
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
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

  raw(): Redis {
    return this.client;
  }
}