import {
  GameStatus,
  Prisma,
  SettlementOutcome,
  TeenPattiRoundStatus,
  TeenPattiRuntimeStatus,
  WalletLedgerType,
} from '@/generated/prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { ensureWallet } from '@/modules/wallet/wallet.services';
import type { WalletBalanceUpdatedPayload } from '@/modules/wallet/wallet.types';
import {
  TEEN_PATTI_GAME_CODE,
  TEEN_PATTI_RNG_ALGORITHM_VERSION,
  TEEN_PATTI_RNG_ALGORITHM_VERSION_BIASED,
  TEEN_PATTI_SOCKET_ROOM,
} from '@/modules/teen-patti/teen-patti.constant';
import { effectiveTeenPattiResultDurationMs } from '@/modules/teen-patti/teen-patti.config';
import { dealUniqueWinner, dealWithWinningOption } from '@/modules/teen-patti/teen-patti.deal';
import { splitPot } from '@/modules/teen-patti/teen-patti.payout';
import { buildTeenPattiPreview } from '@/modules/teen-patti/teen-patti.public';
import { buildTeenPattiResultCommitment } from '@/modules/teen-patti/teen-patti.audit';
import { withSerializableRetry } from '@/modules/greedy/greedy.utils';
import { logger } from '@/utils/logger';
import { pickBiasedWinner, pickNaturalWinner } from '@/modules/game-bot/biased-outcome';
import { loadTeenPattiRoundBets } from '@/modules/game-bot/biased-round';
import { getGameBotPolicy } from '@/modules/game-bot/bot-policy';
import { isBotUserIdSync } from '@/modules/game-bot/bot-identity';

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
    if (config.options.length !== 3) {
      throw new Error('Teen Patti config must have exactly three enabled decks');
    }
    const betting_ends_at = new Date(database_now.getTime() + config.betting_duration_ms);
    const deal = dealUniqueWinner(
      config.options.map((option) => ({ id: option.id, code: option.code })),
    );
    const winner = deal.hands[deal.winner_index];
    if (!winner) throw new Error('Teen Patti deal produced no winner');
    const hands = deal.hands.map((hand) => ({
      option_id: hand.option_id,
      option_code: hand.option_code,
      cards: hand.cards,
      category: hand.category,
      rank_key: hand.rank_key,
    }));

    const round = await tx.teenPattiRound.create({
      data: {
        game_id: game.id,
        round_number,
        config_version_id: config.id,
        status: TeenPattiRoundStatus.betting_open,
        betting_started_at: database_now,
        betting_ends_at,
        result_generated_at: database_now,
      },
    });
    const audit_hash = buildTeenPattiResultCommitment({
      round_id: round.id,
      config_version_id: config.id,
      winning_option_id: winner.option_id,
      algorithm_version: TEEN_PATTI_RNG_ALGORITHM_VERSION,
      entropy_digest: deal.entropy_digest,
      hands,
      generated_at: database_now,
    });
    await tx.teenPattiRoundResult.create({
      data: {
        round_id: round.id,
        winning_option_version_id: winner.option_id,
        algorithm_version: TEEN_PATTI_RNG_ALGORITHM_VERSION,
        config_version_id: config.id,
        entropy_digest: deal.entropy_digest,
        audit_hash,
        deal_attempt_count: deal.deal_attempt_count,
        hands,
        generated_at: database_now,
      },
    });
    const preview = buildTeenPattiPreview({ audit_hash, hands });

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
          preview_cards: preview.preview_cards,
          result_commitment: preview.result_commitment,
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

const applyBiasedResultAtLock = async (round_id: string): Promise<void> => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (
    !round ||
    round.status !== TeenPattiRoundStatus.betting_locked ||
    !round.result ||
    !round.locked_at ||
    round.result.generated_at >= round.locked_at
  ) {
    return;
  }

  const options = round.config_version.options;
  if (options.length !== 3) {
    throw new Error('Teen Patti config must have exactly three enabled decks');
  }

  const round_bets = await loadTeenPattiRoundBets(round.id);
  const pot = round_bets.reduce((sum, bet) => sum + bet.amount, 0n);
  const distributable =
    pot - (pot * BigInt(round.config_version.rake_bps)) / 10000n;
  const biased_options = options.map((option) => {
    const stake_on_option = round_bets
      .filter((bet) => bet.option_id === option.id)
      .reduce((sum, bet) => sum + bet.amount, 0n);
    return {
      id: option.id,
      probability_weight: 1n,
      payout_numerator: distributable > 0n ? distributable : 1n,
      payout_denominator: stake_on_option > 0n ? stake_on_option : 1n,
    };
  });

  const policy = await getGameBotPolicy();
  const biased = policy.enabled
    ? pickBiasedWinner({
        options: biased_options,
        bets: round_bets,
        target_human_win_rate: policy.target_human_win_rate,
        min_human_bets_before_bias: policy.min_human_bets_before_bias,
      })
    : pickNaturalWinner(biased_options);

  const deal = dealWithWinningOption(
    options.map((option) => ({ id: option.id, code: option.code })),
    biased.option_id,
  );
  const winner = deal.hands[deal.winner_index];
  if (!winner) throw new Error('Teen Patti biased deal produced no winner');

  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) throw new Error('Database time unavailable');

  const hands = deal.hands.map((hand) => ({
    option_id: hand.option_id,
    option_code: hand.option_code,
    cards: hand.cards,
    category: hand.category,
    rank_key: hand.rank_key,
  }));
  const algorithm_version =
    biased.algorithm_suffix === 'biased-v1'
      ? TEEN_PATTI_RNG_ALGORITHM_VERSION_BIASED
      : TEEN_PATTI_RNG_ALGORITHM_VERSION;
  const audit_hash = buildTeenPattiResultCommitment({
    round_id: round.id,
    config_version_id: round.config_version_id,
    winning_option_id: winner.option_id,
    algorithm_version,
    entropy_digest: deal.entropy_digest,
    hands,
    generated_at: database_now,
  });

  await withSerializableRetry(async (tx) => {
    const current = await tx.teenPattiRound.findUnique({
      where: { id: round.id },
      include: { result: true },
    });
    if (
      !current ||
      current.status !== TeenPattiRoundStatus.betting_locked ||
      !current.result ||
      !current.locked_at ||
      current.result.generated_at >= current.locked_at
    ) {
      return;
    }

    await tx.teenPattiRoundResult.update({
      where: { round_id: round.id },
      data: {
        winning_option_version_id: winner.option_id,
        algorithm_version,
        entropy_digest: deal.entropy_digest,
        audit_hash,
        deal_attempt_count: deal.deal_attempt_count,
        hands,
        generated_at: database_now,
      },
    });
    await tx.teenPattiRound.update({
      where: { id: round.id },
      data: { result_generated_at: database_now },
    });
  });
};

const startDrawingAfterLock = async (round_id: string): Promise<boolean> => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: {
      config_version: {
        include: { options: { where: { is_enabled: true }, orderBy: { display_order: 'asc' } } },
      },
      result: true,
    },
  });
  if (!round || round.status !== TeenPattiRoundStatus.betting_locked) return false;
  if (!round.locked_at) return false;
  const database_now_rows = await prisma.$queryRaw<Array<{ database_now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
  );
  const database_now = database_now_rows[0]?.database_now;
  if (!database_now) throw new Error('Database time unavailable');
  if (
    database_now.getTime() <
    round.locked_at.getTime() + round.config_version.lock_duration_ms
  ) {
    return false;
  }

  // New rounds are predealt atomically when opened so their first card can be
  // shown during betting. The fallback only recovers a legacy in-flight round
  // created before that deployment; an existing committed result is never
  // replaced or re-dealt after bets have been accepted.
  let legacy_result: {
    winning_option_version_id: string;
    entropy_digest: string;
    audit_hash: string;
    deal_attempt_count: number;
    hands: Prisma.InputJsonValue;
    generated_at: Date;
  } | null = null;
  if (!round.result) {
    const options = round.config_version.options;
    if (options.length !== 3) {
      throw new Error('Teen Patti config must have exactly three enabled decks');
    }
    const deal = dealUniqueWinner(
      options.map((option) => ({ id: option.id, code: option.code })),
    );
    const winner = deal.hands[deal.winner_index];
    if (!winner) throw new Error('Teen Patti deal produced no winner');
    const hands = deal.hands.map((hand) => ({
      option_id: hand.option_id,
      option_code: hand.option_code,
      cards: hand.cards,
      category: hand.category,
      rank_key: hand.rank_key,
    }));
    legacy_result = {
      winning_option_version_id: winner.option_id,
      entropy_digest: deal.entropy_digest,
      audit_hash: buildTeenPattiResultCommitment({
        round_id: round.id,
        config_version_id: round.config_version_id,
        winning_option_id: winner.option_id,
        algorithm_version: TEEN_PATTI_RNG_ALGORITHM_VERSION,
        entropy_digest: deal.entropy_digest,
        hands,
        generated_at: database_now,
      }),
      deal_attempt_count: deal.deal_attempt_count,
      hands,
      generated_at: database_now,
    };
  }

  const drawing_started_at = database_now;
  const result_reveal_at = new Date(
    drawing_started_at.getTime() + round.config_version.drawing_duration_ms,
  );

  const transitioned = await withSerializableRetry(async (tx) => {
    const current = await tx.teenPattiRound.findUnique({ where: { id: round.id }, include: { result: true } });
    if (!current || current.status !== TeenPattiRoundStatus.betting_locked) return false;

    if (!current.result) {
      if (!legacy_result) {
        throw new Error('Teen Patti predealt result is unavailable');
      }
      await tx.teenPattiRoundResult.create({
        data: {
          round_id: round.id,
          winning_option_version_id:
            legacy_result.winning_option_version_id,
          algorithm_version: TEEN_PATTI_RNG_ALGORITHM_VERSION,
          config_version_id: round.config_version_id,
          entropy_digest: legacy_result.entropy_digest,
          audit_hash: legacy_result.audit_hash,
          deal_attempt_count: legacy_result.deal_attempt_count,
          hands: legacy_result.hands,
          generated_at: legacy_result.generated_at,
        },
      });
    }
    await tx.teenPattiRound.update({
      where: { id: round.id },
      data: {
        status: TeenPattiRoundStatus.drawing,
        ...(current.result_generated_at
          ? {}
          : { result_generated_at: legacy_result?.generated_at ?? database_now }),
        drawing_started_at,
        result_reveal_at,
      },
    });
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
  return transitioned;
};

const startDrawing = async (round_id: string): Promise<boolean> => {
  const round = await prisma.teenPattiRound.findUnique({
    where: { id: round_id },
    include: { config_version: true },
  });
  if (!round || round.status !== TeenPattiRoundStatus.result_ready) return false;

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
  return transitioned;
};

const revealResult = async (round_id: string): Promise<string[] | null> => {
  const reveal_context = await prisma.$queryRaw<Array<{
    id: string;
    result_reveal_at: Date;
    database_now: Date;
    hands: Prisma.JsonValue;
    algorithm_version: string;
    config_version_id: string;
    entropy_digest: string;
    audit_hash: string;
    deal_attempt_count: number;
    generated_at: Date;
    winning_option_id: string;
    winning_option_code: string;
    winning_option_name: string;
    winning_option_image_url: string | null;
    settlement_users: string[];
  }>>(Prisma.sql`
    SELECT
      game_round.id,
      game_round.result_reveal_at,
      CURRENT_TIMESTAMP AS database_now,
      result.hands,
      result.algorithm_version,
      result.config_version_id,
      result.entropy_digest,
      result.audit_hash,
      result.deal_attempt_count,
      result.generated_at,
      winning_option.id AS winning_option_id,
      winning_option.code AS winning_option_code,
      winning_option.name AS winning_option_name,
      winning_option.image_url AS winning_option_image_url,
      ARRAY(
        SELECT DISTINCT bet.user_id
        FROM teen_patti_bets AS bet
        WHERE bet.round_id = game_round.id
        LIMIT ${SETTLEMENT_BATCH_USERS}
      ) AS settlement_users
    FROM teen_patti_rounds AS game_round
    JOIN teen_patti_round_results AS result
      ON result.round_id = game_round.id
    JOIN teen_patti_option_versions AS winning_option
      ON winning_option.id = result.winning_option_version_id
    WHERE game_round.id = ${round_id}
      AND game_round.status = 'drawing'::teen_patti_round_status
      AND game_round.result_reveal_at IS NOT NULL
  `);
  const round = reveal_context[0];
  if (!round || round.database_now < round.result_reveal_at) return null;

  const revealed_at = round.database_now;
  const revealed = await withSerializableRetry(async (tx) => {
    const updated = await tx.teenPattiRound.updateMany({
      where: { id: round.id, status: TeenPattiRoundStatus.drawing },
      data: {
        status: TeenPattiRoundStatus.settling,
        settlement_started_at: revealed_at,
      },
    });
    if (!updated.count) return null;
    await tx.teenPattiRoundResult.update({ where: { round_id: round.id }, data: { revealed_at } });
    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'teen_patti_round', aggregate_id: round.id,
        event_type: 'teen_patti.round.result', socket_room: TEEN_PATTI_SOCKET_ROOM,
        payload: {
          round_id: round.id,
          winning_option: {
            id: round.winning_option_id,
            code: round.winning_option_code,
            name: round.winning_option_name,
            image_url: round.winning_option_image_url,
          },
          hands: round.hands,
          algorithm_version: round.algorithm_version,
          config_version_id: round.config_version_id,
          entropy_digest: round.entropy_digest,
          deal_attempt_count: round.deal_attempt_count,
          generated_at: round.generated_at.toISOString(),
          result_commitment: round.audit_hash,
          revealed_at: revealed_at.toISOString(),
        },
      },
    });
    return round.settlement_users;
  });
  return revealed;
};

const startSettlement = async (round_id: string): Promise<boolean> => {
  const transitioned = await prisma.teenPattiRound.updateMany({
    where: { id: round_id, status: TeenPattiRoundStatus.result_revealed },
    data: {
      status: TeenPattiRoundStatus.settling,
      settlement_started_at: new Date(),
    },
  });
  return transitioned.count === 1;
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
    const bets = await tx.$queryRaw<Array<{
      bet_id: string;
      wallet_id: string;
      option_version_id: string;
      amount: bigint;
      game_id: string;
      result_id: string;
      winning_option_version_id: string;
      rake_bps: number;
      pot: bigint;
      total_winning_stake: bigint;
    }>>(Prisma.sql`
      WITH round_context AS (
        SELECT
          game_round.game_id,
          result.id AS result_id,
          result.winning_option_version_id,
          config.rake_bps
        FROM teen_patti_rounds AS game_round
        JOIN teen_patti_round_results AS result
          ON result.round_id = game_round.id
        JOIN teen_patti_config_versions AS config
          ON config.id = game_round.config_version_id
        WHERE game_round.id = ${round_id}
          AND game_round.status = 'settling'::teen_patti_round_status
      ),
      round_totals AS (
        SELECT
          COALESCE(SUM(bet.amount), 0)::bigint AS pot,
          COALESCE(
            SUM(bet.amount) FILTER (
              WHERE bet.option_version_id = context.winning_option_version_id
            ),
            0
          )::bigint AS total_winning_stake
        FROM teen_patti_bets AS bet
        CROSS JOIN round_context AS context
        WHERE bet.round_id = ${round_id}
      )
      SELECT
        bet.id AS bet_id,
        bet.wallet_id,
        bet.option_version_id,
        bet.amount,
        context.game_id,
        context.result_id,
        context.winning_option_version_id,
        context.rake_bps,
        totals.pot,
        totals.total_winning_stake
      FROM teen_patti_bets AS bet
      CROSS JOIN round_context AS context
      CROSS JOIN round_totals AS totals
      WHERE bet.round_id = ${round_id}
        AND bet.user_id = ${user_id}
        AND NOT EXISTS (
          SELECT 1
          FROM teen_patti_bet_settlements AS settlement
          WHERE settlement.bet_id = bet.id
        )
      ORDER BY bet.created_at ASC
    `);
    if (!bets.length) return;

    const context = bets[0]!;
    if (bets.some((bet) => bet.wallet_id !== context.wallet_id)) {
      throw new Error('A player cannot settle one round across multiple wallets');
    }
    const split = splitPot(
      context.pot,
      context.rake_bps,
      [context.total_winning_stake],
    );

    let total_winning_stake_user = 0n;
    let total_payout = 0n;
    let winning_bet_count = 0;

    const settlement_rows = bets.map((bet) => {
      const is_win =
        bet.option_version_id === context.winning_option_version_id;
      const payout = is_win && context.total_winning_stake > 0n
        ? (split.distributable * bet.amount) / context.total_winning_stake
        : 0n;
      if (is_win) {
        total_winning_stake_user += bet.amount;
        total_payout += payout;
        winning_bet_count += 1;
      }
      return {
        id: randomUUID(),
        round_id,
        bet_id: bet.bet_id,
        result_id: context.result_id,
        outcome: is_win ? SettlementOutcome.win : SettlementOutcome.loss,
        payout_amount: payout,
      };
    });

    if (total_payout <= 0n || isBotUserIdSync(user_id)) {
      await tx.teenPattiBetSettlement.createMany({
        data: settlement_rows,
        skipDuplicates: true,
      });
      return;
    }

    const ledger_id = randomUUID();
    const payout_id = randomUUID();
    const settlement_values = Prisma.join(
      settlement_rows.map((settlement) => Prisma.sql`(
        ${settlement.id},
        ${settlement.round_id},
        ${settlement.bet_id},
        ${settlement.result_id},
        ${settlement.outcome}::settlement_outcome,
        ${settlement.payout_amount}
      )`),
    );
    const payout_mutation = await tx.$queryRaw<Array<{
        id: string;
        balance_before: bigint;
        balance_after: bigint;
        version: number;
      }>>(Prisma.sql`
      WITH inserted_settlements AS (
        INSERT INTO teen_patti_bet_settlements (
          id,
          round_id,
          bet_id,
          result_id,
          outcome,
          payout_amount
        )
        VALUES ${settlement_values}
        ON CONFLICT (bet_id) DO NOTHING
        RETURNING bet_id
      ),
      updated_wallet AS (
        UPDATE wallets AS wallet
        SET
          balance = wallet.balance + ${total_payout},
          version = wallet.version + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE wallet.id = ${context.wallet_id}
          AND EXISTS (SELECT 1 FROM inserted_settlements)
          AND NOT EXISTS (
            SELECT 1
            FROM teen_patti_user_payouts AS existing_payout
            WHERE existing_payout.round_id = ${round_id}
              AND existing_payout.user_id = ${user_id}
          )
        RETURNING
          wallet.id,
          wallet.balance - ${total_payout} AS balance_before,
          wallet.balance AS balance_after,
          wallet.version
      ),
      inserted_ledger AS (
        INSERT INTO wallet_ledger (
          id,
          wallet_id,
          user_id,
          game_id,
          type,
          amount,
          balance_before,
          balance_after,
          reference_type,
          reference_id
        )
        SELECT
          ${ledger_id},
          wallet.id,
          ${user_id},
          ${context.game_id},
          ${WalletLedgerType.win_credit}::wallet_ledger_type,
          ${total_payout},
          wallet.balance_before,
          wallet.balance_after,
          'teen_patti_round_payout',
          ${round_id}
        FROM updated_wallet AS wallet
        RETURNING id
      ),
      inserted_payout AS (
        INSERT INTO teen_patti_user_payouts (
          id,
          round_id,
          user_id,
          wallet_id,
          winning_bet_count,
          total_winning_stake,
          total_payout,
          wallet_ledger_id
        )
        SELECT
          ${payout_id},
          ${round_id},
          ${user_id},
          ${context.wallet_id},
          ${winning_bet_count},
          ${total_winning_stake_user},
          ${total_payout},
          ledger.id
        FROM inserted_ledger AS ledger
        ON CONFLICT (round_id, user_id) DO NOTHING
        RETURNING id
      )
      SELECT
        wallet.id,
        wallet.balance_before,
        wallet.balance_after,
        wallet.version
      FROM updated_wallet AS wallet
      WHERE EXISTS (SELECT 1 FROM inserted_payout)
    `);
    const updated_wallet = payout_mutation[0];
    if (!updated_wallet) return;

    await tx.outboxEvent.create({
      data: {
        aggregate_type: 'wallet', aggregate_id: updated_wallet.id,
        event_type: 'wallet.balance.updated', socket_room: `user:${user_id}`,
        payload: {
          wallet_id: updated_wallet.id,
          balance: updated_wallet.balance_after.toString(),
          wallet_version: updated_wallet.version,
          reason: 'teen_patti_win',
          round_id,
          payout: total_payout.toString(),
        } satisfies WalletBalanceUpdatedPayload,
      },
    });
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
  const close_at =
    round.result_reveal_at.getTime() +
    effectiveTeenPattiResultDurationMs(
      round.config_version.result_duration_ms,
    );
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
        payload: {
          wallet_id: wallet.id,
          balance: updated_wallet.balance.toString(),
          wallet_version: updated_wallet.version,
          reason: 'teen_patti_refund',
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

const processCurrentRound = async (
  round: { id: string; status: TeenPattiRoundStatus },
): Promise<void> => {
  switch (round.status) {
    case TeenPattiRoundStatus.betting_open:
      await lockRound(round.id);
      break;
    case TeenPattiRoundStatus.betting_locked:
      await applyBiasedResultAtLock(round.id);
      await startDrawingAfterLock(round.id);
      break;
    case TeenPattiRoundStatus.result_ready:
      await startDrawing(round.id);
      break;
    case TeenPattiRoundStatus.drawing:
      {
        const settlement_users = await revealResult(round.id);
        if (settlement_users) {
          for (const user_id of settlement_users) {
            await settleUser(round.id, user_id);
          }
          if (!settlement_users.length) await settleRoundBatch(round.id);
        }
      }
      break;
    case TeenPattiRoundStatus.result_revealed:
      if (await startSettlement(round.id)) {
        await settleRoundBatch(round.id);
      }
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
    include: {
      teen_patti_runtime_state: {
        include: {
          current_round: { select: { id: true, status: true } },
        },
      },
    },
  });
  if (!game?.teen_patti_runtime_state) return;

  const current_round = game.teen_patti_runtime_state.current_round;
  if (current_round) {
    await processCurrentRound(current_round);
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
