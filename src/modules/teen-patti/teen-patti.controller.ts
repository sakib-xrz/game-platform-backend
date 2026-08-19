import { Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import TeenPattiService from './teen-patti.services';
import type { PlaceBetBody } from './teen-patti.validation';

const requireUserId = (req: Request): string => {
  if (!req.game_user_id) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Player identity missing');
  }
  return req.game_user_id;
};

const getSnapshot = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiService.getSnapshot(requireUserId(req));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Teen Patti snapshot fetched',
    data,
  });
});

const placeBet = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiService.placeBet(
    requireUserId(req),
    req.body as PlaceBetBody,
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Bet accepted',
    data,
  });
});

const getMyBets = catchAsync(async (req: Request, res: Response) => {
  const result = await TeenPattiService.getMyBets(
    requireUserId(req),
    Number(req.query.page || 1),
    Number(req.query.limit || 20),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Bet history fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const getRoundHistory = catchAsync(async (req: Request, res: Response) => {
  const result = await TeenPattiService.getRoundHistory(
    Number(req.query.page || 1),
    Number(req.query.limit || 20),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Round history fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const getRound = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiService.getRound(String(req.params.round_id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Round fetched',
    data,
  });
});

export default { getSnapshot, placeBet, getMyBets, getRoundHistory, getRound };
