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
  ) { }

  async create(userId: string, productId: string, traceId?: string) {
    const soldOutKey = this.soldOutKey(productId);
    const purchasedKey = this.purchasedKey(userId, productId);
    const lockKey = this.lockKey(userId, productId);

    const [isSoldOut, alreadyPurchased] = await Promise.all([
      this.redis.get<string>(soldOutKey),
      this.redis.get<string>(purchasedKey),
    ]);

    if (isSoldOut) {
      throw new ConflictException({
        status: 'conflict',
        message: 'Product is sold out',
      });
    }

    if (alreadyPurchased) {
      throw new ConflictException({
        status: 'conflict',
        message: 'You have already purchased this product',
      });
    }

    const acquired = await this.redis.setNx(
      lockKey,
      { ts: Date.now(), traceId },
      OrdersService.LOCK_TTL_SECONDS,
    );

    if (!acquired) {
      throw new ConflictException({
        status: 'conflict',
        message: 'You already have an order being processed for this product',
      });
    }

    const stockKey = `stock:${productId}`;
    const remainingStock = await this.redis.raw().decr(stockKey);

    if (remainingStock < 0) {
      await this.redis.raw().incr(stockKey);
      await this.redis.set(soldOutKey, '1', 86400);
      await this.redis.del(lockKey);
      throw new ConflictException({
        status: 'conflict',
        message: 'Product is sold out',
      });
    }

    if (remainingStock === 0) {
      await this.redis.set(soldOutKey, '1', 86400);
    }

    const jobTraceId = traceId ?? randomUUID();

    try {
      const job = await this.ordersQueue.add(
        'process',
        { userId, productId, traceId: jobTraceId },
        {
          removeOnComplete: 1000,
          removeOnFail: 1000,
          attempts: 1,
        },
      );

      return {
        status: 'processing',
        orderJobId: String(job.id),
        message: 'Your order is in the queue.',
        traceId: jobTraceId,
      };
    } catch (error) {
      await this.redis.raw().incr(stockKey);
      await this.redis.del(lockKey);
      throw error;
    }
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

  purchasedKey(userId: string, productId: string) {
    return `order:purchased:${userId}:${productId}`;
  }

  soldOutKey(productId: string) {
    return `product:soldout:${productId}`;
  }
}
