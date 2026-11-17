import express from 'express';
import playerContext, { optionalPlayerContext } from '@/middlewares/player-context';
import validateRequest from '@/middlewares/validate-request';
import { greedyClassicBetRateLimiter } from '@/middlewares/rate-limiter';
import DailyLeaderboardController from '@/modules/leaderboard/daily-leaderboard.controller';
import { dailyLeaderboardQuerySchema } from '@/modules/leaderboard/daily-leaderboard.validation';
import GreedyClassicController from './greedy-classic.controller';
import {
  greedyHistorySchema,
  greedyClassicRoundParamSchema,
  placeBetSchema,
} from './greedy-classic.validation';

export const GreedyClassicRoutes = express.Router();

GreedyClassicRoutes.get(
  '/leaderboard',
  optionalPlayerContext,
  validateRequest(dailyLeaderboardQuerySchema),
  DailyLeaderboardController.getDailyLeaderboardHandler('greedy-classic'),
);
GreedyClassicRoutes.get('/snapshot', playerContext, GreedyClassicController.getSnapshot);
GreedyClassicRoutes.post(
  '/bets',
  playerContext,
  greedyClassicBetRateLimiter,
  validateRequest(placeBetSchema),
  GreedyClassicController.placeBet,
);
GreedyClassicRoutes.get(
  '/my-bets',
  playerContext,
  validateRequest(greedyHistorySchema),
  GreedyClassicController.getMyBets,
);
GreedyClassicRoutes.get(
  '/rounds',
  validateRequest(greedyHistorySchema),
  GreedyClassicController.getRoundHistory,
);
GreedyClassicRoutes.get(
  '/rounds/:round_id',
  validateRequest(greedyClassicRoundParamSchema),
  GreedyClassicController.getRound,
);
