import express from 'express';
import validateRequest from '@/middlewares/validate-request';
import { integrationRateLimiter } from '@/middlewares/rate-limiter';
import platformAppCredentials from '@/middlewares/platform-app-credentials';
import PlatformIntegrationController from './platform-integration.controller';
import {
  creditPlatformUserCoinsSchema,
  externalUserIdParamSchema,
  getGamesQuerySchema,
  launchGameSchema,
  launchPlatformUserSchema,
  syncBalanceSchema,
  syncPlatformUserSchema,
  verifySessionSchema,
  withdrawPlatformUserCoinsSchema,
} from './platform-integration.validation';

export const PlatformIntegrationRoutes = express.Router();

PlatformIntegrationRoutes.use(integrationRateLimiter);

// 1. Standard B2B Game Catalog & Session Verification
PlatformIntegrationRoutes.get(
  '/games',
  validateRequest(getGamesQuerySchema),
  PlatformIntegrationController.getGameCatalog,
);

PlatformIntegrationRoutes.post(
  '/session/verify',
  validateRequest(verifySessionSchema),
  PlatformIntegrationController.verifySession,
);

PlatformIntegrationRoutes.post(
  '/launch',
  validateRequest(launchGameSchema),
  PlatformIntegrationController.launchGame,
);

PlatformIntegrationRoutes.post(
  '/wallet/sync',
  validateRequest(syncBalanceSchema),
  PlatformIntegrationController.syncBalance,
);

// 2. Legacy Platform App Routes
PlatformIntegrationRoutes.post(
  '/users/sync',
  validateRequest(syncPlatformUserSchema),
  PlatformIntegrationController.syncPlatformUser,
);
PlatformIntegrationRoutes.post(
  '/users/coins',
  validateRequest(creditPlatformUserCoinsSchema),
  platformAppCredentials,
  PlatformIntegrationController.creditPlatformUserCoins,
);
PlatformIntegrationRoutes.post(
  '/users/coins/withdraw',
  validateRequest(withdrawPlatformUserCoinsSchema),
  platformAppCredentials,
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
