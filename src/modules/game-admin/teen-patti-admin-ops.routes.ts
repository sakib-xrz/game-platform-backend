import express from 'express';
import multer from 'multer';
import validateRequest from '@/middlewares/validate-request';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import Controller from './teen-patti-admin-ops.controller';
import AssetController from './teen-patti-admin-assets.controller';
import { alertListSchema, alertParamSchema, assetIdParamSchema, assetPresignSchema, availabilitySchema, auditLogSchema, configIdParamSchema, configUpdateSchema, metricsSchema, roundBetsSchema, roundListSchema, roundParamSchema, userParamSchema } from './teen-patti-admin-ops.validation';

const router = express.Router();
const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
});
router.get('/overview', requireAdminPermission('dashboard.read'), Controller.getOverview);
router.get('/health', requireAdminPermission('ops.read'), Controller.getOperationsHealth);
router.get('/alerts', requireAdminPermission('ops.read'), validateRequest(alertListSchema), Controller.listAlerts);
router.post('/alerts/:alert_id/acknowledge', requireAdminPermission('ops.alert.manage'), requireAdminIdempotency('teen_patti.alert.acknowledge'), validateRequest(alertParamSchema), Controller.acknowledgeAlert);
router.post('/alerts/:alert_id/resolve', requireAdminPermission('ops.alert.manage'), requireAdminIdempotency('teen_patti.alert.resolve'), validateRequest(alertParamSchema), Controller.resolveAlert);
router.get('/metrics', requireAdminPermission('dashboard.read'), validateRequest(metricsSchema), Controller.getMetrics);
router.get('/audit-logs', requireAdminPermission('audit.read'), validateRequest(auditLogSchema), Controller.listAuditLogs);
router.get('/config-versions/:config_id', requireAdminPermission('game.read'), validateRequest(configIdParamSchema), Controller.getConfig);
router.put('/config-versions/:config_id', requireAdminPermission('game.config.draft.create'), requireAdminIdempotency('teen_patti.config.draft.update'), validateRequest(configUpdateSchema), Controller.updateDraft);
router.post('/config-versions/:config_id/clone', requireAdminPermission('game.config.draft.create'), requireAdminIdempotency('teen_patti.config.draft.clone'), validateRequest(configIdParamSchema), Controller.cloneConfig);
router.get('/rounds', requireAdminPermission('round.read'), validateRequest(roundListSchema), Controller.listRounds);
router.get('/rounds/:round_id/bets', requireAdminPermission('round.read'), validateRequest(roundBetsSchema), Controller.listRoundBets);
router.get('/rounds/:round_id/result-verification', requireAdminPermission('round.read'), validateRequest(roundParamSchema), Controller.verifyRoundResult);
router.get('/rounds/:round_id', requireAdminPermission('round.read'), validateRequest(roundParamSchema), Controller.getRound);
router.get('/users/:user_id', requireAdminPermission('wallet.read'), validateRequest(userParamSchema), Controller.getUserSummary);
router.post('/availability', requireAdminPermission('game.runtime.control'), requireAdminIdempotency('teen_patti.availability.update'), validateRequest(availabilitySchema), Controller.setAvailability);
router.get('/assets', requireAdminPermission('asset.manage'), AssetController.listAssets);
router.get('/assets/:asset_id', requireAdminPermission('asset.manage'), validateRequest(assetIdParamSchema), AssetController.getAsset);
router.post('/assets/presign', requireAdminPermission('asset.manage'), requireAdminIdempotency('teen_patti.asset.presign'), validateRequest(assetPresignSchema), AssetController.presignAsset);
router.post('/assets/:asset_id/complete', requireAdminPermission('asset.manage'), requireAdminIdempotency('teen_patti.asset.complete'), validateRequest(assetIdParamSchema), AssetController.completeAsset);
router.post('/assets', requireAdminPermission('asset.manage'), assetUpload.single('file'), requireAdminIdempotency('teen_patti.asset.upload'), AssetController.uploadAsset);
router.delete('/assets/:asset_id', requireAdminPermission('asset.manage'), requireAdminIdempotency('teen_patti.asset.delete'), AssetController.deleteAsset);

export default router;
