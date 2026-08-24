import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import PlatformUserService from './platform-user.services';
import type {
  AdminPlatformUserLedgerQuery,
  AdminPlatformUserSearchQuery,
} from './platform-user.validation';

const listAdminPlatformUsers = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as AdminPlatformUserSearchQuery;
  const result = await PlatformUserService.listAdminPlatformUsers(query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform users fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const getAdminPlatformUser = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformUserService.getAdminPlatformUser(String(req.params.user_id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform user fetched',
    data,
  });
});

const listAdminPlatformUserLedger = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as AdminPlatformUserLedgerQuery;
  const result = await PlatformUserService.listAdminPlatformUserLedger(String(req.params.user_id), query);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform user ledger fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const listPlatformAppsForFilter = catchAsync(async (_req: Request, res: Response) => {
  const data = await PlatformUserService.listPlatformAppsForFilter();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform apps fetched for filter',
    data,
  });
});

const PlatformUserController = {
  listAdminPlatformUsers,
  getAdminPlatformUser,
  listAdminPlatformUserLedger,
  listPlatformAppsForFilter,
};

export default PlatformUserController;
