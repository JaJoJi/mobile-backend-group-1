import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from './entities/product.entity';

const CACHE_TTL_SECONDS = 60;

@Injectable()
export class ProductsService {
  private readonly logger = new NestLogger(ProductsService.name);

  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
    private readonly redis: RedisService,
  ) {}

  async findAll(page: number, limit: number) {
    const cacheKey = this.cacheKey(page, limit);

    const cached = await this.redis.get<unknown>(cacheKey);
    if (cached) {
      await this.redis.incrCacheHit();
      this.logger.log(`[CACHE HIT] ${cacheKey}`);
      return cached;
    }

    const [data, total] = await this.repo.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { productId: 'ASC' },
    });

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

    await this.redis.set(cacheKey, result, CACHE_TTL_SECONDS);
    await this.redis.trackCacheKey(cacheKey);
    await this.redis.incrCacheMiss();
    this.logger.log(`[CACHE MISS] ${cacheKey} (${data.length} rows)`);

    return result;
  }

  private cacheKey(page: number, limit: number) {
    return `products:list:page:${page}:limit:${limit}`;
  }
}