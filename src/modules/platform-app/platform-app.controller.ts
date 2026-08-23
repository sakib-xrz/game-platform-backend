import { Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import { requestAuditContext } from '@/modules/admin/admin.request';
import PlatformAppService from './platform-app.services';
import type { CreatePlatformAppBody, UpdatePlatformAppBody } from './platform-app.validation';

const requireAdmin = (req: Request) => {
  if (!req.admin) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin authentication is required');
  return req.admin;
};

const listPlatformApps = catchAsync(async (_req: Request, res: Response) => {
  const data = await PlatformAppService.listPlatformApps();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform apps fetched',
    data,
  });
});

const getPlatformApp = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformAppService.getPlatformApp(String(req.params.app_id));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform app fetched',
    data,
  });
});

const createPlatformApp = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformAppService.createPlatformApp(
    requireAdmin(req),
    req.body as CreatePlatformAppBody,
    requestAuditContext(req),
  );
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Platform app created',
    data,
  });
});

const updatePlatformApp = catchAsync(async (req: Request, res: Response) => {
  const data = await PlatformAppService.updatePlatformApp(
    String(req.params.app_id),
    req.body as UpdatePlatformAppBody,
    requestAuditContext(req),
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform app updated',
    data,
  });
});

const deletePlatformApp = catchAsync(async (req: Request, res: Response) => {
  await PlatformAppService.deletePlatformApp(String(req.params.app_id), requestAuditContext(req));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Platform app deleted',
    data: null,
  });
});

const PlatformAppController = {
  listPlatformApps,
  getPlatformApp,
  createPlatformApp,
  updatePlatformApp,
  deletePlatformApp,
};

export default PlatformAppController;
