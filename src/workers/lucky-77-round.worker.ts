import {
  GameStatus,
  Lucky77RoundStatus,
  Lucky77RuntimeStatus,
  Prisma,
  SettlementOutcome,
  WalletLedgerType,
} from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import type { WalletBalanceUpdatedPayload } from '@/modules/wallet/wallet.types';
import {
  LUCKY_77_GAME_CODE,
  LUCKY_77_RNG_ALGORITHM_VERSION,
  LUCKY_77_RNG_ALGORITHM_VERSION_BIASED,
  LUCKY_77_SLOT_MAP,
  LUCKY_77_SOCKET_ROOM,
} from '@/modules/lucky-77/lucky-77.constant';
import {
  calculatePayout,
  pickUniformSlotIndex,
  slotIndexesForOption,
  withSerializableRetry,
} from '@/modules/lucky-77/lucky-77.utils';
import { getLucky77TopWinnersByRound } from '@/modules/lucky-77/lucky-77.leaderboard';
import { secureRandomBigIntBelow } from '@/utils/crypto-rng';
import { sha256 } from '@/utils/hash';
import { logger } from '@/utils/logger';
import { pickBiasedWinner, pickNaturalWinner } from '@/modules/game-bot/biased-outcome';
import { loadLucky77RoundBets } from '@/modules/game-bot/biased-round';
import { getGameBotPolicy } from '@/modules/game-bot/bot-policy';
import { isBotUserIdSync } from '@/modules/game-bot/bot-identity';

const SETTLEMENT_BATCH_USERS = 50;
const REFUND_BATCH_USERS = 50;

const cacheRound = async (round_id: string | null): Promise<void> => {
  if (!redisClient.isReady) return;
  if (!round_id) {
    await redisClient.del('lucky-77:current_round');
    return;
  }
  const round = await prisma.lucky77Round.findUnique({
    where: { id: round_id },
    include: { result: true },
  });
  if (round) {
    await redisClient.set('lucky-77:current_round', JSON.stringify({
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
    const game = await tx.game.findUnique({ where: { code: LUCKY_77_GAME_CODE } });
    if (!game || game.status !== GameStatus.active) return null;

    const runtime = await tx.lucky77RuntimeState.findUnique({
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
      runtime.status !== Lucky77RuntimeStatus.running ||
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

    const round = await tx.lucky77Round.create({
      data: {
        game_id: game.id,
        round_number,
        config_version_id: config.id,
        status: Lucky77RoundStatus.betting_open,
        betting_started_at: now,
        betting_ends_at,
      },
    });

    await tx.lucky77RuntimeState.update({
      where: { game_id: game.id },
      data: {
        current_round_id: round.id,
        last_round_number: round_number,
        revision: { increment: 1 },
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round',
        aggregate_id: round.id,
        event_type: 'lucky_77.round.opened',
        socket_room: LUCKY_77_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          round_number: round_number.toString(),
          betting_started_at: now.toISOString(),
          betting_ends_at: betting_ends_at.toISOString(),
          slot_map: [...LUCKY_77_SLOT_MAP],
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
      UPDATE lucky_77_rounds
      SET
        status = 'betting_locked'::lucky_77_round_status,
        locked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${round_id}
        AND status = 'betting_open'::lucky_77_round_status
        AND betting_ends_at <= CURRENT_TIMESTAMP
      RETURNING locked_at
    `);

    const transitioned_at = rows[0]?.locked_at;
    if (!transitioned_at) return null;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round',
        aggregate_id: round_id,
        event_type: 'lucky_77.round.locked',
        socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { round_id, locked_at: transitioned_at.toISOString() },
      },
    });
    return transitioned_at;
  });

  if (locked_at) await cacheRound(round_id);
};

const generateResult = async (round_id: string): Promise<void> => {
  const round = await prisma.lucky77Round.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (!round || round.status !== Lucky77RoundStatus.betting_locked || round.result) return;
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
  const round_bets = await loadLucky77RoundBets(round.id);
  const biased = policy.enabled
    ? pickBiasedWinner({
        options,
        bets: round_bets,
        target_human_win_rate: policy.target_human_win_rate,
        min_human_bets_before_bias: policy.min_human_bets_before_bias,
      })
    : pickNaturalWinner(options);
  const winner = options.find((option) => option.id === biased.option_id) ?? options[options.length - 1];
  if (!winner) throw new Error('Lucky 77 result winner could not be selected');

  const matching_slots = slotIndexesForOption(winner.code);
  if (!matching_slots.length) {
    throw new Error(`Lucky 77 slot map has no slots for ${winner.code}`);
  }
  const slot_random = secureRandomBigIntBelow(BigInt(matching_slots.length));
  const winning_slot_index = pickUniformSlotIndex(winner.code, slot_random.value);

  const generated_at = database_now;
  const algorithm_version =
    biased.algorithm_suffix !== 'natural-v1'
      ? LUCKY_77_RNG_ALGORITHM_VERSION_BIASED
      : LUCKY_77_RNG_ALGORITHM_VERSION;
  const entropy_digest = sha256(
    [biased.entropy_digest, slot_random.entropy_digest].join('|'),
  );
  const audit_hash = sha256([
    round.id,
    round.config_version_id,
    winner.id,
    String(winning_slot_index),
    algorithm_version,
    entropy_digest,
    generated_at.toISOString(),
  ].join('|'));

  await withSerializableRetry(async (tx) => {
    const current = await tx.lucky77Round.findUnique({ where: { id: round.id }, include: { result: true } });
    if (!current || current.status !== Lucky77RoundStatus.betting_locked || current.result) return;

    await tx.lucky77RoundResult.create({
      data: {
        round_id: round.id,
        winning_option_version_id: winner.id,
        winning_slot_index,
        algorithm_version,
        config_version_id: round.config_version_id,
        entropy_digest,
        audit_hash,
        generated_at,
      },
    });
    await tx.lucky77Round.update({
      where: { id: round.id },
      data: { status: Lucky77RoundStatus.result_ready, result_generated_at: generated_at },
    });
  });
  await cacheRound(round_id);
};

const startDrawing = async (round_id: string): Promise<void> => {
  const round = await prisma.lucky77Round.findUnique({
    where: { id: round_id },
    include: { config_version: true, result: true },
  });
  if (!round || round.status !== Lucky77RoundStatus.result_ready || !round.result) {
    return;
  }

  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) throw new Error('Database time unavailable');
  const drawing_started_at = database_now;
  const result_reveal_at = new Date(
    drawing_started_at.getTime() + round.config_version.drawing_duration_ms,
  );
  // Clients need the stop index during drawing so the wheel can decelerate
  // onto the same slot the server will reveal. The winning option stays hidden.
  const winning_slot_index = round.result.winning_slot_index;
  const transitioned = await withSerializableRetry(async (tx) => {
    const updated = await tx.lucky77Round.updateMany({
      where: { id: round.id, status: Lucky77RoundStatus.result_ready },
      data: {
        status: Lucky77RoundStatus.drawing,
        drawing_started_at,
        result_reveal_at,
      },
    });
    if (!updated.count) return false;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round',
        aggregate_id: round.id,
        event_type: 'lucky_77.round.drawing',
        socket_room: LUCKY_77_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          drawing_started_at: drawing_started_at.toISOString(),
          result_reveal_at: result_reveal_at.toISOString(),
          winning_slot_index,
        },
      },
    });
    return true;
  });

  if (transitioned) await cacheRound(round_id);
};

const revealResult = async (round_id: string): Promise<void> => {
  const round = await prisma.lucky77Round.findUnique({
    where: { id: round_id },
    include: { result: { include: { winning_option: true } } },
  });
  if (!round || round.status !== Lucky77RoundStatus.drawing || !round.result || !round.result_reveal_at) return;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now < round.result_reveal_at) return;

  const revealed_at = database_now;
  const top_winners_by_round = await getLucky77TopWinnersByRound([
    {
      round_id: round.id,
      winning_option_id: round.result.winning_option.id,
      payout_numerator: round.result.winning_option.payout_numerator,
      payout_denominator: round.result.winning_option.payout_denominator,
    },
  ]);
  await withSerializableRetry(async (tx) => {
    const updated = await tx.lucky77Round.updateMany({
      where: { id: round.id, status: Lucky77RoundStatus.drawing },
      data: { status: Lucky77RoundStatus.result_revealed },
    });
    if (!updated.count) return;
    await tx.lucky77RoundResult.update({ where: { round_id: round.id }, data: { revealed_at } });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round', aggregate_id: round.id,
        event_type: 'lucky_77.round.result', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          winning_slot_index: round.result!.winning_slot_index,
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
  await prisma.lucky77Round.updateMany({
    where: { id: round_id, status: Lucky77RoundStatus.result_revealed },
    data: { status: Lucky77RoundStatus.settling, settlement_started_at: database_now },
  });
};

const pendingSettlementUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM lucky_77_bets b
    LEFT JOIN lucky_77_bet_settlements s ON s.bet_id = b.id
    WHERE b.round_id = ${round_id} AND s.id IS NULL
    LIMIT ${SETTLEMENT_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const settleUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const result = await tx.lucky77RoundResult.findUnique({ where: { round_id } });
    if (!result) throw new Error('Cannot settle a round without a result');

    const bets = await tx.lucky77Bet.findMany({
      where: { round_id, user_id, settlement: null },
      orderBy: { created_at: 'asc' },
    });
    if (!bets.length) return;

    let total_winning_stake = 0n;
    let total_payout = 0n;
    let winning_bet_count = 0;

    const settlement_rows = bets.map((bet) => {
      const is_win = bet.option_version_id === result.winning_option_version_id;
      const payout = is_win ? calculatePayout(bet.amount, bet.payout_numerator, bet.payout_denominator) : 0n;
      if (is_win) {
        total_winning_stake += bet.amount;
        total_payout += payout;
        winning_bet_count += 1;
      }
      return {
        round_id,
        bet_id: bet.id,
        result_id: result.id,
        outcome: is_win ? SettlementOutcome.win : SettlementOutcome.loss,
        payout_amount: payout,
      };
    });

    await tx.lucky77BetSettlement.createMany({ data: settlement_rows, skipDuplicates: true });

    if (total_payout > 0n && !isBotUserIdSync(user_id)) {
      const existing_payout = await tx.lucky77UserPayout.findUnique({
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
            game_id: (await tx.lucky77Round.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } })).game_id,
            type: WalletLedgerType.win_credit,
            amount: total_payout,
            balance_before: wallet.balance,
            balance_after: updated_wallet.balance,
            reference_type: 'lucky_77_round_payout',
            reference_id: round_id,
          },
        });
        await tx.lucky77UserPayout.create({
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
              reason: 'lucky_77_win',
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
      const updated = await tx.lucky77Round.updateMany({
        where: { id: round_id, status: Lucky77RoundStatus.settling },
        data: { status: Lucky77RoundStatus.settled, settled_at },
      });
      if (!updated.count) return false;

      await tx.outboxEvent.create({
        data: {
          aggregate_type: 'lucky_77_round',
          aggregate_id: round_id,
          event_type: 'lucky_77.round.settled',
          socket_room: LUCKY_77_SOCKET_ROOM,
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
  const round = await prisma.lucky77Round.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== Lucky77RoundStatus.settled || !round.result_reveal_at) return;
  const close_at = round.result_reveal_at.getTime() + round.config_version.result_duration_ms;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now.getTime() < close_at) return;

  const now = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.lucky77Round.updateMany({
      where: { id: round_id, status: Lucky77RoundStatus.settled },
      data: { status: Lucky77RoundStatus.closed, closed_at: now },
    });
    if (!updated.count) return;
    await tx.lucky77RuntimeState.updateMany({
      where: { current_round_id: round_id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round', aggregate_id: round_id,
        event_type: 'lucky_77.round.closed', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { round_id, closed_at: now.toISOString() },
      },
    });
  });
  await cacheRound(null);
};

const pendingRefundUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM lucky_77_bets b
    LEFT JOIN lucky_77_user_refunds r ON r.round_id = b.round_id AND r.user_id = b.user_id
    WHERE b.round_id = ${round_id} AND r.id IS NULL
    LIMIT ${REFUND_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const refundUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const existing = await tx.lucky77UserRefund.findUnique({ where: { round_id_user_id: { round_id, user_id } } });
    if (existing) return;
    const bets = await tx.lucky77Bet.findMany({ where: { round_id, user_id } });
    if (!bets.length) return;
    const total_bet_amount = bets.reduce((sum, bet) => sum + bet.amount, 0n);
    const wallet = await ensureWallet(user_id, tx);
    const updated_wallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: total_bet_amount }, version: { increment: 1 } },
    });
    const round = await tx.lucky77Round.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } });
    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id, user_id, game_id: round.game_id,
        type: WalletLedgerType.bet_refund, amount: total_bet_amount,
        balance_before: wallet.balance, balance_after: updated_wallet.balance,
        reference_type: 'lucky_77_round_refund', reference_id: round_id,
      },
    });
    await tx.lucky77UserRefund.create({
      data: { round_id, user_id, wallet_id: wallet.id, total_bet_amount, wallet_ledger_id: ledger.id },
    });
    await tx.lucky77BetSettlement.createMany({
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
          reason: 'lucky_77_refund',
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
    const runtime = await tx.lucky77RuntimeState.findFirst({ where: { current_round_id: round_id } });
    if (!runtime) return;
    await tx.lucky77RuntimeState.update({
      where: { id: runtime.id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'lucky_77_round', aggregate_id: round_id,
        event_type: 'lucky_77.round.refunded', socket_room: LUCKY_77_SOCKET_ROOM,
        payload: { round_id },
      },
    });
  });
  await cacheRound(null);
};

const processCurrentRound = async (round_id: string): Promise<void> => {
  const round = await prisma.lucky77Round.findUnique({ where: { id: round_id } });
  if (!round) return;

  switch (round.status) {
    case Lucky77RoundStatus.betting_open:
      await lockRound(round.id);
      break;
    case Lucky77RoundStatus.betting_locked:
      await generateResult(round.id);
      break;
    case Lucky77RoundStatus.result_ready:
      await startDrawing(round.id);
      break;
    case Lucky77RoundStatus.drawing:
      await revealResult(round.id);
      break;
    case Lucky77RoundStatus.result_revealed:
      await startSettlement(round.id);
      break;
    case Lucky77RoundStatus.settling:
      await settleRoundBatch(round.id);
      break;
    case Lucky77RoundStatus.settled:
      await closeSettledRound(round.id);
      break;
    case Lucky77RoundStatus.cancelled:
      await refundCancelledRound(round.id);
      break;
    default:
      break;
  }
};

export const runLucky77Tick = async (): Promise<void> => {
  const game = await prisma.game.findUnique({
    where: { code: LUCKY_77_GAME_CODE },
    include: { lucky_77_runtime_state: true },
  });
  if (!game?.lucky_77_runtime_state) return;

  const current_round_id = game.lucky_77_runtime_state.current_round_id;
  if (current_round_id) {
    await processCurrentRound(current_round_id);
    return;
  }

  if (
    game.status === GameStatus.active &&
    game.lucky_77_runtime_state.status === Lucky77RuntimeStatus.running
  ) {
    await createRoundIfNeeded();
  }
};

export const recoverLucky77Runtime = async (): Promise<void> => {
  const game = await prisma.game.findUnique({ where: { code: LUCKY_77_GAME_CODE }, include: { lucky_77_runtime_state: true } });
  if (!game?.lucky_77_runtime_state) return;
  if (game.lucky_77_runtime_state.current_round_id) {
    await cacheRound(game.lucky_77_runtime_state.current_round_id);
    logger.info('lucky_77_worker_recovered_round', { round_id: game.lucky_77_runtime_state.current_round_id });
  }
};
