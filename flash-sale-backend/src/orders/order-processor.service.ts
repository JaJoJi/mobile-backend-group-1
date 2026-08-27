import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';

@Injectable()
export class OrderProcessorService {
  private readonly logger = new NestLogger(OrderProcessorService.name);

  constructor(private readonly redis: RedisService) {}

  stockKey(productId: string): string {
    return `stock:${productId}`;
  }

  async reduceRedisStockSafely(productId: string): Promise<boolean> {
    // Safe DECR logic: only decrement if the stock fragment already exists in Redis.
    // If the key is absent because the catalog never lazy-loaded that stock yet, do nothing here.
    // The database remains the source of truth and the next cache miss will hydrate the correct value.
    const stockKey = this.stockKey(productId);
    const result = await this.redis.safeDecrIfExists(stockKey);

    if (!result.changed) {
      this.logger.warn({ productId, stockKey }, 'safeRedisDecr skipped because stock key is missing');
      return false;
    }

    this.logger.log({ productId, stockKey, newValue: result.value }, 'redis stock decremented safely');
    return true;
  }
}
