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
        logging: ['error'],
        extra: {
          max: 300,
          min: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}