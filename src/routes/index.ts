import express from 'express';
import { GreedyRoutes } from '@/modules/greedy/greedy.routes';
import { TeenPattiRoutes } from '@/modules/teen-patti/teen-patti.routes';
import { WalletRoutes, WalletAdminRoutes } from '@/modules/wallet/wallet.routes';
import { GameAdminRoutes } from '@/modules/game-admin/game-admin.routes';
import AdminRoutes from '@/modules/admin/admin.routes';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import sendResponse from '@/utils/send-response';

const router = express.Router();

router.get('/health/live', (_req, res) => {
  sendResponse(res, { statusCode: 200, success: true, message: 'Service is alive', data: { process_uptime_seconds: Math.floor(process.uptime()) } });
});

router.get('/health/ready', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redis_ok = redisClient.isReady;
    sendResponse(res, {
      statusCode: redis_ok ? 200 : 503,
      success: redis_ok,
      message: redis_ok ? 'Service is ready' : 'Redis is not ready',
      data: { database: 'ready', redis: redis_ok ? 'ready' : 'not_ready' },
    });
  } catch (error) {
    next(error);
  }
});

router.use('/games/greedy', GreedyRoutes);
router.use('/games/teen-patti', TeenPattiRoutes);
router.use('/wallets', WalletRoutes);
router.use('/admin/wallets', WalletAdminRoutes);
router.use('/admin/games', GameAdminRoutes);
router.use('/admin', AdminRoutes);

export default router;
