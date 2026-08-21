import express from 'express';
import multer from 'multer';
import validateRequest from '@/middlewares/validate-request';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import Controller from './greedy-classic-admin-ops.controller';
import AssetController from './greedy-classic-admin-assets.controller';
import { alertListSchema, alertParamSchema, assetIdParamSchema, assetPresignSchema, availabilitySchema, auditLogSchema, configIdParamSchema, configUpdateSchema, metricsSchema, roundBetsSchema, roundListSchema, roundParamSchema, userParamSchema } from './greedy-classic-admin-ops.validation';

const router = express.Router();
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
});
router.get('/overview', requireAdminPermission('dashboard.read'), Controller.getOverview);
router.get('/health', requireAdminPermission('ops.read'), Controller.getOperationsHealth);
router.get('/alerts', requireAdminPermission('ops.read'), validateRequest(alertListSchema), Controller.listAlerts);
router.post('/alerts/:alert_id/acknowledge', requireAdminPermission('ops.alert.manage'), requireAdminIdempotency('greedy_classic.alert.acknowledge'), validateRequest(alertParamSchema), Controller.acknowledgeAlert);
router.post('/alerts/:alert_id/resolve', requireAdminPermission('ops.alert.manage'), requireAdminIdempotency('greedy_classic.alert.resolve'), validateRequest(alertParamSchema), Controller.resolveAlert);
router.get('/metrics', requireAdminPermission('dashboard.read'), validateRequest(metricsSchema), Controller.getMetrics);
router.get('/audit-logs', requireAdminPermission('audit.read'), validateRequest(auditLogSchema), Controller.listAuditLogs);
router.get('/config-versions/:config_id', requireAdminPermission('game.read'), validateRequest(configIdParamSchema), Controller.getConfig);
router.put('/config-versions/:config_id', requireAdminPermission('game.config.draft.create'), requireAdminIdempotency('greedy_classic.config.draft.update'), validateRequest(configUpdateSchema), Controller.updateDraft);
router.post('/config-versions/:config_id/clone', requireAdminPermission('game.config.draft.create'), requireAdminIdempotency('greedy_classic.config.draft.clone'), validateRequest(configIdParamSchema), Controller.cloneConfig);
router.get('/rounds', requireAdminPermission('round.read'), validateRequest(roundListSchema), Controller.listRounds);
router.get('/rounds/:round_id/bets', requireAdminPermission('round.read'), validateRequest(roundBetsSchema), Controller.listRoundBets);
router.get('/rounds/:round_id/result-verification', requireAdminPermission('round.read'), validateRequest(roundParamSchema), Controller.verifyRoundResult);
router.get('/rounds/:round_id', requireAdminPermission('round.read'), validateRequest(roundParamSchema), Controller.getRound);
router.get('/users/:user_id', requireAdminPermission('wallet.read'), validateRequest(userParamSchema), Controller.getUserSummary);
router.post('/availability', requireAdminPermission('game.runtime.control'), requireAdminIdempotency('greedy_classic.availability.update'), validateRequest(availabilitySchema), Controller.setAvailability);
router.get('/assets', requireAdminPermission('asset.manage'), AssetController.listAssets);
router.get('/assets/:asset_id', requireAdminPermission('asset.manage'), validateRequest(assetIdParamSchema), AssetController.getAsset);
router.post('/assets/presign', requireAdminPermission('asset.manage'), requireAdminIdempotency('greedy_classic.asset.presign'), validateRequest(assetPresignSchema), AssetController.presignAsset);
router.post('/assets/:asset_id/complete', requireAdminPermission('asset.manage'), requireAdminIdempotency('greedy_classic.asset.complete'), validateRequest(assetIdParamSchema), AssetController.completeAsset);
router.post('/assets', requireAdminPermission('asset.manage'), assetUpload.single('file'), requireAdminIdempotency('greedy_classic.asset.upload'), AssetController.uploadAsset);
router.delete('/assets/:asset_id', requireAdminPermission('asset.manage'), requireAdminIdempotency('greedy_classic.asset.delete'), AssetController.deleteAsset);

export default router;
