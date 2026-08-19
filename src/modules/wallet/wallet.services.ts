import httpStatus from 'http-status';
import { AdminApprovalStatus, AuditActorType, Prisma, WalletLedgerType } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { getPagination } from '@/utils/pagination';
import type { AdminAdjustWalletBody } from './wallet.validation';
import type { AdminAuditContext } from '@/modules/admin/admin.services';
import { createPendingApproval, markApprovalApplied, verifyApprovalPayloadHash } from '@/modules/admin/admin-approval.services';

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
  const where = {
    user_id_currency_id: { user_id, currency_id: currency.id },
  };
  const include = { currency: true } as const;

  const existing = await tx.wallet.findUnique({ where, include });
  if (existing) return existing;

  // Concurrent first-time creates race Prisma upsert; skipDuplicates is ON CONFLICT DO NOTHING.
  await tx.wallet.createMany({
    data: [{ user_id, currency_id: currency.id }],
    skipDuplicates: true,
  });

  const wallet = await tx.wallet.findUnique({ where, include });
  if (!wallet) {
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Wallet could not be initialized');
  }
  return wallet;
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
          reason: 'admin_adjustment',
        },
      },
    });

    if (payload.approval_id) await markApprovalApplied(tx, payload.approval_id, context);
    return { status: 'applied' as const, wallet: updated, ledger };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

const WalletService = {
  getMyWallet,
  getTransactions,
  adminAdjustWallet,
};

export default WalletService;
