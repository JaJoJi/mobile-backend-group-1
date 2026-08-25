import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';

interface OrderJobData {
  userId: string;
  productId: string;
  traceId?: string;
}

@Processor('orders', { concurrency: 5 })
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
    } catch (err) {
      await this.productRepo.increment({ productId }, 'remainingStock', 1);
      await this.redis.del(lockKey);
      this.logger.warn(
        { ...logCtx, reason: 'DUPLICATE_USER_PRODUCT' },
        'order rejected: duplicate (unique constraint)',
      );
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