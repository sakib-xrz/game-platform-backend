import { describe, expect, it } from 'vitest';
import { rankTeenPattiWinnerAggregates } from '@/modules/teen-patti/teen-patti.leaderboard';

describe('teen-patti leaderboard ranking', () => {
  it('ranks winners by gross payout and includes bots', () => {
    const winners = rankTeenPattiWinnerAggregates([
      {
        user_id: 'human-1',
        winning_stake: 500n,
        bet_count: 1,
        first_bet_at: new Date(2_000),
      },
      {
        user_id: 'bot-1',
        winning_stake: 900n,
        bet_count: 2,
        first_bet_at: new Date(1_000),
      },
    ]);

    expect(winners).toEqual([
      expect.objectContaining({
        rank: 1,
        user_id: 'bot-1',
        winning_stake: '900',
        total_payout: '1800',
        bet_count: 2,
      }),
      expect.objectContaining({
        rank: 2,
        user_id: 'human-1',
        winning_stake: '500',
        total_payout: '1000',
        bet_count: 1,
      }),
    ]);
  });
});
