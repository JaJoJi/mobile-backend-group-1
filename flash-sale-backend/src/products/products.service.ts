import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from './entities/product.entity';

interface ProductStaticRecord {
  productId: string;
  name: string;
  description: string | null;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

@Injectable()
export class ProductsService {
  private readonly logger = new NestLogger(ProductsService.name);

  // Promise memoization / request deduplication:
  // when 10,000 requests hit the same cold cache window, only the first request creates the DB lookup.
  // Every other request reuses the same Promise until the load completes.
  private readonly inFlightLoads = new Map<string, Promise<Record<string, ProductStaticRecord>>>();

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
      return {
        status: 'success',
        data: [],
        meta: {
          total: 0,
          page,
          limit,
          totalPages: 0,
        },
      };
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
      this.logger.log(`Cache HIT for page=${page}, limit=${limit}, ids=${ids.length}`);
    } else {
      await this.redis.recordFragmentCacheMiss();
      this.logger.warn(`Cache MISS for page=${page}, limit=${limit}, missing=${missingIds.length}`);
    }

    // Data stitching: join the immutable static fragment with the volatile stock fragment
    // in a single response object. Missing fragments are lazily loaded and cached back to Redis.
    const data = ids
      .map((id) => {
        const product = detailMap.get(id);
        if (!product) return null;

        return {
          ...product,
          stock: stockMap.get(id) ?? 0,
        };
      })
      .filter(Boolean);

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

  private async ensureActiveProductIdIndex(): Promise<void> {
    const listKey = 'products:id_list';
    const currentCount = await this.redis.llen(listKey);

    if (currentCount > 0) {
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
    await this.redis.recordFragmentCacheMiss();
    this.logger.log(`Rebuilt ${listKey} with ${rows.length} IDs after cache flush`);
  }

  private staticKey(id: string): string {
    return `product:static:${id}`;
  }

  private stockKey(id: string): string {
    return `stock:${id}`;
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

    for (const row of rows) {
      const staticRecord: ProductStaticRecord = {
        productId: row.productId,
        name: row.name,
        description: row.description ?? null,
        price: Number(row.price),
        availableStock: Number(row.availableStock),
        isFlashSaleActive: Boolean(row.isFlashSaleActive),
      };

      byId[row.productId] = staticRecord;
      writeBack.push({
        key: this.staticKey(row.productId),
        value: staticRecord,
        ttlSeconds: 60 * 60,
      });

      writeBack.push({
        key: this.stockKey(row.productId),
        value: Number(row.remainingStock ?? row.availableStock ?? 0),
        ttlSeconds: 60,
      });
    }

    if (writeBack.length > 0) {
      await this.redis.mset(writeBack);
    }

    return byId;
  }
}