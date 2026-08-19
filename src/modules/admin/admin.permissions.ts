import { AdminRole } from '@/generated/prisma/client';

export const ADMIN_PERMISSIONS = [
  'admin.manage',
  'approval.read',
  'approval.decide',
  'audit.read',
  'dashboard.read',
  'game.read',
  'game.config.draft.create',
  'game.config.publish',
  'game.runtime.control',
  'round.read',
  'round.cancel',
  'wallet.read',
  'wallet.adjust.create',
  'wallet.adjust.approve',
  'asset.manage',
  'ops.read',
  'ops.alert.manage',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  [AdminRole.super_admin]: ADMIN_PERMISSIONS,
  [AdminRole.game_operator]: [
    'dashboard.read',
    'approval.read',
    'approval.decide',
    'game.read',
    'game.config.draft.create',
    'game.config.publish',
    'game.runtime.control',
    'round.read',
    'round.cancel',
    'asset.manage',
    'ops.read',
    'ops.alert.manage',
  ],
  [AdminRole.finance_operator]: [
    'approval.read',
    'approval.decide',
    'game.read',
    'round.read',
    'wallet.read',
    'wallet.adjust.create',
    'wallet.adjust.approve',
    'ops.read',
  ],
  [AdminRole.support]: [
    'game.read',
    'round.read',
    'wallet.read',
  ],
  [AdminRole.auditor]: [
    'dashboard.read',
    'approval.read',
    'game.read',
    'round.read',
    'wallet.read',
    'audit.read',
    'ops.read',
  ],
};

export const hasAdminPermission = (role: AdminRole, permission: AdminPermission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const permissionsForRole = (role: AdminRole): readonly AdminPermission[] =>
  ROLE_PERMISSIONS[role];
