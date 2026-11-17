import express from 'express';
import playerContext, { optionalPlayerContext } from '@/middlewares/player-context';
import validateRequest from '@/middlewares/validate-request';
import { teenPattiBetRateLimiter } from '@/middlewares/rate-limiter';
import DailyLeaderboardController from '@/modules/leaderboard/daily-leaderboard.controller';
import { dailyLeaderboardQuerySchema } from '@/modules/leaderboard/daily-leaderboard.validation';
import TeenPattiController from './teen-patti.controller';
import {
  teenPattiHistorySchema,
  teenPattiRoundParamSchema,
  placeBetSchema,
} from './teen-patti.validation';

export const TeenPattiRoutes = express.Router();

TeenPattiRoutes.get(
  '/leaderboard',
  optionalPlayerContext,
  validateRequest(dailyLeaderboardQuerySchema),
  DailyLeaderboardController.getDailyLeaderboardHandler('teen-patti'),
);
TeenPattiRoutes.get('/snapshot', playerContext, TeenPattiController.getSnapshot);
TeenPattiRoutes.post(
  '/bets',
  playerContext,
  teenPattiBetRateLimiter,
  validateRequest(placeBetSchema),
  TeenPattiController.placeBet,
);
TeenPattiRoutes.get(
  '/my-bets',
  playerContext,
  validateRequest(teenPattiHistorySchema),
  TeenPattiController.getMyBets,
);
TeenPattiRoutes.get(
  '/rounds',
  validateRequest(teenPattiHistorySchema),
  TeenPattiController.getRoundHistory,
);
TeenPattiRoutes.get(
  '/rounds/:round_id',
  validateRequest(teenPattiRoundParamSchema),
  TeenPattiController.getRound,
);
