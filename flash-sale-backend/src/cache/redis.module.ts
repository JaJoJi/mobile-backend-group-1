import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: Number(config.get('REDIS_PORT')),
          maxRetriesPerRequest: null,
          // Auto-pipelining: ioredis batches commands issued in the same
          // event-loop tick into a single TCP write. With 1000+ concurrent
          // reads, this turns N round-trips into ~1, cutting Redis latency
          // dramatically under flash-sale load.
          enableAutoPipelining: true,
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}