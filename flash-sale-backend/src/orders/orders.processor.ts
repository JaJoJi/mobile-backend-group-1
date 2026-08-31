import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import { DataSource, QueryFailedError } from 'typeorm';
import { RedisService } from '../cache/redis.service';

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

// PostgreSQL unique-violation code: raised when an INSERT collides with the
// UNIQUE ("userId", "productId") constraint on the orders table. This is the
// ONLY signal the worker treats as a genuine duplicate (already-purchased).
const PG_UNIQUE_VIOLATION = '23505';

// TTL for the `order:purchased:{u}:{p}` flag written by the self-healing
// path. Mirrors the TTL used on the normal post-commit success path so the
// flag semantics (24h idempotency window) stay identical.
const PURCHASED_TTL_SECONDS = 24 * 60 * 60;

@Processor('orders', { concurrency: 4 })
export class OrdersProcessor extends WorkerHost {
  constructor(
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
      return { ok: true, reason: 'ALREADY_PURCHASED' };
    }

    let remainingStock = 0;

    // ------------------------------------------------------------------
    // No Redis state mutations happen inside the transaction below.
    // `product:soldout` and `order:purchased` are only written POST-COMMIT,
    // so a rollback (e.g. 23505 duplicate, OUT_OF_STOCK, lock timeout) can
    // never leave stale sold-out / purchased flags that contradict the DB.
    // ------------------------------------------------------------------
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

        // 3. INSERT order. If UNIQUE (userId, productId) collides, the whole
        // transaction rolls back, the PG decrement is undone automatically,
        // and the error propagates to the outer catch for classification
        // (23505 → self-heal; otherwise → re-throw for BullMQ retry). No
        // Redis writes happen here, so nothing needs manual compensation.
        await manager.query(
          `INSERT INTO "orders" ("id", "userId", "productId", "status", "failureReason", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, NULL, now(), now())`,
          [userId, productId, 'SUCCESS'],
        );
      }); // COMMIT here - row lock released, changes visible.

      // ------------------------------------------------------------------
      // POST-COMMIT: the DB state is now durable. Only at this point do we
      // write Redis flags, so Redis can never claim an order was purchased
      // (or that a product is sold out) when the DB rolled the change back.
      // ------------------------------------------------------------------

      // Idempotency marker: only a committed SUCCESS row may set this. A
      // 23505 duplicate on a rolled-back tx will never reach this line, so
      // the false-positive "blocked for 24h without a purchase" bug is gone.
      await this.redis.set(purchasedKey, '1', PURCHASED_TTL_SECONDS);

      // Sticky sold-out flag: only set when the committed decrement drove
      // remainingStock to exactly 0. If the last item's transaction rolls
      // back, this is never set — the product is NOT falsely sold out.
      if (remainingStock - 1 === 0) {
        await this.redis.set(soldOutKey, '1', 24 * 60 * 60);
      }

      this.logger.info(logCtx, 'order processed successfully');
      return { ok: true };
    } catch (err) {
      // DECISION 3 — Deduplication & worker self-healing.
      //
      // The pessimistic transaction has already rolled itself back, so the
      // PG decrement is undone automatically and no Redis flags were written
      // in-tx. Now classify the error:
      //
      // 1. PostgreSQL 23505 (unique violation on UNIQUE(userId, productId)):
      //    a genuine duplicate — the user already owns a SUCCESS row for this
      //    product. Self-heal: set the `already_purchased` flag so every future
      //    request for this (user, product) is blocked instantly at the Redis
      //    hot-path, then complete the job cleanly (no retry, no error).
      //
      // 2. Any other error (OUT_OF_STOCK, PRODUCT_NOT_FOUND, transient DB /
      //    network drops, lock timeouts): release locks in `finally`, keep
      //    stock intact, and re-throw so BullMQ applies its normal retry
      //    backoff. We do NOT treat generic errors as duplicates.
      const isUniqueViolation =
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION;

      if (isUniqueViolation) {
        this.logger.warn(
          { ...logCtx, reason: 'DUPLICATE_USER_PRODUCT' },
          'duplicate order detected (23505); self-healing: setting already_purchased flag and completing job',
        );

        // Self-heal step 1: set the dedup flag so future requests are blocked
        // at the Redis hot-path (matching the post-commit success path's TTL).
        await this.redis.set(purchasedKey, '1', PURCHASED_TTL_SECONDS);

        // Self-heal step 2: complete cleanly instead of throwing/retrying.
        return { ok: true, reason: 'ALREADY_PURCHASED' };
      }

      // Generic failure: no INCR / stock compensation (DECISION 1 — ghost
      // stock is acceptable and cleaned up offline; we never restore stock).
      this.logger.error(
        { ...logCtx, err },
        'order processing failed; releasing lock and re-throwing for BullMQ retry (no stock compensation)',
      );
      throw err;
    } finally {
      // Best-effort lock release. If the API was a no-op (Lua returned OK
      // but the API process died before DEL), the TTL will clean it up.
      await this.redis.del(lockKey);
    }
  }
}