import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import TeenPattiAdminService from './teen-patti-admin.services';
import type { CancelRoundBody, CreateTeenPattiConfigBody } from './game-admin.validation';
import { requestAuditContext } from '@/modules/admin/admin.request';

const actorId = (req: Request) => req.admin?.id;
const requestIdempotency = (req: Request) => req.header('idempotency-key')?.trim() || undefined;

const createConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiAdminService.createConfig(req.body as CreateTeenPattiConfigBody, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Teen Patti config draft created', data });
});
const listConfigs = catchAsync(async (_req: Request, res: Response) => {
  const data = await TeenPattiAdminService.listConfigs();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti configs fetched', data });
});
const validateConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiAdminService.validateConfig(req.body as CreateTeenPattiConfigBody);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti config validation completed', data });
});
const publishConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  const idempotency_key = requestIdempotency(req);
  if (!admin_id || !idempotency_key) {
    res.status(httpStatus.BAD_REQUEST).json({ success: false, statusCode: httpStatus.BAD_REQUEST, message: 'Admin identity and Idempotency-Key are required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await TeenPattiAdminService.requestPublishConfig(String(req.params.config_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.ACCEPTED, success: true, message: 'Config publish is pending approval', data });
});
const requestPublishConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  const idempotency_key = requestIdempotency(req);
  if (!admin_id || !idempotency_key) {
    res.status(httpStatus.BAD_REQUEST).json({ success: false, statusCode: httpStatus.BAD_REQUEST, message: 'Admin identity and Idempotency-Key are required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await TeenPattiAdminService.requestPublishConfig(String(req.params.config_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.ACCEPTED, success: true, message: 'Config publish is pending approval', data });
});
const publishApprovedConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  if (!admin_id) {
    res.status(httpStatus.UNAUTHORIZED).json({ success: false, statusCode: httpStatus.UNAUTHORIZED, message: 'Admin identity is required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await TeenPattiAdminService.publishApprovedConfig(String((req.body as { approval_id: string }).approval_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti config published', data });
});
const getRuntime = catchAsync(async (_req: Request, res: Response) => {
  const data = await TeenPattiAdminService.getRuntime();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti runtime fetched', data });
});
const resume = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiAdminService.resume(requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti resumed', data });
});
const pause = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiAdminService.pause(requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti paused; active round will finish safely', data });
});
const cancelCurrentRound = catchAsync(async (req: Request, res: Response) => {
  const data = await TeenPattiAdminService.cancelCurrentRound(req.body as CancelRoundBody, requestAuditContext(req));
  sendResponse(res, { statusCode: data.status === 'pending_approval' ? httpStatus.ACCEPTED : httpStatus.OK, success: true, message: data.status === 'pending_approval' ? 'Round cancellation is pending approval' : 'Current round cancelled; worker will refund accepted bets', data });
});

export default { createConfig, listConfigs, validateConfig, publishConfig, requestPublishConfig, publishApprovedConfig, getRuntime, resume, pause, cancelCurrentRound };
