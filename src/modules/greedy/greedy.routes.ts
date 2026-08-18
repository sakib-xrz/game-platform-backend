import express from 'express';
import playerContext from '@/middlewares/player-context';
import validateRequest from '@/middlewares/validate-request';
import { betRateLimiter } from '@/middlewares/rate-limiter';
import GreedyController from './greedy.controller';
import {
  greedyHistorySchema,
  greedyRoundParamSchema,
  placeBetSchema,
} from './greedy.validation';

export const GreedyRoutes = express.Router();

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
