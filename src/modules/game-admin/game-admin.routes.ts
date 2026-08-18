import express from 'express';
import adminKeyGuard from '@/middlewares/admin-key';
import validateRequest from '@/middlewares/validate-request';
import GameAdminController from './game-admin.controller';
import { cancelRoundSchema, configParamSchema, createGreedyConfigSchema } from './game-admin.validation';

export const GameAdminRoutes = express.Router();
GameAdminRoutes.use(adminKeyGuard);
GameAdminRoutes.get('/greedy/runtime', GameAdminController.getRuntime);
GameAdminRoutes.get('/greedy/config-versions', GameAdminController.listConfigs);
GameAdminRoutes.post('/greedy/config-versions', validateRequest(createGreedyConfigSchema), GameAdminController.createConfig);
GameAdminRoutes.post('/greedy/config-versions/:config_id/publish', validateRequest(configParamSchema), GameAdminController.publishConfig);
GameAdminRoutes.post('/greedy/resume', GameAdminController.resume);
GameAdminRoutes.post('/greedy/pause', GameAdminController.pause);
GameAdminRoutes.post('/greedy/cancel-current-round', validateRequest(cancelRoundSchema), GameAdminController.cancelCurrentRound);
