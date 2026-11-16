import express from 'express';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import HouseProfitAdminController from './house-profit.controller';

export const HouseProfitAdminRoutes = express.Router();

HouseProfitAdminRoutes.use(adminAuth, adminPasswordGate);

// Get Tecsior-style Overview & P&L metrics
HouseProfitAdminRoutes.get(
  '/overview',
  requireAdminPermission('game.read'),
  HouseProfitAdminController.getOverview,
);

// Get House Profit configuration
HouseProfitAdminRoutes.get(
  '/config/:game_code',
  requireAdminPermission('game.read'),
  HouseProfitAdminController.getConfig,
);

// Update House Profit configuration
HouseProfitAdminRoutes.put(
  '/config/:game_code',
  requireAdminPermission('game.runtime.control'),
  requireAdminIdempotency('game.house_profit.update'),
  HouseProfitAdminController.updateConfig,
);

export default HouseProfitAdminRoutes;

