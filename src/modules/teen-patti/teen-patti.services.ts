import httpStatus from 'http-status';
import {
  IdempotencyStatus,
  Prisma,
  TeenPattiRoundStatus,
  WalletLedgerType,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import {
  ensureWallet,
  WalletInitializationRequiredError,
  withWalletInitializationRetry,
} from '@/modules/wallet/wallet.services';
import { getPagination } from '@/utils/pagination';
import { sha256 } from '@/utils/hash';
import { toJsonSafe } from '@/utils/json-safe';
import { withSerializableRetry } from '@/modules/greedy/greedy.utils';
import {
  TEEN_PATTI_CURRENCY_CODE,
  TEEN_PATTI_GAME_CODE,
  TEEN_PATTI_IDEMPOTENCY_SCOPE,
  TEEN_PATTI_SOCKET_ROOM,
} from './teen-patti.constant';
import type {
  BetResponse,
  TeenPattiBettorAggregate,
} from './teen-patti.types';
import type { PlaceBetBody } from './teen-patti.validation';
import type { WalletBalanceUpdatedPayload } from '@/modules/wallet/wallet.types';
import { randomUUID } from 'node:crypto';
import {
  buildTeenPattiBetPlacedPayload,
  buildTeenPattiPreview,
} from './teen-patti.public';
import { effectiveTeenPattiResultDurationMs } from './teen-patti.config';

const public_result_statuses: TeenPattiRoundStatus[] = [
  TeenPattiRoundStatus.result_revealed,
  TeenPattiRoundStatus.settling,
  TeenPattiRoundStatus.settled,
  TeenPattiRoundStatus.closed,
];

const publicOptionSelect = {
  id: true,
  code: true,
  name: true,
  image_url: true,
  display_order: true,
  is_enabled: true,
} satisfies Prisma.TeenPattiOptionVersionSelect;

const publicChipSelect = {
  id: true,
  amount: true,
  display_order: true,
  is_enabled: true,
} satisfies Prisma.TeenPattiChipValueVersionSelect;

const publicConfigSelect = {
  id: true,
  version: true,
  betting_duration_ms: true,
  lock_duration_ms: true,
  drawing_duration_ms: true,
  result_duration_ms: true,
  min_bet: true,
  max_single_bet: true,
  max_round_bet: true,
  rake_bps: true,
  options: {
    select: publicOptionSelect,
    where: { is_enabled: true },
    orderBy: { display_order: 'asc' as const },
  },
  chip_values: {
    select: publicChipSelect,
    where: { is_enabled: true },
    orderBy: { display_order: 'asc' as const },
  },
} satisfies Prisma.TeenPattiConfigVersionSelect;

const publicResultSelect = {
  id: true,
  round_id: true,
  algorithm_version: true,
  config_version_id: true,
  entropy_digest: true,
  audit_hash: true,
  generated_at: true,
  revealed_at: true,
  deal_attempt_count: true,
  hands: true,
  winning_option: { select: publicOptionSelect },
} satisfies Prisma.TeenPattiRoundResultSelect;

const decoratePublicResult = <T extends { audit_hash: string }>(
  result: T | null,
) => {
  if (!result) return null;
  const { audit_hash, ...public_result } = result;
  return { ...public_result, result_commitment: audit_hash };
};

const requestHash = (payload: PlaceBetBody): string =>
  sha256(
    [
      payload.round_id,
      payload.option_id,
      payload.amount,
      payload.client_request_id,
    ].join('|'),
  );

const getSnapshotFromTransaction = async (
  user_id: string,
  tx: Prisma.TransactionClient,
) => {
  const [
    server_time_rows,
    game,
    wallet,
    current_bets,
    current_bettor_groups,
    history_candidates,
    config_candidates,
    current_result_candidate,
  ] = await Promise.all([
    tx.$queryRaw<Array<{ server_time: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS server_time`,
    ),
    tx.game.findUnique({
      where: { code: TEEN_PATTI_GAME_CODE },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        teen_patti_runtime_state: {
          select: {
            status: true,
            revision: true,
            active_config_version_id: true,
            current_round: {
              select: {
                id: true,
                round_number: true,
                config_version_id: true,
                status: true,
                betting_started_at: true,
                betting_ends_at: true,
                drawing_started_at: true,
                result_reveal_at: true,
              },
            },
          },
        },
      },
    }),
    ensureWallet(user_id, tx),
    tx.teenPattiBet.findMany({
      where: {
        user_id,
        round: {
          game: { code: TEEN_PATTI_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      select: {
        id: true,
        round_id: true,
        amount: true,
        client_request_id: true,
        accepted_at: true,
        option: { select: publicOptionSelect },
        settlement: {
          select: {
            outcome: true,
            payout_amount: true,
            settled_at: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    }),
    tx.teenPattiBet.groupBy({
      by: ['round_id', 'option_version_id', 'user_id'],
      where: {
        round: {
          game: { code: TEEN_PATTI_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { accepted_at: true },
      _max: { accepted_at: true },
    }),
    tx.teenPattiRound.findMany({
      where: {
        game: { code: TEEN_PATTI_GAME_CODE },
        status: { in: public_result_statuses },
        result: { isNot: null },
      },
      select: {
        id: true,
        round_number: true,
        status: true,
        result_reveal_at: true,
        closed_at: true,
        result: { select: publicResultSelect },
      },
      orderBy: { round_number: 'desc' },
      take: 21,
    }),
    tx.teenPattiConfigVersion.findMany({
      where: {
        OR: [
          {
            active_runtime_states: {
              some: { game: { code: TEEN_PATTI_GAME_CODE } },
            },
          },
          {
            rounds: {
              some: {
                game: { code: TEEN_PATTI_GAME_CODE },
                runtime_current: { isNot: null },
              },
            },
          },
        ],
      },
      select: publicConfigSelect,
    }),
    tx.teenPattiRoundResult.findFirst({
      where: {
        round: {
          game: { code: TEEN_PATTI_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      select: publicResultSelect,
    }),
  ]);

  const server_time = server_time_rows[0]?.server_time;
  if (!server_time) throw new Error('Database time unavailable');

  if (
    !game ||
    !game.teen_patti_runtime_state ||
    !game.teen_patti_runtime_state.active_config_version_id
  ) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Teen Patti game is not fully initialized',
    );
  }

  const current_round = game.teen_patti_runtime_state.current_round;
  const required_config_ids = new Set([
    game.teen_patti_runtime_state.active_config_version_id,
    ...(current_round ? [current_round.config_version_id] : []),
  ]);
  let config_versions = config_candidates;
  const missing_config_ids = [...required_config_ids].filter(
    (config_id) => !config_versions.some((config) => config.id === config_id),
  );
  if (missing_config_ids.length) {
    const fallback_configs = await tx.teenPattiConfigVersion.findMany({
      where: { id: { in: missing_config_ids } },
      select: publicConfigSelect,
    });
    config_versions = [...config_versions, ...fallback_configs];
  }
  const active_config = config_versions.find(
    (config) =>
      config.id === game.teen_patti_runtime_state!.active_config_version_id,
  );
  const current_config = current_round
    ? config_versions.find(
        (config) => config.id === current_round.config_version_id,
      )
    : null;
  if (!active_config || (current_round && !current_config)) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Teen Patti game configuration is unavailable',
    );
  }

  const my_bets = current_round
    ? current_bets.filter((bet) => bet.round_id === current_round.id)
    : [];
  const history = history_candidates
    .filter((round) => round.id !== current_round?.id)
    .slice(0, 20);
  const history_round_ids = history.map((round) => round.id);
  const [history_bet_groups, history_payout_groups] = history_round_ids.length
    ? await Promise.all([
        tx.teenPattiBet.groupBy({
          by: ['round_id'],
          where: { round_id: { in: history_round_ids } },
          _sum: { amount: true },
        }),
        tx.teenPattiUserPayout.groupBy({
          by: ['round_id'],
          where: { round_id: { in: history_round_ids } },
          _sum: { total_payout: true },
        }),
      ])
    : [[], []];
  const history_bet_totals = new Map(
    history_bet_groups.map((group) => [
      group.round_id,
      group._sum.amount ?? 0n,
    ]),
  );
  const history_payout_totals = new Map(
    history_payout_groups.map((group) => [
      group.round_id,
      group._sum.total_payout ?? 0n,
    ]),
  );

  const result_is_public = current_round
    ? public_result_statuses.includes(current_round.status)
    : false;
  let current_result =
    current_result_candidate?.round_id === current_round?.id
      ? current_result_candidate
      : null;
  if (current_round && result_is_public && !current_result) {
    current_result = await tx.teenPattiRoundResult.findUnique({
      where: { round_id: current_round.id },
      select: publicResultSelect,
    });
  }

  const bettors: TeenPattiBettorAggregate[] = current_round
    ? current_bettor_groups
        .filter(
          (group) =>
            group.round_id === current_round.id &&
            group._sum.amount !== null &&
            group._min.accepted_at !== null &&
            group._max.accepted_at !== null,
        )
        .map((group) => ({
          round_id: group.round_id,
          option_id: group.option_version_id,
          user_id: group.user_id,
          display_name: null,
          avatar_url: null,
          total_amount: group._sum.amount!.toString(),
          bet_count: group._count._all,
          first_bet_at: group._min.accepted_at!.toISOString(),
          last_bet_at: group._max.accepted_at!.toISOString(),
        }))
        .sort((left, right) => {
          const recent_difference =
            Date.parse(right.last_bet_at) - Date.parse(left.last_bet_at);
          if (recent_difference !== 0) return recent_difference;
          if (left.option_id !== right.option_id) {
            return left.option_id < right.option_id ? -1 : 1;
          }
          return left.user_id < right.user_id
            ? -1
            : left.user_id > right.user_id
              ? 1
              : 0;
        })
    : [];
  const option_pot_totals = new Map<string, bigint>();
  for (const bettor of bettors) {
    option_pot_totals.set(
      bettor.option_id,
      (option_pot_totals.get(bettor.option_id) ?? 0n) +
        BigInt(bettor.total_amount),
    );
  }
  const player_count = new Set(bettors.map((bettor) => bettor.user_id)).size;
  const round_bet_count = bettors.reduce(
    (total, bettor) => total + bettor.bet_count,
    0,
  );
  const preview =
    current_round && current_result
      ? buildTeenPattiPreview(current_result)
      : { preview_cards: [], result_commitment: null };

  return {
    server_time,
    player: { user_id, display_name: null, avatar_url: null },
    game: { code: game.code, name: game.name, status: game.status },
    runtime: {
      status: game.teen_patti_runtime_state.status,
      revision: game.teen_patti_runtime_state.revision,
    },
    active_config,
    round: current_round
      ? {
          id: current_round.id,
          round_number: current_round.round_number,
          status: current_round.status,
          betting_started_at: current_round.betting_started_at,
          betting_ends_at: current_round.betting_ends_at,
          drawing_started_at: current_round.drawing_started_at,
          result_reveal_at: current_round.result_reveal_at,
          config_version_id: current_round.config_version_id,
          betting_duration_ms:
            current_config!.betting_duration_ms,
          lock_duration_ms: current_config!.lock_duration_ms,
          drawing_duration_ms:
            current_config!.drawing_duration_ms,
          result_duration_ms: effectiveTeenPattiResultDurationMs(
            current_config!.result_duration_ms,
          ),
          min_bet: current_config!.min_bet,
          max_single_bet: current_config!.max_single_bet,
          max_round_bet: current_config!.max_round_bet,
          options: current_config!.options,
          chip_values: current_config!.chip_values,
          rake_bps: current_config!.rake_bps,
          bettors,
          player_count,
          round_bet_count,
          option_pot_totals: [...option_pot_totals.entries()].map(
            ([option_id, total_amount]) => ({
              option_id,
              total_amount: total_amount.toString(),
            }),
          ),
          preview_cards: preview.preview_cards,
          result_commitment: preview.result_commitment,
          result: result_is_public
            ? decoratePublicResult(current_result)
            : null,
        }
      : null,
    wallet,
    my_bets,
    recent_history: history.map((round) => ({
      ...round,
      total_bet_amount: (
        history_bet_totals.get(round.id) ?? 0n
      ).toString(),
      total_payout_amount: (
        history_payout_totals.get(round.id) ?? 0n
      ).toString(),
      result: decoratePublicResult(round.result),
    })),
  };
};

const getSnapshot = async (user_id: string) => {
  // Initialize a first-time wallet outside the read-only snapshot transaction,
  // then read it again inside the same MVCC view as bets and aggregates.
  await ensureWallet(user_id);
  return prisma.$transaction(
    (tx) => getSnapshotFromTransaction(user_id, tx),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
};

const placeBetTransaction = async (
  user_id: string,
  payload: PlaceBetBody,
): Promise<BetResponse> => {
  const amount = BigInt(payload.amount);
  const req_hash = requestHash(payload);

  return withSerializableRetry(async (tx) => {
    const idempotency_rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO idempotency_records (
        id,
        user_id,
        scope,
        idempotency_key,
        request_hash,
        expires_at,
        updated_at
      )
      VALUES (
        ${randomUUID()},
        ${user_id},
        ${TEEN_PATTI_IDEMPOTENCY_SCOPE},
        ${payload.client_request_id},
        ${req_hash},
        ${new Date(Date.now() + 24 * 60 * 60 * 1000)},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (user_id, scope, idempotency_key) DO NOTHING
      RETURNING id
    `);

    if (!idempotency_rows.length) {
      const existing = await tx.idempotencyRecord.findUnique({
        where: {
          user_id_scope_idempotency_key: {
            user_id,
            scope: TEEN_PATTI_IDEMPOTENCY_SCOPE,
            idempotency_key: payload.client_request_id,
          },
        },
      });
      if (!existing) {
        throw new AppError(
          httpStatus.CONFLICT,
          'The same bet request is already being processed',
        );
      }
      if (existing.request_hash !== req_hash) {
        throw new AppError(
          httpStatus.CONFLICT,
          'Idempotency key was already used for another request',
        );
      }
      if (
        existing.status === IdempotencyStatus.completed &&
        existing.response_body
      ) {
        return existing.response_body as unknown as BetResponse;
      }
      throw new AppError(
        httpStatus.CONFLICT,
        'The same bet request is already being processed',
      );
    }

    const round_barrier = await tx.$queryRaw<
      Array<{
        id: string;
        game_id: string;
        game_code: string;
        game_status: string;
        runtime_round_id: string | null;
        status: string;
        betting_ends_at: Date | null;
        server_now: Date;
        option_id: string | null;
        enabled_chip_amount: bigint | null;
        min_bet: bigint;
        max_single_bet: bigint;
        max_round_bet: bigint;
      }>
    >(Prisma.sql`
      SELECT
        game_round.id,
        game_round.game_id,
        game.code AS game_code,
        game.status::text AS game_status,
        runtime.current_round_id AS runtime_round_id,
        game_round.status::text AS status,
        game_round.betting_ends_at,
        CURRENT_TIMESTAMP AS server_now,
        betting_option.id AS option_id,
        enabled_chip.amount AS enabled_chip_amount,
        config.min_bet,
        config.max_single_bet,
        config.max_round_bet
      FROM teen_patti_rounds AS game_round
      JOIN games AS game ON game.id = game_round.game_id
      JOIN teen_patti_config_versions AS config
        ON config.id = game_round.config_version_id
      LEFT JOIN teen_patti_runtime_state AS runtime
        ON runtime.game_id = game_round.game_id
      LEFT JOIN teen_patti_option_versions AS betting_option
        ON betting_option.id = ${payload.option_id}
        AND betting_option.config_version_id = game_round.config_version_id
        AND betting_option.is_enabled = TRUE
      LEFT JOIN teen_patti_chip_value_versions AS enabled_chip
        ON enabled_chip.config_version_id = game_round.config_version_id
        AND enabled_chip.amount = ${amount}
        AND enabled_chip.is_enabled = TRUE
      WHERE game_round.id = ${payload.round_id}
      FOR SHARE OF game_round
    `);

    const barrier = round_barrier[0];
    if (barrier && barrier.game_status !== 'active') {
      throw new AppError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Teen Patti is not accepting bets',
      );
    }
    if (
      !barrier ||
      barrier.game_code !== TEEN_PATTI_GAME_CODE ||
      barrier.runtime_round_id !== barrier.id ||
      barrier.status !== TeenPattiRoundStatus.betting_open ||
      !barrier.betting_ends_at ||
      barrier.server_now >= barrier.betting_ends_at
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Betting is closed for this round',
      );
    }

    if (!barrier.option_id) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Invalid betting deck');
    }

    if (barrier.enabled_chip_amount === null) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Bet amount is not an enabled chip denomination',
      );
    }

    if (amount < barrier.min_bet || amount > barrier.max_single_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Bet must be between ${barrier.min_bet.toString()} and ${barrier.max_single_bet.toString()}`,
      );
    }

    const exposure = await tx.teenPattiBet.aggregate({
      where: { round_id: barrier.id, user_id },
      _sum: { amount: true },
    });
    if ((exposure._sum.amount ?? 0n) + amount > barrier.max_round_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Maximum round bet limit exceeded',
      );
    }

    const wallet_rows = await tx.$queryRaw<
      Array<{
        id: string;
        balance_before: bigint;
        balance_after: bigint;
        version: number;
      }>
    >(Prisma.sql`
      UPDATE wallets AS wallet
      SET
        balance = wallet.balance - ${amount},
        version = wallet.version + 1,
        updated_at = CURRENT_TIMESTAMP
      FROM currencies AS currency
      WHERE wallet.user_id = ${user_id}
        AND wallet.currency_id = currency.id
        AND currency.code = ${TEEN_PATTI_CURRENCY_CODE}
        AND currency.is_active = TRUE
        AND wallet.balance >= ${amount}
      RETURNING
        wallet.id,
        wallet.balance + ${amount} AS balance_before,
        wallet.balance AS balance_after,
        wallet.version
    `);
    const debited_wallet = wallet_rows[0];
    if (!debited_wallet) {
      const wallet = await tx.wallet.findFirst({
        where: {
          user_id,
          currency: {
            code: TEEN_PATTI_CURRENCY_CODE,
            is_active: true,
          },
        },
        select: { balance: true },
      });
      if (!wallet) throw new WalletInitializationRequiredError();
      if (wallet.balance >= amount) {
        throw new AppError(
          httpStatus.CONFLICT,
          'Wallet balance changed; retry the bet',
        );
      }
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Insufficient wallet balance',
      );
    }

    const bet_id = randomUUID();
    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: debited_wallet.id,
        user_id,
        game_id: barrier.game_id,
        type: WalletLedgerType.bet_debit,
        amount: -amount,
        balance_before: debited_wallet.balance_before,
        balance_after: debited_wallet.balance_after,
        reference_type: 'teen_patti_bet',
        reference_id: bet_id,
        idempotency_key: payload.client_request_id,
      },
    });

    const bet = await tx.teenPattiBet.create({
      data: {
        id: bet_id,
        game_id: barrier.game_id,
        round_id: barrier.id,
        user_id,
        wallet_id: debited_wallet.id,
        option_version_id: barrier.option_id,
        amount,
        client_request_id: payload.client_request_id,
        wallet_debit_ledger_id: ledger.id,
      },
    });
    const bettor_option_aggregate = await tx.teenPattiBet.aggregate({
      where: {
        round_id: barrier.id,
        option_version_id: barrier.option_id,
        user_id,
      },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { accepted_at: true },
      _max: { accepted_at: true },
    });
    const option_aggregate = await tx.teenPattiBet.aggregate({
      where: {
        round_id: barrier.id,
        option_version_id: barrier.option_id,
      },
      _sum: { amount: true },
    });
    const round_aggregate = await tx.teenPattiBet.aggregate({
      where: { round_id: barrier.id },
      _count: { _all: true },
    });
    const round_players = await tx.teenPattiBet.findMany({
      where: { round_id: barrier.id },
      distinct: ['user_id'],
      select: { user_id: true },
    });
    if (
      bettor_option_aggregate._sum.amount === null ||
      bettor_option_aggregate._min.accepted_at === null ||
      bettor_option_aggregate._max.accepted_at === null ||
      option_aggregate._sum.amount === null
    ) {
      throw new Error('Accepted Teen Patti bet aggregate is unavailable');
    }

    const response: BetResponse = {
      bet_id: bet.id,
      round_id: barrier.id,
      option_id: barrier.option_id,
      amount: amount.toString(),
      client_request_id: payload.client_request_id,
      wallet_balance: debited_wallet.balance_after.toString(),
      wallet_version: debited_wallet.version,
      accepted_at: bet.accepted_at.toISOString(),
    };
    const public_bet_event = buildTeenPattiBetPlacedPayload(
      {
        id: bet.id,
        round_id: barrier.id,
        option_id: barrier.option_id,
        amount,
        accepted_at: bet.accepted_at,
        user_total_amount: bettor_option_aggregate._sum.amount,
        option_total_amount: option_aggregate._sum.amount,
        bet_count: bettor_option_aggregate._count._all,
        first_bet_at: bettor_option_aggregate._min.accepted_at,
        last_bet_at: bettor_option_aggregate._max.accepted_at,
        player_count: round_players.length,
        round_bet_count: round_aggregate._count._all,
      },
      user_id,
    );

    await tx.idempotencyRecord.update({
      where: {
        user_id_scope_idempotency_key: {
          user_id,
          scope: TEEN_PATTI_IDEMPOTENCY_SCOPE,
          idempotency_key: payload.client_request_id,
        },
      },
      data: {
        status: IdempotencyStatus.completed,
        http_status: httpStatus.CREATED,
        response_body: toJsonSafe(response) as Prisma.InputJsonValue,
      },
    });

    await tx.outboxEvent.createMany({
      data: [
        {
          aggregate_type: 'teen_patti_bet',
          aggregate_id: bet.id,
          event_type: 'teen_patti.bet.accepted',
          socket_room: `user:${user_id}`,
          payload: toJsonSafe(response) as Prisma.InputJsonValue,
        },
        {
          aggregate_type: 'teen_patti_bet',
          aggregate_id: bet.id,
          event_type: 'teen_patti.bet.placed',
          socket_room: TEEN_PATTI_SOCKET_ROOM,
          payload: toJsonSafe(public_bet_event) as Prisma.InputJsonValue,
        },
        {
          aggregate_type: 'wallet',
          aggregate_id: debited_wallet.id,
          event_type: 'wallet.balance.updated',
          socket_room: `user:${user_id}`,
          payload: {
            wallet_id: debited_wallet.id,
            balance: debited_wallet.balance_after.toString(),
            wallet_version: debited_wallet.version,
            reason: 'teen_patti_bet',
            round_id: barrier.id,
          } satisfies WalletBalanceUpdatedPayload,
        },
      ],
    });

    return response;
  });
};

const placeBet = async (user_id: string, payload: PlaceBetBody) => {
  try {
    return await withWalletInitializationRetry(user_id, () =>
      placeBetTransaction(user_id, payload),
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: {
          user_id_scope_idempotency_key: {
            user_id,
            scope: TEEN_PATTI_IDEMPOTENCY_SCOPE,
            idempotency_key: payload.client_request_id,
          },
        },
      });
      if (
        existing?.request_hash === requestHash(payload) &&
        existing.status === IdempotencyStatus.completed &&
        existing.response_body
      ) {
        return existing.response_body as unknown as BetResponse;
      }
    }
    throw error;
  }
};

const getMyBets = async (user_id: string, page = 1, limit = 20) => {
  const pagination = getPagination(page, limit);
  const [items, total] = await prisma.$transaction([
    prisma.teenPattiBet.findMany({
      where: { user_id },
      select: {
        id: true,
        round_id: true,
        amount: true,
        accepted_at: true,
        round: { select: { round_number: true, status: true } },
        option: { select: publicOptionSelect },
        settlement: {
          select: {
            outcome: true,
            payout_amount: true,
            settled_at: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.teenPattiBet.count({ where: { user_id } }),
  ]);
  return { items, total, ...pagination };
};

const getRoundHistory = async (page = 1, limit = 20) => {
  const game = await prisma.game.findUnique({
    where: { code: TEEN_PATTI_GAME_CODE },
  });
  if (!game) {
    throw new AppError(httpStatus.NOT_FOUND, 'Teen Patti game not found');
  }

  const pagination = getPagination(page, limit);
  const where: Prisma.TeenPattiRoundWhereInput = {
    game_id: game.id,
    status: { in: public_result_statuses },
    result: { isNot: null },
  };

  const [items, total] = await prisma.$transaction([
    prisma.teenPattiRound.findMany({
      where,
      select: {
        id: true,
        round_number: true,
        status: true,
        result_reveal_at: true,
        closed_at: true,
        result: { select: publicResultSelect },
      },
      orderBy: { round_number: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.teenPattiRound.count({ where }),
  ]);
  return {
    items: items.map((round) => ({
      ...round,
      result: decoratePublicResult(round.result),
    })),
    total,
    ...pagination,
  };
};

const getRound = async (round_id: string) => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    select: {
      id: true,
      round_number: true,
      status: true,
      betting_started_at: true,
      betting_ends_at: true,
      locked_at: true,
      drawing_started_at: true,
      result_reveal_at: true,
      settled_at: true,
      closed_at: true,
      cancelled_at: true,
      cancellation_reason: true,
      config_version: { select: publicConfigSelect },
      result: { select: publicResultSelect },
    },
  });

  if (!round) {
    throw new AppError(httpStatus.NOT_FOUND, 'Round not found');
  }

  const result_is_public = public_result_statuses.includes(round.status);

  const preview = round.result
    ? buildTeenPattiPreview(round.result)
    : { preview_cards: [], result_commitment: null };

  return {
    ...round,
    preview_cards: preview.preview_cards,
    result_commitment: preview.result_commitment,
    result: result_is_public ? decoratePublicResult(round.result) : null,
  };
};

const TeenPattiService = {
  getSnapshot,
  placeBet,
  getMyBets,
  getRoundHistory,
  getRound,
};

export default TeenPattiService;
