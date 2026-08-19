import httpStatus from 'http-status';
import {
  AdminRole,
  AdminStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { sha256, stableRequestHash } from '@/utils/hash';
import { createSessionToken, hashAdminPassword, hashSessionToken, normalizeAdminEmail, verifyAdminPassword } from './admin.crypto';
import type { AdminPermission } from './admin.permissions';
import type { AuthenticatedAdmin } from './admin.types';

export const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1000;
export const ADMIN_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const ADMIN_MAX_SESSIONS = 3;
export const ADMIN_MAX_FAILED_LOGINS = 5;
export const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

const adminSelect = {
  id: true,
  email: true,
  display_name: true,
  role: true,
  status: true,
  force_password_change: true,
  last_login_at: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.AdminUserSelect;

const toAdmin = (admin: Prisma.AdminUserGetPayload<{ select: typeof adminSelect }>): AuthenticatedAdmin => ({
  id: admin.id,
  email: admin.email,
  display_name: admin.display_name,
  role: admin.role,
  status: admin.status,
  force_password_change: admin.force_password_change,
});

const adminListSelect = {
  ...adminSelect,
  failed_login_count: true,
  locked_until: true,
  password_changed_at: true,
} satisfies Prisma.AdminUserSelect;

export type AdminAuditContext = {
  admin_user_id?: string;
  actor_role?: AdminRole;
  request_id?: string;
  ip_address?: string;
  user_agent?: string;
  approval_request_id?: string;
  outcome?: string;
  idempotency_key?: string;
};

export const writeAdminAudit = async (
  tx: Prisma.TransactionClient,
  context: AdminAuditContext,
  data: { action: string; entity_type: string; entity_id?: string; old_values?: Prisma.InputJsonValue; new_values?: Prisma.InputJsonValue },
): Promise<void> => {
  await tx.auditLog.create({
    data: {
      actor_type: 'admin',
      actor_id: context.admin_user_id,
      admin_user_id: context.admin_user_id,
      actor_role: context.actor_role,
      outcome: context.outcome,
      approval_request_id: context.approval_request_id,
      action: data.action,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      old_values: data.old_values,
      new_values: data.new_values,
      request_id: context.request_id,
      ip_address: context.ip_address,
      user_agent: context.user_agent,
    },
  });
};

const genericLoginError = (): AppError =>
  new AppError(httpStatus.UNAUTHORIZED, 'Invalid admin credentials');

export const ensureStrongPassword = (password: string): void => {
  if (password.length < 12 || password.length > 128) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Password must be between 12 and 128 characters');
  }
};

const activeSuperAdminCount = async (tx: Prisma.TransactionClient = prisma): Promise<number> =>
  tx.adminUser.count({ where: { role: AdminRole.super_admin, status: AdminStatus.active } });

export type AdminRequestContext = AdminAuditContext & { user_agent?: string };

const login = async (
  email_input: string,
  password: string,
  context: AdminRequestContext,
) => {
  const email = normalizeAdminEmail(email_input);
  const admin = await prisma.adminUser.findUnique({ where: { email }, select: { ...adminSelect, password_hash: true, failed_login_count: true, locked_until: true } });
  if (!admin) throw genericLoginError();

  const now = new Date();
  if (admin.status === AdminStatus.disabled) {
    await prisma.$transaction(async (tx) => writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: admin.role, outcome: 'failed' }, { action: 'admin.auth.login', entity_type: 'admin_user', entity_id: admin.id, new_values: { reason: 'disabled' } }));
    throw genericLoginError();
  }
  if (admin.status === AdminStatus.locked && admin.locked_until && admin.locked_until > now) {
    await prisma.$transaction(async (tx) => writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: admin.role, outcome: 'failed' }, { action: 'admin.auth.login', entity_type: 'admin_user', entity_id: admin.id, new_values: { reason: 'locked' } }));
    throw new AppError(httpStatus.LOCKED, 'Admin account is temporarily locked');
  }

  let valid = false;
  try {
    valid = await verifyAdminPassword(admin.password_hash, password);
  } catch {
    valid = false;
  }
  if (!valid) {
    const failed_count = admin.failed_login_count + 1;
    const locked = failed_count >= ADMIN_MAX_FAILED_LOGINS;
    await prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: admin.id },
        data: {
          failed_login_count: failed_count,
          status: locked ? AdminStatus.locked : admin.status,
          locked_until: locked ? new Date(now.getTime() + ADMIN_LOCKOUT_MS) : admin.locked_until,
        },
      });
      await writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: admin.role, outcome: 'failed' }, { action: 'admin.auth.login', entity_type: 'admin_user', entity_id: admin.id });
    });
    throw genericLoginError();
  }

  const token = createSessionToken();
  const absolute_expires_at = new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS);
  const idle_expires_at = new Date(now.getTime() + ADMIN_SESSION_IDLE_MS);
  const session = await prisma.$transaction(async (tx) => {
    const updated = await tx.adminUser.update({
      where: { id: admin.id },
      data: {
        failed_login_count: 0,
        locked_until: null,
        status: AdminStatus.active,
        last_login_at: now,
      },
      select: adminSelect,
    });

    const existing = await tx.adminSession.findMany({
      where: { admin_user_id: admin.id, revoked_at: null, idle_expires_at: { gt: now }, absolute_expires_at: { gt: now } },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });
    const revoke = existing.slice(ADMIN_MAX_SESSIONS - 1).map((item) => item.id);
    if (revoke.length) await tx.adminSession.updateMany({ where: { id: { in: revoke } }, data: { revoked_at: now } });

    const created = await tx.adminSession.create({
      data: {
        admin_user_id: admin.id,
        token_hash: hashSessionToken(token),
        idle_expires_at,
        absolute_expires_at,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
      },
    });
    await writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: updated.role, outcome: 'success' }, {
      action: 'admin.auth.login', entity_type: 'admin_user', entity_id: admin.id,
    });
    return { updated, created };
  });

  return {
    session_token: token,
    admin: toAdmin(session.updated),
    expires_at: absolute_expires_at.toISOString(),
  };
};

const revokeSession = async (admin: AuthenticatedAdmin, session_id: string, context: AdminRequestContext): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const result = await tx.adminSession.updateMany({
      where: { id: session_id, admin_user_id: admin.id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (result.count) await writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: admin.role, outcome: 'success' }, { action: 'admin.auth.logout', entity_type: 'admin_session', entity_id: session_id });
  });
};

const listSessions = async (admin: AuthenticatedAdmin) => prisma.adminSession.findMany({
  where: { admin_user_id: admin.id, revoked_at: null, idle_expires_at: { gt: new Date() }, absolute_expires_at: { gt: new Date() } },
  select: { id: true, created_at: true, last_seen_at: true, idle_expires_at: true, absolute_expires_at: true, ip_address: true, user_agent: true },
  orderBy: { created_at: 'desc' },
});

const changePassword = async (
  admin: AuthenticatedAdmin,
  session_id: string,
  current_password: string,
  new_password: string,
  context: AdminRequestContext,
): Promise<AuthenticatedAdmin> => {
  ensureStrongPassword(new_password);
  if (current_password === new_password) throw new AppError(httpStatus.BAD_REQUEST, 'New password must differ from the current password');
  const current = await prisma.adminUser.findUnique({ where: { id: admin.id }, select: { password_hash: true } });
  if (!current || !(await verifyAdminPassword(current.password_hash, current_password))) throw genericLoginError();
  const password_hash = await hashAdminPassword(new_password);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.adminUser.update({ where: { id: admin.id }, data: { password_hash, force_password_change: false, password_changed_at: new Date() }, select: adminSelect });
    await tx.adminSession.updateMany({ where: { admin_user_id: admin.id, id: { not: session_id }, revoked_at: null }, data: { revoked_at: new Date() } });
    await writeAdminAudit(tx, { ...context, admin_user_id: admin.id, actor_role: admin.role, outcome: 'success' }, { action: 'admin.auth.password_changed', entity_type: 'admin_user', entity_id: admin.id });
    return toAdmin(updated);
  });
};

export type CreateAdminInput = { email: string; display_name: string; role: AdminRole; password: string; force_password_change?: boolean };

const createAdmin = async (actor: AuthenticatedAdmin, input: CreateAdminInput, context: AdminRequestContext) => {
  if (actor.role !== AdminRole.super_admin) throw new AppError(httpStatus.FORBIDDEN, 'Only a super admin can manage admins');
  ensureStrongPassword(input.password);
  const password_hash = await hashAdminPassword(input.password);
  const email = normalizeAdminEmail(input.email);
  return prisma.$transaction(async (tx) => {
    const created = await tx.adminUser.create({ data: { email, display_name: input.display_name.trim(), role: input.role, password_hash, force_password_change: input.force_password_change ?? true }, select: adminSelect });
    await writeAdminAudit(tx, { ...context, admin_user_id: actor.id, actor_role: actor.role, outcome: 'success' }, { action: 'admin.user.created', entity_type: 'admin_user', entity_id: created.id, new_values: { email, role: input.role } });
    return toAdmin(created);
  });
};

const listAdmins = async () => prisma.adminUser.findMany({ select: adminListSelect, orderBy: [{ status: 'asc' }, { email: 'asc' }] });

const updateAdmin = async (actor: AuthenticatedAdmin, target_id: string, input: { display_name?: string; role?: AdminRole; status?: AdminStatus; force_password_change?: boolean }, context: AdminRequestContext) => {
  if (actor.role !== AdminRole.super_admin) throw new AppError(httpStatus.FORBIDDEN, 'Only a super admin can manage admins');
  return prisma.$transaction(async (tx) => {
    const target = await tx.adminUser.findUnique({ where: { id: target_id }, select: adminSelect });
    if (!target) throw new AppError(httpStatus.NOT_FOUND, 'Admin user not found');
    const next_role = input.role ?? target.role;
    const next_status = input.status ?? target.status;
    if (target.role === AdminRole.super_admin && target.status === AdminStatus.active && (next_role !== AdminRole.super_admin || next_status !== AdminStatus.active) && await activeSuperAdminCount(tx) <= 1) {
      throw new AppError(httpStatus.CONFLICT, 'The last active super admin cannot be disabled or demoted');
    }
    const updated = await tx.adminUser.update({ where: { id: target_id }, data: { display_name: input.display_name?.trim(), role: next_role, status: next_status, force_password_change: input.force_password_change }, select: adminSelect });
    if (next_status !== AdminStatus.active || next_role !== target.role) await tx.adminSession.updateMany({ where: { admin_user_id: target_id, revoked_at: null }, data: { revoked_at: new Date() } });
    await writeAdminAudit(tx, { ...context, admin_user_id: actor.id, actor_role: actor.role, outcome: 'success' }, { action: 'admin.user.updated', entity_type: 'admin_user', entity_id: target_id, old_values: { role: target.role, status: target.status, display_name: target.display_name }, new_values: { role: updated.role, status: updated.status, display_name: updated.display_name } });
    return toAdmin(updated);
  });
};

const revokeAdminSessions = async (actor: AuthenticatedAdmin, target_id: string, context: AdminRequestContext): Promise<void> => {
  if (actor.role !== AdminRole.super_admin) throw new AppError(httpStatus.FORBIDDEN, 'Only a super admin can manage sessions');
  await prisma.$transaction(async (tx) => {
    await tx.adminSession.updateMany({ where: { admin_user_id: target_id, revoked_at: null }, data: { revoked_at: new Date() } });
    await writeAdminAudit(tx, { ...context, admin_user_id: actor.id, actor_role: actor.role, outcome: 'success' }, { action: 'admin.user.sessions_revoked', entity_type: 'admin_user', entity_id: target_id });
  });
};

const resetPassword = async (actor: AuthenticatedAdmin, target_id: string, password: string, context: AdminRequestContext): Promise<AuthenticatedAdmin> => {
  if (actor.role !== AdminRole.super_admin) throw new AppError(httpStatus.FORBIDDEN, 'Only a super admin can reset passwords');
  ensureStrongPassword(password);
  const password_hash = await hashAdminPassword(password);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.adminUser.update({ where: { id: target_id }, data: { password_hash, force_password_change: true, password_changed_at: new Date(), failed_login_count: 0, locked_until: null, status: AdminStatus.active }, select: adminSelect });
    await tx.adminSession.updateMany({ where: { admin_user_id: target_id, revoked_at: null }, data: { revoked_at: new Date() } });
    await writeAdminAudit(tx, { ...context, admin_user_id: actor.id, actor_role: actor.role, outcome: 'success' }, { action: 'admin.user.password_reset', entity_type: 'admin_user', entity_id: target_id });
    return toAdmin(updated);
  });
};

const getPolicy = async () => prisma.adminPolicy.upsert({ where: { code: 'default' }, create: {}, update: {} });

const updatePolicy = async (actor: AuthenticatedAdmin, threshold: string, expiry_minutes: number, context: AdminRequestContext) => {
  if (actor.role !== AdminRole.super_admin) throw new AppError(httpStatus.FORBIDDEN, 'Only a super admin can manage policy');
  const wallet_adjustment_threshold = BigInt(threshold);
  if (wallet_adjustment_threshold < 0n) throw new AppError(httpStatus.BAD_REQUEST, 'Approval threshold cannot be negative');
  return prisma.$transaction(async (tx) => {
    const previous = await tx.adminPolicy.upsert({ where: { code: 'default' }, create: {}, update: {} });
    const updated = await tx.adminPolicy.update({ where: { id: previous.id }, data: { wallet_adjustment_threshold, approval_expiry_minutes: expiry_minutes, updated_by_admin_id: actor.id } });
    await writeAdminAudit(tx, { ...context, admin_user_id: actor.id, actor_role: actor.role, outcome: 'success' }, { action: 'admin.policy.updated', entity_type: 'admin_policy', entity_id: updated.id, old_values: { wallet_adjustment_threshold: previous.wallet_adjustment_threshold.toString(), approval_expiry_minutes: previous.approval_expiry_minutes }, new_values: { wallet_adjustment_threshold: threshold, approval_expiry_minutes: expiry_minutes } });
    return updated;
  });
};

const adminRequestHash = (scope: string, body: unknown): string => stableRequestHash({ scope, body });

export default {
  login,
  revokeSession,
  listSessions,
  changePassword,
  createAdmin,
  listAdmins,
  updateAdmin,
  revokeAdminSessions,
  resetPassword,
  getPolicy,
  updatePolicy,
  adminRequestHash,
};
