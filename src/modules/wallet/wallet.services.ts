import httpStatus from 'http-status';
import { AuditActorType, Prisma, WalletLedgerType } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { getPagination } from '@/utils/pagination';
import type { AdminAdjustWalletBody } from './wallet.validation';

const DEFAULT_CURRENCY_CODE = 'COIN';

const getCurrency = async (tx: Prisma.TransactionClient = prisma) => {
  const currency = await tx.currency.findUnique({
    where: { code: DEFAULT_CURRENCY_CODE },
  });
  if (!currency || !currency.is_active) {
    throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Game currency is unavailable');
  }
  return currency;
};

export const ensureWallet = async (
  user_id: string,
  tx: Prisma.TransactionClient = prisma,
) => {
  const currency = await getCurrency(tx);
  return tx.wallet.upsert({
    where: {
      user_id_currency_id: { user_id, currency_id: currency.id },
    },
    create: { user_id, currency_id: currency.id },
    update: {},
    include: { currency: true },
  });
};

const getMyWallet = async (user_id: string) => ensureWallet(user_id);

const getTransactions = async (user_id: string, page = 1, limit = 20) => {
  const wallet = await ensureWallet(user_id);
  const pagination = getPagination(page, limit);
  const [items, total] = await prisma.$transaction([
    prisma.walletLedger.findMany({
      where: { wallet_id: wallet.id },
      orderBy: { created_at: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.walletLedger.count({ where: { wallet_id: wallet.id } }),
  ]);
  return { items, total, ...pagination };
};

const adminAdjustWallet = async (payload: AdminAdjustWalletBody) => {
  const amount = BigInt(payload.amount);
  if (amount === 0n) throw new AppError(httpStatus.BAD_REQUEST, 'amount cannot be zero');

  return prisma.$transaction(async (tx) => {
    const wallet = await ensureWallet(payload.user_id, tx);
    const balance_after = wallet.balance + amount;
    if (balance_after < 0n) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Wallet balance cannot become negative');
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: balance_after,
        version: { increment: 1 },
      },
    });

    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id,
        user_id: payload.user_id,
        type: amount > 0n ? WalletLedgerType.admin_credit : WalletLedgerType.admin_debit,
        amount,
        balance_before: wallet.balance,
        balance_after,
        reference_type: 'admin_adjustment',
        metadata: { reason: payload.reason },
      },
    });

    await tx.auditLog.create({
      data: {
        actor_type: AuditActorType.admin,
        action: 'wallet.admin_adjusted',
        entity_type: 'wallet',
        entity_id: wallet.id,
        new_values: {
          user_id: payload.user_id,
          amount: amount.toString(),
          reason: payload.reason,
          ledger_id: ledger.id,
        },
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'wallet',
        aggregate_id: wallet.id,
        event_type: 'wallet.balance.updated',
        socket_room: `user:${payload.user_id}`,
        payload: {
          wallet_id: wallet.id,
          balance: balance_after.toString(),
          reason: 'admin_adjustment',
        },
      },
    });

    return { wallet: updated, ledger };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

const WalletService = {
  getMyWallet,
  getTransactions,
  adminAdjustWallet,
};

export default WalletService;
