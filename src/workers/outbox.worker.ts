import { OutboxStatus } from '@/generated/prisma/client';
import config from '@/config';
import prisma from '@/lib/prisma';
import { getSocketServer } from '@/infrastructure/socket/socket';
import { logger } from '@/utils/logger';

let timer: NodeJS.Timeout | null = null;
let running = false;
const worker_id = `outbox-${process.pid}`;

const processBatch = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    await prisma.outboxEvent.updateMany({
      where: {
        status: OutboxStatus.processing,
        locked_at: { lt: new Date(Date.now() - 30_000) },
      },
      data: { status: OutboxStatus.pending, locked_at: null, locked_by: null },
    });

    const events = await prisma.outboxEvent.findMany({
      where: { status: OutboxStatus.pending, available_at: { lte: new Date() } },
      orderBy: { created_at: 'asc' },
      take: 100,
    });

    for (const event of events) {
      const claimed = await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: OutboxStatus.pending },
        data: { status: OutboxStatus.processing, locked_at: new Date(), locked_by: worker_id, attempt_count: { increment: 1 } },
      });
      if (!claimed.count) continue;

      try {
        const io = getSocketServer();
        if (event.socket_room) io.to(event.socket_room).emit(event.event_type, { event_id: event.id, ...(event.payload as object) });
        else io.emit(event.event_type, { event_id: event.id, ...(event.payload as object) });

        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: OutboxStatus.published, published_at: new Date(), locked_at: null, locked_by: null, last_error: null },
        });
      } catch (error) {
        const delay_ms = Math.min(30000, 500 * 2 ** Math.min(event.attempt_count, 6));
        const terminal = event.attempt_count + 1 >= 12;
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: terminal ? OutboxStatus.failed : OutboxStatus.pending,
            available_at: new Date(Date.now() + delay_ms),
            locked_at: null,
            locked_by: null,
            last_error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          },
        });
      }
    }
  } catch (error) {
    logger.error('outbox_worker_failed', { error });
  } finally {
    running = false;
  }
};

export const startOutboxWorker = (): void => {
  timer = setInterval(() => void processBatch(), config.outbox_poll_ms);
  void processBatch();
};

export const stopOutboxWorker = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
