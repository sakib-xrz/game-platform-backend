import httpStatus from 'http-status';
import {
  GreedyRoundStatus,
  IdempotencyStatus,
  Prisma,
  WalletLedgerType,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import { getPagination } from '@/utils/pagination';
import { sha256 } from '@/utils/hash';
import { toJsonSafe } from '@/utils/json-safe';
import {
  GREEDY_GAME_CODE,
  GREEDY_IDEMPOTENCY_SCOPE,
} from './greedy.constant';
import type { BetResponse } from './greedy.types';
import type { PlaceBetBody } from './greedy.validation';
import { withSerializableRetry } from './greedy.utils';

const public_result_statuses: GreedyRoundStatus[] = [
  GreedyRoundStatus.result_revealed,
  GreedyRoundStatus.settling,
  GreedyRoundStatus.settled,
  GreedyRoundStatus.closed,
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
} satisfies Prisma.GreedyOptionVersionSelect;

const publicChipSelect = {
  id: true,
  amount: true,
  display_order: true,
  is_enabled: true,
} satisfies Prisma.GreedyChipValueVersionSelect;

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
    orderBy: { display_order: 'asc' as const },
  },
  chip_values: {
    select: publicChipSelect,
    where: { is_enabled: true },
    orderBy: { display_order: 'asc' as const },
  },
} satisfies Prisma.GreedyConfigVersionSelect;

const publicResultSelect = {
  id: true,
  round_id: true,
  algorithm_version: true,
  generated_at: true,
  revealed_at: true,
  winning_option: { select: publicOptionSelect },
} satisfies Prisma.GreedyRoundResultSelect;

const requestHash = (payload: PlaceBetBody): string =>
  sha256(
    [
      payload.round_id,
      payload.option_id,
      payload.amount,
      payload.client_request_id,
    ].join('|'),
  );

const getSnapshot = async (user_id: string) => {
  const game = await prisma.game.findUnique({
    where: { code: GREEDY_GAME_CODE },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      greedy_runtime_state: {
        select: {
          status: true,
          revision: true,
          active_config_version: { select: publicConfigSelect },
          current_round: {
            select: {
              id: true,
              round_number: true,
              status: true,
              betting_started_at: true,
              betting_ends_at: true,
              drawing_started_at: true,
              result_reveal_at: true,
              config_version: { select: publicConfigSelect },
              result: { select: publicResultSelect },
            },
          },
        },
      },
    },
  });

  if (!game || !game.greedy_runtime_state) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Greedy game is not initialized',
    );
  }

  const wallet = await ensureWallet(user_id);
  const current_round = game.greedy_runtime_state.current_round;

  const my_bets = current_round
    ? await prisma.greedyBet.findMany({
        where: { round_id: current_round.id, user_id },
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
      })
    : [];

  const history = await prisma.greedyRound.findMany({
    where: {
      game_id: game.id,
      status: {
        in: [
          GreedyRoundStatus.result_revealed,
          GreedyRoundStatus.settling,
          GreedyRoundStatus.settled,
          GreedyRoundStatus.closed,
        ],
      },
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
    take: 20,
  });

  const result_is_public = current_round
    ? public_result_statuses.includes(current_round.status)
    : false;

  return {
    server_time: new Date(),
    game: { code: game.code, name: game.name, status: game.status },
    runtime: {
      status: game.greedy_runtime_state.status,
      revision: game.greedy_runtime_state.revision,
    },
    active_config: game.greedy_runtime_state.active_config_version,
    round: current_round
      ? {
          id: current_round.id,
          round_number: current_round.round_number,
          status: current_round.status,
          betting_started_at: current_round.betting_started_at,
          betting_ends_at: current_round.betting_ends_at,
          drawing_started_at: current_round.drawing_started_at,
          result_reveal_at: current_round.result_reveal_at,
          options: current_round.config_version.options,
          chip_values: current_round.config_version.chip_values,
          result: result_is_public ? current_round.result : null,
        }
      : null,
    wallet,
    my_bets,
    recent_history: history,
  };
};

const placeBetTransaction = async (
  user_id: string,
  payload: PlaceBetBody,
): Promise<BetResponse> => {
  const amount = BigInt(payload.amount);
  const req_hash = requestHash(payload);

  return withSerializableRetry(async (tx) => {
    const existing = await tx.idempotencyRecord.findUnique({
      where: {
        user_id_scope_idempotency_key: {
          user_id,
          scope: GREEDY_IDEMPOTENCY_SCOPE,
          idempotency_key: payload.client_request_id,
        },
      },
    });

    if (existing) {
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

    await tx.idempotencyRecord.create({
      data: {
        user_id,
        scope: GREEDY_IDEMPOTENCY_SCOPE,
        idempotency_key: payload.client_request_id,
        request_hash: req_hash,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const game = await tx.game.findUnique({
      where: { code: GREEDY_GAME_CODE },
    });
    if (!game || game.status !== 'active') {
      throw new AppError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Greedy game is not accepting bets',
      );
    }

    const runtime = await tx.greedyRuntimeState.findUnique({
      where: { game_id: game.id },
      select: { current_round_id: true },
    });

    // Lock the round row in shared mode for the duration of this bet transaction.
    // The worker needs an UPDATE lock to transition betting_open -> betting_locked,
    // so it must wait for every already-accepted/in-flight bet transaction to finish.
    // CURRENT_TIMESTAMP keeps the deadline decision on the database clock.
    const round_barrier = await tx.$queryRaw<
      Array<{
        id: string;
        game_id: string;
        status: string;
        betting_ends_at: Date | null;
        server_now: Date;
      }>
    >(Prisma.sql`
      SELECT
        id,
        game_id,
        status::text AS status,
        betting_ends_at,
        CURRENT_TIMESTAMP AS server_now
      FROM greedy_rounds
      WHERE id = ${payload.round_id}
      FOR SHARE
    `);

    const barrier = round_barrier[0];
    if (
      !barrier ||
      runtime?.current_round_id !== barrier.id ||
      barrier.game_id !== game.id ||
      barrier.status !== GreedyRoundStatus.betting_open ||
      !barrier.betting_ends_at ||
      barrier.server_now >= barrier.betting_ends_at
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        'Betting is closed for this round',
      );
    }

    const round = await tx.greedyRound.findUnique({
      where: { id: barrier.id },
      include: { config_version: true },
    });

    if (!round) {
      throw new AppError(httpStatus.CONFLICT, 'Betting is closed for this round');
    }

    const option = await tx.greedyOptionVersion.findFirst({
      where: {
        id: payload.option_id,
        config_version_id: round.config_version_id,
        is_enabled: true,
      },
    });
    if (!option) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Invalid betting option');
    }

    const game_config = round.config_version;
    if (amount < game_config.min_bet || amount > game_config.max_single_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Bet must be between ${game_config.min_bet.toString()} and ${game_config.max_single_bet.toString()}`,
      );
    }

    const exposure = await tx.greedyBet.aggregate({
      where: { round_id: round.id, user_id },
      _sum: { amount: true },
    });
    if ((exposure._sum.amount ?? 0n) + amount > game_config.max_round_bet) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Maximum round bet limit exceeded',
      );
    }

    const wallet = await ensureWallet(user_id, tx);
    if (wallet.balance < amount) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Insufficient wallet balance',
      );
    }

    const updated_wallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: amount },
        version: { increment: 1 },
      },
    });

    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id,
        user_id,
        game_id: game.id,
        type: WalletLedgerType.bet_debit,
        amount: -amount,
        balance_before: wallet.balance,
        balance_after: updated_wallet.balance,
        reference_type: 'greedy_bet',
        idempotency_key: payload.client_request_id,
      },
    });

    const bet = await tx.greedyBet.create({
      data: {
        game_id: game.id,
        round_id: round.id,
        user_id,
        wallet_id: wallet.id,
        option_version_id: option.id,
        amount,
        payout_numerator: option.payout_numerator,
        payout_denominator: option.payout_denominator,
        client_request_id: payload.client_request_id,
        wallet_debit_ledger_id: ledger.id,
      },
    });

    await tx.walletLedger.update({
      where: { id: ledger.id },
      data: { reference_id: bet.id },
    });

    const response: BetResponse = {
      bet_id: bet.id,
      round_id: round.id,
      option_id: option.id,
      amount: amount.toString(),
      wallet_balance: updated_wallet.balance.toString(),
      accepted_at: bet.accepted_at.toISOString(),
    };

    await tx.idempotencyRecord.update({
      where: {
        user_id_scope_idempotency_key: {
          user_id,
          scope: GREEDY_IDEMPOTENCY_SCOPE,
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
          aggregate_type: 'greedy_bet',
          aggregate_id: bet.id,
          event_type: 'greedy.bet.accepted',
          socket_room: `user:${user_id}`,
          payload: toJsonSafe(response) as Prisma.InputJsonValue,
        },
        {
          aggregate_type: 'wallet',
          aggregate_id: wallet.id,
          event_type: 'wallet.balance.updated',
          socket_room: `user:${user_id}`,
          payload: {
            wallet_id: wallet.id,
            balance: updated_wallet.balance.toString(),
            reason: 'greedy_bet',
            round_id: round.id,
          },
        },
      ],
    });

    return response;
  });
};

const placeBet = async (user_id: string, payload: PlaceBetBody) => {
  try {
    return await placeBetTransaction(user_id, payload);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: {
          user_id_scope_idempotency_key: {
            user_id,
            scope: GREEDY_IDEMPOTENCY_SCOPE,
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
    prisma.greedyBet.findMany({
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
    prisma.greedyBet.count({ where: { user_id } }),
  ]);
  return { items, total, ...pagination };
};

const getRoundHistory = async (page = 1, limit = 20) => {
  const game = await prisma.game.findUnique({
    where: { code: GREEDY_GAME_CODE },
  });
  if (!game) {
    throw new AppError(httpStatus.NOT_FOUND, 'Greedy game not found');
  }

  const pagination = getPagination(page, limit);
  const where: Prisma.GreedyRoundWhereInput = {
    game_id: game.id,
    status: {
      in: [
        GreedyRoundStatus.result_revealed,
        GreedyRoundStatus.settling,
        GreedyRoundStatus.settled,
        GreedyRoundStatus.closed,
      ],
    },
    result: { isNot: null },
  };

  const [items, total] = await prisma.$transaction([
    prisma.greedyRound.findMany({
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
    prisma.greedyRound.count({ where }),
  ]);
  return { items, total, ...pagination };
};

const getRound = async (round_id: string) => {
  const round = await prisma.greedyRound.findUnique({
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

  return { ...round, result: result_is_public ? round.result : null };
};

const GreedyService = {
  getSnapshot,
  placeBet,
  getMyBets,
  getRoundHistory,
  getRound,
};

export default GreedyService;
