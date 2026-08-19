import { Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import WalletService from './wallet.services';
import type { AdminAdjustWalletBody } from './wallet.validation';
import { requestAuditContext } from '@/modules/admin/admin.request';

const getMyWallet = catchAsync(async (req: Request, res: Response) => {
  if (!req.game_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Player identity missing');
  const data = await WalletService.getMyWallet(req.game_user_id);
  sendResponse(res, { statusCode: 200, success: true, message: 'Wallet fetched', data });
});

const getTransactions = catchAsync(async (req: Request, res: Response) => {
  if (!req.game_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Player identity missing');
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const result = await WalletService.getTransactions(req.game_user_id, page, limit);
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Wallet transactions fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const adminAdjustWallet = catchAsync(async (req: Request, res: Response) => {
  const data = await WalletService.adminAdjustWallet(req.body as AdminAdjustWalletBody, requestAuditContext(req));
  sendResponse(res, { statusCode: data.status === 'pending_approval' ? 202 : 200, success: true, message: data.status === 'pending_approval' ? 'Wallet adjustment is pending approval' : 'Wallet adjusted', data });
});

export default { getMyWallet, getTransactions, adminAdjustWallet };
