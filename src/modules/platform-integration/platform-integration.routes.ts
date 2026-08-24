import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import { integrationRateLimiter } from '@/middlewares/rate-limiter';
import PlatformIntegrationController from './platform-integration.controller';
import {
  creditPlatformUserCoinsSchema,
  externalUserIdParamSchema,
  launchPlatformUserSchema,
  syncPlatformUserSchema,
  withdrawPlatformUserCoinsSchema,
} from './platform-integration.validation';

export const PlatformIntegrationRoutes = express.Router();

PlatformIntegrationRoutes.use(integrationRateLimiter);

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
  '/users/launch',
  validateRequest(launchPlatformUserSchema),
  PlatformIntegrationController.launchPlatformUser,
);
PlatformIntegrationRoutes.get(
  '/users/:external_user_id/coins',
  validateRequest(externalUserIdParamSchema),
  PlatformIntegrationController.getPlatformUserCoins,
);

export default PlatformIntegrationRoutes;
