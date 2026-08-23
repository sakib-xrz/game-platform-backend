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

describe('biased-outcome', () => {
  it('favors bot outcomes over many simulated rounds', () => {
    let human_wins = 0;
    const rounds = 500;
    for (let index = 0; index < rounds; index += 1) {
      const result = pickBiasedWinner({
        options,
        bets: [
          { user_id: 'human-1', option_id: 'opt-a', amount: 100n, is_bot: false },
          { user_id: 'bot-1', option_id: 'opt-b', amount: 100n, is_bot: true },
        ],
        target_human_win_rate: 0.15,
        min_human_bets_before_bias: 1,
      });
      if (
        didHumansNetWinRound(result.option_id, [
          { user_id: 'human-1', option_id: 'opt-a', amount: 100n, is_bot: false },
          { user_id: 'bot-1', option_id: 'opt-b', amount: 100n, is_bot: true },
        ], options)
      ) {
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
});
