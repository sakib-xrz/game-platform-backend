import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import { adminLoginRateLimiter } from '@/middlewares/rate-limiter';
import AdminController from './admin.controller';
import { adminIdSchema, approvalDecisionSchema, approvalListSchema, approvalParamSchema, changePasswordSchema, createAdminSchema, loginSchema, resetPasswordSchema, sessionIdSchema, updateAdminSchema, updatePolicySchema } from './admin.validation';

export const AdminRoutes = express.Router();

AdminRoutes.post('/auth/login', adminLoginRateLimiter, validateRequest(loginSchema), AdminController.login);
AdminRoutes.use(adminAuth, adminPasswordGate);
AdminRoutes.get('/auth/me', AdminController.me);
AdminRoutes.post('/auth/logout', requireAdminIdempotency('admin.auth.logout'), AdminController.logout);
AdminRoutes.post('/auth/password/change', requireAdminIdempotency('admin.auth.password_change'), validateRequest(changePasswordSchema), AdminController.changePassword);
AdminRoutes.get('/auth/sessions', AdminController.listSessions);
AdminRoutes.post('/auth/sessions/:session_id/revoke', requireAdminIdempotency('admin.auth.session.revoke'), validateRequest(sessionIdSchema), AdminController.revokeOwnSession);

AdminRoutes.get('/admin-users', requireAdminPermission('admin.manage'), AdminController.listAdmins);
AdminRoutes.post('/admin-users', requireAdminPermission('admin.manage'), requireAdminIdempotency('admin.user.create'), validateRequest(createAdminSchema), AdminController.createAdmin);
AdminRoutes.patch('/admin-users/:admin_id', requireAdminPermission('admin.manage'), requireAdminIdempotency('admin.user.update'), validateRequest(updateAdminSchema), AdminController.updateAdmin);
AdminRoutes.post('/admin-users/:admin_id/revoke-sessions', requireAdminPermission('admin.manage'), requireAdminIdempotency('admin.user.revoke_sessions'), validateRequest(adminIdSchema), AdminController.revokeAdminSessions);
AdminRoutes.post('/admin-users/:admin_id/reset-password', requireAdminPermission('admin.manage'), requireAdminIdempotency('admin.user.reset_password'), validateRequest(resetPasswordSchema), AdminController.resetPassword);

AdminRoutes.get('/policy', requireAdminPermission('admin.manage'), AdminController.getPolicy);
AdminRoutes.patch('/policy', requireAdminPermission('admin.manage'), requireAdminIdempotency('admin.policy.update'), validateRequest(updatePolicySchema), AdminController.updatePolicy);

AdminRoutes.get('/approvals', requireAdminPermission('approval.read'), validateRequest(approvalListSchema), AdminController.listApprovalRequests);
AdminRoutes.get('/approvals/:approval_id', requireAdminPermission('approval.read'), validateRequest(approvalParamSchema), AdminController.getApprovalRequest);
AdminRoutes.post('/approvals/:approval_id/approve', requireAdminPermission('approval.decide'), requireAdminIdempotency('admin.approval.approve'), validateRequest(approvalDecisionSchema), AdminController.approveApproval);
AdminRoutes.post('/approvals/:approval_id/reject', requireAdminPermission('approval.decide'), requireAdminIdempotency('admin.approval.reject'), validateRequest(approvalDecisionSchema), AdminController.rejectApproval);

export default AdminRoutes;
