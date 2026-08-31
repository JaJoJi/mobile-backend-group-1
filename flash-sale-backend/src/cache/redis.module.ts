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
          // NOTE: enableAutoPipelining was tried but REVERTED. Under our
          // heavy Lua-script usage (FAST_FAIL_LUA on every POST /orders),
          // auto-pipelining caused command-ordering issues that surfaced as
          // ~88% infra failures (Nginx 504s after 10s) despite p95 dropping
          // to ~675ms. Single-command-per-RTT is safer for this workload.
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}