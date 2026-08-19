import config from '@/config';
import prisma from '@/lib/prisma';
import {
  connectRedis,
  disconnectRedis,
} from '@/infrastructure/redis/redis.client';
import { acquireOrRenewLease, releaseLease } from '@/workers/worker-lease';
import {
  recoverGreedyRuntime,
  runGreedyTick,
} from '@/workers/greedy-round.worker';
import { logger } from '@/utils/logger';

const LEASE_KEY = 'game-worker:greedy';
let stopping = false;
let leader = false;
let last_lease_refresh = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  await prisma.$connect();
  await connectRedis();
  await recoverGreedyRuntime();

  while (!stopping) {
    try {
      if (!leader || Date.now() - last_lease_refresh >= 2000) {
        leader = await acquireOrRenewLease(
          LEASE_KEY,
          config.worker_instance_id,
        );
        last_lease_refresh = Date.now();
      }

      if (leader) {
        // A shutdown signal only flips `stopping`. The current authoritative
        // tick is allowed to finish before the lease and connections are
        // released, which avoids overlapping leaders during deployments.
        await runGreedyTick();
      }
    } catch (error) {
      logger.error('greedy_worker_tick_failed', { error });
      leader = false;
    }

    if (!stopping) await sleep(config.greedy_worker_poll_ms);
  }
};

const cleanup = async (): Promise<void> => {
  try {
    if (leader) {
      await releaseLease(LEASE_KEY, config.worker_instance_id);
    }
  } catch (error) {
    logger.warn('greedy_worker_lease_release_failed', { error });
  }

  await disconnectRedis();
  await prisma.$disconnect();
};

const requestShutdown = (signal: string): void => {
  if (stopping) return;
  logger.info('greedy_worker_shutdown_requested', { signal });
  stopping = true;
};

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

main()
  .then(cleanup)
  .catch(async (error) => {
    logger.error('greedy_worker_start_failed', { error });
    stopping = true;
    await cleanup();
    process.exit(1);
  });
