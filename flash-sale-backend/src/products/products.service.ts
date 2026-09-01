import {
  Injectable,
  Logger as NestLogger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { RedisService } from '../cache/redis.service';
import { Product } from './entities/product.entity';

export interface ProductStaticRecord {
  productId: string;
  name: string;
  description: string | null;
  price: number;
  availableStock: number;
  remainingStock?: number;
  isFlashSaleActive: boolean;
}

interface ProductRow {
  productId: string;
  name: string;
  description: string | null;
  price: string | number;
  availableStock: string | number;
  remainingStock: string | number;
  isFlashSaleActive: boolean;
}

@Injectable()
export class ProductsService {
  private static readonly INDEX_KEY = 'products:id_list';
  private static readonly INDEX_REBUILD_LOCK_KEY = 'products:id_list:rebuild_lock';
  private static readonly INDEX_REBUILD_LOCK_TTL_SECONDS = 10;
  // Distributed lock guarding cold-start hydration of missing fragments.
  // "Losers" (instances that fail SET NX) do NOT re-query PostgreSQL — they
  // await the winner's result via the in-process promise coalescing map below.
  private static readonly HYDRATION_LOCK_TTL_SECONDS = 10;

  private readonly logger = new NestLogger(ProductsService.name);

  // Promise memoization / request deduplication:
  // when 10,000 requests hit the same cold cache window, only the first request creates the DB lookup.
  // Every other request reuses the same Promise until the load completes.
  private readonly inFlightLoads = new Map<string, Promise<Record<string, ProductStaticRecord>>>();
  private indexRebuildPromise?: Promise<void>;

  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) { }

  async findAll(page: number, limit: number) {
    const listKey = ProductsService.INDEX_KEY;
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    // Single parallel round-trip for IDs and Total count
    const [ids, total] = await Promise.all([
      this.redis.lrange(listKey, start, stop),
      this.redis.llen(listKey),
    ]);

    // Rebuild index only if Redis cache is cold
    if (total === 0) {
      await this.ensureActiveProductIdIndex();
      const [rebuiltIds, rebuiltTotal] = await Promise.all([
        this.redis.lrange(listKey, start, stop),
        this.redis.llen(listKey),
      ]);
      return this.processProductsList(rebuiltIds, rebuiltTotal, page, limit);
    }

    return this.processProductsList(ids, total, page, limit);
  }

  private async processProductsList(ids: string[], total: number, page: number, limit: number) {
    if (ids.length === 0) {
      const emptyResult = {
        status: 'success',
        data: [],
        meta: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      };
      return emptyResult;
    }

    const detailKeys = ids.map((id) => this.staticKey(id));
    const stockKeys = ids.map((id) => this.stockKey(id));

    // Batch all keys into 1 single Redis MGET query
    const allKeys = [...detailKeys, ...stockKeys];
    const allValues = await this.redis.mgetStrings(allKeys);
    const detailValues = allValues.slice(0, ids.length);
    const stockValues = allValues.slice(ids.length);

    const detailMap = new Map<string, ProductStaticRecord>();
    const stockMap = new Map<string, number>();
    let fragmentCacheHit = true;

    for (const [index, id] of ids.entries()) {
      const detailValue = detailValues[index];
      const parsedDetail = detailValue ? this.parseJson<ProductStaticRecord>(detailValue) : null;
      if (parsedDetail) {
        detailMap.set(id, parsedDetail);
      } else {
        fragmentCacheHit = false;
      }

      const stockValue = stockValues[index];
      if (stockValue != null) {
        stockMap.set(id, Number(stockValue));
      } else {
        fragmentCacheHit = false;
      }
    }

    const missingIds = Array.from(
      new Set(
        ids.filter((id) => !detailMap.has(id) || !stockMap.has(id)).map(String),
      ),
    ).sort();

    if (missingIds.length > 0) {
      fragmentCacheHit = false;
      const missingProducts = await this.loadMissingProducts(missingIds);

      for (const id of missingIds) {
        const record = missingProducts[id];
        if (record) {
          detailMap.set(id, record);
        }

        const stock = this.extractStock(record, stockMap.get(id));
        if (stock !== null) {
          stockMap.set(id, stock);
        }
      }
    }

    if (fragmentCacheHit) {
      this.redis.recordFragmentCacheHit().catch(() => { });
    }
    // Note: cache misses are NOT counted here. Miss counting lives inside
    // fetchMissingProductsFromDb() so it reflects each distinct product that was
    // actually loaded from PostgreSQL, independent of request batching and
    // single-flight deduplication.

    // Data stitching: join the immutable static fragment with the volatile stock fragment
    const data = ids
      .map((id) => {
        const product = detailMap.get(id);
        if (!product) return null;

        return {
          ...product,
          remainingStock: stockMap.get(id) ?? 0,
        };
      })
      .filter((p): p is ProductStaticRecord & { remainingStock: number } => p !== null);

    const result = {
      status: 'success',
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };


    return result;
  }

  private async ensureActiveProductIdIndex(): Promise<void> {
    const listKey = ProductsService.INDEX_KEY;
    const currentCount = await this.redis.llen(listKey);

    if (currentCount > 0) {
      return;
    }

    if (this.indexRebuildPromise) {
      return this.indexRebuildPromise;
    }

    this.indexRebuildPromise = this.rebuildActiveProductIdIndex().finally(() => {
      this.indexRebuildPromise = undefined;
    });

    return this.indexRebuildPromise;
  }

  private async rebuildActiveProductIdIndex(): Promise<void> {
    const listKey = ProductsService.INDEX_KEY;
    const lockKey = ProductsService.INDEX_REBUILD_LOCK_KEY;
    const lockToken = randomUUID();

    const acquired = await this.redis.setNx(
      lockKey,
      lockToken,
      ProductsService.INDEX_REBUILD_LOCK_TTL_SECONDS,
    );

    if (!acquired) {
      // Another API instance owns the rebuild. Wait for its list write instead of
      // issuing a competing PostgreSQL query during a cold start.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if ((await this.redis.llen(listKey)) > 0) {
          return;
        }
      }

      // Recover if the owner failed before publishing the list or its lock expired.
      return this.ensureActiveProductIdIndex();
    }

    try {
      if ((await this.redis.llen(listKey)) > 0) {
        return;
      }

      this.logger.warn(
        `Index cache missing or empty (${listKey}); rebuilding from PostgreSQL for flash-sale products`,
      );

      const rows = await this.repo
        .createQueryBuilder('product')
        .select('product."productId"', 'productId')
        .where('product."isFlashSaleActive" = :active', { active: true })
        .orderBy('product."productId"', 'ASC')
        .getRawMany<{ productId: string }>();

      if (rows.length === 0) {
        return;
      }

      await this.redis.rpush(listKey, ...rows.map((row) => row.productId));
      await this.redis.raw().expire(listKey, 60 * 60);
      this.logger.log(`Rebuilt ${listKey} with ${rows.length} IDs after cache flush`);
    } finally {
      await this.redis.raw().eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        lockKey,
        lockToken,
      );
    }
  }

  private staticKey(id: string): string {
    return `product:static:${id}`;
  }

  private stockKey(id: string): string {
    return `stock:${id}`;
  }

  private soldOutKey(id: string): string {
    return `product:soldout:${id}`;
  }

  private parseJson<T>(raw: string): T | null {
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  // On a Redis cache miss, return the LIVE remaining stock, never the initial
  // total. Preference order:
  //   1. record.remainingStock (the live value maintained by the worker's
  //      pessimistic PG transaction, read from the PRIMARY database)
  //   2. fallback (the already-cached stock fragment, if any)
  //
  // DECISION 2: `availableStock` (the bootstrap seed value) is deliberately
  // NOT consulted here. Reading it would reintroduce the oversell bug where a
  // cache miss rehydrates the stock counter with the initial total instead of
  // the live remaining value. If neither the live value nor the fallback is
  // present, we return null and the caller treats the product as out-of-stock
  // rather than guessing.
  private extractStock(record: ProductStaticRecord | undefined, fallback: number | undefined): number | null {
    if (record && typeof record === 'object') {
      const remaining = Number(record.remainingStock ?? record['remainingStock'] ?? NaN);
      if (Number.isFinite(remaining) && remaining >= 0) {
        return remaining;
      }

      const fallbackValue = Number(fallback ?? NaN);
      if (Number.isFinite(fallbackValue) && fallbackValue >= 0) {
        return fallbackValue;
      }
    }

    if (fallback != null) {
      return Number(fallback);
    }

    return null;
  }

  private async loadMissingProducts(missingIds: string[]) {
    const dedupeKey = missingIds.slice().sort().join(',');
    const existing = this.inFlightLoads.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const promise = this.hydrateWithStampedeGuard(missingIds)
      .finally(() => {
        this.inFlightLoads.delete(dedupeKey);
      });

    this.inFlightLoads.set(dedupeKey, promise);
    return promise;
  }

  // DECISION 2 — cache miss, hydration & stampede prevention.
  //
  // On a cold cache, thousands of instances/requests could simultaneously try to
  // re-hydrate the same missing fragments, causing a thundering herd against
  // PostgreSQL. Two layers of defense are combined here:
  //
  // 1. Distributed lock (Redis SET NX): exactly ONE API instance across the whole
  //    cluster wins the right to query PostgreSQL. The key embeds the sorted
  //    missing-ID set so distinct product batches hydrate independently.
  //
  // 2. In-process promise coalescing (`inFlightLoads`): on the winning instance,
  //    concurrent requests for the same batch share a single Promise. Losers of
  //    the distributed lock do NOT re-query PG — they either fail-fast (throw a
  //    retryable error surfaced as 503) or, within the same process, await the
  //    winner's in-flight promise. This prevents cascading client timeouts.
  private async hydrateWithStampedeGuard(
    missingIds: string[],
  ): Promise<Record<string, ProductStaticRecord>> {
    const sorted = missingIds.slice().sort();
    const lockKey = `products:hydrate:lock:${sorted.join('|')}`;
    const lockToken = randomUUID();

    const acquired = await this.redis.setNx(
      lockKey,
      lockToken,
      ProductsService.HYDRATION_LOCK_TTL_SECONDS,
    );

    if (!acquired) {
      // Another instance owns this hydration. Fail-fast rather than querying
      // PostgreSQL again — the client should retry once the winner has
      // populated the cache. This avoids cascading client timeouts and keeps
      // replica/primary load bounded under a stampede.
      this.logger.warn(
        `Hydration lock not acquired (${lockKey}); failing fast to avoid stampede`,
      );
      throw new ServiceUnavailableException({
        status: 'service_unavailable',
        message: 'Catalog cache is warming up, please retry shortly',
      });
    }

    try {
      return await this.fetchMissingProductsFromDb(sorted);
    } finally {
      await this.redis.raw().eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        lockKey,
        lockToken,
      );
    }
  }

  private async fetchMissingProductsFromDb(missingIds: string[]): Promise<Record<string, ProductStaticRecord>> {
    // DECISION 2: `remainingStock` MUST be read from the PRIMARY database, never
    // from a read replica. Replica lag means a replica read can return a stale
    // (higher) stock value right after a worker COMMIT, which rehydrates Redis
    // with phantom stock and reintroduces oversell. We run this query through a
    // dedicated connection on the primary ("master") node of the replication
    // cluster, then release it back to the pool immediately.
    const queryRunner = this.dataSource.createQueryRunner('master');
    try {
      const rows = await queryRunner.query(
        `SELECT "productId", "name", "description", "price",
                "availableStock", "remainingStock", "isFlashSaleActive"
         FROM products
         WHERE "productId" = ANY($1::varchar[])
           AND "isFlashSaleActive" = $2`,
        [missingIds, true],
      );

      return this.buildRecordsFromRows(rows as ProductRow[]);
    } finally {
      await queryRunner.release();
    }
  }

  private async buildRecordsFromRows(rows: ProductRow[]): Promise<Record<string, ProductStaticRecord>> {
    const byId: Record<string, ProductStaticRecord> = {};
    const writeBack: Array<{ key: string; value: unknown; ttlSeconds?: number }> = [];

    // Count a miss for each distinct product that was actually fetched here.
    // Because loadMissingProducts() single-flights concurrent requests onto one
    // promise, this runs exactly once per cold-start batch and accurately reflects
    // the distinct DB fallback reads (e.g. 11 misses for 11 missing products).
    await this.redis.recordFragmentCacheMiss(rows.length);

    const stockEntries: Array<{ productId: string; stockValue: number }> = [];

    for (const row of rows) {
      const staticRecord: ProductStaticRecord = {
        productId: row.productId,
        name: row.name,
        description: row.description ?? null,
        price: Number(row.price),
        availableStock: Number(row.availableStock),
        isFlashSaleActive: Boolean(row.isFlashSaleActive),
      };

      // Live remaining stock from the primary. Never fall back to
      // `availableStock` — that would rehydrate the counter with the initial
      // total and reintroduce oversell. If remainingStock is somehow null,
      // treat as 0 (sold out) so the Lua fast-fail blocks further orders.
      const stockValue = Number(row.remainingStock ?? 0);

      byId[row.productId] = staticRecord;
      writeBack.push({
        key: this.staticKey(row.productId),
        value: staticRecord,
        ttlSeconds: 24 * 60 * 60,
      });

      // Defer stock/soldout writes so we can apply them with NX
      // (only fill missing keys, never stomp live DECR-decremented values).
      stockEntries.push({ productId: row.productId, stockValue });
    }

    if (writeBack.length > 0) {
      await this.redis.mset(writeBack);
    }

    // Stock & soldout keys: SET ... NX (only if missing).
    //
    // Critical: the Lua fast-fail script atomically DECRs `stock:{id}` on
    // every accepted order. If hydration SETs unconditionally on every cache
    // miss, it can overwrite a live DECR-decremented value with the (stale)
    // PG remainingStock while workers are still committing — letting through
    // more requests than the actual stock (observed: 112 HTTP 202 vs 50
    // SUCCESS in the k6 test).
    //
    // NX preserves any in-flight DECR counter and only fills truly missing
    // keys on cold start. Trade-off: if PG ever drifts from Redis stock, we
    // no longer auto-heal on the next hydration — we wait for the 10-minute
    // TTL to expire. Acceptable because (a) drift only causes mild
    // over-rejection, never over-admission, and (b) PG's pessimistic lock
    // is the authoritative gate regardless.
    for (const entry of stockEntries) {
      await this.redis.setNx(this.stockKey(entry.productId), entry.stockValue, 60 * 10);
      if (entry.stockValue === 0) {
        await this.redis.setNx(this.soldOutKey(entry.productId), '1', 24 * 60 * 60);
      }
    }

    return byId;
  }
}