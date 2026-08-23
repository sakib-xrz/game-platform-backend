import { PrismaPg } from '@prisma/adapter-pg';
import config from '@/config';
import { PrismaClient } from '@/generated/prisma/client';
import { logger } from '@/utils/logger';

if (!config.database_url) {
  throw new Error('DATABASE_URL is required');
}

const global_for_prisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const TRANSIENT_DATABASE_TOKENS = [
  'eaddrnotavail',
  'econnreset',
  'econnrefused',
  'etimedout',
  'epipe',
  'enotfound',
  'connection terminated',
  'connection ended unexpectedly',
  'client has encountered a connection error',
  'server closed the connection',
  'cannot use a pool after calling end',
  'p1001',
  'p1002',
  'p1017',
  'p2024',
];

export const serializeUnknownError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { value: String(error) };
  const extra = error as Error & { code?: unknown; meta?: unknown; clientVersion?: unknown };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(typeof extra.code === 'string' || typeof extra.code === 'number' ? { code: extra.code } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
    ...(extra.clientVersion ? { clientVersion: extra.clientVersion } : {}),
    ...(extra.cause ? { cause: serializeUnknownError(extra.cause) } : {}),
  };
};

export const isTransientDatabaseError = (error: unknown): boolean => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      const extra = current as Error & { code?: unknown; cause?: unknown };
      parts.push(current.name, current.message, current.stack ?? '');
      if (typeof extra.code === 'string' || typeof extra.code === 'number') parts.push(String(extra.code));
      current = extra.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  const details = parts.join('\n').toLowerCase();
  return TRANSIENT_DATABASE_TOKENS.some((token) => details.includes(token));
};

const create_prisma_client = (): PrismaClient => {
  const adapter = new PrismaPg(
    {
      connectionString: config.database_url,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 8_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    },
    {
      onPoolError: (error) =>
        logger.warn('postgres_pool_error', { error: serializeUnknownError(error) }),
      onConnectionError: (error) =>
        logger.warn('postgres_connection_error', { error: serializeUnknownError(error) }),
    },
  );
  return new PrismaClient({ adapter });
};

const prisma = global_for_prisma.prisma ?? create_prisma_client();

if (config.node_env !== 'production') {
  global_for_prisma.prisma = prisma;
}

export default prisma;
