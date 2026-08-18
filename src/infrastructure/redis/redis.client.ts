import { createClient } from 'redis';
import config from '@/config';
import { logger } from '@/utils/logger';

export const redisClient = createClient({ url: config.redis_url });

redisClient.on('error', (error) => logger.error('redis_error', { error }));
redisClient.on('reconnecting', () => logger.warn('redis_reconnecting'));

export const connectRedis = async (): Promise<void> => {
  if (!redisClient.isOpen) await redisClient.connect();
};

export const disconnectRedis = async (): Promise<void> => {
  if (redisClient.isOpen) await redisClient.quit();
};
