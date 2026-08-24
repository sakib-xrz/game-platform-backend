import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import PlatformIntegrationService from './platform-integration.services';
import type {
  AppCredentials,
  CreditPlatformUserCoinsBody,
  SyncPlatformUserBody,
  WithdrawPlatformUserCoinsBody,
} from './platform-integration.validation';

const syncPlatformUser = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformIntegrationService.syncPlatformUser(
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
  const credentials: AppCredentials = {
    app_name: String(req.query.app_name),
    package_name: String(req.query.package_name),
    sha_key: String(req.query.sha_key),
  };
  const data = await PlatformIntegrationService.getPlatformUserCoins(
    credentials,
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
