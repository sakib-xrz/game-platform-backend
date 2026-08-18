import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { logger } from '@/utils/logger';

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const BET_WINDOW_MS = 1000;
const BET_LIMIT = 12;

/**
 * Distributed per-player betting limiter. Redis is used when available so the
 * same limit applies across horizontally-scaled API instances.
 *
 * If Redis is temporarily unavailable, the request is allowed to continue;
 * database/game rules remain authoritative. Infrastructure-level/WAF limits
 * should still be configured in production.
 */
export const betRateLimiter = async (
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
  const key = `rate:greedy:bet:${identity}:${bucket}`;

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
    logger.warn('redis_bet_rate_limit_failed', { error });
    next();
  }
};
