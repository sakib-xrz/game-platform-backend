import httpStatus from 'http-status';
import {
  GreedyClassicRoundStatus,
  IdempotencyStatus,
  Prisma,
  WalletLedgerType,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import {
  ensureWallet,
  WalletInitializationRequiredError,
  withWalletInitializationRetry,
} from '@/modules/wallet/wallet.services';
import {
  attachUserId,
  isBotUserId,
  isBotUserIdSync,
  resolveGameIdentities,
  resolveGameIdentitySync,
} from '@/modules/game-bot/bot-identity';
import { getPagination } from '@/utils/pagination';
import { sha256 } from '@/utils/hash';
import { toJsonSafe } from '@/utils/json-safe';
import {
  GREEDY_CLASSIC_CURRENCY_CODE,
  GREEDY_CLASSIC_GAME_CODE,
  GREEDY_CLASSIC_IDEMPOTENCY_SCOPE,
  GREEDY_CLASSIC_SOCKET_ROOM,
} from './greedy-classic.constant';
import type {
  BetResponse,
  GreedyClassicBettorAggregate,
  GreedyClassicTopWinner,
} from './greedy-classic.types';
import type { PlaceBetBody } from './greedy-classic.validation';
import type { WalletBalanceUpdatedPayload } from '@/modules/wallet/wallet.types';
import {
  buildGreedyClassicBetPlacedPayload,
  withSerializableRetry,
  withPayoutMultiplier,
  withPayoutMultipliers,
} from './greedy-classic.utils';
import {
  getGreedyClassicTopWinnersByRound,
  type GreedyClassicLeaderboardTarget,
} from './greedy-classic.leaderboard';
import { randomUUID } from 'node:crypto';

const public_result_statuses: GreedyClassicRoundStatus[] = [
  GreedyClassicRoundStatus.result_revealed,
  GreedyClassicRoundStatus.settling,
  GreedyClassicRoundStatus.settled,
  GreedyClassicRoundStatus.closed,
];

const publicOptionSelect = {
  id: true,
  code: true,
  name: true,
  image_url: true,
  display_order: true,
  payout_numerator: true,
  payout_denominator: true,
  is_enabled: true,
} satisfies Prisma.GreedyClassicOptionVersionSelect;

const publicChipSelect = {
  id: true,
  amount: true,
  display_order: true,
  is_enabled: true,
} satisfies Prisma.GreedyClassicChipValueVersionSelect;

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
} satisfies Prisma.GreedyClassicConfigVersionSelect;

const publicResultSelect = {
  id: true,
  round_id: true,
  algorithm_version: true,
  generated_at: true,
  revealed_at: true,
  winning_option: { select: publicOptionSelect },
} satisfies Prisma.GreedyClassicRoundResultSelect;

const requestHash = (payload: PlaceBetBody): string =>
  sha256(
    [
      payload.round_id,
      payload.option_id,
      payload.amount,
      payload.client_request_id,
    ].join('|'),
  );

type ResultWithWinningOption = {
  round_id: string;
  winning_option: {
    id: string;
    payout_numerator: bigint;
    payout_denominator: bigint;
  };
};

const toLeaderboardTarget = (
  result: ResultWithWinningOption,
): GreedyClassicLeaderboardTarget => ({
  round_id: result.round_id,
  winning_option_id: result.winning_option.id,
  payout_numerator: result.winning_option.payout_numerator,
  payout_denominator: result.winning_option.payout_denominator,
});

const decorateResult = <T extends ResultWithWinningOption>(
  result: T | null,
  top_winners: GreedyClassicTopWinner[] = [],
) => {
  if (!result) return null;
  return {
    ...result,
    winning_option: withPayoutMultiplier(result.winning_option),
    top_winners,
  };
};

const getSnapshot = async (user_id: string) => {
  const [
    game,
    wallet,
    current_bets,
    history_candidates,
    config_candidates,
    current_result_candidate,
    current_bettor_groups,
  ] = await Promise.all([
    prisma.game.findUnique({
      where: { code: GREEDY_CLASSIC_GAME_CODE },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        greedy_classic_runtime_state: {
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
    ensureWallet(user_id),
    prisma.greedyClassicBet.findMany({
      where: {
        user_id,
        round: {
          game: { code: GREEDY_CLASSIC_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      select: {
        id: true,
        round_id: true,
        amount: true,
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
    prisma.greedyClassicRound.findMany({
      where: {
        game: { code: GREEDY_CLASSIC_GAME_CODE },
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
    prisma.greedyClassicConfigVersion.findMany({
      where: {
        OR: [
          {
            active_runtime_states: {
              some: { game: { code: GREEDY_CLASSIC_GAME_CODE } },
            },
          },
          {
            rounds: {
              some: {
                game: { code: GREEDY_CLASSIC_GAME_CODE },
                runtime_current: { isNot: null },
              },
            },
          },
        ],
      },
      select: publicConfigSelect,
    }),
    prisma.greedyClassicRoundResult.findFirst({
      where: {
        round: {
          game: { code: GREEDY_CLASSIC_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      select: publicResultSelect,
    }),
    prisma.greedyClassicBet.groupBy({
      by: ['round_id', 'option_version_id', 'user_id'],
      where: {
        round: {
          game: { code: GREEDY_CLASSIC_GAME_CODE },
          runtime_current: { isNot: null },
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { accepted_at: true },
      _max: { accepted_at: true },
    }),
  ]);

  if (
    !game ||
    !game.greedy_classic_runtime_state ||
    !game.greedy_classic_runtime_state.active_config_version_id
  ) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Greedy game is not fully initialized',
    );
  }

  const current_round = game.greedy_classic_runtime_state.current_round;
  const required_config_ids = new Set([
    game.greedy_classic_runtime_state.active_config_version_id,
    ...(current_round ? [current_round.config_version_id] : []),
  ]);
  let config_versions = config_candidates;
  const missing_config_ids = [...required_config_ids].filter(
    (config_id) => !config_versions.some((config) => config.id === config_id),
  );
  if (missing_config_ids.length) {
    const fallback_configs = await prisma.greedyClassicConfigVersion.findMany({
      where: { id: { in: missing_config_ids } },
      select: publicConfigSelect,
    });
    config_versions = [...config_versions, ...fallback_configs];
  }
  const active_config = config_versions.find(
    (config) =>
      config.id === game.greedy_classic_runtime_state!.active_config_version_id,
  );
  const current_config = current_round
    ? config_versions.find(
        (config) => config.id === current_round.config_version_id,
      )
    : null;
  if (!active_config || (current_round && !current_config)) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Greedy game configuration is unavailable',
    );
  }

  const my_bets = current_round
    ? current_bets.filter((bet) => bet.round_id === current_round.id)
    : [];
  const history = history_candidates
    .filter((round) => round.id !== current_round?.id)
    .slice(0, 20);

  const result_is_public = current_round
    ? public_result_statuses.includes(current_round.status)
    : false;
  let current_result =
    current_result_candidate?.round_id === current_round?.id
      ? current_result_candidate
      : null;
  if (current_round && result_is_public && !current_result) {
    current_result = await prisma.greedyClassicRoundResult.findUnique({
      where: { round_id: current_round.id },
      select: publicResultSelect,
    });
  }

  const bettors: GreedyClassicBettorAggregate[] = current_round
    ? await (async () => {
        const groups = current_bettor_groups
          .filter(
            (group) =>
              group.round_id === current_round.id &&
              group._sum.amount !== null &&
              group._min.accepted_at !== null &&
              group._max.accepted_at !== null,
          )
          .sort((left, right) => {
            const recent_difference =
              right._max.accepted_at!.getTime() - left._max.accepted_at!.getTime();
            if (recent_difference !== 0) return recent_difference;
            return left.user_id < right.user_id
              ? -1
              : left.user_id > right.user_id
                ? 1
                : 0;
          });
        const identities = await resolveGameIdentities(groups.map((group) => group.user_id));
        return groups.map((group) => ({
          round_id: group.round_id,
          option_id: group.option_version_id,
          user_id: group.user_id,
          display_name: identities.get(group.user_id)?.display_name ?? null,
          avatar_url: identities.get(group.user_id)?.avatar_url ?? null,
          total_amount: group._sum.amount!.toString(),
          bet_count: group._count._all,
          first_bet_at: group._min.accepted_at!.toISOString(),
          last_bet_at: group._max.accepted_at!.toISOString(),
        }));
      })()
    : [];

  const leaderboard_targets: GreedyClassicLeaderboardTarget[] = [
    ...(result_is_public && current_result
      ? [toLeaderboardTarget(current_result)]
      : []),
    ...history.flatMap((round) =>
      round.result ? [toLeaderboardTarget(round.result)] : [],
    ),
  ];
  const top_winners_by_round = await getGreedyClassicTopWinnersByRound(
    leaderboard_targets,
  );

  const public_active_config = {
    ...active_config,
    options: withPayoutMultipliers(active_config.options),
  };
  const public_current_config = current_config
    ? {
        ...current_config,
        options: withPayoutMultipliers(current_config.options),
      }
    : null;

  return {
    server_time: new Date(),
    game: { code: game.code, name: game.name, status: game.status },
    runtime: {
      status: game.greedy_classic_runtime_state.status,
      revision: game.greedy_classic_runtime_state.revision,
    },
    active_config: public_active_config,
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
            public_current_config!.betting_duration_ms,
          lock_duration_ms: public_current_config!.lock_duration_ms,
          drawing_duration_ms:
            public_current_config!.drawing_duration_ms,
          result_duration_ms: public_current_config!.result_duration_ms,
          min_bet: public_current_config!.min_bet,
          max_single_bet: public_current_config!.max_single_bet,
          max_round_bet: public_current_config!.max_round_bet,
          options: public_current_config!.options,
          chip_values: public_current_config!.chip_values,
          bettors,
          result: result_is_public
            ? decorateResult(
                current_result,
                top_winners_by_round.get(current_round.id) ?? [],
              )
            : null,
        }
      : null,
    wallet,
    my_bets: my_bets.map((bet) => ({
      ...bet,
      option: withPayoutMultiplier(bet.option),
    })),
    recent_history: history.map((round) => ({
      ...round,
      result: decorateResult(
        round.result,
        top_winners_by_round.get(round.id) ?? [],
      ),
    })),
  };
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
        ${GREEDY_CLASSIC_IDEMPOTENCY_SCOPE},
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
            scope: GREEDY_CLASSIC_IDEMPOTENCY_SCOPE,
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

    // Lock the round row in shared mode for the duration of this bet transaction.
    // The worker needs an UPDATE lock to transition betting_open -> betting_locked,
    // so it must wait for every already-accepted/in-flight bet transaction to finish.
    // CURRENT_TIMESTAMP keeps the deadline decision on the database clock.
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
        payout_numerator: bigint | null;
        payout_denominator: bigint | null;
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
        betting_option.payout_numerator,
        betting_option.payout_denominator,
        config.min_bet,
        config.max_single_bet,
        config.max_round_bet
      FROM greedy_classic_rounds AS game_round
      JOIN games AS game ON game.id = game_round.game_id
      JOIN greedy_classic_config_versions AS config
        ON config.id = game_round.config_version_id
      LEFT JOIN greedy_classic_runtime_state AS runtime
        ON runtime.game_id = game_round.game_id
      LEFT JOIN greedy_classic_option_versions AS betting_option
        ON betting_option.id = ${payload.option_id}
        AND betting_option.config_version_id = game_round.config_version_id
        AND betting_option.is_enabled = TRUE
      WHERE game_round.id = ${payload.round_id}
      FOR SHARE OF game_round
    `);

    const barrier = round_barrier[0];
    if (barrier && barrier.game_status !== 'active') {
      throw new AppError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Greedy game is not accepting bets',
      );
    }
    if (
      !barrier ||
      barrier.game_code !== GREEDY_CLASSIC_GAME_CODE ||
      barrier.runtime_round_id !== barrier.id ||
      barrier.status !== GreedyClassicRoundStatus.betting_open ||
      !barrier.betting_ends_at ||
      barrier.server_now >= barrier.betting_ends_at
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Betting is closed for this round',
      );
    }

    if (
      !barrier.option_id ||
      barrier.payout_numerator === null ||
      barrier.payout_denominator === null
    ) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Invalid betting option');
    }

    if (amount < barrier.min_bet || amount > barrier.max_single_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Bet must be between ${barrier.min_bet.toString()} and ${barrier.max_single_bet.toString()}`,
      );
    }

    const exposure = await tx.greedyClassicBet.aggregate({
      where: { round_id: barrier.id, user_id },
      _sum: { amount: true },
    });
    if ((exposure._sum.amount ?? 0n) + amount > barrier.max_round_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Maximum round bet limit exceeded',
      );
    }

    const bot_bet = isBotUserIdSync(user_id);
    const bet_id = randomUUID();
    let debited_wallet: {
      id: string;
      balance_before: bigint;
      balance_after: bigint;
      version: number;
    } | null = null;
    let ledger_id: string | null = null;

    if (!bot_bet) {
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
          AND currency.code = ${GREEDY_CLASSIC_CURRENCY_CODE}
          AND currency.is_active = TRUE
          AND wallet.balance >= ${amount}
        RETURNING
          wallet.id,
          wallet.balance + ${amount} AS balance_before,
          wallet.balance AS balance_after,
          wallet.version
      `);
      debited_wallet = wallet_rows[0] ?? null;
      if (!debited_wallet) {
        const wallet = await tx.wallet.findFirst({
          where: {
            user_id,
            currency: { code: GREEDY_CLASSIC_CURRENCY_CODE, is_active: true },
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

      const ledger = await tx.walletLedger.create({
        data: {
          wallet_id: debited_wallet.id,
          user_id,
          game_id: barrier.game_id,
          type: WalletLedgerType.bet_debit,
          amount: -amount,
          balance_before: debited_wallet.balance_before,
          balance_after: debited_wallet.balance_after,
          reference_type: 'greedy_classic_bet',
          reference_id: bet_id,
          idempotency_key: payload.client_request_id,
        },
      });
      ledger_id = ledger.id;
    }

    const bet = await tx.greedyClassicBet.create({
      data: {
        id: bet_id,
        game_id: barrier.game_id,
        round_id: barrier.id,
        user_id,
        wallet_id: debited_wallet?.id ?? null,
        option_version_id: barrier.option_id,
        amount,
        payout_numerator: barrier.payout_numerator,
        payout_denominator: barrier.payout_denominator,
        client_request_id: payload.client_request_id,
        wallet_debit_ledger_id: ledger_id,
      },
    });
    const bettor_option_aggregate = await tx.greedyClassicBet.aggregate({
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
    if (
      bettor_option_aggregate._sum.amount === null ||
      bettor_option_aggregate._min.accepted_at === null ||
      bettor_option_aggregate._max.accepted_at === null
    ) {
      throw new Error('Accepted Greedy Classic bet aggregate is unavailable');
    }

    const response: BetResponse = {
      bet_id: bet.id,
      round_id: barrier.id,
      option_id: barrier.option_id,
      amount: amount.toString(),
      client_request_id: payload.client_request_id,
      wallet_balance: bot_bet ? '0' : debited_wallet!.balance_after.toString(),
      wallet_version: bot_bet ? 0 : debited_wallet!.version,
      accepted_at: bet.accepted_at.toISOString(),
    };
    const public_bet_event = buildGreedyClassicBetPlacedPayload(
      {
        id: bet.id,
        round_id: barrier.id,
        option_id: barrier.option_id,
        amount,
        accepted_at: bet.accepted_at,
        total_amount: bettor_option_aggregate._sum.amount,
        bet_count: bettor_option_aggregate._count._all,
        first_bet_at: bettor_option_aggregate._min.accepted_at,
        last_bet_at: bettor_option_aggregate._max.accepted_at,
      },
      attachUserId(user_id, resolveGameIdentitySync(user_id)),
    );

    await tx.idempotencyRecord.update({
      where: {
        user_id_scope_idempotency_key: {
          user_id,
          scope: GREEDY_CLASSIC_IDEMPOTENCY_SCOPE,
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
          aggregate_type: 'greedy_classic_bet',
          aggregate_id: bet.id,
          event_type: 'greedy_classic.bet.accepted',
          socket_room: `user:${user_id}`,
          payload: toJsonSafe(response) as Prisma.InputJsonValue,
        },
        {
          aggregate_type: 'greedy_classic_bet',
          aggregate_id: bet.id,
          event_type: 'greedy_classic.bet.placed',
          socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
          payload: toJsonSafe(public_bet_event) as Prisma.InputJsonValue,
        },
        ...(bot_bet || !debited_wallet
          ? []
          : [{
              aggregate_type: 'wallet',
              aggregate_id: debited_wallet.id,
              event_type: 'wallet.balance.updated',
              socket_room: `user:${user_id}`,
              payload: {
                wallet_id: debited_wallet.id,
                balance: debited_wallet.balance_after.toString(),
                wallet_version: debited_wallet.version,
                reason: 'greedy_classic_bet',
                round_id: barrier.id,
              } satisfies WalletBalanceUpdatedPayload,
            }]),
      ],
    });

    return response;
  });
};

const placeBet = async (user_id: string, payload: PlaceBetBody) => {
  if (await isBotUserId(user_id)) {
    return placeBetTransaction(user_id, payload);
  }
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
            scope: GREEDY_CLASSIC_IDEMPOTENCY_SCOPE,
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
    prisma.greedyClassicBet.findMany({
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
    prisma.greedyClassicBet.count({ where: { user_id } }),
  ]);
  return {
    items: items.map((item) => ({
      ...item,
      option: withPayoutMultiplier(item.option),
    })),
    total,
    ...pagination,
  };
};

const getRoundHistory = async (page = 1, limit = 20) => {
  const game = await prisma.game.findUnique({
    where: { code: GREEDY_CLASSIC_GAME_CODE },
  });
  if (!game) {
    throw new AppError(httpStatus.NOT_FOUND, 'Greedy game not found');
  }

  const pagination = getPagination(page, limit);
  const where: Prisma.GreedyClassicRoundWhereInput = {
    game_id: game.id,
    status: {
      in: [
        GreedyClassicRoundStatus.result_revealed,
        GreedyClassicRoundStatus.settling,
        GreedyClassicRoundStatus.settled,
        GreedyClassicRoundStatus.closed,
      ],
    },
    result: { isNot: null },
  };

  const [items, total] = await prisma.$transaction([
    prisma.greedyClassicRound.findMany({
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
    prisma.greedyClassicRound.count({ where }),
  ]);
  const top_winners_by_round = await getGreedyClassicTopWinnersByRound(
    items.flatMap((item) =>
      item.result ? [toLeaderboardTarget(item.result)] : [],
    ),
  );
  return {
    items: items.map((item) => ({
      ...item,
      result: decorateResult(
        item.result,
        top_winners_by_round.get(item.id) ?? [],
      ),
    })),
    total,
    ...pagination,
  };
};

const getRound = async (round_id: string) => {
  const round = await prisma.greedyClassicRound.findUnique({
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
  const top_winners_by_round =
    result_is_public && round.result
      ? await getGreedyClassicTopWinnersByRound([
          toLeaderboardTarget(round.result),
        ])
      : new Map<string, GreedyClassicTopWinner[]>();
  const result = result_is_public
    ? decorateResult(
        round.result,
        top_winners_by_round.get(round.id) ?? [],
      )
    : null;

  return {
    ...round,
    config_version: {
      ...round.config_version,
      options: withPayoutMultipliers(round.config_version.options),
    },
    result,
  };
};

const GreedyClassicService = {
  getSnapshot,
  placeBet,
  getMyBets,
  getRoundHistory,
  getRound,
};

export default GreedyClassicService;
