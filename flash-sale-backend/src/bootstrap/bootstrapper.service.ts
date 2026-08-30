import { Injectable, Logger as NestLogger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { RedisService } from '../cache/redis.service';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class BootstrapperService implements OnApplicationBootstrap {
  private static readonly INDEX_KEY = 'products:id_list';
  private static readonly WARMUP_LOCK_KEY = 'products:id_list:warmup_lock';
  private static readonly WARMUP_LOCK_TTL_SECONDS = 30;

  private readonly logger = new NestLogger(BootstrapperService.name);

  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    // Index-only warm-up: pre-populate the active product ID list. Individual
    // static/stock fragments are hydrated lazily on the read path to avoid a
    // startup scan of every product row.
    const indexKey = BootstrapperService.INDEX_KEY;
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(
      BootstrapperService.WARMUP_LOCK_KEY,
      lockToken,
      BootstrapperService.WARMUP_LOCK_TTL_SECONDS,
    );

    if (!acquired) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if ((await this.redis.llen(indexKey)) > 0) {
          return;
        }
      }

      throw new Error('Timed out waiting for Redis product cache warm-up');
    }

    try {
      await this.redis.raw().del(indexKey);

      const rows = await this.productRepo
      .createQueryBuilder('product')
      .select('product."productId"', 'productId')
      .where('product."isFlashSaleActive" = :active', { active: true })
      .orderBy('product."productId"', 'ASC')
      .getRawMany<{ productId: string }>();

      const ids = rows.map((row) => row.productId);

      if (ids.length > 0) {
        await this.redis.rpush(indexKey, ...ids);
        await this.redis.raw().expire(indexKey, 60 * 60);
      }

      this.logger.log(`Warm cache complete: products:id_list has ${ids.length} active product IDs`);
    } finally {
      await this.redis.raw().eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        BootstrapperService.WARMUP_LOCK_KEY,
        lockToken,
      );
    }
  }
}
