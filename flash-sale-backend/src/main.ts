import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  const server = await app.listen(port);
  if (server && typeof server.setTimeout === 'function') {
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  }

  const adminPort = config.get<number>('ADMIN_PORT') ?? 3001;
  const adminApp = express();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  const ordersQueue = new Queue('orders', {
    connection: {
      host: config.get<string>('REDIS_HOST'),
      port: Number(config.get('REDIS_PORT')),
    },
  });

  createBullBoard({
    queues: [new BullMQAdapter(ordersQueue)],
    serverAdapter,
  });

  adminApp.use('/admin/queues', serverAdapter.getRouter());
  adminApp.listen(adminPort, () => {
    console.log(`Bull-Board running on http://localhost:${adminPort}/admin/queues`);
  });

  console.log(
    `App running on http://localhost:${port} (instance=${config.get('INSTANCE_ID')})`,
  );
}
bootstrap();