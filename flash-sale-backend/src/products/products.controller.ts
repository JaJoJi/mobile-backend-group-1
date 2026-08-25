import { Controller, Get, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';
import { QueryProductsDto } from './dto/query-products.dto';
import { ProductsService } from './products.service';

@Controller('api/v1/products')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ProductsController {
  constructor(
    private readonly service: ProductsService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  findAll(@Query() query: QueryProductsDto) {
    return this.service.findAll(query.page, query.limit);
  }

  @Get('admin/cache-stats')
  async cacheStats() {
    return this.redis.getCacheStats();
  }
}