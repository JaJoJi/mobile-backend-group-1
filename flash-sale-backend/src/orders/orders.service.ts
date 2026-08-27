import {
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { RedisService } from '../cache/redis.service';
import { Order } from './entities/order.entity';
import { QueryOrdersDto } from './dto/query-orders.dto';

@Injectable()
export class OrdersService {
  private static readonly LOCK_TTL_SECONDS = 30;

  constructor(
    @InjectQueue('orders') private readonly ordersQueue: Queue,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
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

  async findAll(query: QueryOrdersDto) {
    const { page, limit, productId, userId, status } = query;

    const where: Record<string, unknown> = {};
    if (productId) where.productId = productId;
    if (userId) where.userId = userId;
    if (status) where.status = status;

    const [data, total] = await this.orderRepo.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'ASC' },
    });

    return {
      status: 'success',
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  lockKey(userId: string, productId: string) {
    return `order:lock:${userId}:${productId}`;
  }
}
