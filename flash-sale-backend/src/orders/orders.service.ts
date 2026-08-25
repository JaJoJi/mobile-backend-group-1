import {
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { RedisService } from '../cache/redis.service';

@Injectable()
export class OrdersService {
  private static readonly LOCK_TTL_SECONDS = 30;

  constructor(
    @InjectQueue('orders') private readonly ordersQueue: Queue,
    private readonly redis: RedisService,
    @InjectPinoLogger(OrdersService.name)
    private readonly logger: PinoLogger,
  ) {}

  async create(userId: string, productId: string, traceId?: string) {
    const lockKey = this.lockKey(userId, productId);

    const acquired = await this.redis.setNx(
      lockKey,
      { ts: Date.now(), traceId },
      OrdersService.LOCK_TTL_SECONDS,
    );

    if (!acquired) {
      this.logger.warn(
        { userId, productId, traceId },
        'order rejected: lock already held',
      );
      throw new ConflictException({
        status: 'conflict',
        message: 'You already have an order being processed for this product',
      });
    }

    const jobTraceId = traceId ?? randomUUID();
    const job = await this.ordersQueue.add(
      'process',
      { userId, productId, traceId: jobTraceId },
      {
        removeOnComplete: 100,
        removeOnFail: 100,
        attempts: 1,
      },
    );

    this.logger.info(
      { userId, productId, traceId: jobTraceId, jobId: job.id },
      'order enqueued',
    );

    return {
      status: 'processing',
      orderJobId: String(job.id),
      message: 'Your order is in the queue.',
      traceId: jobTraceId,
    };
  }

  lockKey(userId: string, productId: string) {
    return `order:lock:${userId}:${productId}`;
  }
}