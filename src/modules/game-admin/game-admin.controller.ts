import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import GameAdminService from './game-admin.services';
import type { CancelRoundBody, CreateGreedyConfigBody } from './game-admin.validation';

const actorId = (req: Request) => req.header('x-admin-actor-id')?.trim() || undefined;

const createConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.createConfig(req.body as CreateGreedyConfigBody, actorId(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Greedy config draft created', data });
});
const listConfigs = catchAsync(async (_req: Request, res: Response) => {
  const data = await GameAdminService.listConfigs();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy configs fetched', data });
});
const publishConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.publishConfig(String(req.params.config_id), actorId(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy config published', data });
});
const getRuntime = catchAsync(async (_req: Request, res: Response) => {
  const data = await GameAdminService.getRuntime();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy runtime fetched', data });
});
const resume = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.resume(actorId(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy resumed', data });
});
const pause = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.pause(actorId(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy paused; active round will finish safely', data });
});
const cancelCurrentRound = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.cancelCurrentRound(req.body as CancelRoundBody, actorId(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Current round cancelled; worker will refund accepted bets', data });
});

export default { createConfig, listConfigs, publishConfig, getRuntime, resume, pause, cancelCurrentRound };
