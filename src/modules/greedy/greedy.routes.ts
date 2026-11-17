import express from 'express';
import playerContext, { optionalPlayerContext } from '@/middlewares/player-context';
import validateRequest from '@/middlewares/validate-request';
import { betRateLimiter } from '@/middlewares/rate-limiter';
import DailyLeaderboardController from '@/modules/leaderboard/daily-leaderboard.controller';
import { dailyLeaderboardQuerySchema } from '@/modules/leaderboard/daily-leaderboard.validation';
import GreedyController from './greedy.controller';
import {
  greedyHistorySchema,
  greedyRoundParamSchema,
  placeBetSchema,
} from './greedy.validation';

export const GreedyRoutes = express.Router();

GreedyRoutes.get(
  '/leaderboard',
  optionalPlayerContext,
  validateRequest(dailyLeaderboardQuerySchema),
  DailyLeaderboardController.getDailyLeaderboardHandler('greedy'),
);
GreedyRoutes.get('/snapshot', playerContext, GreedyController.getSnapshot);
GreedyRoutes.post(
  '/bets',
  playerContext,
  betRateLimiter,
  validateRequest(placeBetSchema),
  GreedyController.placeBet,
);
GreedyRoutes.get(
  '/my-bets',
  playerContext,
  validateRequest(greedyHistorySchema),
  GreedyController.getMyBets,
);
GreedyRoutes.get(
  '/rounds',
  validateRequest(greedyHistorySchema),
  GreedyController.getRoundHistory,
);
GreedyRoutes.get(
  '/rounds/:round_id',
  validateRequest(greedyRoundParamSchema),
  GreedyController.getRound,
);
