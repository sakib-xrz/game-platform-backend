import express from 'express';
import playerContext from '@/middlewares/player-context';
import adminKeyGuard from '@/middlewares/admin-key';
import validateRequest from '@/middlewares/validate-request';
import WalletController from './wallet.controller';
import { adminAdjustWalletSchema, walletHistorySchema } from './wallet.validation';

export const WalletRoutes = express.Router();
WalletRoutes.get('/me', playerContext, WalletController.getMyWallet);
WalletRoutes.get('/me/transactions', playerContext, validateRequest(walletHistorySchema), WalletController.getTransactions);

export const WalletAdminRoutes = express.Router();
WalletAdminRoutes.post('/adjust', adminKeyGuard, validateRequest(adminAdjustWalletSchema), WalletController.adminAdjustWallet);
