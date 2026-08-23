import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import Lucky77AdminOpsService from './lucky-77-admin-ops.services';
import type { CreateLucky77ConfigBody } from './game-admin.validation';
import type { OpsAuditLogQuery, OpsMetricsQuery, OpsRoundBetsQuery, OpsRoundListQuery } from './lucky-77-admin-ops.validation';
import type { AdminRole } from '@/generated/prisma/client';
import { OpsAlertStatus } from '@/generated/prisma/client';
import { requestAuditContext } from '@/modules/admin/admin.request';

const actorId = (req: Request) => req.admin?.id;
const actorRole = (req: Request): AdminRole | undefined => req.admin?.role;
const send = (res: Response, data: unknown, message: string, statusCode: number = httpStatus.OK) => sendResponse(res, { statusCode, success: true, message, data });

const getConfig = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.getConfig(String(req.params.config_id)), 'Lucky 77 config fetched'));
const updateDraft = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.updateDraft(String(req.params.config_id), req.body as CreateLucky77ConfigBody, requestAuditContext(req)), 'Lucky 77 config draft updated'));
const cloneConfig = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.cloneConfig(String(req.params.config_id), requestAuditContext(req)), 'Lucky 77 config draft cloned', httpStatus.CREATED));
const listRounds = catchAsync(async (req, res) => {
  const result = await Lucky77AdminOpsService.listRounds(req.query as unknown as OpsRoundListQuery, actorRole(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky 77 rounds fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getRound = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.getRound(String(req.params.round_id), actorRole(req)), 'Lucky 77 round fetched'));
const verifyRoundResult = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.verifyRoundResult(String(req.params.round_id), actorRole(req)), 'Lucky 77 result verification completed'));
const listRoundBets = catchAsync(async (req, res) => {
  const result = await Lucky77AdminOpsService.listRoundBets(String(req.params.round_id), req.query as unknown as OpsRoundBetsQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky 77 round bets fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getUserSummary = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.getUserSummary(String(req.params.user_id)), 'Lucky 77 user summary fetched'));
const getMetrics = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.getMetrics(req.query as unknown as OpsMetricsQuery), 'Lucky 77 metrics fetched'));
const listAuditLogs = catchAsync(async (req, res) => {
  const result = await Lucky77AdminOpsService.listAuditLogs(req.query as unknown as OpsAuditLogQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin audit logs fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getOperationsHealth = catchAsync(async (_req, res) => send(res, await Lucky77AdminOpsService.getOperationsHealth(), 'Operations health fetched'));
const getOverview = catchAsync(async (_req, res) => send(res, await Lucky77AdminOpsService.getOverview(), 'Lucky 77 operations overview fetched'));
const setAvailability = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.setAvailability(req.body.status, requestAuditContext(req)), 'Game availability updated'));
const listAlerts = catchAsync(async (req, res) => {
  const result = await Lucky77AdminOpsService.listAlerts(req.query.status as OpsAlertStatus | undefined, Number(req.query.page || 1), Number(req.query.limit || 20));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Operations alerts fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const acknowledgeAlert = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.acknowledgeAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert acknowledged'));
const resolveAlert = catchAsync(async (req, res) => send(res, await Lucky77AdminOpsService.resolveAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert resolved'));

export default { getConfig, updateDraft, cloneConfig, listRounds, getRound, verifyRoundResult, listRoundBets, getUserSummary, getMetrics, listAuditLogs, getOperationsHealth, getOverview, setAvailability, listAlerts, acknowledgeAlert, resolveAlert };
