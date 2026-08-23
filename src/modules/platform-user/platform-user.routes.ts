import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import PlatformUserController from './platform-user.controller';
import {
  adminPlatformUserIdSchema,
  adminPlatformUserLedgerSchema,
  adminPlatformUserSearchSchema,
} from './platform-user.validation';

export const PlatformUserRoutes = express.Router();

PlatformUserRoutes.use(adminAuth, adminPasswordGate);

PlatformUserRoutes.get(
  '/apps',
  requireAdminPermission('platform.user.read'),
  PlatformUserController.listPlatformAppsForFilter,
);
PlatformUserRoutes.get(
  '/',
  requireAdminPermission('platform.user.read'),
  validateRequest(adminPlatformUserSearchSchema),
  PlatformUserController.listAdminPlatformUsers,
);
PlatformUserRoutes.get(
  '/:user_id',
  requireAdminPermission('platform.user.read'),
  validateRequest(adminPlatformUserIdSchema),
  PlatformUserController.getAdminPlatformUser,
);
PlatformUserRoutes.get(
  '/:user_id/ledger',
  requireAdminPermission('platform.user.read'),
  validateRequest(adminPlatformUserLedgerSchema),
  PlatformUserController.listAdminPlatformUserLedger,
);

export default PlatformUserRoutes;
