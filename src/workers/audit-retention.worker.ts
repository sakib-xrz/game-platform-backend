import prisma from '@/lib/prisma';
import { logger } from '@/utils/logger';

const RETENTION_DAYS = 365;
const BATCH_SIZE = 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export const purgeExpiredAuditLogs = async (): Promise<number> => {
  if (running) return 0;
  running = true;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.audit_retention_purge = 'on'`;
      return Number(await tx.$executeRaw`
        WITH expired AS (
          SELECT id FROM audit_logs
          WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '365 days'
          ORDER BY created_at ASC
          LIMIT ${BATCH_SIZE}
        )
        DELETE FROM audit_logs logs
        USING expired
        WHERE logs.id = expired.id
      `);
    });
  } finally {
    running = false;
  }
};

export const startAuditRetentionWorker = (): void => {
  if (timer) return;
  const poll_ms = 6 * 60 * 60 * 1000;
  timer = setInterval(() => {
    void purgeExpiredAuditLogs().catch((error) => logger.error('audit_retention_purge_failed', { error }));
  }, poll_ms);
};

export const stopAuditRetentionWorker = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
