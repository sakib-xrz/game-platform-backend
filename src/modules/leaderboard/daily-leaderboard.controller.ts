import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import DailyLeaderboardService from './daily-leaderboard.service';
import type { LeaderboardPeriod } from './daily-leaderboard.helpers';

export const getDailyLeaderboardHandler = (defaultGameCode?: string) =>
  catchAsync(async (req: Request, res: Response) => {
    const gameCode = defaultGameCode || (req.params.gameCode as string);
    const period = ((req.query.period as LeaderboardPeriod | undefined) ??
      'today') as LeaderboardPeriod;
    const currentUserId = req.game_user_id || undefined;

    const data = await DailyLeaderboardService.getDailyLeaderboard(
      gameCode,
      period,
      currentUserId,
    );

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: `${gameCode} daily leaderboard fetched`,
      data,
    });
  });

export const DailyLeaderboardController = {
  getDailyLeaderboardHandler,
};

export default DailyLeaderboardController;
