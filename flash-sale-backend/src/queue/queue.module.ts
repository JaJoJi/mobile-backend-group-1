import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: Number(config.get('REDIS_PORT')),
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'orders',
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}