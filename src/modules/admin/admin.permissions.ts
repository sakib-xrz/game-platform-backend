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
  'platform.app.read',
  'platform.app.manage',
  'platform.user.read',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const PLATFORM_SUPER_ADMIN_PERMISSIONS = [
  'dashboard.read',
  'admin.manage',
  'approval.read',
  'approval.decide',
  'audit.read',
  'wallet.read',
  'wallet.adjust.create',
  'wallet.adjust.approve',
  'platform.app.read',
  'platform.app.manage',
  'platform.user.read',
] as const satisfies readonly AdminPermission[];

const GAME_OPERATOR_PERMISSIONS = [
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
] as const satisfies readonly AdminPermission[];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  [AdminRole.dev_super_admin]: ADMIN_PERMISSIONS,
  [AdminRole.super_admin]: PLATFORM_SUPER_ADMIN_PERMISSIONS,
  [AdminRole.game_operator]: GAME_OPERATOR_PERMISSIONS,
  [AdminRole.finance_operator]: [
    'approval.read',
    'approval.decide',
    'game.read',
    'round.read',
    'wallet.read',
    'wallet.adjust.create',
    'wallet.adjust.approve',
    'platform.user.read',
    'ops.read',
  ],
  [AdminRole.support]: [
    'game.read',
    'round.read',
    'wallet.read',
    'platform.user.read',
  ],
  [AdminRole.auditor]: [
    'dashboard.read',
    'approval.read',
    'game.read',
    'round.read',
    'wallet.read',
    'platform.user.read',
    'audit.read',
    'ops.read',
  ],
};

export const hasAdminPermission = (role: AdminRole, permission: AdminPermission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const permissionsForRole = (role: AdminRole): readonly AdminPermission[] =>
  ROLE_PERMISSIONS[role];

export const canManageGameAvailability = (role?: AdminRole): boolean =>
  role === AdminRole.dev_super_admin || role === AdminRole.game_operator;

export const canViewGameEntropy = (role?: AdminRole): boolean =>
  role === AdminRole.dev_super_admin || role === AdminRole.auditor;
