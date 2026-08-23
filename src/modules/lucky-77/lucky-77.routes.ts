import express from 'express';
import playerContext from '@/middlewares/player-context';
import validateRequest from '@/middlewares/validate-request';
import { lucky77BetRateLimiter } from '@/middlewares/rate-limiter';
import Lucky77Controller from './lucky-77.controller';
import {
  lucky77HistorySchema,
  lucky77RoundParamSchema,
  placeBetSchema,
} from './lucky-77.validation';

export const Lucky77Routes = express.Router();

Lucky77Routes.get('/snapshot', playerContext, Lucky77Controller.getSnapshot);
Lucky77Routes.post(
  '/bets',
  playerContext,
  lucky77BetRateLimiter,
  validateRequest(placeBetSchema),
  Lucky77Controller.placeBet,
);
Lucky77Routes.get(
  '/my-bets',
  playerContext,
  validateRequest(lucky77HistorySchema),
  Lucky77Controller.getMyBets,
);
Lucky77Routes.get(
  '/rounds',
  validateRequest(lucky77HistorySchema),
  Lucky77Controller.getRoundHistory,
);
Lucky77Routes.get(
  '/rounds/:round_id',
  validateRequest(lucky77RoundParamSchema),
  Lucky77Controller.getRound,
);
