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

describe('biased-outcome', () => {
  it('favors bot outcomes over many simulated rounds', () => {
    let human_wins = 0;
    const rounds = 500;
    for (let index = 0; index < rounds; index += 1) {
      const bets = [
        { user_id: 'human-1', option_id: 'opt-a', amount: 100n, is_bot: false },
        { user_id: 'bot-1', option_id: 'opt-b', amount: 100n, is_bot: true },
      ];
      const result = pickBiasedWinner({
        options,
        bets,
        target_human_win_rate: 0.15,
        min_human_bets_before_bias: 1,
      });
      if (didHumansNetWinRound(result.option_id, bets, options)) {
        human_wins += 1;
      }
    }
    const human_rate = human_wins / rounds;
    expect(human_rate).toBeGreaterThan(0.05);
    expect(human_rate).toBeLessThan(0.35);
  });

  it('uses natural odds when no human bets exist', () => {
    const result = pickBiasedWinner({
      options,
      bets: [{ user_id: 'bot-1', option_id: 'opt-a', amount: 50n, is_bot: true }],
      target_human_win_rate: 0.15,
      min_human_bets_before_bias: 1,
    });
    expect(result.algorithm_suffix).toBe('natural-v1');
  });

  it('almost never picks ham when humans bet only ham', () => {
    const winners = new Map<string, number>();
    const rounds = 500;
    let ham_wins = 0;
    let human_net_wins = 0;

    for (let index = 0; index < rounds; index += 1) {
      const bets = [
        { user_id: 'human-1', option_id: 'ham', amount: 100n, is_bot: false },
        { user_id: 'bot-1', option_id: 'carrot', amount: 50n, is_bot: true },
        { user_id: 'bot-2', option_id: 'corn', amount: 50n, is_bot: true },
        { user_id: 'bot-3', option_id: 'cabbage', amount: 50n, is_bot: true },
        { user_id: 'bot-4', option_id: 'tomato', amount: 50n, is_bot: true },
        { user_id: 'bot-5', option_id: 'hot-dog', amount: 50n, is_bot: true },
        { user_id: 'bot-6', option_id: 'kebab', amount: 50n, is_bot: true },
        { user_id: 'bot-7', option_id: 'steak', amount: 50n, is_bot: true },
      ];
      const result = pickBiasedWinner({
        options: greedy_like_options,
        bets,
        target_human_win_rate: 0.15,
        min_human_bets_before_bias: 1,
      });
      winners.set(result.option_id, (winners.get(result.option_id) ?? 0) + 1);
      if (result.option_id === 'ham') ham_wins += 1;
      if (didHumansNetWinRound(result.option_id, bets, greedy_like_options)) {
        human_net_wins += 1;
      }
    }

    expect(winners.size).toBeGreaterThanOrEqual(4);
    // Ham should only appear on the small human-allowance path.
    expect(ham_wins / rounds).toBeLessThan(0.3);
    expect(human_net_wins / rounds).toBeLessThan(0.35);
  });
});
