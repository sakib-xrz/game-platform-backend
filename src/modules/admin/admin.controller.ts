import { Request, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '@/errors/app-error';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import AdminService from './admin.services';
import { AdminApprovalDecisionType } from '@/generated/prisma/client';
import { decideApproval, getApproval, listApprovals } from './admin-approval.services';
import { requestAuditContext } from './admin.request';
import type { ApprovalDecisionBody, ChangePasswordBody, CreateAdminBody, LoginBody, ResetPasswordBody, UpdateAdminBody, UpdatePolicyBody } from './admin.validation';

const requireAdmin = (req: Request) => {
  if (!req.admin) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin authentication is required');
  return req.admin;
};

const login = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.login((req.body as LoginBody).email, (req.body as LoginBody).password, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin login successful', data });
});

const me = catchAsync(async (req: Request, res: Response) => {
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin session fetched', data: requireAdmin(req) });
});

const logout = catchAsync(async (req: Request, res: Response) => {
  const admin = requireAdmin(req);
  if (req.admin_session_id) await AdminService.revokeSession(admin, req.admin_session_id, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin session revoked', data: null });
});

const changePassword = catchAsync(async (req: Request, res: Response) => {
  const admin = requireAdmin(req);
  const body = req.body as ChangePasswordBody;
  const data = await AdminService.changePassword(admin, req.admin_session_id || '', body.current_password, body.new_password, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin password changed', data });
});

const listSessions = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.listSessions(requireAdmin(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin sessions fetched', data });
});

const revokeOwnSession = catchAsync(async (req: Request, res: Response) => {
  const admin = requireAdmin(req);
  await AdminService.revokeSession(admin, String(req.params.session_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin session revoked', data: null });
});

const listAdmins = catchAsync(async (_req: Request, res: Response) => {
  const data = await AdminService.listAdmins();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin users fetched', data });
});

const createAdmin = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.createAdmin(requireAdmin(req), req.body as CreateAdminBody, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Admin user created', data });
});

const updateAdmin = catchAsync(async (req: Request, res: Response) => {
  const data = await AdminService.updateAdmin(requireAdmin(req), String(req.params.admin_id), req.body as UpdateAdminBody, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin user updated', data });
});

const revokeAdminSessions = catchAsync(async (req: Request, res: Response) => {
  await AdminService.revokeAdminSessions(requireAdmin(req), String(req.params.admin_id), requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin sessions revoked', data: null });
});

const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as ResetPasswordBody;
  const data = await AdminService.resetPassword(requireAdmin(req), String(req.params.admin_id), body.password, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin password reset; next login must change it', data });
});

const getPolicy = catchAsync(async (_req: Request, res: Response) => {
  const data = await AdminService.getPolicy();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin policy fetched', data });
});

const updatePolicy = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as UpdatePolicyBody;
  const data = await AdminService.updatePolicy(requireAdmin(req), body.wallet_adjustment_threshold, body.approval_expiry_minutes, requestAuditContext(req));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Admin policy updated', data });
});

const listApprovalRequests = catchAsync(async (req: Request, res: Response) => {
  const result = await listApprovals(requireAdmin(req).id, Number(req.query.page || 1), Number(req.query.limit || 20));
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Approval requests fetched', meta: { page: result.page, limit: result.limit, total: result.total }, data: result.items });
});

const getApprovalRequest = catchAsync(async (req: Request, res: Response) => {
  const admin = requireAdmin(req);
  const data = await getApproval(String(req.params.approval_id), { id: admin.id, role: admin.role });
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Approval request fetched', data });
});

const decideApprovalRequest = (decision: AdminApprovalDecisionType) => catchAsync(async (req: Request, res: Response) => {
  requireAdmin(req);
  const data = await decideApproval(String(req.params.approval_id), requestAuditContext(req), decision, (req.body as ApprovalDecisionBody).reason);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: `Approval request ${decision === AdminApprovalDecisionType.approve ? 'approved' : 'rejected'}`, data });
});

export default { login, me, logout, changePassword, listSessions, revokeOwnSession, listAdmins, createAdmin, updateAdmin, revokeAdminSessions, resetPassword, getPolicy, updatePolicy, listApprovalRequests, getApprovalRequest, approveApproval: decideApprovalRequest(AdminApprovalDecisionType.approve), rejectApproval: decideApprovalRequest(AdminApprovalDecisionType.reject) };
