import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        replication: {
          master: {
            host: config.get<string>('POSTGRES_PRIMARY_HOST'),
            port: Number(config.get('POSTGRES_PRIMARY_PORT')),
            username: config.get<string>('POSTGRES_USER'),
            password: config.get<string>('POSTGRES_PASSWORD'),
            database: config.get<string>('POSTGRES_DB'),
          },
          slaves: [
            {
              host: config.get<string>('POSTGRES_REPLICA_HOST'),
              port: Number(config.get('POSTGRES_REPLICA_PORT')),
              username: config.get<string>('POSTGRES_USER'),
              password: config.get<string>('POSTGRES_PASSWORD'),
              database: config.get<string>('POSTGRES_DB'),
            },
          ],
        },
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: true,
        migrations: ['dist/database/migrations/*.js'],
        // Logging disabled to keep event loop free at high RPS.
        // Each PG query used to be serialized to Pino — at 6k+ req/s
        // this saturated I/O and was a major contributor to infra failures.
        logging: false,
        logger: 'advanced-console',
        extra: {
          // 6 instances * 80 = 480 < PG max_connections (1000),
          // leaving headroom for replica reads, healthchecks, and admin.
          max: 80,
          min: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}