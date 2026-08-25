import {
  GameStatus,
  GreedyClassicRoundStatus,
  GreedyClassicRuntimeStatus,
  Prisma,
  SettlementOutcome,
  WalletLedgerType,
} from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import type { WalletBalanceUpdatedPayload } from '@/modules/wallet/wallet.types';
import {
  GREEDY_CLASSIC_GAME_CODE,
  GREEDY_CLASSIC_RNG_ALGORITHM_VERSION,
  GREEDY_CLASSIC_RNG_ALGORITHM_VERSION_BIASED,
  GREEDY_CLASSIC_SOCKET_ROOM,
} from '@/modules/greedy-classic/greedy-classic.constant';
import { getGreedyClassicTopWinnersByRound } from '@/modules/greedy-classic/greedy-classic.leaderboard';
import {
  allocateGreedyClassicWinningBetPayouts,
  withSerializableRetry,
} from '@/modules/greedy-classic/greedy-classic.utils';
import { sha256 } from '@/utils/hash';
import { logger } from '@/utils/logger';
import { pickBiasedWinner, pickNaturalWinner } from '@/modules/game-bot/biased-outcome';
import { loadGreedyClassicRoundBets } from '@/modules/game-bot/biased-round';
import { getGameBotPolicy } from '@/modules/game-bot/bot-policy';
import { isBotUserIdSync } from '@/modules/game-bot/bot-identity';

const SETTLEMENT_BATCH_USERS = 50;
const REFUND_BATCH_USERS = 50;

const cacheRound = async (round_id: string | null): Promise<void> => {
  if (!redisClient.isReady) return;
  if (!round_id) {
    await redisClient.del('greedy-classic:current_round');
    return;
  }
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: round_id },
    include: { result: true },
  });
  if (round) {
    await redisClient.set('greedy-classic:current_round', JSON.stringify({
      id: round.id,
      round_number: round.round_number.toString(),
      status: round.status,
      betting_ends_at: round.betting_ends_at?.toISOString() ?? null,
      result_reveal_at: round.result_reveal_at?.toISOString() ?? null,
      updated_at: round.updated_at.toISOString(),
    }), { EX: 120 });
  }
};

const createRoundIfNeeded = async (): Promise<void> => {
  const created = await withSerializableRetry(async (tx) => {
    const game = await tx.game.findUnique({ where: { code: GREEDY_CLASSIC_GAME_CODE } });
    if (!game || game.status !== GameStatus.active) return null;

    const runtime = await tx.greedyClassicRuntimeState.findUnique({
      where: { game_id: game.id },
      include: {
        active_config_version: {
          include: {
            options: {
              where: { is_enabled: true },
              orderBy: { display_order: 'asc' },
            },
            chip_values: {
              where: { is_enabled: true },
              orderBy: { display_order: 'asc' },
            },
          },
        },
      },
    });

    if (
      !runtime ||
      runtime.status !== GreedyClassicRuntimeStatus.running ||
      runtime.current_round_id ||
      !runtime.active_config_version
    ) {
      return null;
    }

    const database_now_rows = await tx.$queryRaw<Array<{ database_now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
    );
    const database_now = database_now_rows[0]?.database_now;
    if (!database_now) throw new Error('Database time unavailable');

    const now = database_now;
    const round_number = runtime.last_round_number + 1n;
    const config = runtime.active_config_version;
    const betting_ends_at = new Date(now.getTime() + config.betting_duration_ms);

    const round = await tx.greedyClassicRound.create({
      data: {
        game_id: game.id,
        round_number,
        config_version_id: config.id,
        status: GreedyClassicRoundStatus.betting_open,
        betting_started_at: now,
        betting_ends_at,
      },
    });

    await tx.greedyClassicRuntimeState.update({
      where: { game_id: game.id },
      data: {
        current_round_id: round.id,
        last_round_number: round_number,
        revision: { increment: 1 },
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round',
        aggregate_id: round.id,
        event_type: 'greedy_classic.round.opened',
        socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          round_number: round_number.toString(),
          betting_started_at: now.toISOString(),
          betting_ends_at: betting_ends_at.toISOString(),
          options: config.options.map((option) => ({
            id: option.id,
            code: option.code,
            name: option.name,
            image_url: option.image_url,
            display_order: option.display_order,
            payout_numerator: option.payout_numerator.toString(),
            payout_denominator: option.payout_denominator.toString(),
          })),
          chip_values: config.chip_values.map((chip) => ({
            id: chip.id,
            amount: chip.amount.toString(),
            display_order: chip.display_order,
          })),
        },
      },
    });

    return round;
  });

  if (created) await cacheRound(created.id);
};

const lockRound = async (round_id: string): Promise<void> => {
  const locked_at = await withSerializableRetry(async (tx) => {
    // UPDATE conflicts with the FOR SHARE lock held by in-flight accepted bets.
    // This creates a hard barrier: once this transition commits, no bet from
    // the betting phase can still commit afterward.
    const rows = await tx.$queryRaw<Array<{ locked_at: Date }>>(Prisma.sql`
      UPDATE greedy_classic_rounds
      SET
        status = 'betting_locked'::greedy_classic_round_status,
        locked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${round_id}
        AND status = 'betting_open'::greedy_classic_round_status
        AND betting_ends_at <= CURRENT_TIMESTAMP
      RETURNING locked_at
    `);

    const transitioned_at = rows[0]?.locked_at;
    if (!transitioned_at) return null;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round',
        aggregate_id: round_id,
        event_type: 'greedy_classic.round.locked',
        socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: { round_id, locked_at: transitioned_at.toISOString() },
      },
    });
    return transitioned_at;
  });

  if (locked_at) await cacheRound(round_id);
};

const generateResult = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (!round || round.status !== GreedyClassicRoundStatus.betting_locked || round.result) return;
  if (!round.locked_at) return;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) throw new Error('Database time unavailable');
  if (
    database_now.getTime() <
    round.locked_at.getTime() + round.config_version.lock_duration_ms
  ) {
    return;
  }

  const options = round.config_version.options;
  const policy = await getGameBotPolicy();
  const round_bets = await loadGreedyClassicRoundBets(round.id);
  const biased = policy.enabled
    ? pickBiasedWinner({
        options,
        bets: round_bets,
        target_human_win_rate: policy.target_human_win_rate,
        min_human_bets_before_bias: policy.min_human_bets_before_bias,
      })
    : pickNaturalWinner(options);
  const winner = options.find((option) => option.id === biased.option_id) ?? options[options.length - 1];
  if (!winner) throw new Error('Greedy result winner could not be selected');

  const generated_at = database_now;
  const algorithm_version =
    biased.algorithm_suffix === 'biased-v1'
      ? GREEDY_CLASSIC_RNG_ALGORITHM_VERSION_BIASED
      : GREEDY_CLASSIC_RNG_ALGORITHM_VERSION;
  const audit_hash = sha256([
    round.id,
    round.config_version_id,
    winner.id,
    algorithm_version,
    biased.entropy_digest,
    generated_at.toISOString(),
  ].join('|'));

  await withSerializableRetry(async (tx) => {
    const current = await tx.greedyClassicRound.findUnique({ where: { id: round.id }, include: { result: true } });
    if (!current || current.status !== GreedyClassicRoundStatus.betting_locked || current.result) return;

    await tx.greedyClassicRoundResult.create({
      data: {
        round_id: round.id,
        winning_option_version_id: winner.id,
        algorithm_version,
        config_version_id: round.config_version_id,
        entropy_digest: biased.entropy_digest,
        audit_hash,
        generated_at,
      },
    });
    await tx.greedyClassicRound.update({
      where: { id: round.id },
      data: { status: GreedyClassicRoundStatus.result_ready, result_generated_at: generated_at },
    });
  });
  await cacheRound(round_id);
};

const startDrawing = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== GreedyClassicRoundStatus.result_ready) return;

  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) throw new Error('Database time unavailable');
  const drawing_started_at = database_now;
  const result_reveal_at = new Date(
    drawing_started_at.getTime() + round.config_version.drawing_duration_ms,
  );
  const transitioned = await withSerializableRetry(async (tx) => {
    const updated = await tx.greedyClassicRound.updateMany({
      where: { id: round.id, status: GreedyClassicRoundStatus.result_ready },
      data: {
        status: GreedyClassicRoundStatus.drawing,
        drawing_started_at,
        result_reveal_at,
      },
    });
    if (!updated.count) return false;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round',
        aggregate_id: round.id,
        event_type: 'greedy_classic.round.drawing',
        socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          drawing_started_at: drawing_started_at.toISOString(),
          result_reveal_at: result_reveal_at.toISOString(),
        },
      },
    });
    return true;
  });

  if (transitioned) await cacheRound(round_id);
};

const revealResult = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: round_id },
    include: { result: { include: { winning_option: true } } },
  });
  if (!round || round.status !== GreedyClassicRoundStatus.drawing || !round.result || !round.result_reveal_at) return;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now < round.result_reveal_at) return;

  const revealed_at = database_now;
  const top_winners_by_round = await getGreedyClassicTopWinnersByRound([
    {
      round_id: round.id,
      winning_option_id: round.result.winning_option.id,
      payout_numerator: round.result.winning_option.payout_numerator,
      payout_denominator: round.result.winning_option.payout_denominator,
    },
  ]);
  await withSerializableRetry(async (tx) => {
    const updated = await tx.greedyClassicRound.updateMany({
      where: { id: round.id, status: GreedyClassicRoundStatus.drawing },
      data: { status: GreedyClassicRoundStatus.result_revealed },
    });
    if (!updated.count) return;
    await tx.greedyClassicRoundResult.update({ where: { round_id: round.id }, data: { revealed_at } });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round', aggregate_id: round.id,
        event_type: 'greedy_classic.round.result', socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          winning_option: {
            id: round.result!.winning_option.id,
            code: round.result!.winning_option.code,
            name: round.result!.winning_option.name,
            image_url: round.result!.winning_option.image_url,
            payout_numerator: round.result!.winning_option.payout_numerator.toString(),
            payout_denominator: round.result!.winning_option.payout_denominator.toString(),
          },
          top_winners: top_winners_by_round.get(round.id) ?? [],
          revealed_at: revealed_at.toISOString(),
        },
      },
    });
  });
  await cacheRound(round_id);
};

const startSettlement = async (round_id: string): Promise<void> => {
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) return;
  await prisma.greedyClassicRound.updateMany({
    where: { id: round_id, status: GreedyClassicRoundStatus.result_revealed },
    data: { status: GreedyClassicRoundStatus.settling, settlement_started_at: database_now },
  });
};

const pendingSettlementUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM greedy_classic_bets b
    LEFT JOIN greedy_classic_bet_settlements s ON s.bet_id = b.id
    WHERE b.round_id = ${round_id} AND s.id IS NULL
    LIMIT ${SETTLEMENT_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const settleUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const result = await tx.greedyClassicRoundResult.findUnique({
      where: { round_id },
      include: {
        winning_option: {
          select: { payout_numerator: true, payout_denominator: true },
        },
      },
    });
    if (!result) throw new Error('Cannot settle a round without a result');

    const bets = await tx.greedyClassicBet.findMany({
      where: { round_id, user_id, settlement: null },
      orderBy: [{ accepted_at: 'asc' }, { id: 'asc' }],
    });
    if (!bets.length) return;

    const winning_bets = bets.filter(
      (bet) => bet.option_version_id === result.winning_option_version_id,
    );
    const winning_bet_count = winning_bets.length;
    const {
      total_winning_stake,
      total_payout,
      payout_by_bet,
    } = allocateGreedyClassicWinningBetPayouts(
      winning_bets,
      result.winning_option.payout_numerator,
      result.winning_option.payout_denominator,
    );

    const settlement_rows = bets.map((bet) => {
      const is_win = bet.option_version_id === result.winning_option_version_id;
      return {
        round_id,
        bet_id: bet.id,
        result_id: result.id,
        outcome: is_win ? SettlementOutcome.win : SettlementOutcome.loss,
        payout_amount: payout_by_bet.get(bet.id) ?? 0n,
      };
    });

    await tx.greedyClassicBetSettlement.createMany({ data: settlement_rows, skipDuplicates: true });

    if (total_payout > 0n && !isBotUserIdSync(user_id)) {
      const existing_payout = await tx.greedyClassicUserPayout.findUnique({
        where: { round_id_user_id: { round_id, user_id } },
      });
      if (!existing_payout) {
        const wallet = await ensureWallet(user_id, tx);
        const updated_wallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: total_payout }, version: { increment: 1 } },
        });
        const ledger = await tx.walletLedger.create({
          data: {
            wallet_id: wallet.id,
            user_id,
            game_id: (await tx.greedyClassicRound.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } })).game_id,
            type: WalletLedgerType.win_credit,
            amount: total_payout,
            balance_before: wallet.balance,
            balance_after: updated_wallet.balance,
            reference_type: 'greedy_classic_round_payout',
            reference_id: round_id,
          },
        });
        await tx.greedyClassicUserPayout.create({
          data: {
            round_id,
            user_id,
            wallet_id: wallet.id,
            winning_bet_count,
            total_winning_stake,
            total_payout,
            wallet_ledger_id: ledger.id,
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregate_type: 'wallet', aggregate_id: wallet.id,
            event_type: 'wallet.balance.updated', socket_room: `user:${user_id}`,
            payload: {
              wallet_id: wallet.id,
              balance: updated_wallet.balance.toString(),
              wallet_version: updated_wallet.version,
              reason: 'greedy_classic_win',
              round_id,
              payout: total_payout.toString(),
            } satisfies WalletBalanceUpdatedPayload,
          },
        });
      }
    }
  });
};

const settleRoundBatch = async (round_id: string): Promise<void> => {
  const users = await pendingSettlementUsers(round_id);
  if (!users.length) {
    const settled_at = new Date();
    const transitioned = await withSerializableRetry(async (tx) => {
      const updated = await tx.greedyClassicRound.updateMany({
        where: { id: round_id, status: GreedyClassicRoundStatus.settling },
        data: { status: GreedyClassicRoundStatus.settled, settled_at },
      });
      if (!updated.count) return false;

      await tx.outboxEvent.create({
        data: {
          aggregate_type: 'greedy_classic_round',
          aggregate_id: round_id,
          event_type: 'greedy_classic.round.settled',
          socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
          payload: { round_id, settled_at: settled_at.toISOString() },
        },
      });
      return true;
    });

    if (transitioned) await cacheRound(round_id);
    return;
  }

  for (const user_id of users) await settleUser(round_id, user_id);
};

const closeSettledRound = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyClassicRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== GreedyClassicRoundStatus.settled || !round.result_reveal_at) return;
  const close_at = round.result_reveal_at.getTime() + round.config_version.result_duration_ms;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now.getTime() < close_at) return;

  const now = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.greedyClassicRound.updateMany({
      where: { id: round_id, status: GreedyClassicRoundStatus.settled },
      data: { status: GreedyClassicRoundStatus.closed, closed_at: now },
    });
    if (!updated.count) return;
    await tx.greedyClassicRuntimeState.updateMany({
      where: { current_round_id: round_id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round', aggregate_id: round_id,
        event_type: 'greedy_classic.round.closed', socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: { round_id, closed_at: now.toISOString() },
      },
    });
  });
  await cacheRound(null);
};

const pendingRefundUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM greedy_classic_bets b
    LEFT JOIN greedy_classic_user_refunds r ON r.round_id = b.round_id AND r.user_id = b.user_id
    WHERE b.round_id = ${round_id} AND r.id IS NULL
    LIMIT ${REFUND_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const refundUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const existing = await tx.greedyClassicUserRefund.findUnique({ where: { round_id_user_id: { round_id, user_id } } });
    if (existing) return;
    const bets = await tx.greedyClassicBet.findMany({ where: { round_id, user_id } });
    if (!bets.length) return;
    const total_bet_amount = bets.reduce((sum, bet) => sum + bet.amount, 0n);
    const wallet = await ensureWallet(user_id, tx);
    const updated_wallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: total_bet_amount }, version: { increment: 1 } },
    });
    const round = await tx.greedyClassicRound.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } });
    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id, user_id, game_id: round.game_id,
        type: WalletLedgerType.bet_refund, amount: total_bet_amount,
        balance_before: wallet.balance, balance_after: updated_wallet.balance,
        reference_type: 'greedy_classic_round_refund', reference_id: round_id,
      },
    });
    await tx.greedyClassicUserRefund.create({
      data: { round_id, user_id, wallet_id: wallet.id, total_bet_amount, wallet_ledger_id: ledger.id },
    });
    await tx.greedyClassicBetSettlement.createMany({
      data: bets.map((bet) => ({
        round_id, bet_id: bet.id, result_id: null,
        outcome: SettlementOutcome.refunded, payout_amount: 0n,
      })),
      skipDuplicates: true,
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'wallet', aggregate_id: wallet.id,
        event_type: 'wallet.balance.updated', socket_room: `user:${user_id}`,
        payload: {
          wallet_id: wallet.id,
          balance: updated_wallet.balance.toString(),
          wallet_version: updated_wallet.version,
          reason: 'greedy_classic_refund',
          round_id,
          refund: total_bet_amount.toString(),
        } satisfies WalletBalanceUpdatedPayload,
      },
    });
  });
};

const refundCancelledRound = async (round_id: string): Promise<void> => {
  const users = await pendingRefundUsers(round_id);
  if (users.length) {
    for (const user_id of users) await refundUser(round_id, user_id);
    return;
  }

  await withSerializableRetry(async (tx) => {
    const runtime = await tx.greedyClassicRuntimeState.findFirst({ where: { current_round_id: round_id } });
    if (!runtime) return;
    await tx.greedyClassicRuntimeState.update({
      where: { id: runtime.id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_classic_round', aggregate_id: round_id,
        event_type: 'greedy_classic.round.refunded', socket_room: GREEDY_CLASSIC_SOCKET_ROOM,
        payload: { round_id },
      },
    });
  });
  await cacheRound(null);
};

const processCurrentRound = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyClassicRound.findUnique({ where: { id: round_id } });
  if (!round) return;

  switch (round.status) {
    case GreedyClassicRoundStatus.betting_open:
      await lockRound(round.id);
      break;
    case GreedyClassicRoundStatus.betting_locked:
      await generateResult(round.id);
      break;
    case GreedyClassicRoundStatus.result_ready:
      await startDrawing(round.id);
      break;
    case GreedyClassicRoundStatus.drawing:
      await revealResult(round.id);
      break;
    case GreedyClassicRoundStatus.result_revealed:
      await startSettlement(round.id);
      break;
    case GreedyClassicRoundStatus.settling:
      await settleRoundBatch(round.id);
      break;
    case GreedyClassicRoundStatus.settled:
      await closeSettledRound(round.id);
      break;
    case GreedyClassicRoundStatus.cancelled:
      await refundCancelledRound(round.id);
      break;
    default:
      break;
  }
};

export const runGreedyClassicTick = async (): Promise<void> => {
  const game = await prisma.game.findUnique({
    where: { code: GREEDY_CLASSIC_GAME_CODE },
    include: { greedy_classic_runtime_state: true },
  });
  if (!game?.greedy_classic_runtime_state) return;

  const current_round_id = game.greedy_classic_runtime_state.current_round_id;
  if (current_round_id) {
    await processCurrentRound(current_round_id);
    return;
  }

  if (
    game.status === GameStatus.active &&
    game.greedy_classic_runtime_state.status === GreedyClassicRuntimeStatus.running
  ) {
    await createRoundIfNeeded();
  }
};

export const recoverGreedyClassicRuntime = async (): Promise<void> => {
  const game = await prisma.game.findUnique({ where: { code: GREEDY_CLASSIC_GAME_CODE }, include: { greedy_classic_runtime_state: true } });
  if (!game?.greedy_classic_runtime_state) return;
  if (game.greedy_classic_runtime_state.current_round_id) {
    await cacheRound(game.greedy_classic_runtime_state.current_round_id);
    logger.info('greedy_classic_worker_recovered_round', { round_id: game.greedy_classic_runtime_state.current_round_id });
  }
};
