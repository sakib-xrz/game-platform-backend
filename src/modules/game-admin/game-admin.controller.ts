import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import GameAdminService from './game-admin.services';
import type { CancelRoundBody, CreateGreedyConfigBody } from './game-admin.validation';
import { requestAuditContext } from '@/modules/admin/admin.request';

const actorId = (req: Request) => req.admin?.id;
const actorRole = (req: Request) => req.admin?.role;
const requestIdempotency = (req: Request) => req.header('idempotency-key')?.trim() || undefined;

const createConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.createConfig(req.body as CreateGreedyConfigBody, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Greedy config draft created', data });
});
const listConfigs = catchAsync(async (_req: Request, res: Response) => {
  const data = await GameAdminService.listConfigs();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy configs fetched', data });
});
const validateConfig = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.validateConfig(req.body as CreateGreedyConfigBody);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy config validation completed', data });
});
const publishConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  const idempotency_key = requestIdempotency(req);
  if (!admin_id || !idempotency_key) {
    res.status(httpStatus.BAD_REQUEST).json({ success: false, statusCode: httpStatus.BAD_REQUEST, message: 'Admin identity and Idempotency-Key are required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await GameAdminService.requestPublishConfig(String(req.params.config_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.ACCEPTED, success: true, message: 'Config publish is pending approval', data });
});
const requestPublishConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  const idempotency_key = requestIdempotency(req);
  if (!admin_id || !idempotency_key) {
    res.status(httpStatus.BAD_REQUEST).json({ success: false, statusCode: httpStatus.BAD_REQUEST, message: 'Admin identity and Idempotency-Key are required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await GameAdminService.requestPublishConfig(String(req.params.config_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.ACCEPTED, success: true, message: 'Config publish is pending approval', data });
});
const publishApprovedConfig = catchAsync(async (req: Request, res: Response) => {
  const admin_id = actorId(req);
  if (!admin_id) {
    res.status(httpStatus.UNAUTHORIZED).json({ success: false, statusCode: httpStatus.UNAUTHORIZED, message: 'Admin identity is required', timestamp: new Date().toISOString() });
    return;
  }
  const data = await GameAdminService.publishApprovedConfig(String((req.body as { approval_id: string }).approval_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy config published', data });
});
const getRuntime = catchAsync(async (_req: Request, res: Response) => {
  const data = await GameAdminService.getRuntime();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy runtime fetched', data });
});
const resume = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.resume(requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy resumed', data });
});
const pause = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.pause(requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy paused; active round will finish safely', data });
});
const cancelCurrentRound = catchAsync(async (req: Request, res: Response) => {
  const data = await GameAdminService.cancelCurrentRound(req.body as CancelRoundBody, requestAuditContext(req));
  sendResponse(res, { statusCode: data.status === 'pending_approval' ? httpStatus.ACCEPTED : httpStatus.OK, success: true, message: data.status === 'pending_approval' ? 'Round cancellation is pending approval' : 'Current round cancelled; worker will refund accepted bets', data });
});

export default { createConfig, listConfigs, validateConfig, publishConfig, requestPublishConfig, publishApprovedConfig, getRuntime, resume, pause, cancelCurrentRound };
