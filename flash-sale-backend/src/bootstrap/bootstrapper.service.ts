import { Injectable, Logger as NestLogger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../cache/redis.service';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class BootstrapperService implements OnApplicationBootstrap {
  private readonly logger = new NestLogger(BootstrapperService.name);

  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    // We intentionally warm only the index cache. Static detail and stock fragments are left cold
    // and loaded lazily on demand, so the cache is cheap to initialize and resilient to traffic spikes.
    const indexKey = 'products:id_list';
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
    }

    this.logger.log(`Warm cache complete: products:id_list has ${ids.length} active product IDs`);
  }
}
