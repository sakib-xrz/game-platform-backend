import http from 'http';
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
import {
  recoverTeenPattiRuntime,
  runTeenPattiTick,
} from '@/workers/teen-patti-round.worker';
import { logger } from '@/utils/logger';

const GREEDY_LEASE_KEY = 'game-worker:greedy';
const TEEN_PATTI_LEASE_KEY = 'game-worker:teen-patti';
const LEASE_REFRESH_MS = 2000;
let stopping = false;
let greedy_leader = false;
let teen_patti_leader = false;
let lease_refresh_timer: NodeJS.Timeout | null = null;
let lease_refresh_task: Promise<void> | null = null;
let health_server: http.Server | undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const startHealthServer = (port: number): Promise<http.Server> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url?.split('?')[0] === '/api/v1/health/live') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, role: 'worker' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', reject);
    server.listen(port, () => {
      logger.info('worker_health_server_started', { port });
      resolve(server);
    });
  });

const refreshLeadership = (): Promise<void> => {
  if (lease_refresh_task) return lease_refresh_task;

  const task = (async () => {
    try {
      [greedy_leader, teen_patti_leader] = await Promise.all([
        acquireOrRenewLease(GREEDY_LEASE_KEY, config.worker_instance_id),
        acquireOrRenewLease(TEEN_PATTI_LEASE_KEY, config.worker_instance_id),
      ]);
    } catch (error) {
      greedy_leader = false;
      teen_patti_leader = false;
      logger.error('game_worker_lease_refresh_failed', { error });
    }
  })();

  lease_refresh_task = task;
  void task.finally(() => {
    if (lease_refresh_task === task) lease_refresh_task = null;
  });
  return task;
};

const main = async (): Promise<void> => {
  await prisma.$connect();
  await connectRedis();
  await recoverGreedyRuntime();
  await recoverTeenPattiRuntime();
  health_server = await startHealthServer(config.worker_health_port);
  logger.info('game_worker_started', {
    instance_id: config.worker_instance_id,
  });
  await refreshLeadership();
  lease_refresh_timer = setInterval(
    () => void refreshLeadership(),
    LEASE_REFRESH_MS,
  );

  while (!stopping) {
    try {
      // The games have independent runtimes and tables. Advancing them in
      // parallel prevents a slow transition or settlement in one game from
      // stretching every phase deadline in the other game.
      const [greedy_tick, teen_patti_tick] = await Promise.allSettled([
        greedy_leader ? runGreedyTick() : Promise.resolve(),
        teen_patti_leader ? runTeenPattiTick() : Promise.resolve(),
      ]);

      // Wait for both ticks to finish before the next loop so a fast failure
      // cannot leave the other game running in the background. Demote only the
      // failed game's leadership; an unrelated game keeps progressing.
      if (greedy_tick.status === 'rejected') {
        greedy_leader = false;
        logger.error('game_worker_tick_failed', {
          game_code: 'GREEDY',
          error: greedy_tick.reason,
        });
      }
      if (teen_patti_tick.status === 'rejected') {
        teen_patti_leader = false;
        logger.error('game_worker_tick_failed', {
          game_code: 'TEEN_PATTI',
          error: teen_patti_tick.reason,
        });
      }
    } catch (error) {
      logger.error('game_worker_loop_failed', { error });
      greedy_leader = false;
      teen_patti_leader = false;
    }

    if (!stopping) await sleep(config.greedy_worker_poll_ms);
  }
};

const cleanup = async (): Promise<void> => {
  if (lease_refresh_timer) clearInterval(lease_refresh_timer);
  lease_refresh_timer = null;
  if (lease_refresh_task) await lease_refresh_task;

  try {
    if (greedy_leader) {
      await releaseLease(GREEDY_LEASE_KEY, config.worker_instance_id);
    }
    if (teen_patti_leader) {
      await releaseLease(TEEN_PATTI_LEASE_KEY, config.worker_instance_id);
    }
  } catch (error) {
    logger.warn('game_worker_lease_release_failed', { error });
  }

  await disconnectRedis();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => {
    if (!health_server) {
      resolve();
      return;
    }
    health_server.close(() => resolve());
  });
};

const requestShutdown = (signal: string): void => {
  if (stopping) return;
  logger.info('game_worker_shutdown_requested', { signal });
  stopping = true;
};

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

main()
  .then(cleanup)
  .catch(async (error) => {
    logger.error('game_worker_start_failed', { error });
    stopping = true;
    await cleanup();
    process.exit(1);
  });
