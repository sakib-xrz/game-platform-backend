import {
  GameStatus,
  GreedyRoundStatus,
  GreedyRuntimeStatus,
  Prisma,
  SettlementOutcome,
  WalletLedgerType,
} from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import {
  GREEDY_GAME_CODE,
  GREEDY_RNG_ALGORITHM_VERSION,
  GREEDY_SOCKET_ROOM,
} from '@/modules/greedy/greedy.constant';
import { calculatePayout, withSerializableRetry } from '@/modules/greedy/greedy.utils';
import { secureRandomBigIntBelow } from '@/utils/crypto-rng';
import { sha256 } from '@/utils/hash';
import { logger } from '@/utils/logger';

const SETTLEMENT_BATCH_USERS = 50;
const REFUND_BATCH_USERS = 50;

const cacheRound = async (round_id: string | null): Promise<void> => {
  if (!redisClient.isReady) return;
  if (!round_id) {
    await redisClient.del('greedy:current_round');
    return;
  }
  const round = await prisma.greedyRound.findUnique({
    where: { id: round_id },
    include: { result: true },
  });
  if (round) {
    await redisClient.set('greedy:current_round', JSON.stringify({
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
    const game = await tx.game.findUnique({ where: { code: GREEDY_GAME_CODE } });
    if (!game || game.status !== GameStatus.active) return null;

    const runtime = await tx.greedyRuntimeState.findUnique({
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
      runtime.status !== GreedyRuntimeStatus.running ||
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

    const round = await tx.greedyRound.create({
      data: {
        game_id: game.id,
        round_number,
        config_version_id: config.id,
        status: GreedyRoundStatus.betting_open,
        betting_started_at: now,
        betting_ends_at,
      },
    });

    await tx.greedyRuntimeState.update({
      where: { game_id: game.id },
      data: {
        current_round_id: round.id,
        last_round_number: round_number,
        revision: { increment: 1 },
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round',
        aggregate_id: round.id,
        event_type: 'greedy.round.opened',
        socket_room: GREEDY_SOCKET_ROOM,
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
      UPDATE greedy_rounds
      SET
        status = 'betting_locked'::greedy_round_status,
        locked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${round_id}
        AND status = 'betting_open'::greedy_round_status
        AND betting_ends_at <= CURRENT_TIMESTAMP
      RETURNING locked_at
    `);

    const transitioned_at = rows[0]?.locked_at;
    if (!transitioned_at) return null;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round',
        aggregate_id: round_id,
        event_type: 'greedy.round.locked',
        socket_room: GREEDY_SOCKET_ROOM,
        payload: { round_id, locked_at: transitioned_at.toISOString() },
      },
    });
    return transitioned_at;
  });

  if (locked_at) await cacheRound(round_id);
};

const generateResult = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyRound.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (!round || round.status !== GreedyRoundStatus.betting_locked || round.result) return;
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
  const total_weight = options.reduce((sum, item) => sum + item.probability_weight, 0n);
  if (total_weight <= 0n) throw new Error('Greedy config has no positive probability weight');

  const random = secureRandomBigIntBelow(total_weight);
  let cursor = 0n;
  let winner = options[options.length - 1];
  for (const option of options) {
    cursor += option.probability_weight;
    if (random.value < cursor) {
      winner = option;
      break;
    }
  }
  if (!winner) throw new Error('Greedy result winner could not be selected');

  const generated_at = database_now;
  const audit_hash = sha256([
    round.id,
    round.config_version_id,
    winner.id,
    GREEDY_RNG_ALGORITHM_VERSION,
    random.entropy_digest,
    generated_at.toISOString(),
  ].join('|'));

  await withSerializableRetry(async (tx) => {
    const current = await tx.greedyRound.findUnique({ where: { id: round.id }, include: { result: true } });
    if (!current || current.status !== GreedyRoundStatus.betting_locked || current.result) return;

    await tx.greedyRoundResult.create({
      data: {
        round_id: round.id,
        winning_option_version_id: winner.id,
        algorithm_version: GREEDY_RNG_ALGORITHM_VERSION,
        config_version_id: round.config_version_id,
        entropy_digest: random.entropy_digest,
        audit_hash,
        generated_at,
      },
    });
    await tx.greedyRound.update({
      where: { id: round.id },
      data: { status: GreedyRoundStatus.result_ready, result_generated_at: generated_at },
    });
  });
  await cacheRound(round_id);
};

const startDrawing = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== GreedyRoundStatus.result_ready) return;

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
    const updated = await tx.greedyRound.updateMany({
      where: { id: round.id, status: GreedyRoundStatus.result_ready },
      data: {
        status: GreedyRoundStatus.drawing,
        drawing_started_at,
        result_reveal_at,
      },
    });
    if (!updated.count) return false;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round',
        aggregate_id: round.id,
        event_type: 'greedy.round.drawing',
        socket_room: GREEDY_SOCKET_ROOM,
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
  const round = await prisma.greedyRound.findUnique({
    where: { id: round_id },
    include: { result: { include: { winning_option: true } } },
  });
  if (!round || round.status !== GreedyRoundStatus.drawing || !round.result || !round.result_reveal_at) return;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now < round.result_reveal_at) return;

  const revealed_at = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.greedyRound.updateMany({
      where: { id: round.id, status: GreedyRoundStatus.drawing },
      data: { status: GreedyRoundStatus.result_revealed },
    });
    if (!updated.count) return;
    await tx.greedyRoundResult.update({ where: { round_id: round.id }, data: { revealed_at } });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round', aggregate_id: round.id,
        event_type: 'greedy.round.result', socket_room: GREEDY_SOCKET_ROOM,
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
  await prisma.greedyRound.updateMany({
    where: { id: round_id, status: GreedyRoundStatus.result_revealed },
    data: { status: GreedyRoundStatus.settling, settlement_started_at: database_now },
  });
};

const pendingSettlementUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM greedy_bets b
    LEFT JOIN greedy_bet_settlements s ON s.bet_id = b.id
    WHERE b.round_id = ${round_id} AND s.id IS NULL
    LIMIT ${SETTLEMENT_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const settleUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const result = await tx.greedyRoundResult.findUnique({ where: { round_id } });
    if (!result) throw new Error('Cannot settle a round without a result');

    const bets = await tx.greedyBet.findMany({
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

    await tx.greedyBetSettlement.createMany({ data: settlement_rows, skipDuplicates: true });

    if (total_payout > 0n) {
      const existing_payout = await tx.greedyUserPayout.findUnique({
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
            game_id: (await tx.greedyRound.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } })).game_id,
            type: WalletLedgerType.win_credit,
            amount: total_payout,
            balance_before: wallet.balance,
            balance_after: updated_wallet.balance,
            reference_type: 'greedy_round_payout',
            reference_id: round_id,
          },
        });
        await tx.greedyUserPayout.create({
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
            payload: { wallet_id: wallet.id, balance: updated_wallet.balance.toString(), reason: 'greedy_win', round_id, payout: total_payout.toString() },
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
      const updated = await tx.greedyRound.updateMany({
        where: { id: round_id, status: GreedyRoundStatus.settling },
        data: { status: GreedyRoundStatus.settled, settled_at },
      });
      if (!updated.count) return false;

      await tx.outboxEvent.create({
        data: {
          aggregate_type: 'greedy_round',
          aggregate_id: round_id,
          event_type: 'greedy.round.settled',
          socket_room: GREEDY_SOCKET_ROOM,
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
  const round = await prisma.greedyRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== GreedyRoundStatus.settled || !round.result_reveal_at) return;
  const close_at = round.result_reveal_at.getTime() + round.config_version.result_duration_ms;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now.getTime() < close_at) return;

  const now = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.greedyRound.updateMany({
      where: { id: round_id, status: GreedyRoundStatus.settled },
      data: { status: GreedyRoundStatus.closed, closed_at: now },
    });
    if (!updated.count) return;
    await tx.greedyRuntimeState.updateMany({
      where: { current_round_id: round_id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round', aggregate_id: round_id,
        event_type: 'greedy.round.closed', socket_room: GREEDY_SOCKET_ROOM,
        payload: { round_id, closed_at: now.toISOString() },
      },
    });
  });
  await cacheRound(null);
};

const pendingRefundUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM greedy_bets b
    LEFT JOIN greedy_user_refunds r ON r.round_id = b.round_id AND r.user_id = b.user_id
    WHERE b.round_id = ${round_id} AND r.id IS NULL
    LIMIT ${REFUND_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const refundUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const existing = await tx.greedyUserRefund.findUnique({ where: { round_id_user_id: { round_id, user_id } } });
    if (existing) return;
    const bets = await tx.greedyBet.findMany({ where: { round_id, user_id } });
    if (!bets.length) return;
    const total_bet_amount = bets.reduce((sum, bet) => sum + bet.amount, 0n);
    const wallet = await ensureWallet(user_id, tx);
    const updated_wallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: total_bet_amount }, version: { increment: 1 } },
    });
    const round = await tx.greedyRound.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } });
    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id, user_id, game_id: round.game_id,
        type: WalletLedgerType.bet_refund, amount: total_bet_amount,
        balance_before: wallet.balance, balance_after: updated_wallet.balance,
        reference_type: 'greedy_round_refund', reference_id: round_id,
      },
    });
    await tx.greedyUserRefund.create({
      data: { round_id, user_id, wallet_id: wallet.id, total_bet_amount, wallet_ledger_id: ledger.id },
    });
    await tx.greedyBetSettlement.createMany({
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
        payload: { wallet_id: wallet.id, balance: updated_wallet.balance.toString(), reason: 'greedy_refund', round_id, refund: total_bet_amount.toString() },
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
    const runtime = await tx.greedyRuntimeState.findFirst({ where: { current_round_id: round_id } });
    if (!runtime) return;
    await tx.greedyRuntimeState.update({
      where: { id: runtime.id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'greedy_round', aggregate_id: round_id,
        event_type: 'greedy.round.refunded', socket_room: GREEDY_SOCKET_ROOM,
        payload: { round_id },
      },
    });
  });
  await cacheRound(null);
};

const processCurrentRound = async (round_id: string): Promise<void> => {
  const round = await prisma.greedyRound.findUnique({ where: { id: round_id } });
  if (!round) return;

  switch (round.status) {
    case GreedyRoundStatus.betting_open:
      await lockRound(round.id);
      break;
    case GreedyRoundStatus.betting_locked:
      await generateResult(round.id);
      break;
    case GreedyRoundStatus.result_ready:
      await startDrawing(round.id);
      break;
    case GreedyRoundStatus.drawing:
      await revealResult(round.id);
      break;
    case GreedyRoundStatus.result_revealed:
      await startSettlement(round.id);
      break;
    case GreedyRoundStatus.settling:
      await settleRoundBatch(round.id);
      break;
    case GreedyRoundStatus.settled:
      await closeSettledRound(round.id);
      break;
    case GreedyRoundStatus.cancelled:
      await refundCancelledRound(round.id);
      break;
    default:
      break;
  }
};

export const runGreedyTick = async (): Promise<void> => {
  const game = await prisma.game.findUnique({
    where: { code: GREEDY_GAME_CODE },
    include: { greedy_runtime_state: true },
  });
  if (!game?.greedy_runtime_state) return;

  const current_round_id = game.greedy_runtime_state.current_round_id;
  if (current_round_id) {
    await processCurrentRound(current_round_id);
    return;
  }

  if (
    game.status === GameStatus.active &&
    game.greedy_runtime_state.status === GreedyRuntimeStatus.running
  ) {
    await createRoundIfNeeded();
  }
};

export const recoverGreedyRuntime = async (): Promise<void> => {
  const game = await prisma.game.findUnique({ where: { code: GREEDY_GAME_CODE }, include: { greedy_runtime_state: true } });
  if (!game?.greedy_runtime_state) return;
  if (game.greedy_runtime_state.current_round_id) {
    await cacheRound(game.greedy_runtime_state.current_round_id);
    logger.info('greedy_worker_recovered_round', { round_id: game.greedy_runtime_state.current_round_id });
  }
};
