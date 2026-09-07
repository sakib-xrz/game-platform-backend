import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import AnalyticsController from './analytics.controller';
import {
  analyticsOverviewSchema,
  analyticsUserDetailSchema,
  analyticsUsersSchema,
} from './analytics.validation';

export const AnalyticsRoutes = express.Router();

AnalyticsRoutes.use(adminAuth, adminPasswordGate);

AnalyticsRoutes.get(
  '/overview',
  requireAdminPermission('dashboard.read'),
  validateRequest(analyticsOverviewSchema),
  AnalyticsController.getOverview,
);

AnalyticsRoutes.get(
  '/users',
  requireAdminPermission('dashboard.read'),
  validateRequest(analyticsUsersSchema),
  AnalyticsController.listUsers,
);

AnalyticsRoutes.get(
  '/users/:user_id',
  requireAdminPermission('dashboard.read'),
  validateRequest(analyticsUserDetailSchema),
  AnalyticsController.getUserDetail,
);

export default AnalyticsRoutes;
