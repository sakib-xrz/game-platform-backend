import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import TeenPattiAdminOpsService from './teen-patti-admin-ops.services';
import type { CreateTeenPattiConfigBody } from './game-admin.validation';
import type { OpsAuditLogQuery, OpsMetricsQuery, OpsRoundBetsQuery, OpsRoundListQuery } from './teen-patti-admin-ops.validation';
import type { AdminRole } from '@/generated/prisma/client';
import { OpsAlertStatus } from '@/generated/prisma/client';
import { requestAuditContext } from '@/modules/admin/admin.request';

const actorId = (req: Request) => req.admin?.id;
const actorRole = (req: Request): AdminRole | undefined => req.admin?.role;
const send = (res: Response, data: unknown, message: string, statusCode: number = httpStatus.OK) => sendResponse(res, { statusCode, success: true, message, data });

const getConfig = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.getConfig(String(req.params.config_id)), 'Teen Patti config fetched'));
const updateDraft = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.updateDraft(String(req.params.config_id), req.body as CreateTeenPattiConfigBody, requestAuditContext(req)), 'Teen Patti config draft updated'));
const cloneConfig = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.cloneConfig(String(req.params.config_id), requestAuditContext(req)), 'Teen Patti config draft cloned', httpStatus.CREATED));
const listRounds = catchAsync(async (req, res) => {
  const result = await TeenPattiAdminOpsService.listRounds(req.query as unknown as OpsRoundListQuery, actorRole(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti rounds fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getRound = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.getRound(String(req.params.round_id), actorRole(req)), 'Teen Patti round fetched'));
const verifyRoundResult = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.verifyRoundResult(String(req.params.round_id), actorRole(req)), 'Teen Patti result verification completed'));
const listRoundBets = catchAsync(async (req, res) => {
  const result = await TeenPattiAdminOpsService.listRoundBets(String(req.params.round_id), req.query as unknown as OpsRoundBetsQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Teen Patti round bets fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getUserSummary = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.getUserSummary(String(req.params.user_id)), 'Teen Patti user summary fetched'));
const getMetrics = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.getMetrics(req.query as unknown as OpsMetricsQuery), 'Teen Patti metrics fetched'));
const listAuditLogs = catchAsync(async (req, res) => {
  const result = await TeenPattiAdminOpsService.listAuditLogs(req.query as unknown as OpsAuditLogQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin audit logs fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getOperationsHealth = catchAsync(async (_req, res) => send(res, await TeenPattiAdminOpsService.getOperationsHealth(), 'Operations health fetched'));
const getOverview = catchAsync(async (_req, res) => send(res, await TeenPattiAdminOpsService.getOverview(), 'Teen Patti operations overview fetched'));
const setAvailability = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.setAvailability(req.body.status, requestAuditContext(req)), 'Game availability updated'));
const listAlerts = catchAsync(async (req, res) => {
  const result = await TeenPattiAdminOpsService.listAlerts(req.query.status as OpsAlertStatus | undefined, Number(req.query.page || 1), Number(req.query.limit || 20));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Operations alerts fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const acknowledgeAlert = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.acknowledgeAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert acknowledged'));
const resolveAlert = catchAsync(async (req, res) => send(res, await TeenPattiAdminOpsService.resolveAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert resolved'));

export default { getConfig, updateDraft, cloneConfig, listRounds, getRound, verifyRoundResult, listRoundBets, getUserSummary, getMetrics, listAuditLogs, getOperationsHealth, getOverview, setAvailability, listAlerts, acknowledgeAlert, resolveAlert };
