import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';

interface OrderJobData {
  userId: string;
  productId: string;
  traceId?: string;
}

@Processor('orders', { concurrency: 10 })
export class OrdersProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    private readonly redis: RedisService,
    @InjectPinoLogger(OrdersProcessor.name)
    private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<OrderJobData>): Promise<{ ok: boolean; reason?: string }> {
    const { userId, productId, traceId } = job.data;
    const lockKey = `order:lock:${userId}:${productId}`;
    const logCtx = { jobId: job.id, userId, productId, traceId };

    this.logger.info(logCtx, 'order job picked up');

    // The producer already reserved Redis stock before enqueueing this job.
    // The worker only persists the order and records the purchased marker.
    const isPurchased = await this.redis.get<string>(`order:purchased:${userId}:${productId}`);
    if (isPurchased) {
      await this.redis.del(lockKey);
      this.logger.warn({ ...logCtx, reason: 'ALREADY_PURCHASED' }, 'order job skipped: user already purchased');
      throw new Error('ALREADY_PURCHASED');
    }

    const updateResult = await this.productRepo
      .createQueryBuilder()
      .update(Product)
      .set({ remainingStock: () => '"remainingStock" - 1' })
      .where('"productId" = :pid AND "remainingStock" > 0', { pid: productId })
      .execute();

    if (!updateResult.affected) {
      await this.recordOrder(userId, productId, 'FAILED', 'OUT_OF_STOCK');
      await this.redis.del(lockKey);
      this.logger.warn({ ...logCtx, reason: 'OUT_OF_STOCK' }, 'order rejected: out of stock');
      throw new Error('OUT_OF_STOCK');
    }

    try {
      await this.recordOrder(userId, productId, 'SUCCESS');
      await this.redis.set(`order:purchased:${userId}:${productId}`, '1', 86400);
    } catch (err) {
      const isUniqueViolation =
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === '23505';

      if (isUniqueViolation) {
        // Only a genuine unique-constraint violation signals a duplicate purchase.
        await this.productRepo.increment({ productId }, 'remainingStock', 1);
        this.logger.warn(
          { ...logCtx, reason: 'DUPLICATE_USER_PRODUCT' },
          'order rejected: duplicate (unique constraint)',
        );
      } else {
        // Transient DB outages, pool exhaustion, or timeouts must surface as a real
        // job failure rather than being relabeled as a duplicate purchase.
        this.logger.error(
          { ...logCtx, err },
          'order persistence failed',
        );
      }

      await this.redis.del(lockKey);
      throw err;
    }

    const invalidated = await this.redis.invalidateProductsCache();
    await this.redis.del(lockKey);

    this.logger.info(
      { ...logCtx, invalidatedCacheKeys: invalidated },
      'order processed successfully',
    );

    return { ok: true };
  }

  private async recordOrder(
    userId: string,
    productId: string,
    status: 'SUCCESS' | 'FAILED',
    failureReason?: string,
  ) {
    return this.orderRepo.save({
      userId,
      productId,
      status,
      failureReason: failureReason ?? null,
    });
  }
}