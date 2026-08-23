import httpStatus from 'http-status';
import { randomUUID } from 'node:crypto';
import { AdminApprovalStatus, AuditActorType, Prisma, WalletLedgerType } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { getPagination } from '@/utils/pagination';
import type { AdminAdjustWalletBody } from './wallet.validation';
import type { WalletBalanceUpdatedPayload } from './wallet.types';
import type { AdminAuditContext } from '@/modules/admin/admin.services';
import { createPendingApproval, markApprovalApplied, verifyApprovalPayloadHash } from '@/modules/admin/admin-approval.services';

const DEFAULT_CURRENCY_CODE = 'COIN';

export class WalletInitializationRequiredError extends Error {
  constructor() {
    super('Player wallet must be initialized before retrying the operation');
    this.name = 'WalletInitializationRequiredError';
  }
}

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
  const include = { currency: true } as const;

  // Existing players are the overwhelmingly common path. Resolve the wallet
  // and its active currency in one query instead of first looking the currency
  // up and then looking the wallet up. This is especially important for every
  // game snapshot, which is polled throughout a round.
  const existing = await tx.wallet.findFirst({
    where: {
      user_id,
      currency: { code: DEFAULT_CURRENCY_CODE, is_active: true },
    },
    include,
  });
  if (existing) return existing;

  // The cold path is one atomic statement. A Prisma currency lookup + create +
  // relation fetch adds three remote-database round trips to a player's first
  // snapshot, and a normal upsert can race concurrent first requests.
  const initialized = await tx.$queryRaw<Array<{
    wallet_id: string;
    user_id: string;
    currency_id: string;
    balance: bigint;
    version: number;
    wallet_created_at: Date;
    wallet_updated_at: Date;
    currency_code: string;
    currency_name: string;
    currency_symbol: string | null;
    currency_is_active: boolean;
    currency_created_at: Date;
    currency_updated_at: Date;
  }>>(Prisma.sql`
    WITH initialized_wallet AS (
      INSERT INTO wallets (id, user_id, currency_id, updated_at)
      SELECT
        ${randomUUID()},
        ${user_id},
        currency.id,
        CURRENT_TIMESTAMP
      FROM currencies AS currency
      WHERE currency.code = ${DEFAULT_CURRENCY_CODE}
        AND currency.is_active = TRUE
      ON CONFLICT (user_id, currency_id)
      DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING *
    )
    SELECT
      wallet.id AS wallet_id,
      wallet.user_id,
      wallet.currency_id,
      wallet.balance,
      wallet.version,
      wallet.created_at AS wallet_created_at,
      wallet.updated_at AS wallet_updated_at,
      currency.code AS currency_code,
      currency.name AS currency_name,
      currency.symbol AS currency_symbol,
      currency.is_active AS currency_is_active,
      currency.created_at AS currency_created_at,
      currency.updated_at AS currency_updated_at
    FROM initialized_wallet AS wallet
    JOIN currencies AS currency ON currency.id = wallet.currency_id
  `);
  const row = initialized[0];
  if (!row) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Game currency is unavailable',
    );
  }

  return {
    id: row.wallet_id,
    user_id: row.user_id,
    currency_id: row.currency_id,
    balance: row.balance,
    version: row.version,
    created_at: row.wallet_created_at,
    updated_at: row.wallet_updated_at,
    currency: {
      id: row.currency_id,
      code: row.currency_code,
      name: row.currency_name,
      symbol: row.currency_symbol,
      is_active: row.currency_is_active,
      created_at: row.currency_created_at,
      updated_at: row.currency_updated_at,
    },
  };
};

export const withWalletInitializationRetry = async <T>(
  user_id: string,
  operation: () => Promise<T>,
  initialize: (target_user_id: string) => Promise<unknown> = ensureWallet,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof WalletInitializationRequiredError)) throw error;
  }

  // Initialization must commit outside the failed bet transaction. Retrying
  // exactly once prevents a missing-wallet rollback loop while keeping the
  // existing-wallet path free of an additional preflight query.
  await initialize(user_id);
  return operation();
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

const listAdminWallets = async (search = '', page = 1, limit = 20) => {
  const pagination = getPagination(page, limit);
  const normalized_search = search.trim();
  const where: Prisma.WalletWhereInput = {
    currency: { code: DEFAULT_CURRENCY_CODE },
    ...(normalized_search
      ? { user_id: { contains: normalized_search, mode: 'insensitive' } }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.wallet.findMany({
      where,
      select: {
        id: true,
        user_id: true,
        balance: true,
        version: true,
        created_at: true,
        updated_at: true,
        currency: { select: { code: true, name: true, symbol: true } },
      },
      orderBy: [{ updated_at: 'desc' }, { user_id: 'asc' }],
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.wallet.count({ where }),
  ]);
  return { items, total, ...pagination };
};

const adminAdjustWallet = async (payload: AdminAdjustWalletBody, context: AdminAuditContext = {}) => {
  const unsigned_amount = BigInt(payload.amount.startsWith('-') ? payload.amount.slice(1) : payload.amount);
  const amount = payload.direction === 'debit' || (!payload.direction && payload.amount.startsWith('-')) ? -unsigned_amount : unsigned_amount;
  if (amount === 0n) throw new AppError(httpStatus.BAD_REQUEST, 'amount cannot be zero');

  return prisma.$transaction(async (tx) => {
    const currency = await getCurrency(tx);
    const wallet = await tx.wallet.findUnique({ where: { user_id_currency_id: { user_id: payload.user_id, currency_id: currency.id } }, include: { currency: true } });
    if (!wallet) throw new AppError(httpStatus.NOT_FOUND, 'Player wallet not found for user ID');
    const policy = await tx.adminPolicy.findUnique({ where: { code: 'default' } });
    const threshold = policy?.wallet_adjustment_threshold ?? 10000n;
    if (!payload.approval_id && (amount < 0n ? -amount : amount) >= threshold) {
      if (!context.admin_user_id || !context.idempotency_key) throw new AppError(httpStatus.UNAUTHORIZED, 'Authenticated admin and Idempotency-Key are required');
      const approval = await createPendingApproval({ admin_user_id: context.admin_user_id, action_type: 'wallet.adjust', target_type: 'wallet', target_id: wallet.id, payload: { user_id: payload.user_id, direction: amount > 0n ? 'credit' : 'debit', amount: unsigned_amount.toString(), reason: payload.reason, ticket_reference: payload.ticket_reference ?? null }, idempotency_key: context.idempotency_key }, tx);
      await tx.auditLog.create({ data: { actor_type: AuditActorType.admin, actor_id: context.admin_user_id, admin_user_id: context.admin_user_id, actor_role: context.actor_role, outcome: 'success', action: 'wallet.adjustment.submitted_for_approval', entity_type: 'wallet', entity_id: wallet.id, approval_request_id: approval.id, request_id: context.request_id, ip_address: context.ip_address, user_agent: context.user_agent, new_values: { user_id: payload.user_id, amount: payload.amount, reason: payload.reason } } });
      return { status: 'pending_approval' as const, approval_id: approval.id, expires_at: approval.expires_at };
    }
    if (payload.approval_id) {
      const approval = await tx.adminApprovalRequest.findUnique({ where: { id: payload.approval_id } });
      if (!approval || approval.action_type !== 'wallet.adjust' || approval.status !== AdminApprovalStatus.approved || approval.expires_at <= new Date()) throw new AppError(httpStatus.CONFLICT, 'Wallet adjustment approval is not ready');
      if (approval.requested_by_admin_id !== context.admin_user_id) throw new AppError(httpStatus.FORBIDDEN, 'Only the requesting admin can apply this approval');
      verifyApprovalPayloadHash(approval.payload, approval.payload_hash);
      const approved = approval.payload as { user_id?: string; direction?: string; amount?: string; reason?: string; ticket_reference?: string | null };
      if (approved.user_id !== payload.user_id || approved.direction !== (amount > 0n ? 'credit' : 'debit') || approved.amount !== unsigned_amount.toString() || approved.reason !== payload.reason || (approved.ticket_reference ?? null) !== (payload.ticket_reference ?? null)) throw new AppError(httpStatus.CONFLICT, 'Wallet adjustment does not match the approved request');
    }
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
        metadata: { reason: payload.reason, direction: amount > 0n ? 'credit' : 'debit', ticket_reference: payload.ticket_reference ?? null },
      },
    });

    await tx.auditLog.create({
      data: {
        actor_type: AuditActorType.admin,
        actor_id: context.admin_user_id,
        admin_user_id: context.admin_user_id,
        actor_role: context.actor_role,
        request_id: context.request_id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        approval_request_id: payload.approval_id,
        outcome: 'success',
        action: 'wallet.admin_adjusted',
        entity_type: 'wallet',
        entity_id: wallet.id,
        new_values: {
          user_id: payload.user_id,
          amount: amount.toString(),
          reason: payload.reason,
          direction: amount > 0n ? 'credit' : 'debit',
          ticket_reference: payload.ticket_reference ?? null,
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
          wallet_version: updated.version,
          reason: 'admin_adjustment',
        } satisfies WalletBalanceUpdatedPayload,
      },
    });

    if (payload.approval_id) await markApprovalApplied(tx, payload.approval_id, context);
    return { status: 'applied' as const, wallet: updated, ledger };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

export const creditPlatformPurchase = async (
  tx: Prisma.TransactionClient,
  params: {
    user_id: string;
    amount: bigint;
    reference_type: string;
    reference_id: string;
    metadata?: Prisma.InputJsonValue;
  },
) => {
  const wallet = await ensureWallet(params.user_id, tx);
  const balance_after = wallet.balance + params.amount;
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
      user_id: params.user_id,
      type: WalletLedgerType.purchase_credit,
      amount: params.amount,
      balance_before: wallet.balance,
      balance_after,
      reference_type: params.reference_type,
      reference_id: params.reference_id,
      metadata: params.metadata,
    },
  });
  await tx.outboxEvent.create({
    data: {
      aggregate_type: 'wallet',
      aggregate_id: wallet.id,
      event_type: 'wallet.balance.updated',
      socket_room: `user:${params.user_id}`,
      payload: {
        wallet_id: wallet.id,
        balance: balance_after.toString(),
        wallet_version: updated.version,
        reason: 'purchase_credit',
      } satisfies WalletBalanceUpdatedPayload,
    },
  });
  return { wallet: updated, ledger, balance_after };
};

export const debitPlatformWithdrawal = async (
  tx: Prisma.TransactionClient,
  params: {
    user_id: string;
    amount: bigint;
    reference_type: string;
    reference_id: string;
    metadata?: Prisma.InputJsonValue;
  },
) => {
  const wallet = await ensureWallet(params.user_id, tx);
  if (wallet.balance < params.amount) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Insufficient wallet balance');
  }

  const balance_after = wallet.balance - params.amount;
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
      user_id: params.user_id,
      type: WalletLedgerType.withdrawal_debit,
      amount: -params.amount,
      balance_before: wallet.balance,
      balance_after,
      reference_type: params.reference_type,
      reference_id: params.reference_id,
      metadata: params.metadata,
    },
  });
  await tx.outboxEvent.create({
    data: {
      aggregate_type: 'wallet',
      aggregate_id: wallet.id,
      event_type: 'wallet.balance.updated',
      socket_room: `user:${params.user_id}`,
      payload: {
        wallet_id: wallet.id,
        balance: balance_after.toString(),
        wallet_version: updated.version,
        reason: 'withdrawal_debit',
      } satisfies WalletBalanceUpdatedPayload,
    },
  });
  return { wallet: updated, ledger, balance_after, balance_before: wallet.balance };
};

const WalletService = {
  getMyWallet,
  getTransactions,
  listAdminWallets,
  adminAdjustWallet,
};

export default WalletService;
