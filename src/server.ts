import http from 'http';
import app from '@/app';
import config from '@/config';
import prisma from '@/lib/prisma';
import { connectRedis, disconnectRedis } from '@/infrastructure/redis/redis.client';
import { initializeSocket } from '@/infrastructure/socket/socket';
import { startOutboxWorker, stopOutboxWorker } from '@/workers/outbox.worker';
import { logger } from '@/utils/logger';

let shutting_down = false;

const start = async (): Promise<void> => {
  await prisma.$connect();
  await connectRedis();

  const http_server = http.createServer(app);
  const io = initializeSocket(http_server);
  startOutboxWorker();

  http_server.listen(config.port, () => {
    logger.info('api_server_started', { port: config.port, env: config.node_env });
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shutting_down) return;
    shutting_down = true;
    logger.info('api_server_shutting_down', { signal });
    stopOutboxWorker();
    io.disconnectSockets(true);
    http_server.close(async () => {
      await disconnectRedis();
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', { error });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('unhandled_rejection', { error });
});

start().catch(async (error) => {
  logger.error('api_server_start_failed', { error });
  await prisma.$disconnect();
  process.exit(1);
});
