import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import {
  OpsAlertSeverity,
  OpsAlertStatus,
  Prisma,
  SeamlessTransferDirection,
  SeamlessTransferStatus,
} from '@/generated/prisma/client';
import { logger } from '@/utils/logger';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import { SeamlessAppConfig, SeamlessWalletClient } from './seamless-wallet.client';

/**
 * Durable journal for every coin movement against a seamless (host) wallet.
 *
 * Credits (wins, cancelled-round refunds, reversals of orphaned debits) are
 * inserted in the SAME database transaction that settles the round, so the
 * obligation to pay is committed atomically with the settlement. A dispatcher
 * then delivers them to POST /internal/wallet/credit until the host
 * acknowledges them. The idempotencyKey is deterministic, so a redelivery can
 * never pay twice on a host that honours idempotency.
 *
 * Debits are journaled BEFORE the host call. If the host takes the coins but
 * the bet transaction never commits (serialization conflict, deadlock,
 * timeout, crash), the reconciler detects the orphan and queues a reversal.
 */

export type SeamlessCreditType = 'game_payout' | 'game_refund';

export const seamlessKeys = {
  betDebit: (bet_id: string) => `game-bet:${bet_id}`,
  betReversal: (bet_id: string) => `game-bet-reversal:${bet_id}`,
  roundPayout: (round_id: string, user_id: string) =>
    `game-payout:${round_id}:${user_id}`,
  roundRefund: (round_id: string, user_id: string) =>
    `game-refund:${round_id}:${user_id}`,
};

const DISPATCH_BATCH = 25;
const PROCESSING_LOCK_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const STUCK_ALERT_ATTEMPTS = 10;
// A bet transaction (8 serializable attempts x 10s timeout + backoff) is
// guaranteed to have finished long before this, so an uncommitted debit older
// than this is an orphan.
const ORPHAN_DEBIT_AGE_MS = 3 * 60_000;
// An unconfirmed debit is only voided after the host has said NOT_FOUND for
// this long, so a late-landing debit is still caught and reversed.
const VOID_UNCONFIRMED_DEBIT_AGE_MS = 15 * 60_000;

const backoffMs = (attempt: number): number =>
  Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.max(0, attempt - 1));

const truncate = (value: unknown): string =>
  (value instanceof Error ? value.message : String(value)).slice(0, 1000);

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

export type SeamlessCreditTarget = {
  platform_app_id: string;
  external_user_id: string;
};

/**
 * Queues a credit to the host wallet inside the caller's transaction.
 * The credit is delivered only if (and as soon as) that transaction commits.
 */
export async function enqueueSeamlessCredit(
  tx: Prisma.TransactionClient,
  target: SeamlessCreditTarget,
  params: {
    idempotency_key: string;
    type: SeamlessCreditType;
    user_id: string;
    amount: bigint;
    game_code: string;
    round_id?: string | null;
    reference_id: string;
  },
): Promise<void> {
  if (params.amount <= 0n) return;
  await tx.seamlessWalletTransfer.createMany({
    data: [
      {
        id: randomUUID(),
        idempotency_key: params.idempotency_key,
        direction: SeamlessTransferDirection.credit,
        type: params.type,
        status: SeamlessTransferStatus.pending,
        platform_app_id: target.platform_app_id,
        user_id: params.user_id,
        external_user_id: target.external_user_id,
        amount: params.amount,
        game_code: params.game_code,
        round_id: params.round_id ?? null,
        reference_id: params.reference_id,
      },
    ],
    skipDuplicates: true,
  });
}

type TransferRow = {
  id: string;
  idempotency_key: string;
  type: string;
  platform_app_id: string;
  user_id: string;
  external_user_id: string;
  amount: bigint;
  game_code: string;
  round_id: string | null;
  attempt_count: number;
};

const claimCredits = async (only_key?: string): Promise<TransferRow[]> =>
  prisma.$queryRaw<TransferRow[]>(Prisma.sql`
    UPDATE seamless_wallet_transfers AS t
    SET status = 'processing'::seamless_transfer_status,
        locked_at = CURRENT_TIMESTAMP,
        attempt_count = t.attempt_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE t.id IN (
      SELECT id FROM seamless_wallet_transfers
      WHERE direction = 'credit'::seamless_transfer_direction
        AND status = 'pending'::seamless_transfer_status
        AND next_attempt_at <= CURRENT_TIMESTAMP
        ${only_key ? Prisma.sql`AND idempotency_key = ${only_key}` : Prisma.empty}
      ORDER BY created_at ASC
      LIMIT ${DISPATCH_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING t.id, t.idempotency_key, t.type, t.platform_app_id, t.user_id,
              t.external_user_id, t.amount, t.game_code, t.round_id, t.attempt_count
  `);

const raiseStuckCreditAlert = async (row: TransferRow, error: string) => {
  const dedupe_key = `seamless-credit:${row.idempotency_key}`;
  const metadata = {
    transfer_id: row.id,
    idempotency_key: row.idempotency_key,
    user_id: row.user_id,
    external_user_id: row.external_user_id,
    amount: row.amount.toString(),
    attempts: row.attempt_count,
    last_error: error,
  } as Prisma.InputJsonObject;
  await prisma.opsAlert.upsert({
    where: { dedupe_key },
    create: {
      code: 'SEAMLESS_CREDIT_UNDELIVERED',
      severity: OpsAlertSeverity.critical,
      status: OpsAlertStatus.open,
      message: `Host wallet credit ${row.idempotency_key} (${row.amount} coins) is still undelivered after ${row.attempt_count} attempts`,
      source: 'seamless-wallet',
      dedupe_key,
      metadata,
    },
    update: { last_seen_at: new Date(), metadata },
  });
};

/**
 * The local wallet of a seamless player is a mirror of the host balance.
 * Refresh it from the host (source of truth) and push the new balance to the
 * player's socket so the game UI and admin panel show the credited coins.
 */
export async function refreshSeamlessMirrorBalance(
  app: SeamlessAppConfig,
  user_id: string,
  external_user_id: string,
  reason: string,
): Promise<bigint | null> {
  try {
    const balance = await SeamlessWalletClient.getRemoteBalance(app, external_user_id);
    const wallet = await ensureWallet(user_id);
    const updated = await prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance, version: { increment: 1 } },
    });
    await prisma.outboxEvent.create({
      data: {
        aggregate_type: 'wallet',
        aggregate_id: wallet.id,
        event_type: 'wallet.balance.updated',
        socket_room: `user:${user_id}`,
        payload: {
          wallet_id: wallet.id,
          balance: balance.toString(),
          wallet_version: updated.version,
          reason,
        },
      },
    });
    return balance;
  } catch (error) {
    // Display-only mirror: the next player request re-syncs it anyway.
    logger.warn('seamless_mirror_refresh_failed', { user_id, error });
    return null;
  }
}

const deliverCredit = async (row: TransferRow): Promise<boolean> => {
  try {
    const app = await prisma.platformApp.findUnique({
      where: { id: row.platform_app_id },
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
    });
    if (!app) throw new Error(`Platform app ${row.platform_app_id} not found`);

    const result = await SeamlessWalletClient.creditRemotePayout(
      app,
      {
        externalUserId: row.external_user_id,
        amount: row.amount,
        idempotencyKey: row.idempotency_key,
        type: row.type as 'game_payout' | 'game_refund',
        gameCode: row.game_code,
        roundId: row.round_id ?? undefined,
      },
      { attempts: 1 },
    );

    await prisma.seamlessWalletTransfer.update({
      where: { id: row.id },
      data: {
        status: SeamlessTransferStatus.completed,
        completed_at: new Date(),
        host_confirmed_at: new Date(),
        host_tx_id: result.txId ?? null,
        host_balance_after: result.balanceAfter ?? null,
        locked_at: null,
        last_error: null,
      },
    });
    await refreshSeamlessMirrorBalance(
      app,
      row.user_id,
      row.external_user_id,
      row.type === 'game_payout' ? 'seamless_payout' : 'seamless_refund',
    );
    logger.info('seamless_credit_delivered', {
      idempotency_key: row.idempotency_key,
      amount: row.amount.toString(),
      attempts: row.attempt_count,
    });
    return true;
  } catch (error) {
    const message = truncate(error);
    await prisma.seamlessWalletTransfer.update({
      where: { id: row.id },
      data: {
        status: SeamlessTransferStatus.pending,
        locked_at: null,
        last_error: message,
        next_attempt_at: new Date(Date.now() + backoffMs(row.attempt_count)),
      },
    });
    logger.error('seamless_credit_delivery_failed', {
      idempotency_key: row.idempotency_key,
      attempts: row.attempt_count,
      error: message,
    });
    if (row.attempt_count >= STUCK_ALERT_ATTEMPTS) {
      await raiseStuckCreditAlert(row, message).catch((alert_error) =>
        logger.error('seamless_credit_alert_failed', { error: alert_error }),
      );
    }
    return false;
  }
};

/** Best-effort immediate delivery of one queued credit (the dispatcher is the safety net). */
export async function dispatchSeamlessCreditNow(idempotency_key: string): Promise<void> {
  try {
    const rows = await claimCredits(idempotency_key);
    for (const row of rows) await deliverCredit(row);
  } catch (error) {
    logger.warn('seamless_credit_immediate_dispatch_failed', {
      idempotency_key,
      error,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Debits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Journals a bet debit BEFORE the host is called. Uses its own autocommit
 * statement so the record survives a rollback of the bet transaction.
 */
export async function journalSeamlessDebit(params: {
  idempotency_key: string;
  platform_app_id: string;
  user_id: string;
  external_user_id: string;
  amount: bigint;
  game_code: string;
  round_id: string;
  bet_id: string;
}): Promise<void> {
  await prisma.seamlessWalletTransfer.createMany({
    data: [
      {
        id: randomUUID(),
        idempotency_key: params.idempotency_key,
        direction: SeamlessTransferDirection.debit,
        type: 'game_bet',
        status: SeamlessTransferStatus.pending,
        platform_app_id: params.platform_app_id,
        user_id: params.user_id,
        external_user_id: params.external_user_id,
        amount: params.amount,
        game_code: params.game_code,
        round_id: params.round_id,
        reference_id: params.bet_id,
        // The reconciler must not look at it before the bet tx can finish.
        next_attempt_at: new Date(Date.now() + ORPHAN_DEBIT_AGE_MS),
      },
    ],
    skipDuplicates: true,
  });
}

export async function markSeamlessDebitHostConfirmed(
  idempotency_key: string,
  result: { txId?: string; balanceAfter?: bigint },
): Promise<void> {
  await prisma.seamlessWalletTransfer.updateMany({
    where: { idempotency_key, direction: SeamlessTransferDirection.debit },
    data: {
      host_confirmed_at: new Date(),
      host_tx_id: result.txId ?? null,
      host_balance_after: result.balanceAfter ?? null,
    },
  });
}

/** Host definitively refused the debit (e.g. insufficient balance): nothing to give back. */
export async function markSeamlessDebitRejected(
  idempotency_key: string,
  reason: string,
): Promise<void> {
  await prisma.seamlessWalletTransfer.updateMany({
    where: {
      idempotency_key,
      direction: SeamlessTransferDirection.debit,
      status: SeamlessTransferStatus.pending,
      host_confirmed_at: null,
    },
    data: { status: SeamlessTransferStatus.voided, last_error: reason.slice(0, 1000) },
  });
}

const betExists = async (game_code: string, bet_id: string): Promise<boolean> => {
  const where = { where: { id: bet_id }, select: { id: true } } as const;
  switch (game_code) {
    case 'GREEDY':
      return Boolean(await prisma.greedyBet.findUnique(where));
    case 'GREEDY_CLASSIC':
      return Boolean(await prisma.greedyClassicBet.findUnique(where));
    case 'LUCKY_77':
      return Boolean(await prisma.lucky77Bet.findUnique(where));
    case 'TEEN_PATTI':
      return Boolean(await prisma.teenPattiBet.findUnique(where));
    default: {
      const [a, b, c, d] = await Promise.all([
        prisma.greedyBet.findUnique(where),
        prisma.greedyClassicBet.findUnique(where),
        prisma.lucky77Bet.findUnique(where),
        prisma.teenPattiBet.findUnique(where),
      ]);
      return Boolean(a || b || c || d);
    }
  }
};

type DebitRow = {
  id: string;
  idempotency_key: string;
  status: SeamlessTransferStatus;
  platform_app_id: string;
  user_id: string;
  external_user_id: string;
  amount: bigint;
  game_code: string;
  round_id: string | null;
  reference_id: string;
  host_confirmed_at: Date | null;
  created_at: Date;
  attempt_count: number;
};

/** Debit taken by the host, bet never committed -> queue a reversal credit atomically. */
const reverseOrphanDebit = async (row: DebitRow, reason: string): Promise<string | null> => {
  const reversal_key = seamlessKeys.betReversal(row.reference_id);
  const reversed = await prisma.$transaction(async (tx) => {
    const updated = await tx.seamlessWalletTransfer.updateMany({
      where: { id: row.id, status: SeamlessTransferStatus.pending },
      data: {
        status: SeamlessTransferStatus.reversed,
        completed_at: new Date(),
        last_error: reason.slice(0, 1000),
      },
    });
    if (!updated.count) return false;
    await enqueueSeamlessCredit(
      tx,
      { platform_app_id: row.platform_app_id, external_user_id: row.external_user_id },
      {
        idempotency_key: reversal_key,
        type: 'game_refund',
        user_id: row.user_id,
        amount: row.amount,
        game_code: row.game_code,
        round_id: row.round_id,
        reference_id: row.reference_id,
      },
    );
    return true;
  });
  if (!reversed) return null;
  logger.warn('seamless_orphan_debit_reversed', {
    debit_key: row.idempotency_key,
    reversal_key,
    user_id: row.user_id,
    amount: row.amount.toString(),
    reason,
  });
  return reversal_key;
};

const loadApp = (platform_app_id: string) =>
  prisma.platformApp.findUnique({
    where: { id: platform_app_id },
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
  });

/**
 * Decides the fate of a debit whose bet may not have committed.
 * Returns the reversal credit key when a refund was queued.
 */
const resolvePendingDebit = async (
  row: DebitRow,
  options: { allow_void: boolean },
): Promise<string | null> => {
  if (await betExists(row.game_code, row.reference_id)) {
    await prisma.seamlessWalletTransfer.updateMany({
      where: { id: row.id, status: SeamlessTransferStatus.pending },
      data: { status: SeamlessTransferStatus.completed, completed_at: new Date() },
    });
    return null;
  }

  if (row.host_confirmed_at) {
    return reverseOrphanDebit(row, 'bet transaction did not commit after host debit');
  }

  // We never saw a 2xx: ask the host whether the debit actually landed.
  const app = await loadApp(row.platform_app_id);
  const lookup = app
    ? await SeamlessWalletClient.checkRemoteTransaction(app, row.idempotency_key)
    : ({ status: 'UNKNOWN', error: 'platform app missing' } as const);

  if (lookup.status === 'FOUND') {
    return reverseOrphanDebit(row, 'host lookup FOUND an uncommitted bet debit');
  }

  if (lookup.status === 'NOT_FOUND' && options.allow_void) {
    await prisma.seamlessWalletTransfer.updateMany({
      where: { id: row.id, status: SeamlessTransferStatus.pending, host_confirmed_at: null },
      data: {
        status: SeamlessTransferStatus.voided,
        completed_at: new Date(),
        last_error: 'host lookup NOT_FOUND; debit never applied',
      },
    });
    return null;
  }

  // NOT_FOUND inside the grace window, or UNKNOWN: look again later.
  await prisma.seamlessWalletTransfer.updateMany({
    where: { id: row.id, status: SeamlessTransferStatus.pending },
    data: {
      attempt_count: { increment: 1 },
      last_error: lookup.error ?? `host lookup ${lookup.status}`,
      next_attempt_at: new Date(Date.now() + Math.max(60_000, backoffMs(row.attempt_count + 1))),
    },
  });
  return null;
};

const debitSelect = {
  id: true,
  idempotency_key: true,
  status: true,
  platform_app_id: true,
  user_id: true,
  external_user_id: true,
  amount: true,
  game_code: true,
  round_id: true,
  reference_id: true,
  host_confirmed_at: true,
  created_at: true,
  attempt_count: true,
} as const;

/** Bet committed: close its debit journal row (best-effort; reconciler is the fallback). */
export async function markSeamlessBetCommitted(bet_id: string): Promise<void> {
  try {
    await prisma.seamlessWalletTransfer.updateMany({
      where: {
        idempotency_key: seamlessKeys.betDebit(bet_id),
        status: SeamlessTransferStatus.pending,
      },
      data: { status: SeamlessTransferStatus.completed, completed_at: new Date() },
    });
  } catch (error) {
    // Never fail an accepted bet over bookkeeping; the reconciler sees the
    // committed bet row and closes the journal entry itself.
    logger.warn('seamless_debit_commit_mark_failed', { bet_id, error });
  }
}

/**
 * Called when a bet request finally failed. If the host already took the
 * coins for this bet, the player gets them back immediately.
 */
export async function compensateFailedSeamlessBet(bet_id: string): Promise<void> {
  try {
    const row = await prisma.seamlessWalletTransfer.findUnique({
      where: { idempotency_key: seamlessKeys.betDebit(bet_id) },
      select: debitSelect,
    });
    if (!row || row.status !== SeamlessTransferStatus.pending) return;
    const reversal_key = await resolvePendingDebit(row, { allow_void: false });
    if (reversal_key) await dispatchSeamlessCreditNow(reversal_key);
  } catch (error) {
    // The reconciler retries; never mask the original bet error.
    logger.error('seamless_bet_compensation_failed', { bet_id, error });
  }
}

/* ------------------------------------------------------------------ */
/* Dispatcher tick (run by the worker process)                         */
/* ------------------------------------------------------------------ */

let tick_running = false;

export async function runSeamlessTransferTick(): Promise<void> {
  if (tick_running) return;
  tick_running = true;
  try {
    // 1. Release credits stuck in 'processing' by a crashed dispatcher.
    await prisma.seamlessWalletTransfer.updateMany({
      where: {
        direction: SeamlessTransferDirection.credit,
        status: SeamlessTransferStatus.processing,
        locked_at: { lt: new Date(Date.now() - PROCESSING_LOCK_TIMEOUT_MS) },
      },
      data: { status: SeamlessTransferStatus.pending, locked_at: null },
    });

    // 2. Deliver due credits.
    const credits = await claimCredits();
    for (const row of credits) await deliverCredit(row);

    // 3. Reconcile orphaned debits (bet tx never committed).
    const debits = await prisma.seamlessWalletTransfer.findMany({
      where: {
        direction: SeamlessTransferDirection.debit,
        status: SeamlessTransferStatus.pending,
        next_attempt_at: { lte: new Date() },
        created_at: { lt: new Date(Date.now() - ORPHAN_DEBIT_AGE_MS) },
      },
      orderBy: { created_at: 'asc' },
      take: DISPATCH_BATCH,
      select: debitSelect,
    });
    for (const row of debits) {
      try {
        await resolvePendingDebit(row, {
          allow_void: Date.now() - row.created_at.getTime() > VOID_UNCONFIRMED_DEBIT_AGE_MS,
        });
      } catch (error) {
        logger.error('seamless_debit_reconcile_failed', {
          idempotency_key: row.idempotency_key,
          error,
        });
      }
    }
  } catch (error) {
    logger.error('seamless_transfer_tick_failed', { error });
  } finally {
    tick_running = false;
  }
}
