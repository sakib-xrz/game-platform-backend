import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import AssetService from './lucky-77-admin-assets.services';
import { requestAuditContext } from '@/modules/admin/admin.request';

const uploadAsset = catchAsync(async (req, res) => sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Lucky77 asset uploaded', data: await AssetService.uploadAsset(req.file, requestAuditContext(req)) }));
const presignAsset = catchAsync(async (req, res) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky77 asset upload URL created', data: await AssetService.presignAsset(req.body, requestAuditContext(req)) }));
const completeAsset = catchAsync(async (req, res) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky77 asset completed', data: await AssetService.completePresignedAsset(String(req.params.asset_id), requestAuditContext(req)) }));
const listAssets = catchAsync(async (_req, res) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky77 assets fetched', data: await AssetService.listAssets() }));
const getAsset = catchAsync(async (req, res) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky77 asset fetched', data: await AssetService.getAsset(String(req.params.asset_id)) }));
const deleteAsset = catchAsync(async (req, res) => sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Lucky77 asset deleted', data: await AssetService.deleteAsset(String(req.params.asset_id), requestAuditContext(req)) }));

export default { uploadAsset, presignAsset, completeAsset, listAssets, getAsset, deleteAsset };
