import httpStatus from 'http-status';
import {
  AdminRole,
  ConfigVersionStatus,
  GameStatus,
  TeenPattiRoundStatus,
  TeenPattiRuntimeStatus,
  OpsAlertStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import {
  TEEN_PATTI_GAME_CODE,
  TEEN_PATTI_LEGACY_RNG_ALGORITHM_VERSION,
  TEEN_PATTI_RNG_ALGORITHM_VERSION,
  TEEN_PATTI_SOCKET_ROOM,
} from '@/modules/teen-patti/teen-patti.constant';
import {
  buildLegacyTeenPattiResultAuditHash,
  buildTeenPattiResultCommitment,
} from '@/modules/teen-patti/teen-patti.audit';
import { deliverOpsWebhook } from '@/modules/admin/admin-webhook';
import { logger } from '@/utils/logger';
import { humanOnlyBetUserFilter } from '@/modules/game-bot/admin-bot-filter';
import { getActiveBotIds, isBotUserId } from '@/modules/game-bot/bot-identity';
import { getPagination } from '@/utils/pagination';
import type { CreateTeenPattiConfigBody } from './game-admin.validation';
import { resolveTeenPattiOptionAssets } from './teen-patti-admin.services';
import type { OpsAuditLogQuery, OpsMetricsQuery, OpsRoundBetsQuery, OpsRoundListQuery } from './teen-patti-admin-ops.validation';
import type { AdminAuditContext } from '@/modules/admin/admin.services';
import { canManageGameAvailability, canViewGameEntropy } from '@/modules/admin/admin.permissions';
import { writeAdminAudit } from '@/modules/admin/admin.services';

const WORKER_LEASE_KEY = 'game-worker:teen-patti';
const PUBLIC_RESULT_STATUSES: TeenPattiRoundStatus[] = [
  TeenPattiRoundStatus.result_revealed,
  TeenPattiRoundStatus.settling,
  TeenPattiRoundStatus.settled,
  TeenPattiRoundStatus.closed,
];
let lastDatabaseUnavailableWebhookAt = 0;
const getGameOrThrow = async (tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const game = await tx.game.findUnique({ where: { code: TEEN_PATTI_GAME_CODE } });
  if (!game) throw new AppError(httpStatus.NOT_FOUND, 'Teen Patti game not initialized');
  return game;
};

const toConfigJson = (config: {
  version: number;
  betting_duration_ms: number;
  lock_duration_ms: number;
  drawing_duration_ms: number;
  result_duration_ms: number;
  min_bet: bigint;
  max_single_bet: bigint;
  max_round_bet: bigint;
  rake_bps: number;
  options: Array<{ code: string; name: string; image_url: string | null; asset_id?: string | null; display_order: number; is_enabled: boolean }>;
  chip_values: Array<{ amount: bigint; display_order: number; is_enabled: boolean }>;
}) => ({
  version: config.version,
  betting_duration_ms: config.betting_duration_ms,
  lock_duration_ms: config.lock_duration_ms,
  drawing_duration_ms: config.drawing_duration_ms,
  result_duration_ms: config.result_duration_ms,
  min_bet: config.min_bet.toString(),
  max_single_bet: config.max_single_bet.toString(),
  max_round_bet: config.max_round_bet.toString(),
  rake_bps: config.rake_bps,
  options: config.options.map((option) => ({
    code: option.code,
    name: option.name,
    image_url: option.image_url,
    asset_id: option.asset_id ?? null,
    display_order: option.display_order,
    is_enabled: option.is_enabled,
  })),
  chip_values: config.chip_values.map((chip) => ({
    amount: chip.amount.toString(),
    display_order: chip.display_order,
    is_enabled: chip.is_enabled,
  })),
});

const getConfig = async (config_id: string) => {
  const game = await getGameOrThrow();
  const config = await prisma.teenPattiConfigVersion.findFirst({
    where: { id: config_id, game_id: game.id },
    include: {
      options: { orderBy: { display_order: 'asc' } },
      chip_values: { orderBy: { display_order: 'asc' } },
      _count: { select: { rounds: true, results: true } },
    },
  });
  if (!config) throw new AppError(httpStatus.NOT_FOUND, 'Config version not found');
  return config;
};

const updateDraft = async (config_id: string, payload: CreateTeenPattiConfigBody, context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const options = await resolveTeenPattiOptionAssets(tx, payload.options);
    const target = await tx.teenPattiConfigVersion.findFirst({
      where: { id: config_id, game_id: game.id },
      include: { options: true, chip_values: true },
    });
    if (!target) throw new AppError(httpStatus.NOT_FOUND, 'Config version not found');
    if (target.status !== ConfigVersionStatus.draft && target.status !== ConfigVersionStatus.published) {
      throw new AppError(httpStatus.CONFLICT, 'Only draft or published configs can be edited');
    }

    const referencedRound = await tx.teenPattiRound.findFirst({
      where: { config_version_id: target.id },
      select: { id: true },
    });
    const hasRoundRefs = Boolean(referencedRound);
    const rootData = {
      betting_duration_ms: payload.betting_duration_ms,
      lock_duration_ms: payload.lock_duration_ms,
      drawing_duration_ms: payload.drawing_duration_ms,
      result_duration_ms: payload.result_duration_ms,
      min_bet: BigInt(payload.min_bet),
      max_single_bet: BigInt(payload.max_single_bet),
      max_round_bet: BigInt(payload.max_round_bet),
      rake_bps: payload.rake_bps,
      notes: payload.notes,
    };

    let updated;

    if (hasRoundRefs) {
      const existingCodes = new Set(target.options.map((item) => item.code));
      const payloadCodes = new Set(options.map((item) => item.code));
      if (existingCodes.size !== payloadCodes.size || [...existingCodes].some((code) => !payloadCodes.has(code))) {
        throw new AppError(httpStatus.CONFLICT, 'Option codes cannot be changed on a config referenced by rounds');
      }

      const orderChanged = options.some((item) => {
        const existing = target.options.find((option) => option.code === item.code);
        return existing?.display_order !== item.display_order;
      });
      if (orderChanged) {
        for (const [index, item] of options.entries()) {
          const existing = target.options.find((option) => option.code === item.code);
          if (!existing) throw new AppError(httpStatus.CONFLICT, `Option ${item.code} not found`);
          await tx.teenPattiOptionVersion.update({
            where: { id: existing.id },
            data: { display_order: existing.display_order + 10000 + index },
          });
        }
      }
      for (const item of options) {
        const existing = target.options.find((option) => option.code === item.code);
        if (!existing) throw new AppError(httpStatus.CONFLICT, `Option ${item.code} not found`);
        await tx.teenPattiOptionVersion.update({
          where: { id: existing.id },
          data: {
            name: item.name,
            image_url: item.image_url ?? null,
            asset_id: item.asset_id ?? null,
            display_order: item.display_order,
            is_enabled: item.is_enabled,
          },
        });
      }

      await tx.teenPattiChipValueVersion.deleteMany({ where: { config_version_id: target.id } });
      if (payload.chip_values.length) {
        await tx.teenPattiChipValueVersion.createMany({
          data: payload.chip_values.map((item) => ({
            config_version_id: target.id,
            amount: BigInt(item.amount),
            display_order: item.display_order,
            is_enabled: item.is_enabled,
          })),
        });
      }

      updated = await tx.teenPattiConfigVersion.update({
        where: { id: target.id },
        data: rootData,
        include: { options: { orderBy: { display_order: 'asc' } }, chip_values: { orderBy: { display_order: 'asc' } } },
      });
    } else {
      await tx.teenPattiChipValueVersion.deleteMany({ where: { config_version_id: target.id } });
      await tx.teenPattiOptionVersion.deleteMany({ where: { config_version_id: target.id } });
      updated = await tx.teenPattiConfigVersion.update({
        where: { id: target.id },
        data: {
          ...rootData,
          options: { create: options.map((item) => ({
            code: item.code, name: item.name, image_url: item.image_url ?? null, asset_id: item.asset_id ?? null, display_order: item.display_order,
            is_enabled: item.is_enabled,
          })) },
          chip_values: { create: payload.chip_values.map((item) => ({ amount: BigInt(item.amount), display_order: item.display_order, is_enabled: item.is_enabled })) },
        },
        include: { options: { orderBy: { display_order: 'asc' } }, chip_values: { orderBy: { display_order: 'asc' } } },
      });
    }

    if (target.status === ConfigVersionStatus.published) {
      const runtime = await tx.teenPattiRuntimeState.findUnique({ where: { game_id: game.id } });
      if (runtime?.active_config_version_id === target.id) {
        await tx.teenPattiRuntimeState.update({ where: { game_id: game.id }, data: { revision: { increment: 1 } } });
        await tx.outboxEvent.create({
          data: {
            aggregate_type: 'teen_patti_config_version',
            aggregate_id: target.id,
            event_type: 'teen_patti.config.updated',
            socket_room: TEEN_PATTI_SOCKET_ROOM,
            payload: { config_id: target.id, version: target.version },
          },
        });
      }
    }

    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'teen_patti.config.updated', entity_type: 'teen_patti_config_version', entity_id: target.id, old_values: toConfigJson(target), new_values: toConfigJson(updated) });
    return updated;
  }, { maxWait: 5000, timeout: 15000 });

const cloneConfig = async (config_id: string, context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const source = await tx.teenPattiConfigVersion.findFirst({ where: { id: config_id, game_id: game.id }, include: { options: true, chip_values: true } });
    if (!source) throw new AppError(httpStatus.NOT_FOUND, 'Config version not found');
    const latest = await tx.teenPattiConfigVersion.findFirst({ where: { game_id: game.id }, orderBy: { version: 'desc' }, select: { version: true } });
    const draft = await tx.teenPattiConfigVersion.create({
      data: {
        game_id: game.id, version: (latest?.version ?? 0) + 1, status: ConfigVersionStatus.draft,
        betting_duration_ms: source.betting_duration_ms, lock_duration_ms: source.lock_duration_ms,
        drawing_duration_ms: source.drawing_duration_ms, result_duration_ms: source.result_duration_ms,
        min_bet: source.min_bet, max_single_bet: source.max_single_bet, max_round_bet: source.max_round_bet,
        rake_bps: source.rake_bps,
        created_by: context.admin_user_id, notes: `Cloned from version ${source.version}`,
        options: { create: source.options.map((item) => ({ code: item.code, name: item.name, image_url: item.image_url, asset_id: item.asset_id, display_order: item.display_order, is_enabled: item.is_enabled })) },
        chip_values: { create: source.chip_values.map((item) => ({ amount: item.amount, display_order: item.display_order, is_enabled: item.is_enabled })) },
      },
      include: { options: { orderBy: { display_order: 'asc' } }, chip_values: { orderBy: { display_order: 'asc' } } },
    });
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'teen_patti.config.cloned', entity_type: 'teen_patti_config_version', entity_id: draft.id, new_values: { source_config_id: source.id, source_version: source.version, version: draft.version } });
    return draft;
  });

const canViewEntropy = canViewGameEntropy;

const stripEntropy = <T extends { result?: { entropy_digest?: string | null } | null }>(item: T, role?: AdminRole): T => {
  if (canViewEntropy(role)) return item;
  if (!item.result) return item;
  return { ...item, result: { ...item.result, entropy_digest: undefined } } as T;
};

const maskUnrevealedResult = <T extends {
  status: TeenPattiRoundStatus;
  result?: unknown;
}>(item: T): T =>
  PUBLIC_RESULT_STATUSES.includes(item.status)
    ? item
    : { ...item, result: null };

const listRounds = async (query: OpsRoundListQuery, role?: AdminRole) => {
  const game = await getGameOrThrow();
  const pagination = getPagination(query.page, query.limit);
  const where: Prisma.TeenPattiRoundWhereInput = {
    game_id: game.id,
    ...(query.status ? { status: query.status } : {}),
    ...(query.round_number ? { round_number: BigInt(query.round_number) } : {}),
    ...(query.config_version ? { config_version: { version: query.config_version } } : {}),
    ...(query.winner ? { AND: [{ status: { in: PUBLIC_RESULT_STATUSES } }, { result: { winning_option: { OR: [{ code: query.winner }, { name: { contains: query.winner, mode: 'insensitive' } }] } } }] } : {}),
    ...(query.from || query.to ? { created_at: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.teenPattiRound.findMany({
      where, orderBy: { round_number: 'desc' }, skip: pagination.skip, take: pagination.limit,
      select: {
        id: true, round_number: true, status: true, betting_started_at: true, betting_ends_at: true, locked_at: true,
        result_generated_at: true, drawing_started_at: true, result_reveal_at: true, settlement_started_at: true,
        settled_at: true, closed_at: true, cancelled_at: true, cancellation_reason: true, created_at: true, updated_at: true,
        config_version: { select: { id: true, version: true } },
        result: { select: { id: true, algorithm_version: true, entropy_digest: true, audit_hash: true, generated_at: true, revealed_at: true, winning_option: { select: { id: true, code: true, name: true, image_url: true } } } },
        _count: { select: { bets: true, settlements: true, payouts: true, refunds: true } },
      },
    }),
    prisma.teenPattiRound.count({ where }),
  ]);
  return { items: items.map((item) => stripEntropy(maskUnrevealedResult(item), role)), total, ...pagination };
};

const getRound = async (round_id: string, role?: AdminRole) => {
  const game = await getGameOrThrow();
  const round = await prisma.teenPattiRound.findFirst({
    where: { id: round_id, game_id: game.id },
    include: {
      config_version: { include: { options: { orderBy: { display_order: 'asc' } }, chip_values: { orderBy: { display_order: 'asc' } } } },
      result: { include: { winning_option: true } },
      _count: { select: { bets: true, settlements: true, payouts: true, refunds: true } },
    },
  });
  if (!round) throw new AppError(httpStatus.NOT_FOUND, 'Round not found');
  const [betTotals, payoutTotals, refundTotals, outcomes] = await Promise.all([
    prisma.teenPattiBet.aggregate({ where: { round_id }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.teenPattiUserPayout.aggregate({ where: { round_id }, _sum: { total_payout: true, total_winning_stake: true }, _count: { _all: true } }),
    prisma.teenPattiUserRefund.aggregate({ where: { round_id }, _sum: { total_bet_amount: true }, _count: { _all: true } }),
    prisma.teenPattiBetSettlement.groupBy({ by: ['outcome'], where: { round_id }, _count: { _all: true }, _sum: { payout_amount: true } }),
  ]);
  return { round: stripEntropy(maskUnrevealedResult(round), role), financials: { bet_count: betTotals._count._all, total_bet_amount: (betTotals._sum.amount ?? 0n).toString(), payout_users: payoutTotals._count._all, total_payout: (payoutTotals._sum.total_payout ?? 0n).toString(), total_winning_stake: (payoutTotals._sum.total_winning_stake ?? 0n).toString(), refund_users: refundTotals._count._all, total_refunded: (refundTotals._sum.total_bet_amount ?? 0n).toString() }, outcomes };
};

const verifyRoundResult = async (round_id: string, role?: AdminRole) => {
  const game = await getGameOrThrow();
  const round = await prisma.teenPattiRound.findFirst({ where: { id: round_id, game_id: game.id }, include: { result: { include: { winning_option: { select: { id: true, code: true, name: true } } } } } });
  if (!round) throw new AppError(httpStatus.NOT_FOUND, 'Round not found');
  if (!PUBLIC_RESULT_STATUSES.includes(round.status)) throw new AppError(httpStatus.CONFLICT, 'Round result is hidden until public reveal');
  if (!round.result) throw new AppError(httpStatus.CONFLICT, 'Round has no immutable result to verify');
  const result = round.result;
  const commitment_input = { round_id: round.id, config_version_id: result.config_version_id, winning_option_id: result.winning_option_version_id, algorithm_version: result.algorithm_version, entropy_digest: result.entropy_digest, hands: result.hands, generated_at: result.generated_at };
  const expected_hash = result.algorithm_version === TEEN_PATTI_RNG_ALGORITHM_VERSION
    ? buildTeenPattiResultCommitment(commitment_input)
    : result.algorithm_version === TEEN_PATTI_LEGACY_RNG_ALGORITHM_VERSION
      ? buildLegacyTeenPattiResultAuditHash(commitment_input)
      : null;
  const privileged = canViewEntropy(role);
  return { verified: expected_hash !== null && expected_hash === result.audit_hash, round_id: round.id, result_id: result.id, algorithm_version: result.algorithm_version, generated_at: result.generated_at, revealed_at: result.revealed_at, winning_option: result.winning_option, audit_hash: privileged ? result.audit_hash : undefined, expected_hash: privileged ? expected_hash : undefined };
};

const listRoundBets = async (round_id: string, query: OpsRoundBetsQuery) => {
  const game = await getGameOrThrow();
  const round = await prisma.teenPattiRound.findFirst({ where: { id: round_id, game_id: game.id }, select: { id: true } });
  if (!round) throw new AppError(httpStatus.NOT_FOUND, 'Round not found');
  const pagination = getPagination(query.page, query.limit);
  const user_filter = await humanOnlyBetUserFilter(query.user_id);
  const where: Prisma.TeenPattiBetWhereInput = {
    round_id,
    ...(query.option_id ? { option_version_id: query.option_id } : {}),
    ...(user_filter ? { user_id: user_filter } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.teenPattiBet.findMany({ where, orderBy: { accepted_at: 'desc' }, skip: pagination.skip, take: pagination.limit, select: { id: true, user_id: true, amount: true, accepted_at: true, client_request_id: true, option: { select: { id: true, code: true, name: true, image_url: true } }, settlement: { select: { outcome: true, payout_amount: true, settled_at: true } } } }),
    prisma.teenPattiBet.count({ where }),
  ]);
  return { items, total, ...pagination };
};

const getUserSummary = async (user_id: string) => {
  if (await isBotUserId(user_id)) {
    throw new AppError(httpStatus.NOT_FOUND, 'Player wallet not found for user ID');
  }
  const [wallet, betsCount, betTotal, payoutTotal, refundTotal] = await Promise.all([
    prisma.wallet.findFirst({ where: { user_id }, include: { currency: true } }),
    prisma.teenPattiBet.count({ where: { user_id } }),
    prisma.teenPattiBet.aggregate({ where: { user_id }, _sum: { amount: true } }),
    prisma.teenPattiUserPayout.aggregate({ where: { user_id }, _sum: { total_payout: true } }),
    prisma.teenPattiUserRefund.aggregate({ where: { user_id }, _sum: { total_bet_amount: true } }),
  ]);
  if (!wallet) throw new AppError(httpStatus.NOT_FOUND, 'Player wallet not found for user ID');
  const ledger = wallet ? await prisma.walletLedger.findMany({ where: { wallet_id: wallet.id }, orderBy: { created_at: 'desc' }, take: 100 }) : [];
  const bets = await prisma.teenPattiBet.findMany({ where: { user_id }, orderBy: { created_at: 'desc' }, take: 100, select: { id: true, round_id: true, amount: true, accepted_at: true, option: { select: { code: true, name: true, image_url: true } }, settlement: { select: { outcome: true, payout_amount: true, settled_at: true } } } });
  return { user_id, wallet, totals: { bet_count: betsCount, total_bet_amount: (betTotal._sum.amount ?? 0n).toString(), total_payout: (payoutTotal._sum.total_payout ?? 0n).toString(), total_refunded: (refundTotal._sum.total_bet_amount ?? 0n).toString() }, ledger, bets };
};

const getMetrics = async (query: OpsMetricsQuery) => {
  const now = new Date();
  const from = query.from ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const to = query.to ?? now;
  if (from >= to) throw new AppError(httpStatus.BAD_REQUEST, 'Metrics from must be before to');
  const game = await getGameOrThrow();
  const [rounds, bets, payouts, refunds, ledger, uniqueBettors, betSeries, refundSeries, payoutSeries, roundSeries, settlementLatency] = await Promise.all([
    prisma.teenPattiRound.groupBy({ by: ['status'], where: { game_id: game.id, created_at: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.teenPattiBet.aggregate({ where: { game_id: game.id, created_at: { gte: from, lte: to } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.teenPattiUserPayout.aggregate({ where: { round: { game_id: game.id }, created_at: { gte: from, lte: to } }, _count: { _all: true }, _sum: { total_payout: true, total_winning_stake: true } }),
    prisma.teenPattiUserRefund.aggregate({ where: { round: { game_id: game.id }, created_at: { gte: from, lte: to } }, _count: { _all: true }, _sum: { total_bet_amount: true } }),
    prisma.walletLedger.groupBy({ by: ['type'], where: { game_id: game.id, created_at: { gte: from, lte: to } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.teenPattiBet.findMany({ where: { game_id: game.id, created_at: { gte: from, lte: to } }, distinct: ['user_id'], select: { user_id: true } }),
    prisma.$queryRaw<Array<{ bucket: string; amount: string; count: string; unique_bettors: string }>>(Prisma.sql`SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bucket, COALESCE(SUM(amount), 0)::text AS amount, COUNT(*)::text AS count, COUNT(DISTINCT user_id)::text AS unique_bettors FROM teen_patti_bets WHERE game_id = ${game.id} AND created_at >= ${from} AND created_at <= ${to} GROUP BY bucket ORDER BY bucket`),
    prisma.$queryRaw<Array<{ bucket: string; amount: string }>>(Prisma.sql`SELECT to_char((r.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bucket, COALESCE(SUM(f.total_bet_amount), 0)::text AS amount FROM teen_patti_user_refunds f JOIN teen_patti_rounds r ON r.id = f.round_id WHERE r.game_id = ${game.id} AND f.created_at >= ${from} AND f.created_at <= ${to} GROUP BY bucket ORDER BY bucket`),
    prisma.$queryRaw<Array<{ bucket: string; amount: string }>>(Prisma.sql`SELECT to_char((r.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bucket, COALESCE(SUM(p.total_payout), 0)::text AS amount FROM teen_patti_user_payouts p JOIN teen_patti_rounds r ON r.id = p.round_id WHERE r.game_id = ${game.id} AND p.created_at >= ${from} AND p.created_at <= ${to} GROUP BY bucket ORDER BY bucket`),
    prisma.$queryRaw<Array<{ bucket: string; rounds: string; cancelled: string }>>(Prisma.sql`SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS bucket, COUNT(*)::text AS rounds, COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled FROM teen_patti_rounds WHERE game_id = ${game.id} AND created_at >= ${from} AND created_at <= ${to} GROUP BY bucket ORDER BY bucket`),
    prisma.$queryRaw<Array<{ average_seconds: number | null; settled_rounds: string }>>(Prisma.sql`SELECT AVG(EXTRACT(EPOCH FROM (settled_at - result_reveal_at)))::float8 AS average_seconds, COUNT(*)::text AS settled_rounds FROM teen_patti_rounds WHERE game_id = ${game.id} AND settled_at IS NOT NULL AND result_reveal_at IS NOT NULL AND settled_at >= ${from} AND settled_at <= ${to}`),
  ]);
  const bot_ids = new Set(await getActiveBotIds());
  const human_unique_bettors = uniqueBettors.filter((row) => !bot_ids.has(row.user_id));
  const accepted = bets._sum.amount ?? 0n;
  const refunded = refunds._sum.total_bet_amount ?? 0n;
  const payout = payouts._sum.total_payout ?? 0n;
  const net_stake = accepted - refunded;
  const gross_result = net_stake - payout;
  const timeSeries = new Map<string, { accepted_stake: bigint; refunded_stake: bigint; payout: bigint; rounds: number; cancelled_rounds: number; bets: number; unique_bettors: number }>();
  const bucket = (key: string) => {
    const existing = timeSeries.get(key) ?? { accepted_stake: 0n, refunded_stake: 0n, payout: 0n, rounds: 0, cancelled_rounds: 0, bets: 0, unique_bettors: 0 };
    timeSeries.set(key, existing);
    return existing;
  };
  for (const row of betSeries) { const item = bucket(row.bucket); item.accepted_stake += BigInt(row.amount); item.bets += Number(row.count); item.unique_bettors = Number(row.unique_bettors); }
  for (const row of refundSeries) bucket(row.bucket).refunded_stake += BigInt(row.amount);
  for (const row of payoutSeries) bucket(row.bucket).payout += BigInt(row.amount);
  for (const row of roundSeries) { const item = bucket(row.bucket); item.rounds = Number(row.rounds); item.cancelled_rounds = Number(row.cancelled); }
  return {
    timezone: 'Asia/Dhaka', window: { from, to },
    rounds: { by_status: rounds, total: rounds.reduce((sum, row) => sum + row._count._all, 0), cancelled: rounds.find((row) => row.status === TeenPattiRoundStatus.cancelled)?._count._all ?? 0, cancellation_rate: rounds.length ? ((rounds.find((row) => row.status === TeenPattiRoundStatus.cancelled)?._count._all ?? 0) / rounds.reduce((sum, row) => sum + row._count._all, 0)) * 100 : 0 },
    bets: { count: bets._count._all, unique_bettors: human_unique_bettors.length, accepted_stake: accepted.toString(), refunded_stake: refunded.toString(), net_stake: net_stake.toString() },
    payouts: { users: payouts._count._all, total_amount: payout.toString(), winning_stake: (payouts._sum.total_winning_stake ?? 0n).toString() },
    gross_result: gross_result.toString(), ledger, settlement: { average_latency_seconds: settlementLatency[0]?.average_seconds ?? null, settled_rounds: Number(settlementLatency[0]?.settled_rounds ?? 0) },
    time_series: [...timeSeries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, item]) => ({ date, accepted_stake: item.accepted_stake.toString(), refunded_stake: item.refunded_stake.toString(), net_stake: (item.accepted_stake - item.refunded_stake).toString(), payout: item.payout.toString(), gross_result: (item.accepted_stake - item.refunded_stake - item.payout).toString(), rounds: item.rounds, cancelled_rounds: item.cancelled_rounds, bets: item.bets, unique_bettors: item.unique_bettors })),
  };
};

const listAuditLogs = async (query: OpsAuditLogQuery) => {
  const pagination = getPagination(query.page, query.limit);
  const where: Prisma.AuditLogWhereInput = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.entity_type ? { entity_type: query.entity_type } : {}),
    ...(query.actor_id ? { actor_id: query.actor_id } : {}),
    ...(query.actor_role ? { actor_role: query.actor_role } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.request_id ? { request_id: query.request_id } : {}),
    ...(query.approval_request_id ? { approval_request_id: query.approval_request_id } : {}),
    ...(query.from || query.to ? { created_at: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
  };
  const [items, total] = await prisma.$transaction([prisma.auditLog.findMany({ where, orderBy: { created_at: 'desc' }, skip: pagination.skip, take: pagination.limit }), prisma.auditLog.count({ where })]);
  return { items, total, ...pagination };
};

const getOperationsHealth = async () => {
  let database: 'ready' | 'not_ready' = 'ready';
  try { await prisma.$queryRaw`SELECT 1`; } catch { database = 'not_ready'; }
  if (database === 'not_ready') {
    return { database, redis: redisClient.isReady ? 'ready' : 'not_ready', game: null, worker: { healthy: false }, outbox: {} as Record<string, number> };
  }
  const [game, lease, outbox] = await Promise.all([
    prisma.game.findUnique({ where: { code: TEEN_PATTI_GAME_CODE }, include: { teen_patti_runtime_state: true } }),
    prisma.workerLease.findUnique({ where: { lease_key: WORKER_LEASE_KEY } }),
    prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const now = new Date();
  return { database, redis: redisClient.isReady ? 'ready' : 'not_ready', game: game ? { status: game.status, runtime_status: game.teen_patti_runtime_state?.status ?? null, revision: game.teen_patti_runtime_state?.revision ?? null } : null, worker: lease ? { owner_id: lease.owner_id, lease_until: lease.lease_until, heartbeat_at: lease.heartbeat_at, healthy: lease.lease_until > now } : { healthy: false }, outbox: Object.fromEntries(outbox.map((item) => [item.status, item._count._all])) };
};

export const refreshOperationalAlerts = async () => {
  const health = await getOperationsHealth();
  const conditions: Array<{ code: string; severity: 'warning' | 'critical'; message: string; metadata: Record<string, unknown> }> = [];
  if (health.database !== 'ready') {
    if (Date.now() - lastDatabaseUnavailableWebhookAt >= 5 * 60_000) {
      lastDatabaseUnavailableWebhookAt = Date.now();
      await deliverOpsWebhook({ event_id: `database-unavailable-${lastDatabaseUnavailableWebhookAt}`, source: 'teen-patti-ops', code: 'database_unavailable', severity: 'critical', message: 'PostgreSQL is unavailable', metadata: {}, occurred_at: new Date().toISOString() }).catch((error) => logger.error('ops_alert_webhook_failed', { code: 'database_unavailable', error }));
    }
    return { active: 1, resolved: 0 };
  }
  lastDatabaseUnavailableWebhookAt = 0;
  if (health.redis !== 'ready') conditions.push({ code: 'redis_unavailable', severity: 'critical', message: 'Redis is unavailable; realtime delivery is degraded', metadata: {} });
  if (!health.worker.healthy && health.game?.status === 'active') conditions.push({ code: 'greedy_worker_unhealthy', severity: 'critical', message: 'Teen Patti worker lease is absent or expired', metadata: { worker: health.worker } });
  if (health.game?.runtime_status === 'degraded') conditions.push({ code: 'greedy_runtime_degraded', severity: 'critical', message: 'Teen Patti runtime is degraded', metadata: {} });
  if (Number(health.outbox.failed || 0) > 0) conditions.push({ code: 'outbox_delivery_failed', severity: 'critical', message: 'Realtime outbox events have failed delivery', metadata: { failed: health.outbox.failed } });
  const stalled_before = new Date(Date.now() - 2 * 60_000);
  const [stalled_settlement, stalled_refund] = await Promise.all([
    prisma.teenPattiRound.findFirst({ where: { game: { code: TEEN_PATTI_GAME_CODE }, status: TeenPattiRoundStatus.settling, settlement_started_at: { lt: stalled_before } }, orderBy: { settlement_started_at: 'asc' }, select: { id: true, round_number: true, settlement_started_at: true } }),
    prisma.teenPattiRound.findFirst({ where: { game: { code: TEEN_PATTI_GAME_CODE }, status: TeenPattiRoundStatus.cancelled, cancelled_at: { lt: stalled_before } }, orderBy: { cancelled_at: 'asc' }, select: { id: true, round_number: true, cancelled_at: true } }),
  ]);
  if (stalled_settlement) conditions.push({ code: 'settlement_failed_or_stalled', severity: 'critical', message: 'A Teen Patti round settlement is stalled', metadata: { round_id: stalled_settlement.id, round_number: stalled_settlement.round_number.toString(), settlement_started_at: stalled_settlement.settlement_started_at?.toISOString() } });
  if (stalled_refund) conditions.push({ code: 'refund_failed_or_stalled', severity: 'critical', message: 'A cancelled Teen Patti round refund is stalled', metadata: { round_id: stalled_refund.id, round_number: stalled_refund.round_number.toString(), cancelled_at: stalled_refund.cancelled_at?.toISOString() } });
  const seen = new Set(conditions.map((item) => item.code));
  for (const condition of conditions) {
    const dedupe_key = `greedy:${condition.code}`;
    const existing = await prisma.opsAlert.findUnique({ where: { dedupe_key } });
    const should_notify = !existing || existing.status === OpsAlertStatus.resolved;
    const alert = existing
      ? await prisma.opsAlert.update({ where: { id: existing.id }, data: { status: existing.status === OpsAlertStatus.acknowledged ? OpsAlertStatus.acknowledged : OpsAlertStatus.open, severity: condition.severity, message: condition.message, metadata: condition.metadata as Prisma.InputJsonObject, last_seen_at: new Date(), resolved_at: null, resolved_by_id: null } })
      : await prisma.opsAlert.create({ data: { code: condition.code, severity: condition.severity, status: OpsAlertStatus.open, message: condition.message, source: 'teen-patti-ops', dedupe_key, metadata: condition.metadata as Prisma.InputJsonObject } });
    if (should_notify && condition.severity === 'critical') {
      await deliverOpsWebhook({ event_id: alert.id, source: 'teen-patti-ops', code: condition.code, severity: condition.severity, message: condition.message, metadata: condition.metadata, occurred_at: alert.first_seen_at.toISOString() }).catch((error) => logger.error('ops_alert_webhook_failed', { alert_id: alert.id, code: condition.code, error }));
    }
  }
  const stale = await prisma.opsAlert.findMany({ where: { status: { in: [OpsAlertStatus.open, OpsAlertStatus.acknowledged] }, dedupe_key: { startsWith: 'teen-patti:' }, last_seen_at: { lt: new Date(Date.now() - 90_000) } }, select: { id: true } });
  if (stale.length) await prisma.opsAlert.updateMany({ where: { id: { in: stale.map((item) => item.id) } }, data: { status: OpsAlertStatus.resolved, resolved_at: new Date() } });
  return { active: seen.size, resolved: stale.length };
};

const getOverview = async () => {
  const [health, metrics, runtime, recent] = await Promise.all([
    getOperationsHealth(), getMetrics({}),
    prisma.teenPattiRuntimeState.findFirst({ where: { game: { code: TEEN_PATTI_GAME_CODE } }, include: { current_round: true, active_config_version: { select: { id: true, version: true, status: true } } } }),
    prisma.teenPattiRound.findMany({ where: { game: { code: TEEN_PATTI_GAME_CODE } }, orderBy: { round_number: 'desc' }, take: 10, select: { id: true, round_number: true, status: true, result: { select: { winning_option: { select: { code: true, name: true, image_url: true } } } }, _count: { select: { bets: true } } } }),
  ]);
  return { health, runtime, metrics, recent_rounds: recent.map(maskUnrevealedResult) };
};

const listAlerts = async (status?: OpsAlertStatus, page = 1, limit = 20) => {
  const pagination = getPagination(page, limit);
  const where = status ? { status } : {};
  const [items, total] = await prisma.$transaction([prisma.opsAlert.findMany({ where, orderBy: [{ status: 'asc' }, { severity: 'desc' }, { last_seen_at: 'desc' }], skip: pagination.skip, take: pagination.limit }), prisma.opsAlert.count({ where })]);
  return { items, total, ...pagination };
};

const acknowledgeAlert = async (alert_id: string, context: AdminAuditContext = {}) => {
  const admin_user_id = context.admin_user_id;
  if (!admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');
  return prisma.$transaction(async (tx) => {
    const alert = await tx.opsAlert.updateMany({ where: { id: alert_id, status: OpsAlertStatus.open }, data: { status: OpsAlertStatus.acknowledged, acknowledged_at: new Date(), acknowledged_by_id: admin_user_id } });
    if (!alert.count) throw new AppError(httpStatus.CONFLICT, 'Alert is no longer open');
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'ops.alert.acknowledged', entity_type: 'ops_alert', entity_id: alert_id });
    return tx.opsAlert.findUniqueOrThrow({ where: { id: alert_id } });
  });
};

const resolveAlert = async (alert_id: string, context: AdminAuditContext = {}) => {
  const admin_user_id = context.admin_user_id;
  if (!admin_user_id) throw new AppError(httpStatus.UNAUTHORIZED, 'Admin identity is required');
  return prisma.$transaction(async (tx) => {
    const alert = await tx.opsAlert.updateMany({ where: { id: alert_id, status: { in: [OpsAlertStatus.open, OpsAlertStatus.acknowledged] } }, data: { status: OpsAlertStatus.resolved, resolved_at: new Date(), resolved_by_id: admin_user_id } });
    if (!alert.count) throw new AppError(httpStatus.CONFLICT, 'Alert is already resolved');
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'ops.alert.resolved', entity_type: 'ops_alert', entity_id: alert_id });
    return tx.opsAlert.findUniqueOrThrow({ where: { id: alert_id } });
  });
};

const setAvailability = async (status: GameStatus, context: AdminAuditContext = {}) =>
  prisma.$transaction(async (tx) => {
    const game = await getGameOrThrow(tx);
    const runtime = await tx.teenPattiRuntimeState.findUnique({ where: { game_id: game.id } });
    if (!runtime) throw new AppError(httpStatus.CONFLICT, 'Teen Patti runtime is not initialized');
    if ((status === GameStatus.disabled || game.status === GameStatus.disabled) && !canManageGameAvailability(context.actor_role)) throw new AppError(httpStatus.FORBIDDEN, 'Only a game admin can transition into or out of the disabled state');
    if (status === GameStatus.disabled && runtime.current_round_id) {
      throw new AppError(httpStatus.CONFLICT, 'The game can only be disabled when no round is active');
    }
    if (status === GameStatus.active && !runtime.active_config_version_id) throw new AppError(httpStatus.CONFLICT, 'Publish a Teen Patti config before activating the game');
    const nextRuntime = status === GameStatus.active
      ? TeenPattiRuntimeStatus.running
      : status === GameStatus.disabled
        ? TeenPattiRuntimeStatus.stopped
        : TeenPattiRuntimeStatus.paused;
    await tx.game.update({ where: { id: game.id }, data: { status } });
    const updated = await tx.teenPattiRuntimeState.update({ where: { game_id: game.id }, data: { status: nextRuntime, revision: { increment: 1 } } });
    await writeAdminAudit(tx, { ...context, outcome: 'success' }, { action: 'teen_patti.game.availability_changed', entity_type: 'game', entity_id: game.id, old_values: { status: game.status }, new_values: { status } });
    await tx.outboxEvent.create({ data: { aggregate_type: 'game', aggregate_id: game.id, event_type: 'platform.game.availability_changed', socket_room: TEEN_PATTI_SOCKET_ROOM, payload: { game_code: TEEN_PATTI_GAME_CODE, status } } });
    return { game: { ...game, status }, runtime: updated };
  });

export default { getConfig, updateDraft, cloneConfig, listRounds, getRound, verifyRoundResult, listRoundBets, getUserSummary, getMetrics, listAuditLogs, getOperationsHealth, getOverview, setAvailability, listAlerts, acknowledgeAlert, resolveAlert, refreshOperationalAlerts };
