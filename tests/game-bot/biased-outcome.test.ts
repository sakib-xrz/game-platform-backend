import { describe, expect, it } from 'vitest';
import { didHumansNetWinRound, pickBiasedWinner } from '@/modules/game-bot/biased-outcome';

const options = [
  {
    id: 'opt-a',
    probability_weight: 50n,
    payout_numerator: 2n,
    payout_denominator: 1n,
  },
  {
    id: 'opt-b',
    probability_weight: 50n,
    payout_numerator: 2n,
    payout_denominator: 1n,
  },
];

const greedy_like_options = [
  { id: 'hot-dog', probability_weight: 45n, payout_numerator: 10n, payout_denominator: 1n },
  { id: 'kebab', probability_weight: 30n, payout_numerator: 15n, payout_denominator: 1n },
  { id: 'ham', probability_weight: 18n, payout_numerator: 25n, payout_denominator: 1n },
  { id: 'steak', probability_weight: 10n, payout_numerator: 45n, payout_denominator: 1n },
  { id: 'carrot', probability_weight: 90n, payout_numerator: 5n, payout_denominator: 1n },
  { id: 'corn', probability_weight: 90n, payout_numerator: 5n, payout_denominator: 1n },
  { id: 'cabbage', probability_weight: 90n, payout_numerator: 5n, payout_denominator: 1n },
  { id: 'tomato', probability_weight: 90n, payout_numerator: 5n, payout_denominator: 1n },
];

const steakOnlyBets = () => [
  { user_id: 'human-1', option_id: 'steak', amount: 50_000n, is_bot: false },
  { user_id: 'bot-1', option_id: 'carrot', amount: 50n, is_bot: true },
  { user_id: 'bot-2', option_id: 'corn', amount: 50n, is_bot: true },
  { user_id: 'bot-3', option_id: 'cabbage', amount: 50n, is_bot: true },
  { user_id: 'bot-4', option_id: 'tomato', amount: 50n, is_bot: true },
  { user_id: 'bot-5', option_id: 'hot-dog', amount: 50n, is_bot: true },
  { user_id: 'bot-6', option_id: 'kebab', amount: 50n, is_bot: true },
  { user_id: 'bot-7', option_id: 'ham', amount: 50n, is_bot: true },
];

describe('biased-outcome revenue controls', () => {
  it('keeps human win rate near 1.5% over many rounds', () => {
    let human_wins = 0;
    const rounds = 2000;
    for (let index = 0; index < rounds; index += 1) {
      const bets = [
        { user_id: 'human-1', option_id: 'opt-a', amount: 100n, is_bot: false },
        { user_id: 'bot-1', option_id: 'opt-b', amount: 100n, is_bot: true },
      ];
      const result = pickBiasedWinner({
        options,
        bets,
        target_human_win_rate: 0.015,
        min_human_bets_before_bias: 1,
      });
      if (didHumansNetWinRound(result.option_id, bets, options)) {
        human_wins += 1;
      }
    }
    const human_rate = human_wins / rounds;
    expect(human_rate).toBeGreaterThanOrEqual(0);
    expect(human_rate).toBeLessThan(0.05);
  });

  it('uses natural odds when no human bets exist', () => {
    const result = pickBiasedWinner({
      options,
      bets: [{ user_id: 'bot-1', option_id: 'opt-a', amount: 50n, is_bot: true }],
      target_human_win_rate: 0.015,
      min_human_bets_before_bias: 1,
    });
    expect(result.algorithm_suffix).toBe('natural-v1');
  });

  it('almost never pays steak when humans only bet steak', () => {
    let steak_wins = 0;
    const rounds = 2000;
    for (let index = 0; index < rounds; index += 1) {
      const bets = steakOnlyBets();
      const result = pickBiasedWinner({
        options: greedy_like_options,
        bets,
        target_human_win_rate: 0.015,
        min_human_bets_before_bias: 1,
        max_human_payout_per_round: 300_000n,
        high_jackpot_allow_rate: 0.00303,
        mid_jackpot_allow_rate: 0.004,
        jackpot_multiplier_threshold: 25,
      });
      if (result.option_id === 'steak') steak_wins += 1;
    }
    // ~1/330 of human-path (~1.5%) => well under 1% overall; allow statistical slack.
    expect(steak_wins / rounds).toBeLessThan(0.01);
  });

  it('blocks cooling users from winning their options', () => {
    let human_option_wins = 0;
    const rounds = 300;
    for (let index = 0; index < rounds; index += 1) {
      const bets = [
        { user_id: 'human-1', option_id: 'opt-a', amount: 100n, is_bot: false },
        { user_id: 'bot-1', option_id: 'opt-b', amount: 100n, is_bot: true },
      ];
      const result = pickBiasedWinner({
        options,
        bets,
        target_human_win_rate: 0.9,
        min_human_bets_before_bias: 1,
        cooling_user_ids: ['human-1'],
      });
      if (result.option_id === 'opt-a') human_option_wins += 1;
    }
    expect(human_option_wins).toBe(0);
  });

  it('enforces max human payout per round', () => {
    let over_cap = 0;
    const rounds = 400;
    for (let index = 0; index < rounds; index += 1) {
      const bets = steakOnlyBets();
      const result = pickBiasedWinner({
        options: greedy_like_options,
        bets,
        target_human_win_rate: 0.5,
        min_human_bets_before_bias: 1,
        max_human_payout_per_round: 300_000n,
        high_jackpot_allow_rate: 1,
        mid_jackpot_allow_rate: 1,
        jackpot_multiplier_threshold: 25,
      });
      if (result.option_id === 'steak') over_cap += 1;
    }
    // 50k * 45 = 2.25M > 300k cap, so steak must be rejected.
    expect(over_cap).toBe(0);
  });
});
