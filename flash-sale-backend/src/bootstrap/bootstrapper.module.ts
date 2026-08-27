import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { RedisModule } from '../cache/redis.module';
import { BootstrapperService } from './bootstrapper.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product]), RedisModule],
  providers: [BootstrapperService],
})
export class BootstrapperModule {}
