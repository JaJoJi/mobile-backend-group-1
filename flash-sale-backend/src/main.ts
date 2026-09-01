import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express from 'express';
import { AppModule } from './app.module';

// ROLE controls whether this instance runs the full stack (API + worker +
// Bull-Board) or only the BullMQ worker.
//
//   ROLE=api     (default) — full stack: HTTP server on $PORT, Bull-Board on
//                          $ADMIN_PORT, BullMQ worker(s) register with the
//                          'orders' queue.
//   ROLE=worker            — worker-only: skip the HTTP server and Bull-Board.
//                          The Nest app is initialised so BullMQ worker(s)
//                          start consuming, but no socket is opened on
//                          $PORT. This lets us run dedicated worker-only
//                          instances that don't compete with the API tier
//                          for CPU on the Node.js event loop.
const ROLE = process.env.ROLE || 'api';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const instanceId = config.get<string>('INSTANCE_ID') ?? 'unknown';

  if (ROLE === 'worker') {
    // Worker-only mode: initialise the Nest app so BullMQ workers attach,
    // then wait for SIGTERM. No HTTP listener, no Bull-Board.
    await app.init();
    app.enableShutdownHooks();
    console.log(`Worker mode: instance=${instanceId}, BullMQ workers active`);
    return;
  }

  // Default: API mode (full stack)
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
    `App running on http://localhost:${port} (instance=${instanceId})`,
  );
}
bootstrap();