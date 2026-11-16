import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  evaluateHouseProfitSteering,
  DEFAULT_HOUSE_PROFIT_CONFIG,
  getTodayDateString,
} from '@/modules/game-bot/profit-steering.service';
import type { BiasedOption, BiasedBetStake } from '@/modules/game-bot/biased-outcome';
import prisma from '@/lib/prisma';

describe('Profit Steering Engine (60:40 Company vs Player)', () => {
  const options: BiasedOption[] = [
    { id: 'opt_apple', probability_weight: 100n, payout_numerator: 2n, payout_denominator: 1n },
    { id: 'opt_banana', probability_weight: 100n, payout_numerator: 5n, payout_denominator: 1n },
    { id: 'opt_jackpot', probability_weight: 10n, payout_numerator: 25n, payout_denominator: 1n },
    { id: 'opt_empty', probability_weight: 100n, payout_numerator: 2n, payout_denominator: 1n },
  ];

  it('enforces 60% company profit / 40% player RTP on standard rounds', async () => {
    // Total human stake = 10,000.
    // 40% max payout = 4,000.
    // Bet on apple = 5,000 (pays 10,000 > 4,000 => rejected).
    // Bet on empty = 0 (pays 0 <= 4,000 => allowed).
    const bets: BiasedBetStake[] = [
      { user_id: 'human_1', option_id: 'opt_apple', amount: 5000n, is_bot: false },
      { user_id: 'human_2', option_id: 'opt_banana', amount: 5000n, is_bot: false },
      { user_id: 'bot_1', option_id: 'opt_empty', amount: 10000n, is_bot: true },
    ];

    const decision = await evaluateHouseProfitSteering({
      game_code: 'greedy',
      options,
      bets,
    });

    expect(decision.mode).toBe('TARGET_60_40_ENFORCED');
    expect(decision.allowed_option_ids).toContain('opt_empty');
    expect(decision.allowed_option_ids).not.toContain('opt_apple');
    expect(decision.allowed_option_ids).not.toContain('opt_banana');
  });

  it('triggers CIRCUIT_BREAKER_EMERGENCY when daily loss limit is hit', async () => {
    const today = getTodayDateString();

    // Mock daily stat with loss exceeding 3M coins
    vi.spyOn(prisma.dailyGameHouseStat, 'findUnique').mockResolvedValueOnce({
      id: 'stat_1',
      game_code: 'greedy',
      stat_date: today,
      total_wagered: 1_000_000n,
      total_paid_out: 4_500_000n,
      house_profit: -3_500_000n, // Loss = 3.5M > 3M cap
      house_kept_pct: -350,
      total_bets: 100,
      total_players: 5,
      created_at: new Date(),
      updated_at: new Date(),
    } as any);

    const bets: BiasedBetStake[] = [
      { user_id: 'human_1', option_id: 'opt_apple', amount: 1000n, is_bot: false },
    ];

    const decision = await evaluateHouseProfitSteering({
      game_code: 'greedy',
      options,
      bets,
    });

    expect(decision.mode).toBe('CIRCUIT_BREAKER_EMERGENCY');
    expect(decision.max_allowed_human_payout).toBe(0n);
    // Only options where human receives 0 payout are allowed
    expect(decision.allowed_option_ids).toContain('opt_empty');
    expect(decision.allowed_option_ids).not.toContain('opt_apple');
  });

  it('blocks users with lifetime net profit from winning (Anti-Profit Exit Engine)', async () => {
    // User has won more than they wagered
    vi.spyOn(prisma.gamePlayerRiskState, 'findMany').mockResolvedValueOnce([
      {
        user_id: 'lucky_human',
        cooling_remaining: 0,
        win_streak: 2,
        jackpot_cooldown_remaining: 0,
        lifetime_wagered: 50_000n,
        lifetime_payout: 100_000n,
        lifetime_net_profit: 50_000n, // Net profit!
        rolling_8d_wagered: 50_000n,
        rolling_8d_payout: 100_000n,
        rolling_8d_net_profit: 50_000n,
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    ]);

    const bets: BiasedBetStake[] = [
      { user_id: 'lucky_human', option_id: 'opt_apple', amount: 5000n, is_bot: false },
      { user_id: 'bot_1', option_id: 'opt_empty', amount: 5000n, is_bot: true },
    ];

    const decision = await evaluateHouseProfitSteering({
      game_code: 'greedy',
      options,
      bets,
    });

    expect(decision.mode).toBe('ANTI_PROFIT_EXIT_BLOCKED');
    // The option chosen by lucky_human must NOT be allowed to win
    expect(decision.allowed_option_ids).not.toContain('opt_apple');
    expect(decision.allowed_option_ids).toContain('opt_empty');
  });

  it('triggers WEEKLY_GUARANTEE_RECOVERY when weekly margin falls below 55%', async () => {
    const today = getTodayDateString();

    // Mock weekly stats with low margin (40% profit instead of target >= 55%)
    vi.spyOn(prisma.dailyGameHouseStat, 'findMany').mockResolvedValueOnce([
      {
        id: 'stat_week',
        game_code: 'greedy',
        stat_date: today,
        total_wagered: 10_000_000n,
        total_paid_out: 6_500_000n,
        house_profit: 3_500_000n, // Kept 35% < 55%
        house_kept_pct: 35.0,
        total_bets: 500,
        total_players: 10,
        created_at: new Date(),
        updated_at: new Date(),
      } as any,
    ]);

    const bets: BiasedBetStake[] = [
      { user_id: 'human_1', option_id: 'opt_apple', amount: 10_000n, is_bot: false },
    ];

    const decision = await evaluateHouseProfitSteering({
      game_code: 'greedy',
      options,
      bets,
    });

    expect(decision.mode).toBe('WEEKLY_GUARANTEE_RECOVERY');
    expect(decision.max_allowed_human_payout).toBe(2000n); // 20% max payout to recover weekly 60%
    expect(decision.allowed_option_ids).not.toContain('opt_apple'); // apple pays 20,000 > 2,000
    expect(decision.allowed_option_ids).toContain('opt_empty');
  });
});

