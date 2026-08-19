import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { logger } from '@/utils/logger';

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

export const adminLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 320) : 'unknown';
    return `${ipKeyGenerator(req.ip || 'unknown')}:${email}`;
  },
  message: {
    success: false,
    statusCode: 429,
    message: 'Too many admin login attempts',
  },
});

const BET_WINDOW_MS = 1000;
const BET_LIMIT = 12;

const createBetRateLimiter = (game_slug: string) =>
  async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!redisClient.isReady) {
      next();
      return;
    }

    const identity = req.game_user_id || req.ip || 'unknown';
    const bucket = Math.floor(Date.now() / BET_WINDOW_MS);
    const key = `rate:${game_slug}:bet:${identity}:${bucket}`;

    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.pExpire(key, BET_WINDOW_MS * 2);
      }

      res.setHeader('RateLimit-Limit', String(BET_LIMIT));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, BET_LIMIT - count)));

      if (count > BET_LIMIT) {
        res.status(429).json({
          success: false,
          statusCode: 429,
          message: 'Too many bet requests',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    } catch (error) {
      logger.warn('redis_bet_rate_limit_failed', { error, game_slug });
      next();
    }
  };

export const betRateLimiter = createBetRateLimiter('greedy');
export const teenPattiBetRateLimiter = createBetRateLimiter('teen-patti');
