import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { isBotUserIdSync } from '@/modules/game-bot/bot-identity';
import type { BiasedBetStake, BiasedOption, PickBiasedWinnerResult } from '@/modules/game-bot/biased-outcome';
import { pickNaturalWinner, pickBiasedWinner } from '@/modules/game-bot/biased-outcome';
import { secureRandomBigIntBelow } from '@/utils/crypto-rng';
import { logger } from '@/utils/logger';

export type BigWinsMode = 'careful' | 'balanced' | 'open';

export type HouseProfitConfigData = {
  id: string;
  game_code: string;
  target_house_profit_pct: number; // default 60.0
  target_player_rtp_pct: number; // default 40.0
  max_daily_loss_coins: bigint; // default 3_000_000
  give_back_lost_pct: number; // default 10.0
  give_back_window_days: number; // default 8
  big_wins_mode: BigWinsMode;
  weekly_guarantee_enabled: boolean;
  min_weekly_profit_pct: number; // default 55.0
};

export const DEFAULT_HOUSE_PROFIT_CONFIG: HouseProfitConfigData = {
  id: 'config_default',
  game_code: 'default',
  target_house_profit_pct: 60.0,
  target_player_rtp_pct: 40.0,
  max_daily_loss_coins: 3_000_000n,
  give_back_lost_pct: 10.0,
  give_back_window_days: 8,
  big_wins_mode: 'balanced',
  weekly_guarantee_enabled: true,
  min_weekly_profit_pct: 55.0,
};

/** Get today's ISO date string YYYY-MM-DD */
export const getTodayDateString = (now = new Date()): string => {
  return now.toISOString().slice(0, 10);
};

/** Load house profit configuration for a specific game, falling back to 'default' */
export const getGameHouseProfitConfig = async (
  game_code = 'default',
): Promise<HouseProfitConfigData> => {
  try {
    const config = await prisma.gameHouseProfitConfig.findFirst({
      where: {
        game_code: { in: [game_code, 'default'] },
      },
      orderBy: {
        game_code: game_code === 'default' ? 'asc' : 'desc',
      },
    });

    if (!config) return DEFAULT_HOUSE_PROFIT_CONFIG;

    return {
      id: config.id,
      game_code: config.game_code,
      target_house_profit_pct: config.target_house_profit_pct,
      target_player_rtp_pct: config.target_player_rtp_pct,
      max_daily_loss_coins: config.max_daily_loss_coins,
      give_back_lost_pct: config.give_back_lost_pct,
      give_back_window_days: config.give_back_window_days,
      big_wins_mode: config.big_wins_mode as BigWinsMode,
      weekly_guarantee_enabled: config.weekly_guarantee_enabled,
      min_weekly_profit_pct: config.min_weekly_profit_pct,
    };
  } catch (error) {
    logger.warn('Failed to load GameHouseProfitConfig, using default', { error, game_code });
    return DEFAULT_HOUSE_PROFIT_CONFIG;
  }
};

export type DailyHouseFinancialSummary = {
  total_wagered: bigint;
  total_paid_out: bigint;
  house_profit: bigint;
  house_kept_pct: number;
  total_bets: number;
  total_players: number;
};

/** Load daily financial summary for today */
export const getDailyHouseStat = async (
  game_code: string,
  stat_date: string = getTodayDateString(),
): Promise<DailyHouseFinancialSummary> => {
  try {
    const row = await prisma.dailyGameHouseStat.findUnique({
      where: {
        game_code_stat_date: {
          game_code,
          stat_date,
        },
      },
    });

    if (!row) {
      return {
        total_wagered: 0n,
        total_paid_out: 0n,
        house_profit: 0n,
        house_kept_pct: 0,
        total_bets: 0,
        total_players: 0,
      };
    }

    return {
      total_wagered: row.total_wagered,
      total_paid_out: row.total_paid_out,
      house_profit: row.house_profit,
      house_kept_pct: row.house_kept_pct,
      total_bets: row.total_bets,
      total_players: row.total_players,
    };
  } catch (error) {
    logger.error('Failed to load DailyGameHouseStat', { error, game_code, stat_date });
    return {
      total_wagered: 0n,
      total_paid_out: 0n,
      house_profit: 0n,
      house_kept_pct: 0,
      total_bets: 0,
      total_players: 0,
    };
  }
};

/** Load rolling 7-day financial summary */
export const getRolling7DayHouseStat = async (
  game_code: string,
  endDate: string = getTodayDateString(),
): Promise<DailyHouseFinancialSummary> => {
  try {
    // Generate dates for the last 7 days inclusive
    const dates: string[] = [];
    const end = new Date(endDate);
    for (let i = 0; i < 7; i++) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const rows = await prisma.dailyGameHouseStat.findMany({
      where: {
        game_code,
        stat_date: { in: dates },
      },
    });

    let total_wagered = 0n;
    let total_paid_out = 0n;
    let total_bets = 0;
    let total_players = 0;

    for (const row of rows) {
      total_wagered += row.total_wagered;
      total_paid_out += row.total_paid_out;
      total_bets += row.total_bets;
      total_players = Math.max(total_players, row.total_players);
    }

    const house_profit = total_wagered - total_paid_out;
    const house_kept_pct =
      total_wagered > 0n
        ? (Number(house_profit) / Number(total_wagered)) * 100
        : 0;

    return {
      total_wagered,
      total_paid_out,
      house_profit,
      house_kept_pct,
      total_bets,
      total_players,
    };
  } catch (error) {
    logger.error('Failed to load Rolling7DayHouseStat', { error, game_code, endDate });
    return {
      total_wagered: 0n,
      total_paid_out: 0n,
      house_profit: 0n,
      house_kept_pct: 0,
      total_bets: 0,
      total_players: 0,
    };
  }
};

export type RecordSettlementStatsInput = {
  game_code: string;
  round_id: string;
  human_bets: Array<{
    user_id: string;
    stake: bigint;
    payout: bigint;
  }>;
};

/**
 * Record settled financials into DailyGameHouseStat and GamePlayerRiskState.
 * Updates both game-specific and 'all' aggregated daily stats.
 */
export const recordSettledRoundFinancials = async (
  input: RecordSettlementStatsInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> => {
  const humans = input.human_bets.filter((b) => !isBotUserIdSync(b.user_id));
  if (!humans.length) return;

  const stat_date = getTodayDateString();
  const total_wagered = humans.reduce((sum, b) => sum + b.stake, 0n);
  const total_paid_out = humans.reduce((sum, b) => sum + b.payout, 0n);
  const house_profit = total_wagered - total_paid_out;
  const human_user_ids = [...new Set(humans.map((b) => b.user_id))];

  // Helper to upsert a daily stat row
  const updateDailyStat = async (gameKey: string) => {
    const existing = await tx.dailyGameHouseStat.findUnique({
      where: {
        game_code_stat_date: {
          game_code: gameKey,
          stat_date,
        },
      },
    });

    const newWagered = (existing?.total_wagered ?? 0n) + total_wagered;
    const newPaidOut = (existing?.total_paid_out ?? 0n) + total_paid_out;
    const newProfit = newWagered - newPaidOut;
    const newKeptPct =
      newWagered > 0n ? (Number(newProfit) / Number(newWagered)) * 100 : 0;
    const newBets = (existing?.total_bets ?? 0) + humans.length;
    const newPlayers = Math.max(existing?.total_players ?? 0, human_user_ids.length);

    await tx.dailyGameHouseStat.upsert({
      where: {
        game_code_stat_date: {
          game_code: gameKey,
          stat_date,
        },
      },
      create: {
        game_code: gameKey,
        stat_date,
        total_wagered: newWagered,
        total_paid_out: newPaidOut,
        house_profit: newProfit,
        house_kept_pct: newKeptPct,
        total_bets: newBets,
        total_players: newPlayers,
      },
      update: {
        total_wagered: newWagered,
        total_paid_out: newPaidOut,
        house_profit: newProfit,
        house_kept_pct: newKeptPct,
        total_bets: newBets,
        total_players: newPlayers,
      },
    });
  };

  await updateDailyStat(input.game_code);
  await updateDailyStat('all');

  // Update lifetime & rolling 8-day P&L for each human player
  for (const bet of humans) {
    const userRisk = await tx.gamePlayerRiskState.findUnique({
      where: { user_id: bet.user_id },
    });

    const lifetime_wagered = (userRisk?.lifetime_wagered ?? 0n) + bet.stake;
    const lifetime_payout = (userRisk?.lifetime_payout ?? 0n) + bet.payout;
    const lifetime_net_profit = lifetime_payout - lifetime_wagered;

    const rolling_8d_wagered = (userRisk?.rolling_8d_wagered ?? 0n) + bet.stake;
    const rolling_8d_payout = (userRisk?.rolling_8d_payout ?? 0n) + bet.payout;
    const rolling_8d_net_profit = rolling_8d_payout - rolling_8d_wagered;

    await tx.gamePlayerRiskState.upsert({
      where: { user_id: bet.user_id },
      create: {
        user_id: bet.user_id,
        lifetime_wagered,
        lifetime_payout,
        lifetime_net_profit,
        rolling_8d_wagered,
        rolling_8d_payout,
        rolling_8d_net_profit,
      },
      update: {
        lifetime_wagered,
        lifetime_payout,
        lifetime_net_profit,
        rolling_8d_wagered,
        rolling_8d_payout,
        rolling_8d_net_profit,
      },
    });
  }
};

export type SteeringDecision = {
  mode:
    | 'CIRCUIT_BREAKER_EMERGENCY'
    | 'WEEKLY_GUARANTEE_RECOVERY'
    | 'ANTI_PROFIT_EXIT_BLOCKED'
    | 'GIVE_BACK_BOOST'
    | 'TARGET_60_40_ENFORCED'
    | 'NATURAL_BALANCED';
  allowed_option_ids: string[];
  max_allowed_human_payout: bigint;
  reason: string;
};

/** Calculate payout for an option */
const calculateOptionPayout = (
  amount: bigint,
  payout_numerator: bigint,
  payout_denominator: bigint,
): bigint => {
  if (payout_denominator <= 0n) return 0n;
  return (amount * payout_numerator) / payout_denominator;
};

/**
 * Evaluates the game state, daily limits, weekly targets, and player P&L
 * to dictate which options are legally allowed to win this round.
 */
export const evaluateHouseProfitSteering = async (input: {
  game_code: string;
  options: BiasedOption[];
  bets: BiasedBetStake[];
}): Promise<SteeringDecision> => {
  const config = await getGameHouseProfitConfig(input.game_code);
  const todayStat = await getDailyHouseStat(input.game_code);
  const weeklyStat = await getRolling7DayHouseStat(input.game_code);

  const human_bets = input.bets.filter((b) => !b.is_bot);
  const total_human_stake = human_bets.reduce((sum, b) => sum + b.amount, 0n);

  // If no human bet this round, any option is safe
  if (!human_bets.length || total_human_stake <= 0n) {
    return {
      mode: 'NATURAL_BALANCED',
      allowed_option_ids: input.options.map((o) => o.id),
      max_allowed_human_payout: 0n,
      reason: 'No human bets in this round',
    };
  }

  // Calculate payout on each option
  const optionPayoutMap = new Map<string, bigint>();
  for (const option of input.options) {
    let payout = 0n;
    for (const bet of human_bets) {
      if (bet.option_id === option.id) {
        payout += calculateOptionPayout(
          bet.amount,
          option.payout_numerator,
          option.payout_denominator,
        );
      }
    }
    optionPayoutMap.set(option.id, payout);
  }

  // Load human player risk states
  const human_ids = [...new Set(human_bets.map((b) => b.user_id))];
  const playerStates = await prisma.gamePlayerRiskState.findMany({
    where: { user_id: { in: human_ids } },
  });
  const playerStateMap = new Map(playerStates.map((s) => [s.user_id, s]));

  // 1. CIRCUIT BREAKER CHECK (Max Daily Loss Cap)
  // If today's net loss hits or exceeds max_daily_loss_coins, freeze all payouts!
  if (todayStat.house_profit <= -config.max_daily_loss_coins) {
    // Only zero-payout or net-profitable options allowed
    const safeOptions = input.options.filter(
      (o) => (optionPayoutMap.get(o.id) ?? 0n) === 0n,
    );
    const optionsToUse = safeOptions.length ? safeOptions : input.options;
    return {
      mode: 'CIRCUIT_BREAKER_EMERGENCY',
      allowed_option_ids: optionsToUse.map((o) => o.id),
      max_allowed_human_payout: 0n,
      reason: `Daily loss cap of ${config.max_daily_loss_coins} reached (current profit: ${todayStat.house_profit})`,
    };
  }

  // 2. WEEKLY GUARANTEE RECOVERY
  // If weekly margin drops below min_weekly_profit_pct (default 55%), steer strictly to company profit
  if (
    config.weekly_guarantee_enabled &&
    weeklyStat.total_wagered > 100_000n &&
    weeklyStat.house_kept_pct < config.min_weekly_profit_pct
  ) {
    // Restrict payout to maximum 20% of stake or zero
    const max_recovery_payout = (total_human_stake * 20n) / 100n;
    const safeOptions = input.options.filter(
      (o) => (optionPayoutMap.get(o.id) ?? 0n) <= max_recovery_payout,
    );
    const optionsToUse = safeOptions.length ? safeOptions : input.options;
    return {
      mode: 'WEEKLY_GUARANTEE_RECOVERY',
      allowed_option_ids: optionsToUse.map((o) => o.id),
      max_allowed_human_payout: max_recovery_payout,
      reason: `Weekly profit margin (${weeklyStat.house_kept_pct.toFixed(1)}%) below target ${config.min_weekly_profit_pct}%`,
    };
  }

  // 3. ANTI-PROFIT EXIT ENFORCEMENT
  // Check if any human player in this round has lifetime_net_profit > 0 (they are ahead of the house)
  const netProfitableUsers = new Set<string>();
  for (const uid of human_ids) {
    const state = playerStateMap.get(uid);
    if (state && state.lifetime_net_profit > 0n) {
      netProfitableUsers.add(uid);
    }
  }

  // If there are players in profit, block options where they would win more!
  if (netProfitableUsers.size > 0) {
    const safeOptions = input.options.filter((o) => {
      // Check if any profitable user bet on this option
      const winningStake = human_bets
        .filter((b) => b.option_id === o.id && netProfitableUsers.has(b.user_id))
        .reduce((sum, b) => sum + b.amount, 0n);
      return winningStake === 0n;
    });

    if (safeOptions.length > 0) {
      return {
        mode: 'ANTI_PROFIT_EXIT_BLOCKED',
        allowed_option_ids: safeOptions.map((o) => o.id),
        max_allowed_human_payout: 0n,
        reason: 'Blocked options where lifetime profitable users would win',
      };
    }
  }

  // 4. GIVE-BACK TO NET LOSERS (Player Retention Boost)
  // Active only if today's house is in surplus (profit % > target)
  const isSurplus =
    todayStat.total_wagered > 50_000n &&
    todayStat.house_kept_pct >= config.target_house_profit_pct + 10;

  if (isSurplus) {
    // Check if players have 8-day net losses
    const eligibleLosers = human_ids.filter((uid) => {
      const state = playerStateMap.get(uid);
      return state && state.rolling_8d_net_profit < 0n && state.lifetime_net_profit < 0n;
    });

    if (eligibleLosers.length > 0) {
      // Allow winning options for eligible losers up to target RTP + give_back_lost_pct
      const max_boosted_payout =
        (total_human_stake * BigInt(Math.round(config.target_player_rtp_pct + config.give_back_lost_pct))) /
        100n;

      const boostedOptions = input.options.filter(
        (o) => (optionPayoutMap.get(o.id) ?? 0n) <= max_boosted_payout,
      );

      if (boostedOptions.length > 0) {
        return {
          mode: 'GIVE_BACK_BOOST',
          allowed_option_ids: boostedOptions.map((o) => o.id),
          max_allowed_human_payout: max_boosted_payout,
          reason: 'Surplus profit give-back applied to retaining net losers',
        };
      }
    }
  }

  // 5. NORMAL 60:40 TARGET ENFORCEMENT
  // Maximum payout allowed to players is 40% of the wagered pool (Company retains >= 60%)
  const max_target_payout =
    (total_human_stake * BigInt(Math.round(config.target_player_rtp_pct))) / 100n;

  const validOptions = input.options.filter(
    (o) => (optionPayoutMap.get(o.id) ?? 0n) <= max_target_payout,
  );

  if (validOptions.length > 0) {
    return {
      mode: 'TARGET_60_40_ENFORCED',
      allowed_option_ids: validOptions.map((o) => o.id),
      max_allowed_human_payout: max_target_payout,
      reason: `Company retains >= ${config.target_house_profit_pct}%, max payout ${max_target_payout}`,
    };
  }

  // Fallback: pick the option with the absolute lowest human payout
  let lowestPayout = optionPayoutMap.get(input.options[0]?.id ?? '') ?? 0n;
  for (const opt of input.options) {
    const p = optionPayoutMap.get(opt.id) ?? 0n;
    if (p < lowestPayout) lowestPayout = p;
  }
  const lowestOptions = input.options.filter(
    (o) => (optionPayoutMap.get(o.id) ?? 0n) === lowestPayout,
  );

  return {
    mode: 'TARGET_60_40_ENFORCED',
    allowed_option_ids: lowestOptions.map((o) => o.id),
    max_allowed_human_payout: lowestPayout,
    reason: 'Forced lowest human payout to preserve 60% house target',
  };
};

/**
 * Orchestrates the full round winner selection with House Profit Engine steering.
 */
export const selectRoundWinnerWithProfitSteering = async (input: {
  game_code?: string;
  options: BiasedOption[];
  bets: BiasedBetStake[];
  policy?: any;
}): Promise<PickBiasedWinnerResult> => {
  const game_code = input.game_code ?? 'greedy';

  // 1. Evaluate profit steering constraints
  const steering = await evaluateHouseProfitSteering({
    game_code,
    options: input.options,
    bets: input.bets,
  });

  logger.info('Profit steering evaluation complete', {
    game_code,
    mode: steering.mode,
    reason: steering.reason,
    allowedCount: steering.allowed_option_ids.length,
  });

  // 2. Filter options by steering decision
  const allowedSet = new Set(steering.allowed_option_ids);
  const eligibleOptions = input.options.filter((o) => allowedSet.has(o.id));
  const optionsToUse = eligibleOptions.length ? eligibleOptions : input.options;

  // 3. Delegate to weighted RNG among eligible options
  return pickBiasedWinner({
    options: optionsToUse,
    bets: input.bets,
    target_human_win_rate: 0.015,
    min_human_bets_before_bias: 1,
    max_human_payout_per_round: steering.max_allowed_human_payout,
  });
};

