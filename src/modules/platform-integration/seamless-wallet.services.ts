import httpStatus from 'http-status';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { Prisma, WalletLedgerType } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import {
  SeamlessAppConfig,
  SeamlessWalletClient,
} from './seamless-wallet.client';
import { logger } from '@/utils/logger';

export type UserWalletContext = {
  isSeamless: boolean;
  platformApp?: SeamlessAppConfig;
  externalUserId?: string;
  localUserId: string;
};

// Fast in-memory LRU-style cache for app wallet modes (1 minute TTL)
const userAppCache = new Map<
  string,
  { context: UserWalletContext; expiresAt: number }
>();

export async function getUserWalletContext(
  userId: string,
): Promise<UserWalletContext> {
  const cached = userAppCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  if (!prisma?.platformUser?.findUnique) {
    const context: UserWalletContext = {
      isSeamless: false,
      localUserId: userId,
    };
    return context;
  }

  const user = await prisma.platformUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      external_user_id: true,
      platform_app: {
        select: {
          id: true,
          app_name: true,
          app_key: true,
          package_name: true,
          wallet_mode: true,
          wallet_base_url: true,
          signing_secret: true,
          signing_secret_previous: true,
        },
      },
    },
  });

  if (!user || !user.platform_app || user.platform_app.wallet_mode !== 'seamless') {
    const context: UserWalletContext = {
      isSeamless: false,
      localUserId: userId,
    };
    userAppCache.set(userId, { context, expiresAt: Date.now() + 60000 });
    return context;
  }

  const context: UserWalletContext = {
    isSeamless: true,
    platformApp: user.platform_app,
    externalUserId: user.external_user_id,
    localUserId: userId,
  };

  userAppCache.set(userId, { context, expiresAt: Date.now() + 60000 });
  return context;
}

export function invalidateUserWalletCache(userId: string) {
  userAppCache.delete(userId);
}

/**
 * Synchronizes user's balance from the host app if in seamless mode.
 */
export async function syncSeamlessUserBalance(userId: string): Promise<bigint> {
  const context = await getUserWalletContext(userId);
  if (!context.isSeamless || !context.platformApp || !context.externalUserId) {
    const wallet = await ensureWallet(userId);
    return wallet.balance;
  }

  const remoteBalance = await SeamlessWalletClient.getRemoteBalance(
    context.platformApp,
    context.externalUserId,
  );

  const wallet = await ensureWallet(userId);
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: remoteBalance,
      version: { increment: 1 },
    },
  });

  return remoteBalance;
}

/**
 * Executes a bet debit. If the user is connected to a seamless wallet,
 * calls the host app's debit endpoint before accepting the bet.
 */
export async function processSeamlessBetDebit(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    amount: bigint;
    betId: string;
    gameId: string;
    gameCode: string;
    roundId: string;
    clientRequestId: string;
  },
): Promise<{
  walletId: string;
  balanceBefore: bigint;
  balanceAfter: bigint;
  version: number;
  ledgerId: string;
}> {
  const context = await getUserWalletContext(params.userId);

  if (context.isSeamless && context.platformApp && context.externalUserId) {
    // 1. Debit from 3rd-party host app
    const idempotencyKey = `game-bet:${params.betId}`;
    const debitResult = await SeamlessWalletClient.debitRemoteBet(
      context.platformApp,
      {
        externalUserId: context.externalUserId,
        amount: params.amount,
        idempotencyKey,
        gameCode: params.gameCode,
        roundId: params.roundId,
      },
    );

    // 2. Ensure local wallet and sync balance
    const wallet = await ensureWallet(params.userId, tx);
    const balanceBefore = wallet.balance;
    const balanceAfter =
      debitResult.balanceAfter !== undefined
        ? debitResult.balanceAfter
        : balanceBefore >= params.amount
          ? balanceBefore - params.amount
          : 0n;

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: balanceAfter,
        version: { increment: 1 },
      },
    });

    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id,
        user_id: params.userId,
        game_id: params.gameId,
        type: WalletLedgerType.bet_debit,
        amount: -params.amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reference_type: `${params.gameCode}_bet`,
        reference_id: params.betId,
        idempotency_key: params.clientRequestId,
        metadata: {
          seamless: true,
          external_tx_id: debitResult.txId,
          host_app: context.platformApp.app_name,
        },
      },
    });

    return {
      walletId: wallet.id,
      balanceBefore,
      balanceAfter,
      version: updated.version,
      ledgerId: ledger.id,
    };
  }

  // Local wallet debit
  const walletRows = await tx.$queryRaw<
    Array<{
      id: string;
      balance_before: bigint;
      balance_after: bigint;
      version: number;
    }>
  >(Prisma.sql`
    UPDATE wallets AS wallet
    SET
      balance = wallet.balance - ${params.amount},
      version = wallet.version + 1,
      updated_at = CURRENT_TIMESTAMP
    FROM currencies AS currency
    WHERE wallet.user_id = ${params.userId}
      AND wallet.currency_id = currency.id
      AND currency.code = 'COIN'
      AND currency.is_active = TRUE
      AND wallet.balance >= ${params.amount}
    RETURNING
      wallet.id,
      wallet.balance + ${params.amount} AS balance_before,
      wallet.balance AS balance_after,
      wallet.version
  `);

  const debitedWallet = walletRows[0];
  if (!debitedWallet) {
    const wallet = await tx.wallet.findFirst({
      where: {
        user_id: params.userId,
        currency: { code: 'COIN', is_active: true },
      },
      select: { balance: true },
    });
    if (!wallet) {
      throw new AppError(httpStatus.NOT_FOUND, 'Player wallet not initialized');
    }
    if (wallet.balance >= params.amount) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Wallet balance changed; retry the bet',
      );
    }
    throw new AppError(httpStatus.BAD_REQUEST, 'Insufficient wallet balance');
  }

  const ledger = await tx.walletLedger.create({
    data: {
      wallet_id: debitedWallet.id,
      user_id: params.userId,
      game_id: params.gameId,
      type: WalletLedgerType.bet_debit,
      amount: -params.amount,
      balance_before: debitedWallet.balance_before,
      balance_after: debitedWallet.balance_after,
      reference_type: `${params.gameCode}_bet`,
      reference_id: params.betId,
      idempotency_key: params.clientRequestId,
    },
  });

  return {
    walletId: debitedWallet.id,
    balanceBefore: debitedWallet.balance_before,
    balanceAfter: debitedWallet.balance_after,
    version: debitedWallet.version,
    ledgerId: ledger.id,
  };
}

/**
 * Handles round payouts for seamless and local wallets.
 */
export async function processSeamlessPayoutCredit(
  tx: Prisma.TransactionClient,
  params: {
    userId: string;
    amount: bigint;
    gameId: string;
    gameCode: string;
    roundId: string;
    referenceType: string;
  },
): Promise<{
  walletId: string;
  balanceBefore: bigint;
  balanceAfter: bigint;
  walletVersion: number;
  ledgerId: string;
}> {
  const context = await getUserWalletContext(params.userId);

  if (context.isSeamless && context.platformApp && context.externalUserId) {
    const idempotencyKey = `game-payout:${params.roundId}:${params.userId}`;
    const creditResult = await SeamlessWalletClient.creditRemotePayout(
      context.platformApp,
      {
        externalUserId: context.externalUserId,
        amount: params.amount,
        idempotencyKey,
        type: 'game_payout',
        gameCode: params.gameCode,
        roundId: params.roundId,
      },
    );

    const wallet = await ensureWallet(params.userId, tx);
    const balanceBefore = wallet.balance;
    const balanceAfter =
      creditResult.balanceAfter !== undefined
        ? creditResult.balanceAfter
        : balanceBefore + params.amount;

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: balanceAfter,
        version: { increment: 1 },
      },
    });

    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id,
        user_id: params.userId,
        game_id: params.gameId,
        type: WalletLedgerType.win_credit,
        amount: params.amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reference_type: params.referenceType,
        reference_id: params.roundId,
        metadata: {
          seamless: true,
          external_tx_id: creditResult.txId,
          host_app: context.platformApp.app_name,
        },
      },
    });

    return {
      walletId: wallet.id,
      balanceBefore,
      balanceAfter,
      walletVersion: updated.version,
      ledgerId: ledger.id,
    };
  }

  // Local wallet credit
  const wallet = await ensureWallet(params.userId, tx);
  const updatedWallet = await tx.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: { increment: params.amount },
      version: { increment: 1 },
    },
  });

  const ledger = await tx.walletLedger.create({
    data: {
      wallet_id: wallet.id,
      user_id: params.userId,
      game_id: params.gameId,
      type: WalletLedgerType.win_credit,
      amount: params.amount,
      balance_before: wallet.balance,
      balance_after: updatedWallet.balance,
      reference_type: params.referenceType,
      reference_id: params.roundId,
    },
  });

  return {
    walletId: wallet.id,
    balanceBefore: wallet.balance,
    balanceAfter: updatedWallet.balance,
    walletVersion: updatedWallet.version,
    ledgerId: ledger.id,
  };
}
