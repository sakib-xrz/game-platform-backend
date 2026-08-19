import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import GreedyAdminOpsService from './greedy-admin-ops.services';
import type { CreateGreedyConfigBody } from './game-admin.validation';
import type { OpsAuditLogQuery, OpsMetricsQuery, OpsRoundBetsQuery, OpsRoundListQuery } from './greedy-admin-ops.validation';
import type { AdminRole } from '@/generated/prisma/client';
import { OpsAlertStatus } from '@/generated/prisma/client';
import { requestAuditContext } from '@/modules/admin/admin.request';

const actorId = (req: Request) => req.admin?.id;
const actorRole = (req: Request): AdminRole | undefined => req.admin?.role;
const send = (res: Response, data: unknown, message: string, statusCode: number = httpStatus.OK) => sendResponse(res, { statusCode, success: true, message, data });

const getConfig = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.getConfig(String(req.params.config_id)), 'Greedy config fetched'));
const updateDraft = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.updateDraft(String(req.params.config_id), req.body as CreateGreedyConfigBody, requestAuditContext(req)), 'Greedy config draft updated'));
const cloneConfig = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.cloneConfig(String(req.params.config_id), requestAuditContext(req)), 'Greedy config draft cloned', httpStatus.CREATED));
const listRounds = catchAsync(async (req, res) => {
  const result = await GreedyAdminOpsService.listRounds(req.query as unknown as OpsRoundListQuery, actorRole(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy rounds fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getRound = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.getRound(String(req.params.round_id), actorRole(req)), 'Greedy round fetched'));
const verifyRoundResult = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.verifyRoundResult(String(req.params.round_id), actorRole(req)), 'Greedy result verification completed'));
const listRoundBets = catchAsync(async (req, res) => {
  const result = await GreedyAdminOpsService.listRoundBets(String(req.params.round_id), req.query as unknown as OpsRoundBetsQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Greedy round bets fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getUserSummary = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.getUserSummary(String(req.params.user_id)), 'Greedy user summary fetched'));
const getMetrics = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.getMetrics(req.query as unknown as OpsMetricsQuery), 'Greedy metrics fetched'));
const listAuditLogs = catchAsync(async (req, res) => {
  const result = await GreedyAdminOpsService.listAuditLogs(req.query as unknown as OpsAuditLogQuery);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin audit logs fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const getOperationsHealth = catchAsync(async (_req, res) => send(res, await GreedyAdminOpsService.getOperationsHealth(), 'Operations health fetched'));
const getOverview = catchAsync(async (_req, res) => send(res, await GreedyAdminOpsService.getOverview(), 'Greedy operations overview fetched'));
const setAvailability = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.setAvailability(req.body.status, requestAuditContext(req)), 'Game availability updated'));
const listAlerts = catchAsync(async (req, res) => {
  const result = await GreedyAdminOpsService.listAlerts(req.query.status as OpsAlertStatus | undefined, Number(req.query.page || 1), Number(req.query.limit || 20));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Operations alerts fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});
const acknowledgeAlert = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.acknowledgeAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert acknowledged'));
const resolveAlert = catchAsync(async (req, res) => send(res, await GreedyAdminOpsService.resolveAlert(String(req.params.alert_id), requestAuditContext(req)), 'Operations alert resolved'));

export default { getConfig, updateDraft, cloneConfig, listRounds, getRound, verifyRoundResult, listRoundBets, getUserSummary, getMetrics, listAuditLogs, getOperationsHealth, getOverview, setAvailability, listAlerts, acknowledgeAlert, resolveAlert };
