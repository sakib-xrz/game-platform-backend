import express from 'express';
import playerContext from '@/middlewares/player-context';
import adminAuth from '@/middlewares/admin-auth';
import adminPasswordGate from '@/middlewares/admin-password-gate';
import { requireAdminPermission } from '@/middlewares/admin-permission';
import { requireAdminIdempotency } from '@/middlewares/admin-idempotency';
import validateRequest from '@/middlewares/validate-request';
import WalletController from './wallet.controller';
import { adminAdjustWalletSchema, adminWalletSearchSchema, walletHistorySchema } from './wallet.validation';

export const WalletRoutes = express.Router();
WalletRoutes.get('/me', playerContext, WalletController.getMyWallet);
WalletRoutes.get('/me/transactions', playerContext, validateRequest(walletHistorySchema), WalletController.getTransactions);

export const WalletAdminRoutes = express.Router();
WalletAdminRoutes.get('/', adminAuth, adminPasswordGate, requireAdminPermission('wallet.read'), validateRequest(adminWalletSearchSchema), WalletController.listAdminWallets);
WalletAdminRoutes.post('/adjust', adminAuth, adminPasswordGate, requireAdminPermission('wallet.adjust.create'), requireAdminIdempotency('wallet.adjust'), validateRequest(adminAdjustWalletSchema), WalletController.adminAdjustWallet);
