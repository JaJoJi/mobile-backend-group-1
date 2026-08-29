import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { RedisService } from '../cache/redis.service';
import { Product } from './entities/product.entity';

export interface ProductStaticRecord {
  productId: string;
  name: string;
  description: string | null;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

@Injectable()
export class ProductsService {
  private static readonly INDEX_KEY = 'products:id_list';
  private static readonly INDEX_REBUILD_LOCK_KEY = 'products:id_list:rebuild_lock';
  private static readonly INDEX_REBUILD_LOCK_TTL_SECONDS = 10;

  private readonly logger = new NestLogger(ProductsService.name);

  // Promise memoization / request deduplication:
  // when 10,000 requests hit the same cold cache window, only the first request creates the DB lookup.
  // Every other request reuses the same Promise until the load completes.
  private readonly inFlightLoads = new Map<string, Promise<Record<string, ProductStaticRecord>>>();
  private indexRebuildPromise?: Promise<void>;

  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
    private readonly redis: RedisService,
  ) {}

  async findAll(page: number, limit: number) {
    await this.ensureActiveProductIdIndex();

    const listKey = 'products:id_list';
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    const [ids, total] = await Promise.all([
      this.redis.lrange(listKey, start, stop),
      this.redis.llen(listKey),
    ]);

    if (ids.length === 0) {
      const emptyResult = {
        status: 'success',
        data: [],
        meta: {
          total: 0,
          page,
          limit,
          totalPages: 0,
        },
      };
      return emptyResult;
    }

    const detailKeys = ids.map((id) => this.staticKey(id));
    const stockKeys = ids.map((id) => this.stockKey(id));

    const [detailValues, stockValues] = await Promise.all([
      this.redis.mgetStrings(detailKeys),
      this.redis.mgetStrings(stockKeys),
    ]);

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
      await this.redis.recordFragmentCacheHit();
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

  private extractStock(record: ProductStaticRecord | undefined, fallback: number | undefined): number | null {
    if (record && typeof record === 'object') {
      return Number(record?.availableStock ?? record?.['remainingStock'] ?? fallback ?? 0);
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

    const promise = this.fetchMissingProductsFromDb(missingIds)
      .finally(() => {
        this.inFlightLoads.delete(dedupeKey);
      });

    this.inFlightLoads.set(dedupeKey, promise);
    return promise;
  }

  private async fetchMissingProductsFromDb(missingIds: string[]): Promise<Record<string, ProductStaticRecord>> {
    const rows = await this.repo
      .createQueryBuilder('product')
      .select([
        'product."productId" AS "productId"',
        'product."name" AS "name"',
        'product."description" AS "description"',
        'product."price" AS "price"',
        'product."availableStock" AS "availableStock"',
        'product."remainingStock" AS "remainingStock"',
        'product."isFlashSaleActive" AS "isFlashSaleActive"',
      ])
      .where('product."productId" IN (:...ids)', { ids: missingIds })
      .andWhere('product."isFlashSaleActive" = :active', { active: true })
      .getRawMany<{
        productId: string;
        name: string;
        description: string | null;
        price: string | number;
        availableStock: string | number;
        remainingStock: string | number;
        isFlashSaleActive: boolean;
      }>();

    const byId: Record<string, ProductStaticRecord> = {};
    const writeBack: Array<{ key: string; value: unknown; ttlSeconds?: number }> = [];

    // Count a miss for each distinct product that was actually fetched here.
    // Because loadMissingProducts() single-flights concurrent requests onto one
    // promise, this runs exactly once per cold-start batch and accurately reflects
    // the distinct DB fallback reads (e.g. 11 misses for 11 missing products).
    await this.redis.recordFragmentCacheMiss(rows.length);

    for (const row of rows) {
      const staticRecord: ProductStaticRecord = {
        productId: row.productId,
        name: row.name,
        description: row.description ?? null,
        price: Number(row.price),
        availableStock: Number(row.availableStock),
        isFlashSaleActive: Boolean(row.isFlashSaleActive),
      };

      const stockValue = Number(row.remainingStock ?? row.availableStock ?? 0);

      byId[row.productId] = staticRecord;
      writeBack.push({
        key: this.staticKey(row.productId),
        value: staticRecord,
        ttlSeconds: 24 * 60 * 60,
      });

      // stock:{id} uses a 1-hour TTL. The DECR-by-API overflow counter must
      // remain authoritative for the entire flash sale duration (typically
      // <1h). A short TTL (e.g. 30s) caused cold-start bypass during the
      // k6 40s test: once stockKey TTL expired mid-test, Lua saw stockVal=nil
      // and skipped DECR entirely, letting thousands of overflow requests
      // through to the queue. 1h TTL keeps the counter alive throughout the
      // sale; it self-heals on next hydration if PG ever drifts.
      writeBack.push({
        key: this.stockKey(row.productId),
        value: stockValue,
        ttlSeconds: 60 * 60,
      });

      // Sync the sticky sold-out flag if PG confirms remainingStock=0, so
      // the API fast-fail Lua catches it without waiting for a worker SET.
      if (stockValue === 0) {
        writeBack.push({
          key: this.soldOutKey(row.productId),
          value: '1',
          ttlSeconds: 24 * 60 * 60,
        });
      }
    }

    if (writeBack.length > 0) {
      await this.redis.mset(writeBack);
    }

    return byId;
  }
}