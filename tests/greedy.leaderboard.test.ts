import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGreedyTopWinnersByRound } from '@/modules/greedy/greedy.leaderboard';

const mocks = vi.hoisted(() => ({
  groupBy: vi.fn(),
  getActiveBotIds: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    greedyBet: {
      groupBy: mocks.groupBy,
    },
  },
}));

vi.mock('@/modules/game-bot/bot-identity', () => ({
  getActiveBotIds: mocks.getActiveBotIds,
  resolveGameIdentitySync: (user_id: string) => ({
    display_name: `Player ${user_id}`,
    avatar_url: null,
  }),
}));

describe('getGreedyTopWinnersByRound', () => {
  beforeEach(() => {
    mocks.groupBy.mockReset();
    mocks.getActiveBotIds.mockReset();
  });

  it('excludes bot users from the podium even when they have the largest winning stake', async () => {
    mocks.getActiveBotIds.mockResolvedValue(['bot-heavy']);
    mocks.groupBy.mockResolvedValue([
      {
        round_id: 'round-1',
        user_id: 'bot-heavy',
        _sum: { amount: 50_000n },
        _count: { _all: 5 },
        _min: { accepted_at: new Date(1_000) },
      },
      {
        round_id: 'round-1',
        user_id: 'human-winner',
        _sum: { amount: 1_000n },
        _count: { _all: 1 },
        _min: { accepted_at: new Date(2_000) },
      },
    ]);

    const winners_by_round = await getGreedyTopWinnersByRound([
      {
        round_id: 'round-1',
        winning_option_id: 'opt-ham',
        payout_numerator: 25n,
        payout_denominator: 1n,
      },
    ]);

    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_id: { notIn: ['bot-heavy'] },
        }),
      }),
    );

    const podium = winners_by_round.get('round-1') ?? [];
    expect(podium).toHaveLength(1);
    expect(podium[0]).toMatchObject({
      rank: 1,
      user_id: 'human-winner',
      winning_stake: '1000',
      total_payout: '25000',
    });
  });
});
