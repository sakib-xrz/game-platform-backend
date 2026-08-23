import winston from 'winston';
import config from '@/config';

const serializeNestedErrors = winston.format((info) => {
  if (info.error instanceof Error) {
    const extra = info.error as Error & {
      code?: unknown;
      meta?: unknown;
      clientVersion?: unknown;
    };
    info.error = {
      name: extra.name,
      message: extra.message,
      stack: extra.stack,
      ...(typeof extra.code === 'string' || typeof extra.code === 'number'
        ? { code: extra.code }
        : {}),
      ...(extra.meta ? { meta: extra.meta } : {}),
      ...(extra.clientVersion ? { clientVersion: extra.clientVersion } : {}),
    };
  }
  return info;
});

export const logger = winston.createLogger({
  level: config.node_env === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    serializeNestedErrors(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});
