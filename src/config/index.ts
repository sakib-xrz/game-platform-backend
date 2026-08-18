import dotenv from 'dotenv';

dotenv.config();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  port: Number(process.env.PORT) || 8000,
  node_env: process.env.NODE_ENV || 'development',
  database_url: process.env.DATABASE_URL || '',
  redis_url: process.env.REDIS_URL || 'redis://localhost:6379',
  cors_origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  admin_api_key: process.env.ADMIN_API_KEY || '',
  allow_dev_identity_header:
    (process.env.ALLOW_DEV_IDENTITY_HEADER || 'false').toLowerCase() === 'true',
  worker_instance_id:
    process.env.WORKER_INSTANCE_ID || `greedy-worker-${process.pid}`,
  greedy_worker_poll_ms: parsePositiveInt(
    process.env.GREEDY_WORKER_POLL_MS,
    200,
  ),
  outbox_poll_ms: parsePositiveInt(process.env.OUTBOX_POLL_MS, 150),
};

export default config;
