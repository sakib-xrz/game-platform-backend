import dotenv from 'dotenv';

dotenv.config();

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  port: Number(process.env.PORT) || 8000,
  node_env: process.env.NODE_ENV || 'development',
  nodeEnv: process.env.NODE_ENV || 'development',
  database_url: process.env.DATABASE_URL || '',
  redis_url: process.env.REDIS_URL || 'redis://localhost:6379',
  // Comma-separated. Set CORS_ORIGIN in prod to include https://game.maxlived.net
  cors_origin:
    process.env.CORS_ORIGIN || 'http://localhost:3000,https://game.maxlived.net',
  /** Public game WebView origin, e.g. https://game.maxlived.net */
  game_frontend_url: (
    process.env.GAME_FRONTEND_URL ||
    (process.env.CORS_ORIGIN || 'https://game.maxlived.net')
      .split(',')[0]
      ?.trim() ||
    'https://game.maxlived.net'
  ).replace(/\/$/, ''),
  admin_api_key: process.env.ADMIN_API_KEY || '',
  allow_dev_identity_header:
    (process.env.ALLOW_DEV_IDENTITY_HEADER || 'false').toLowerCase() === 'true',
  worker_instance_id:
    process.env.WORKER_INSTANCE_ID || `greedy-worker-${process.pid}`,
  worker_health_port: parsePositiveInt(
    process.env.WORKER_HEALTH_PORT,
    process.env.NODE_ENV === 'production'
      ? Number(process.env.PORT) || 8000
      : 8001,
  ),
  greedy_worker_poll_ms: parsePositiveInt(
    process.env.GREEDY_WORKER_POLL_MS,
    200,
  ),
  outbox_poll_ms: parsePositiveInt(process.env.OUTBOX_POLL_MS, 150),
  ops_alert_webhook_url:
    process.env.OPS_ALERT_WEBHOOK_URL || process.env.ADMIN_WEBHOOK_URL || '',
  ops_alert_webhook_secret:
    process.env.OPS_ALERT_WEBHOOK_SECRET ||
    process.env.ADMIN_WEBHOOK_SECRET ||
    '',
  ops_alert_webhook_timeout_ms: parsePositiveInt(
    process.env.OPS_ALERT_WEBHOOK_TIMEOUT_MS ||
      process.env.ADMIN_WEBHOOK_TIMEOUT_MS,
    5000,
  ),
  ops_alert_webhook_max_attempts: parsePositiveInt(
    process.env.OPS_ALERT_WEBHOOK_MAX_ATTEMPTS,
    4,
  ),
  cloudflareR2: {
    account_id: process.env.CLOUDFLARE_R2_ACCOUNT_ID || '',
    access_key_id: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
    secret_access_key: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
    bucket_name: process.env.CLOUDFLARE_R2_BUCKET_NAME || '',
    public_url: process.env.CLOUDFLARE_R2_PUBLIC_URL || '',
  },
};

export default config;
