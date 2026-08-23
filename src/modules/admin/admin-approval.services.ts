import httpStatus from 'http-status';
import { AdminApprovalDecisionType, AdminApprovalStatus, AdminRole, AdminStatus, Prisma } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { canonicalJson, sha256 } from '@/utils/hash';
import type { AdminAuditContext } from './admin.services';
import { writeAdminAudit } from './admin.services';

type ApprovalViewer = { id: string; role: AdminRole };

const approvalPayloadHash = (payload: Prisma.JsonValue): string => sha256(canonicalJson(payload));

export const approvalEligibleRoles = (action_type: string): AdminRole[] => {
  if (action_type.startsWith('wallet.')) return [AdminRole.super_admin, AdminRole.finance_operator];
  if (action_type.startsWith('greedy.') || action_type.startsWith('teen_patti.') || action_type.startsWith('lucky_77.') || action_type.startsWith('greedy_classic.') || action_type.startsWith('game.')) return [AdminRole.super_admin, AdminRole.game_operator];
  return [AdminRole.super_admin];
};

export const canAdminApprove = (action_type: string, approver_role: AdminRole, requester_id: string, approver_id: string): boolean =>
  requester_id !== approver_id && approvalEligibleRoles(action_type).includes(approver_role);

export const verifyApprovalPayloadHash = (payload: Prisma.JsonValue, payload_hash: string): void => {
  // Accept the pre-canonical legacy digest for already-created requests, while
  // all new requests use canonical JSON so JSONB key order cannot invalidate it.
  if (approvalPayloadHash(payload) !== payload_hash && sha256(JSON.stringify(payload)) !== payload_hash) throw new AppError(httpStatus.CONFLICT, 'Approval payload integrity check failed');
};

export type PendingApprovalInput = {
  admin_user_id: string;
  action_type: string;
  target_type: string;
  target_id?: string;
  payload: Prisma.InputJsonValue;
  idempotency_key: string;
  expires_at?: Date;
};

export const createPendingApproval = async (input: PendingApprovalInput, tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const policy = await tx.adminPolicy.findUnique({ where: { code: 'default' } });
  const expires_at = input.expires_at ?? new Date(Date.now() + (policy?.approval_expiry_minutes ?? 1440) * 60_000);
  try {
    return await tx.adminApprovalRequest.create({
      data: {
        action_type: input.action_type,
        target_type: input.target_type,
        target_id: input.target_id,
        payload: input.payload,
        payload_hash: approvalPayloadHash(input.payload as Prisma.JsonValue),
        requested_by_admin_id: input.admin_user_id,
        status: AdminApprovalStatus.pending,
        // The requester is not an approval decision. One distinct approver
        // decision completes the configured dual-control workflow.
        required_approvals: 1,
        idempotency_key: input.idempotency_key,
        expires_at,
      },
      include: { decisions: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await tx.adminApprovalRequest.findFirst({ where: { requested_by_admin_id: input.admin_user_id, action_type: input.action_type, idempotency_key: input.idempotency_key }, include: { decisions: true } });
      if (existing) return existing;
    }
    throw error;
  }
};

export const requirePendingApproval = async (approval_id: string, admin_user_id: string) => {
  const request = await prisma.adminApprovalRequest.findUnique({ where: { id: approval_id }, include: { decisions: true } });
  if (!request) throw new AppError(httpStatus.NOT_FOUND, 'Approval request not found');
  if (request.requested_by_admin_id !== admin_user_id) throw new AppError(httpStatus.FORBIDDEN, 'Only the requesting admin can apply this approval');
  if (request.status !== AdminApprovalStatus.approved) throw new AppError(httpStatus.CONFLICT, 'Approval request is not approved');
  if (request.expires_at <= new Date()) throw new AppError(httpStatus.CONFLICT, 'Approval request has expired');
  verifyApprovalPayloadHash(request.payload, request.payload_hash);
  return request;
};

export const listPendingApprovals = async (admin_user_id: string, page = 1, limit = 20) => {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const where = { status: AdminApprovalStatus.pending, requested_by_admin_id: { not: admin_user_id }, expires_at: { gt: new Date() } };
  const [items, total] = await prisma.$transaction([
    prisma.adminApprovalRequest.findMany({ where, include: { decisions: true }, orderBy: { created_at: 'asc' }, skip: (safe_page - 1) * safe_limit, take: safe_limit }),
    prisma.adminApprovalRequest.count({ where }),
  ]);
  return { items, total, page: safe_page, limit: safe_limit };
};

const mayViewApproval = (approval: { requested_by_admin_id: string; action_type: string; decisions: Array<{ admin_user_id: string }> }, viewer: ApprovalViewer): boolean =>
  viewer.role === AdminRole.super_admin
  || viewer.role === AdminRole.auditor
  || approval.requested_by_admin_id === viewer.id
  || approval.decisions.some((item) => item.admin_user_id === viewer.id)
  || approvalEligibleRoles(approval.action_type).includes(viewer.role);

export const getApproval = async (approval_id: string, viewer: ApprovalViewer) => {
  const approval = await prisma.adminApprovalRequest.findUnique({ where: { id: approval_id }, include: { decisions: { include: { admin_user: { select: { id: true, email: true, display_name: true, role: true } } } }, requested_by: { select: { id: true, email: true, display_name: true, role: true } } } });
  if (!approval) throw new AppError(httpStatus.NOT_FOUND, 'Approval request not found');
  if (!mayViewApproval(approval, viewer)) throw new AppError(httpStatus.FORBIDDEN, 'This approval request is outside your role scope');
  return approval;
};

export const listApprovals = async (admin_user_id: string, page = 1, limit = 20) => {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  const admin = await prisma.adminUser.findUnique({ where: { id: admin_user_id }, select: { role: true } });
  if (!admin) throw new AppError(httpStatus.FORBIDDEN, 'Approver account is unavailable');
  const actions = Object.keys({
    'wallet.adjust': true,
    'greedy.config.publish': true,
    'greedy.round.cancel': true,
    'teen_patti.config.publish': true,
    'teen_patti.round.cancel': true,
    'lucky_77.config.publish': true,
    'lucky_77.round.cancel': true,
    'greedy_classic.config.publish': true,
    'greedy_classic.round.cancel': true,
    'game.runtime.control': true,
  }).filter((action) => approvalEligibleRoles(action).includes(admin.role));
  const where: Prisma.AdminApprovalRequestWhereInput = admin.role === AdminRole.super_admin || admin.role === AdminRole.auditor
    ? {}
    : { OR: [{ requested_by_admin_id: admin_user_id }, { decisions: { some: { admin_user_id } } }, { action_type: { in: actions } }] };
  const [items, total] = await prisma.$transaction([
    prisma.adminApprovalRequest.findMany({ where, include: { decisions: true }, orderBy: { created_at: 'desc' }, skip: (safe_page - 1) * safe_limit, take: safe_limit }),
    prisma.adminApprovalRequest.count({ where }),
  ]);
  return { items, total, page: safe_page, limit: safe_limit };
};

export const decideApproval = async (approval_id: string, context: AdminAuditContext, decision: AdminApprovalDecisionType, reason?: string) => {
  const admin_user_id = context.admin_user_id;
  if (!admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');

  // Persist expiry outside the decision transaction so an expiry transition is
  // not rolled back when the caller receives the expected conflict response.
  const expired = await prisma.adminApprovalRequest.updateMany({
    where: { id: approval_id, status: AdminApprovalStatus.pending, expires_at: { lte: new Date() } },
    data: { status: AdminApprovalStatus.expired },
  });
  if (expired.count) throw new AppError(httpStatus.CONFLICT, 'Approval request has expired');

  return prisma.$transaction(async (tx) => {
    const request = await tx.adminApprovalRequest.findUnique({ where: { id: approval_id }, include: { decisions: true } });
    if (!request) throw new AppError(httpStatus.NOT_FOUND, 'Approval request not found');
    if (request.requested_by_admin_id === admin_user_id) throw new AppError(httpStatus.FORBIDDEN, 'The requesting admin cannot approve their own request');
    if (request.status !== AdminApprovalStatus.pending) throw new AppError(httpStatus.CONFLICT, 'Approval request is no longer pending');
    const admin = await tx.adminUser.findUnique({ where: { id: admin_user_id }, select: { role: true, status: true } });
    if (!admin || admin.status !== AdminStatus.active) throw new AppError(httpStatus.FORBIDDEN, 'Approver account is unavailable');
    if (!canAdminApprove(request.action_type, admin.role, request.requested_by_admin_id, admin_user_id)) throw new AppError(httpStatus.FORBIDDEN, 'This admin role cannot approve the requested action');
    verifyApprovalPayloadHash(request.payload, request.payload_hash);
    const status = decision === AdminApprovalDecisionType.reject ? AdminApprovalStatus.rejected : AdminApprovalStatus.approved;
    // This conditional write is the decision serialization point. Concurrent
    // approvers cannot both transition the same pending request.
    const transitioned = await tx.adminApprovalRequest.updateMany({
      where: { id: request.id, status: AdminApprovalStatus.pending, expires_at: { gt: new Date() } },
      data: { status },
    });
    if (transitioned.count !== 1) throw new AppError(httpStatus.CONFLICT, 'Approval request is no longer pending');
    try {
      await tx.adminApprovalDecision.create({ data: { request_id: request.id, admin_user_id, decision, reason: reason?.trim() || null } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError(httpStatus.CONFLICT, 'This admin has already decided on the request');
      throw error;
    }
    await writeAdminAudit(tx, { ...context, actor_role: admin.role, approval_request_id: request.id, outcome: 'success' }, { action: `admin.approval.${decision}`, entity_type: 'admin_approval_request', entity_id: request.id, new_values: { reason: reason?.trim() || null } });
    return tx.adminApprovalRequest.findUniqueOrThrow({ where: { id: request.id }, include: { decisions: true } });
  });
};

export const expireApprovals = async (): Promise<number> => {
  const result = await prisma.adminApprovalRequest.updateMany({ where: { status: AdminApprovalStatus.pending, expires_at: { lte: new Date() } }, data: { status: AdminApprovalStatus.expired } });
  return result.count;
};

export const markApprovalApplied = async (tx: Prisma.TransactionClient, approval_id: string, context: AdminAuditContext) => {
  const admin_user_id = context.admin_user_id;
  if (!admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');
  const request = await tx.adminApprovalRequest.findUnique({ where: { id: approval_id } });
  if (!request || request.status !== AdminApprovalStatus.approved) throw new AppError(httpStatus.CONFLICT, 'Approval request is not ready to apply');
  const updated = await tx.adminApprovalRequest.updateMany({ where: { id: approval_id, status: AdminApprovalStatus.approved }, data: { status: AdminApprovalStatus.applied, applied_at: new Date() } });
  if (updated.count !== 1) throw new AppError(httpStatus.CONFLICT, 'Approval request was already applied');
  await writeAdminAudit(tx, { ...context, approval_request_id: approval_id, outcome: 'success' }, { action: 'admin.approval.applied', entity_type: 'admin_approval_request', entity_id: approval_id });
  return tx.adminApprovalRequest.findUniqueOrThrow({ where: { id: approval_id }, include: { decisions: true } });
};
