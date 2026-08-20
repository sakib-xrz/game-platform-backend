import {
  GameStatus,
  Prisma,
  SettlementOutcome,
  TeenPattiRoundStatus,
  TeenPattiRuntimeStatus,
  WalletLedgerType,
} from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import {
  TEEN_PATTI_GAME_CODE,
  TEEN_PATTI_RNG_ALGORITHM_VERSION,
  TEEN_PATTI_SOCKET_ROOM,
} from '@/modules/teen-patti/teen-patti.constant';
import { dealUniqueWinner } from '@/modules/teen-patti/teen-patti.deal';
import { splitPot } from '@/modules/teen-patti/teen-patti.payout';
import { withSerializableRetry } from '@/modules/greedy/greedy.utils';
import { sha256 } from '@/utils/hash';
import { logger } from '@/utils/logger';

const SETTLEMENT_BATCH_USERS = 50;
const REFUND_BATCH_USERS = 50;

const cacheRound = async (round_id: string | null): Promise<void> => {
  if (!redisClient.isReady) return;
  if (!round_id) {
    await redisClient.del('teen-patti:current_round');
    return;
  }
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: { result: true },
  });
  if (round) {
    await redisClient.set('teen-patti:current_round', JSON.stringify({
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
    const game = await tx.game.findUnique({ where: { code: TEEN_PATTI_GAME_CODE } });
    if (!game || game.status !== GameStatus.active) return null;

    const runtime = await tx.teenPattiRuntimeState.findUnique({
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
      runtime.status !== TeenPattiRuntimeStatus.running ||
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

    const round_number = runtime.last_round_number + 1n;
    const config = runtime.active_config_version;
    const betting_ends_at = new Date(database_now.getTime() + config.betting_duration_ms);

    const round = await tx.teenPattiRound.create({
      data: {
        game_id: game.id,
        round_number,
        config_version_id: config.id,
        status: TeenPattiRoundStatus.betting_open,
        betting_started_at: database_now,
        betting_ends_at,
      },
    });

    await tx.teenPattiRuntimeState.update({
      where: { game_id: game.id },
      data: {
        current_round_id: round.id,
        last_round_number: round_number,
        revision: { increment: 1 },
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round',
        aggregate_id: round.id,
        event_type: 'teen_patti.round.opened',
        socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          round_number: round_number.toString(),
          betting_started_at: database_now.toISOString(),
          betting_ends_at: betting_ends_at.toISOString(),
          rake_bps: config.rake_bps,
          options: config.options.map((option) => ({
            id: option.id,
            code: option.code,
            name: option.name,
            image_url: option.image_url,
            display_order: option.display_order,
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
    const rows = await tx.$queryRaw<Array<{ locked_at: Date }>>(Prisma.sql`
      UPDATE teen_patti_rounds
      SET
        status = 'betting_locked'::teen_patti_round_status,
        locked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${round_id}
        AND status = 'betting_open'::teen_patti_round_status
        AND betting_ends_at <= CURRENT_TIMESTAMP
      RETURNING locked_at
    `);

    const transitioned_at = rows[0]?.locked_at;
    if (!transitioned_at) return null;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round',
        aggregate_id: round_id,
        event_type: 'teen_patti.round.locked',
        socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: { round_id, locked_at: transitioned_at.toISOString() },
      },
    });
    return transitioned_at;
  });

  if (locked_at) await cacheRound(round_id);
};

const generateResult = async (round_id: string): Promise<void> => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (!round || round.status !== TeenPattiRoundStatus.betting_locked || round.result) return;
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
  if (options.length !== 3) throw new Error('Teen Patti config must have exactly three enabled decks');

  const deal = dealUniqueWinner(options.map((option) => ({ id: option.id, code: option.code })));
  const winner = deal.hands[deal.winner_index];
  if (!winner) throw new Error('Teen Patti deal produced no winner');
  const generated_at = database_now;
  const hands = deal.hands.map((hand) => ({
    option_id: hand.option_id,
    option_code: hand.option_code,
    cards: hand.cards,
    category: hand.category,
    rank_key: hand.rank_key,
  }));
  const audit_hash = sha256([
    round.id,
    round.config_version_id,
    winner.option_id,
    TEEN_PATTI_RNG_ALGORITHM_VERSION,
    deal.entropy_digest,
    JSON.stringify(hands),
    generated_at.toISOString(),
  ].join('|'));

  await withSerializableRetry(async (tx) => {
    const current = await tx.teenPattiRound.findUnique({ where: { id: round.id }, include: { result: true } });
    if (!current || current.status !== TeenPattiRoundStatus.betting_locked || current.result) return;

    await tx.teenPattiRoundResult.create({
      data: {
        round_id: round.id,
        winning_option_version_id: winner.option_id,
        algorithm_version: TEEN_PATTI_RNG_ALGORITHM_VERSION,
        config_version_id: round.config_version_id,
        entropy_digest: deal.entropy_digest,
        audit_hash,
        deal_attempt_count: deal.deal_attempt_count,
        hands,
        generated_at,
      },
    });
    await tx.teenPattiRound.update({
      where: { id: round.id },
      data: { status: TeenPattiRoundStatus.result_ready, result_generated_at: generated_at },
    });
  });
  await cacheRound(round_id);
};

const startDrawing = async (round_id: string): Promise<void> => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== TeenPattiRoundStatus.result_ready) return;

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
    const updated = await tx.teenPattiRound.updateMany({
      where: { id: round.id, status: TeenPattiRoundStatus.result_ready },
      data: {
        status: TeenPattiRoundStatus.drawing,
        drawing_started_at,
        result_reveal_at,
      },
    });
    if (!updated.count) return false;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round',
        aggregate_id: round.id,
        event_type: 'teen_patti.round.drawing',
        socket_room: TEEN_PATTI_SOCKET_ROOM,
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
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: { result: { include: { winning_option: true } } },
  });
  if (!round || round.status !== TeenPattiRoundStatus.drawing || !round.result || !round.result_reveal_at) return;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now < round.result_reveal_at) return;

  const revealed_at = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.teenPattiRound.updateMany({
      where: { id: round.id, status: TeenPattiRoundStatus.drawing },
      data: { status: TeenPattiRoundStatus.result_revealed },
    });
    if (!updated.count) return;
    await tx.teenPattiRoundResult.update({ where: { round_id: round.id }, data: { revealed_at } });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round', aggregate_id: round.id,
        event_type: 'teen_patti.round.result', socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          winning_option: {
            id: round.result!.winning_option.id,
            code: round.result!.winning_option.code,
            name: round.result!.winning_option.name,
            image_url: round.result!.winning_option.image_url,
          },
          hands: round.result!.hands,
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
  await prisma.teenPattiRound.updateMany({
    where: { id: round_id, status: TeenPattiRoundStatus.result_revealed },
    data: { status: TeenPattiRoundStatus.settling, settlement_started_at: database_now },
  });
};

const pendingSettlementUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM teen_patti_bets b
    LEFT JOIN teen_patti_bet_settlements s ON s.bet_id = b.id
    WHERE b.round_id = ${round_id} AND s.id IS NULL
    LIMIT ${SETTLEMENT_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const settleUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const round = await tx.teenPattiRound.findUniqueOrThrow({
      where: { id: round_id },
      include: { result: true, config_version: { select: { rake_bps: true } } },
    });
    if (!round.result) throw new Error('Cannot settle a round without a result');

    const bets = await tx.teenPattiBet.findMany({
      where: { round_id, user_id, settlement: null },
      orderBy: { created_at: 'asc' },
    });
    if (!bets.length) return;

    const all_bets = await tx.teenPattiBet.findMany({
      where: { round_id },
      select: { option_version_id: true, amount: true },
    });
    const pot = all_bets.reduce((sum, bet) => sum + bet.amount, 0n);
    const winning_stakes = all_bets
      .filter((bet) => bet.option_version_id === round.result!.winning_option_version_id)
      .map((bet) => bet.amount);
    const split = splitPot(pot, round.config_version.rake_bps, winning_stakes);
    const total_winning_stake = winning_stakes.reduce((sum, stake) => sum + stake, 0n);

    let total_winning_stake_user = 0n;
    let total_payout = 0n;
    let winning_bet_count = 0;

    const settlement_rows = bets.map((bet) => {
      const is_win = bet.option_version_id === round.result!.winning_option_version_id;
      const payout = is_win && total_winning_stake > 0n
        ? (split.distributable * bet.amount) / total_winning_stake
        : 0n;
      if (is_win) {
        total_winning_stake_user += bet.amount;
        total_payout += payout;
        winning_bet_count += 1;
      }
      return {
        round_id,
        bet_id: bet.id,
        result_id: round.result!.id,
        outcome: is_win ? SettlementOutcome.win : SettlementOutcome.loss,
        payout_amount: payout,
      };
    });

    await tx.teenPattiBetSettlement.createMany({ data: settlement_rows, skipDuplicates: true });

    if (total_payout > 0n) {
      const existing_payout = await tx.teenPattiUserPayout.findUnique({
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
            game_id: round.game_id,
            type: WalletLedgerType.win_credit,
            amount: total_payout,
            balance_before: wallet.balance,
            balance_after: updated_wallet.balance,
            reference_type: 'teen_patti_round_payout',
            reference_id: round_id,
          },
        });
        await tx.teenPattiUserPayout.create({
          data: {
            round_id,
            user_id,
            wallet_id: wallet.id,
            winning_bet_count,
            total_winning_stake: total_winning_stake_user,
            total_payout,
            wallet_ledger_id: ledger.id,
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregate_type: 'wallet', aggregate_id: wallet.id,
            event_type: 'wallet.balance.updated', socket_room: `user:${user_id}`,
            payload: { wallet_id: wallet.id, balance: updated_wallet.balance.toString(), reason: 'teen_patti_win', round_id, payout: total_payout.toString() },
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
      const updated = await tx.teenPattiRound.updateMany({
        where: { id: round_id, status: TeenPattiRoundStatus.settling },
        data: { status: TeenPattiRoundStatus.settled, settled_at },
      });
      if (!updated.count) return false;

      await tx.outboxEvent.create({
        data: {
          aggregate_type: 'teen_patti_round',
          aggregate_id: round_id,
          event_type: 'teen_patti.round.settled',
          socket_room: TEEN_PATTI_SOCKET_ROOM,
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
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== TeenPattiRoundStatus.settled || !round.result_reveal_at) return;
  const close_at = round.result_reveal_at.getTime() + round.config_version.result_duration_ms;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now || database_now.getTime() < close_at) return;

  const now = database_now;
  await withSerializableRetry(async (tx) => {
    const updated = await tx.teenPattiRound.updateMany({
      where: { id: round_id, status: TeenPattiRoundStatus.settled },
      data: { status: TeenPattiRoundStatus.closed, closed_at: now },
    });
    if (!updated.count) return;
    await tx.teenPattiRuntimeState.updateMany({
      where: { current_round_id: round_id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round', aggregate_id: round_id,
        event_type: 'teen_patti.round.closed', socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: { round_id, closed_at: now.toISOString() },
      },
    });
  });
  await cacheRound(null);
};

const pendingRefundUsers = async (round_id: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
    SELECT DISTINCT b.user_id
    FROM teen_patti_bets b
    LEFT JOIN teen_patti_user_refunds r ON r.round_id = b.round_id AND r.user_id = b.user_id
    WHERE b.round_id = ${round_id} AND r.id IS NULL
    LIMIT ${REFUND_BATCH_USERS}
  `);
  return rows.map((row) => row.user_id);
};

const refundUser = async (round_id: string, user_id: string): Promise<void> => {
  await withSerializableRetry(async (tx) => {
    const existing = await tx.teenPattiUserRefund.findUnique({ where: { round_id_user_id: { round_id, user_id } } });
    if (existing) return;
    const bets = await tx.teenPattiBet.findMany({ where: { round_id, user_id } });
    if (!bets.length) return;
    const total_bet_amount = bets.reduce((sum, bet) => sum + bet.amount, 0n);
    const wallet = await ensureWallet(user_id, tx);
    const updated_wallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: total_bet_amount }, version: { increment: 1 } },
    });
    const round = await tx.teenPattiRound.findUniqueOrThrow({ where: { id: round_id }, select: { game_id: true } });
    const ledger = await tx.walletLedger.create({
      data: {
        wallet_id: wallet.id, user_id, game_id: round.game_id,
        type: WalletLedgerType.bet_refund, amount: total_bet_amount,
        balance_before: wallet.balance, balance_after: updated_wallet.balance,
        reference_type: 'teen_patti_round_refund', reference_id: round_id,
      },
    });
    await tx.teenPattiUserRefund.create({
      data: { round_id, user_id, wallet_id: wallet.id, total_bet_amount, wallet_ledger_id: ledger.id },
    });
    await tx.teenPattiBetSettlement.createMany({
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
        payload: { wallet_id: wallet.id, balance: updated_wallet.balance.toString(), reason: 'teen_patti_refund', round_id, refund: total_bet_amount.toString() },
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
    const runtime = await tx.teenPattiRuntimeState.findFirst({ where: { current_round_id: round_id } });
    if (!runtime) return;
    await tx.teenPattiRuntimeState.update({
      where: { id: runtime.id },
      data: { current_round_id: null, revision: { increment: 1 } },
    });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round', aggregate_id: round_id,
        event_type: 'teen_patti.round.refunded', socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: { round_id },
      },
    });
  });
  await cacheRound(null);
};

const processCurrentRound = async (round_id: string): Promise<void> => {
  const round = await prisma.teenPattiRound.findUnique({ where: { id: round_id } });
  if (!round) return;

  switch (round.status) {
    case TeenPattiRoundStatus.betting_open:
      await lockRound(round.id);
      break;
    case TeenPattiRoundStatus.betting_locked:
      await generateResult(round.id);
      break;
    case TeenPattiRoundStatus.result_ready:
      await startDrawing(round.id);
      break;
    case TeenPattiRoundStatus.drawing:
      await revealResult(round.id);
      break;
    case TeenPattiRoundStatus.result_revealed:
      await startSettlement(round.id);
      break;
    case TeenPattiRoundStatus.settling:
      await settleRoundBatch(round.id);
      break;
    case TeenPattiRoundStatus.settled:
      await closeSettledRound(round.id);
      break;
    case TeenPattiRoundStatus.cancelled:
      await refundCancelledRound(round.id);
      break;
    default:
      break;
  }
};

export const runTeenPattiTick = async (): Promise<void> => {
  const game = await prisma.game.findUnique({
    where: { code: TEEN_PATTI_GAME_CODE },
    include: { teen_patti_runtime_state: true },
  });
  if (!game?.teen_patti_runtime_state) return;

  const current_round_id = game.teen_patti_runtime_state.current_round_id;
  if (current_round_id) {
    await processCurrentRound(current_round_id);
    return;
  }

  if (
    game.status === GameStatus.active &&
    game.teen_patti_runtime_state.status === TeenPattiRuntimeStatus.running
  ) {
    await createRoundIfNeeded();
  }
};

export const recoverTeenPattiRuntime = async (): Promise<void> => {
  const game = await prisma.game.findUnique({ where: { code: TEEN_PATTI_GAME_CODE }, include: { teen_patti_runtime_state: true } });
  if (!game?.teen_patti_runtime_state) return;
  if (game.teen_patti_runtime_state.current_round_id) {
    await cacheRound(game.teen_patti_runtime_state.current_round_id);
    logger.info('teen_patti_worker_recovered_round', { round_id: game.teen_patti_runtime_state.current_round_id });
  }
};
