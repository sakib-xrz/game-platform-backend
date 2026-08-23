import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import PlatformAppController from './platform-app.controller';
import {
  createPlatformAppSchema,
  platformAppIdSchema,
  updatePlatformAppSchema,
} from './platform-app.validation';

export const PlatformAppRoutes = express.Router();

PlatformAppRoutes.use(adminAuth, adminPasswordGate);

PlatformAppRoutes.get(
  '/',
  requireAdminPermission('platform.app.read'),
  PlatformAppController.listPlatformApps,
);
PlatformAppRoutes.get(
  '/:app_id',
  requireAdminPermission('platform.app.read'),
  validateRequest(platformAppIdSchema),
  PlatformAppController.getPlatformApp,
);
PlatformAppRoutes.post(
  '/',
  requireAdminPermission('platform.app.manage'),
  requireAdminIdempotency('platform.app.create'),
  validateRequest(createPlatformAppSchema),
  PlatformAppController.createPlatformApp,
);
PlatformAppRoutes.patch(
  '/:app_id',
  requireAdminPermission('platform.app.manage'),
  requireAdminIdempotency('platform.app.update'),
  validateRequest(updatePlatformAppSchema),
  PlatformAppController.updatePlatformApp,
);
PlatformAppRoutes.delete(
  '/:app_id',
  requireAdminPermission('platform.app.manage'),
  requireAdminIdempotency('platform.app.delete'),
  validateRequest(platformAppIdSchema),
  PlatformAppController.deletePlatformApp,
);

export default PlatformAppRoutes;
