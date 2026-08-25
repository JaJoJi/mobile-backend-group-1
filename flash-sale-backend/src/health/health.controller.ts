import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RedisService } from '../cache/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  /** Legacy alias for liveness — kept for backward compat */
  @Get()
  check() {
    return {
      status: 'ok',
      instanceId: this.config.get<string>('INSTANCE_ID') ?? 'unknown',
    };
  }

  /** Liveness — "is the process alive?" Used by Docker healthcheck / k8s livenessProbe. */
  @Get('live')
  liveness() {
    return {
      status: 'ok',
      instanceId: this.config.get<string>('INSTANCE_ID') ?? 'unknown',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness — "can it serve traffic?" Checks DB + Redis. Used by k8s readinessProbe / LB. */
  @Get('ready')
  async readiness() {
    const checks = await Promise.allSettled([
      this.dataSource.query('SELECT 1'),
      this.redis.raw().ping(),
    ]);
    const dbOk = checks[0].status === 'fulfilled';
    const redisOk = checks[1].status === 'fulfilled';
    const dbError =
      checks[0].status === 'rejected'
        ? (checks[0] as PromiseRejectedResult).reason?.message
        : undefined;
    const redisError =
      checks[1].status === 'rejected'
        ? (checks[1] as PromiseRejectedResult).reason?.message
        : undefined;

    const ok = dbOk && redisOk;

    if (!ok) {
      throw new ServiceUnavailableException({
        status: 'fail',
        instanceId: this.config.get<string>('INSTANCE_ID') ?? 'unknown',
        checks: { db: dbOk, redis: redisOk },
        errors: { db: dbError, redis: redisError },
      });
    }

    return {
      status: 'ok',
      instanceId: this.config.get<string>('INSTANCE_ID') ?? 'unknown',
      checks: { db: dbOk, redis: redisOk },
      timestamp: new Date().toISOString(),
    };
  }
}