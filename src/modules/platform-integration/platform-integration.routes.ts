import express from 'express';
import platformAppAuth from '@/middlewares/platform-app-auth';
import validateRequest from '@/middlewares/validate-request';
import { integrationRateLimiter } from '@/middlewares/rate-limiter';
import PlatformIntegrationController from './platform-integration.controller';
import {
  creditPlatformUserCoinsSchema,
  externalUserIdParamSchema,
  syncPlatformUserSchema,
  withdrawPlatformUserCoinsSchema,
} from './platform-integration.validation';

export const PlatformIntegrationRoutes = express.Router();

PlatformIntegrationRoutes.use(integrationRateLimiter, platformAppAuth);

PlatformIntegrationRoutes.post(
  '/users/sync',
  validateRequest(syncPlatformUserSchema),
  PlatformIntegrationController.syncPlatformUser,
);
PlatformIntegrationRoutes.post(
  '/users/coins',
  validateRequest(creditPlatformUserCoinsSchema),
  PlatformIntegrationController.creditPlatformUserCoins,
);
PlatformIntegrationRoutes.post(
  '/users/coins/withdraw',
  validateRequest(withdrawPlatformUserCoinsSchema),
  PlatformIntegrationController.withdrawPlatformUserCoins,
);
PlatformIntegrationRoutes.get(
  '/users/:external_user_id/coins',
  validateRequest(externalUserIdParamSchema),
  PlatformIntegrationController.getPlatformUserCoins,
);

export default PlatformIntegrationRoutes;
