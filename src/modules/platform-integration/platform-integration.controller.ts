import { Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import PlatformIntegrationService from './platform-integration.services';
import type {
  CreditPlatformUserCoinsBody,
  SyncPlatformUserBody,
  WithdrawPlatformUserCoinsBody,
} from './platform-integration.validation';

const requirePlatformApp = (req: Request) => {
  if (!req.platform_app) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Platform app authentication is required');
  }
  return req.platform_app;
};

const syncPlatformUser = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformIntegrationService.syncPlatformUser(
    requirePlatformApp(req),
    req.body as SyncPlatformUserBody,
    req.request_id,
  );
  sendResponse(res, {
    statusCode: data.created ? httpStatus.CREATED : httpStatus.OK,
    success: true,
    message: data.created ? 'Platform user created' : 'Platform user updated',
    data,
  });
});

const creditPlatformUserCoins = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformIntegrationService.creditPlatformUserCoins(
    requirePlatformApp(req),
    req.body as CreditPlatformUserCoinsBody,
    req.request_id,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: data.idempotent ? 'Coin credit already applied' : 'Coins credited',
    data,
  });
});

const getPlatformUserCoins = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformIntegrationService.getPlatformUserCoins(
    requirePlatformApp(req),
    String(req.params.external_user_id),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform user balance fetched',
    data,
  });
});

const withdrawPlatformUserCoins = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformIntegrationService.withdrawPlatformUserCoins(
    requirePlatformApp(req),
    req.body as WithdrawPlatformUserCoinsBody,
    req.request_id,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: data.idempotent
      ? 'Coin withdrawal already processed'
      : 'Coins transferred to app successfully',
    data,
  });
});

const PlatformIntegrationController = {
  syncPlatformUser,
  creditPlatformUserCoins,
  withdrawPlatformUserCoins,
  getPlatformUserCoins,
};

export default PlatformIntegrationController;
