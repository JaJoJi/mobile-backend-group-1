import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './cache/redis.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get<string>('NODE_ENV') !== 'production';
        return {
          pinoHttp: {
            level: config.get<string>('LOG_LEVEL') ?? 'info',
            genReqId: (req) =>
              (req.headers['x-trace-id'] as string) ||
              (req.headers['x-request-id'] as string) ||
              randomUUID(),
            transport: isDev
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,context',
                  },
                }
              : undefined,
            customLogLevel: (req, res, err) => {
              if (err || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },
            serializers: {
              req: (req) => ({ method: req.method, url: req.url, traceId: req.id }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
        };
      },
    }),

    RedisModule,
    DatabaseModule,
    QueueModule,
    AuthModule,
    HealthModule,
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}