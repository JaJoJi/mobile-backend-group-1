import {
  ConflictException,
  HttpException,
  HttpStatus,
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
  // In-flight marker TTL: covers the whole job lifecycle (enqueue → worker
  // process → COMMIT). Worker DELs on completion; this TTL is a safety net
  // for worker crashes / queue stalls. Long enough to absorb a typical
  // BullMQ pickup + transaction; short enough to auto-recover from crashes.
  private static readonly LOCK_TTL_SECONDS = 60;
  private static readonly SOLD_OUT_TTL_SECONDS = 24 * 60 * 60;
  // Short TTL for stock:{id}. The DECR-by-API overflow counter is
  // self-healing: when it expires, ProductsService hydration re-fetches
  // the true remainingStock from PG (replica).
  private static readonly STOCK_TTL_SECONDS = 30;
  // Same-user cooldown: blocks iter 2 of the same VU within this window.
  // Closes the race between API fast-fail (which checks purchasedKey) and
  // worker in-tx SET purchasedKey. With cooldown, iter 2 of a successful
  // iter 1 is rejected at the API layer, not at the worker.
  private static readonly COOLDOWN_TTL_SECONDS = 3;

  constructor(
    @InjectQueue('orders') private readonly ordersQueue: Queue,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    private readonly redis: RedisService,
    @InjectPinoLogger(OrdersService.name)
    private readonly logger: PinoLogger,
  ) { }

  async create(userId: string, productId: string, traceId?: string) {
    const cooldownKey = this.cooldownKey(userId, productId);
    const soldOutKey = this.soldOutKey(productId);
    const stockKey = this.stockKey(productId);
    const purchasedKey = this.purchasedKey(userId, productId);
    const lockKey = this.lockKey(userId, productId);

    // Atomic Lua fast-fail + DECR (single round-trip):
    //   1. user:cooldown:{u}:{p}     -> ALREADY_PURCHASED (3s same-user dedup)
    //   2. product:soldout:{id}      -> SOLD_OUT
    //   3. stock:{id} value <= 0     -> SOLD_OUT (cold-start protected)
    //   4. order:purchased:{u}:{p}   -> ALREADY_PURCHASED (24h idempotency)
    //   5. SET NX EX order:lock:{u}:{p} -> LOCKED (60s in-flight)
    //   6. SET user:cooldown:{u}:{p} EX 3s (closes same-user race window)
    //   7. DECR stock:{id} -> if < 0: rollback -> TOO_MANY_REQUESTS
    //
    // PG stock reservation itself is NOT performed here -- it happens
    // pessimistically in the worker (SELECT ... FOR UPDATE) for 100% integrity.
    const result = await this.redis.tryFastFail(
      cooldownKey,
      soldOutKey,
      stockKey,
      purchasedKey,
      lockKey,
      OrdersService.LOCK_TTL_SECONDS,
      OrdersService.COOLDOWN_TTL_SECONDS,
    );

    if (!result.ok) {
      // TOO_MANY_REQUESTS -> 429 (rate-limit semantics, distinct from 409).
      if (result.reason === 'TOO_MANY_REQUESTS') {
        throw new HttpException(
          {
            status: 'too_many_requests',
            message: 'Too much request, try again',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const message =
        result.reason === 'SOLD_OUT'
          ? 'Product is sold out'
          : result.reason === 'ALREADY_PURCHASED'
            ? 'You have already purchased this product'
            : 'You already have an order being processed for this product';
      throw new ConflictException({ status: 'conflict', message });
    }

    const jobTraceId = traceId ?? randomUUID();

    try {
      const job = await this.ordersQueue.add(
        'process',
        { userId, productId, traceId: jobTraceId },
        {
          removeOnComplete: 1000,
          removeOnFail: 1000,
          // attempts=1: retrying OUT_OF_STOCK or ALREADY_PURCHASED just
          // wastes a worker slot — these failures are deterministic.
          // Transient failures (lock timeout, deadlock) are recovered
          // by the worker's pessimistic tx rolling back; the client can
          // re-submit via the API layer if needed.
          attempts: 1,
          backoff: {
            type: 'fixed',
            delay: 250,
          },
        },
      );

      // Lock PERSISTS until the worker DELs it in its finally block.
      // This makes order:lock:{u}:{p} an in-flight marker: the same
      // (user, product) cannot enqueue another job while a previous job is
      // being processed. The TTL on the lock is the safety net if the worker
      // never picks up the job (queue stall / worker crash).

      return {
        status: 'processing',
        orderJobId: String(job.id),
        message: 'Your order is in the queue.',
        traceId: jobTraceId,
      };
    } catch (error) {
      // Enqueue failed after a successful DECR + cooldown SET. Compensate:
      //   - INCR stockKey back (counter not "phantom-decremented")
      //   - DEL cooldownKey so the user can retry immediately (otherwise
      //     they're locked out for COOLDOWN_TTL_SECONDS despite no job
      //     having been queued)
      // Worker DELs the lock in finally regardless.
      await Promise.all([
        this.redis.incrStock(stockKey),
        this.redis.raw().del(cooldownKey),
      ]);
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

  cooldownKey(userId: string, productId: string) {
    return `user:cooldown:${userId}:${productId}`;
  }

  soldOutKey(productId: string) {
    return `product:soldout:${productId}`;
  }

  stockKey(productId: string) {
    return `stock:${productId}`;
  }
}