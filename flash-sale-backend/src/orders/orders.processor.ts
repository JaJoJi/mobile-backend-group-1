import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import {
  DataSource,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';

interface OrderJobData {
  userId: string;
  productId: string;
  traceId?: string;
}

// Pessimistic-lock timeout per transaction. Workers contending on the same
// product row will wait this long before PostgreSQL aborts the lock attempt
// with error code 55P03 (lock_not_available). 2s is short enough to keep the
// BullMQ worker responsive but long enough to absorb a single hot row.
const PG_LOCK_TIMEOUT_MS = 2000;

@Processor('orders', { concurrency: 2 })
export class OrdersProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    @InjectPinoLogger(OrdersProcessor.name)
    private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<OrderJobData>): Promise<{ ok: boolean; reason?: string }> {
    const { userId, productId, traceId } = job.data;
    const lockKey = `order:lock:${userId}:${productId}`;
    const soldOutKey = `product:soldout:${productId}`;
    const stockKey = `stock:${productId}`;
    const purchasedKey = `order:purchased:${userId}:${productId}`;
    const logCtx = { jobId: job.id, userId, productId, traceId };

    this.logger.info(logCtx, 'order job picked up');

    // Defense-in-depth: the API already short-circuits via the purchased marker,
    // but a fast user could click after the marker is set on a different
    // instance and slip past the API before the marker propagates. Re-check
    // here in the worker so we never persist a duplicate SUCCESS row.
    const isPurchased = await this.redis.get<string>(purchasedKey);
    if (isPurchased) {
      this.logger.warn(
        { ...logCtx, reason: 'ALREADY_PURCHASED' },
        'order job skipped: user already purchased',
      );
      throw new Error('ALREADY_PURCHASED');
    }

    let pgDecremented = false;
    let orderInserted = false;
    let remainingStock = 0;

    try {
      // PESSIMISTIC TRANSACTION
      // =======================
      // Workers contending for the same productId serialize on a row-level
      // lock taken by SELECT ... FOR UPDATE. The lock is released on COMMIT
      // or ROLLBACK. set_config('lock_timeout', ...) makes PG abort the lock
      // attempt after PG_LOCK_TIMEOUT_MS so a stuck worker doesn't block the
      // queue forever. All SQL is run through the same EntityManager inside
      // the transaction so they share a single connection.
      await this.dataSource.transaction(async (manager) => {
        await manager.query('SET LOCAL lock_timeout = ' + PG_LOCK_TIMEOUT_MS);

        // 1. Acquire row lock + read current remainingStock.
        const productRows = await manager.query(
          'SELECT "remainingStock" FROM products WHERE "productId" = $1 FOR UPDATE',
          [productId],
        );

        if (productRows.length === 0) {
          throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'NOT_FOUND' });
        }

        remainingStock = Number(productRows[0].remainingStock);

        if (remainingStock <= 0) {
          // Fix 4: do NOT write a FAILED audit row here. We haven't touched
          // the DB yet inside this transaction, and the wasted PG write was
          // adding load with no integrity benefit. Just throw and let the
          // outer catch + finally clean up.
          this.logger.warn(
            { ...logCtx, reason: 'OUT_OF_STOCK' },
            'order rejected: out of stock',
          );
          throw new Error('OUT_OF_STOCK');
        }

        // 2. Atomic decrement (still holds the row lock).
        await manager.query(
          'UPDATE products SET "remainingStock" = $1 WHERE "productId" = $2',
          [remainingStock - 1, productId],
        );
        pgDecremented = true;

        // Fix 1: REMOVED worker SET stockKey.
        // The Lua fast-fail DECR is the authoritative source of stockKey.
        // Worker SETs were RESETTING the counter back up (race vs concurrent
        // DECRs), so the counter never reached 0 and DECR never caught
        // overflow. stockKey now self-heals via:
        //   - Lua DECR (decrements monotonically)
        //   - ProductsService hydration after 30s TTL expiry (re-fetches
        //     the true remainingStock from PG replica)
        // Worker only owns the sold-out flag (sticky, authoritative).

        // Sticky sold-out flag (24h TTL). Set inside the transaction so
        // it's only visible to the API fast-fail after COMMIT succeeds.
        if (remainingStock - 1 === 0) {
          await this.redis.set(soldOutKey, '1', 24 * 60 * 60);
        }

        // Fix 3: SET purchasedKey IN-TX (after UPDATE, before INSERT).
        // This closes the 23505 race: if a concurrent sibling worker for
        // the same (user, product) also reaches INSERT, at least one will
        // see the purchasedKey already set (either via API fast-fail or
        // worker defense-in-depth). Trade-off: on a real 23505 rollback,
        // purchasedKey stays set (false positive) — the user is blocked
        // for 24h even though the duplicate was rejected. Acceptable
        // because 23505 implies a prior SUCCESS for the same user-product.
        await this.redis.set(purchasedKey, '1', 24 * 60 * 60);

        // 4. INSERT order. If UNIQUE (userId, productId) collides, the whole
        // transaction rolls back, the PG decrement is undone automatically,
        // and we throw to the outer catch — no manual compensation needed.
        try {
          await manager.query(
            `INSERT INTO "orders" ("id", "userId", "productId", "status", "failureReason", "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, NULL, now(), now())`,
            [userId, productId, 'SUCCESS'],
          );
          orderInserted = true;
        } catch (insertErr) {
          const isUniqueViolation =
            insertErr instanceof QueryFailedError &&
            (insertErr as QueryFailedError & { code?: string }).code === '23505';

          if (isUniqueViolation) {
            this.logger.warn(
              { ...logCtx, reason: 'DUPLICATE_USER_PRODUCT' },
              'order rejected: duplicate (unique constraint) - transaction will roll back',
            );
          } else {
            this.logger.error(
              { ...logCtx, err: insertErr },
              'order persistence failed - transaction will roll back',
            );
          }
          throw insertErr;
        }
      }); // COMMIT here - row lock released, changes visible.

      // Post-commit: idempotency marker is already set in-tx (Fix 3), so
      // nothing to do here. Defense-in-depth re-check at the top of this
      // method catches the rare case where a duplicate request slipped past
      // the API fast-fail (e.g., cross-instance propagation delay).

      this.logger.info(logCtx, 'order processed successfully');
      return { ok: true };
    } catch (err) {
      // The pessimistic transaction handles all rollback automatically:
      // - OUT_OF_STOCK: no PG change (we threw before UPDATE). Fix 4 removed
      //   the FAILED audit-row write — it added load with no integrity benefit.
      // - 23505 / transient errors: whole transaction rolled back; PG and
      //   Redis stock are unchanged. Note: with Fix 3, purchasedKey was set
      //   before INSERT, so on 23505 it stays in Redis briefly (false-positive
      //   idempotency lock for this user-product). Acceptable trade-off.
      //
      // pgDecremented/orderInserted may both be false here (transaction
      // rolled back before commit) or one true / one false (we threw mid-tx).
      // In neither case do we need to issue a compensating UPDATE — PG has
      // already done it atomically.
      throw err;
    } finally {
      // Best-effort lock release. If the API was a no-op (Lua returned OK
      // but the API process died before DEL), the TTL will clean it up.
      await this.redis.del(lockKey);
    }
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