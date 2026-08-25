import { describe, expect, it } from 'vitest';
import {
  allocateGreedyClassicWinningBetPayouts,
  buildGreedyClassicBetPlacedPayload,
  buildGreedyClassicTopWinners,
  calculatePayout,
  compareGreedyClassicWinnerRankings,
} from '@/modules/greedy-classic/greedy-classic.utils';

describe('Greedy Classic payout math', () => {
  it('calculates stake-inclusive integer payout for Falcon…Diamond multipliers', () => {
    expect(calculatePayout(100n, 4n, 1n)).toBe(400n);
    expect(calculatePayout(100n, 5n, 1n)).toBe(500n);
    expect(calculatePayout(100n, 6n, 1n)).toBe(600n);
    expect(calculatePayout(100n, 7n, 1n)).toBe(700n);
    expect(calculatePayout(100n, 8n, 1n)).toBe(800n);
    expect(calculatePayout(100n, 10n, 1n)).toBe(1000n);
    expect(calculatePayout(100n, 15n, 1n)).toBe(1500n);
    expect(calculatePayout(100n, 20n, 1n)).toBe(2000n);
  });

  it('uses floor semantics for fractional atomic-unit payout', () => {
    expect(calculatePayout(5n, 3n, 2n)).toBe(7n);
  });
});

describe('Greedy Classic leaderboard and bet-placed parity', () => {
  it('builds the public bet animation event without private wallet/request data', () => {
    const payload = buildGreedyClassicBetPlacedPayload(
      {
        id: 'bet-1',
        round_id: 'round-1',
        option_id: 'option-1',
        amount: 1000n,
        accepted_at: new Date(1_000),
        total_amount: 3000n,
        bet_count: 2,
        first_bet_at: new Date(500),
        last_bet_at: new Date(1_000),
      },
      {
        user_id: 'nasim',
        display_name: null,
        avatar_url: null,
      },
    );

    expect(payload).toEqual({
      bet_id: 'bet-1',
      round_id: 'round-1',
      option_id: 'option-1',
      amount: '1000',
      accepted_at: new Date(1_000).toISOString(),
      total_amount: '3000',
      bet_count: 2,
      first_bet_at: new Date(500).toISOString(),
      last_bet_at: new Date(1_000).toISOString(),
      bettor: {
        user_id: 'nasim',
        display_name: null,
        avatar_url: null,
      },
    });
    expect(payload).not.toHaveProperty('wallet_balance');
    expect(payload).not.toHaveProperty('client_request_id');
  });

  it('aggregates a user winning stake before applying a fractional multiplier', () => {
    const winners = buildGreedyClassicTopWinners(
      [
        { user_id: 'nasim', amount: 1n, accepted_at: new Date(2_000) },
        { user_id: 'nasim', amount: 1n, accepted_at: new Date(1_000) },
        { user_id: 'other', amount: 1n, accepted_at: new Date(500) },
      ],
      3n,
      2n,
    );

    expect(winners.map((winner) => winner.user_id)).toEqual(['nasim', 'other']);
    expect(winners[0]).toMatchObject({
      rank: 1,
      user_id: 'nasim',
      winning_stake: '2',
      bet_count: 2,
      total_payout: '3',
      first_bet_at: new Date(1_000).toISOString(),
    });
  });

  it('limits the podium to real winners and applies both deterministic tie-breaks', () => {
    const winners = buildGreedyClassicTopWinners(
      [
        { user_id: 'later', amount: 100n, accepted_at: new Date(3_000) },
        { user_id: 'z-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'a-user', amount: 100n, accepted_at: new Date(1_000) },
        { user_id: 'largest', amount: 200n, accepted_at: new Date(4_000) },
      ],
      5n,
      1n,
    );

    expect(winners.map((winner) => winner.user_id)).toEqual([
      'largest',
      'a-user',
      'z-user',
    ]);
    expect(winners.map((winner) => winner.rank)).toEqual([1, 2, 3]);
  });

  it('exports the gross-payout comparator used by the leaderboard', () => {
    const common = {
      winning_stake: 10n,
      bet_count: 1,
      first_bet_at: new Date(1_000),
      total_payout: 50n,
    };
    expect(
      compareGreedyClassicWinnerRankings(
        { ...common, user_id: 'a', total_payout: 100n },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
    expect(
      compareGreedyClassicWinnerRankings(
        { ...common, user_id: 'a' },
        { ...common, user_id: 'b' },
      ),
    ).toBe(-1);
  });

  it('allocates fractional rounding while settlement rows still sum to wallet credit', () => {
    const allocation = allocateGreedyClassicWinningBetPayouts(
      [
        { id: 'later', amount: 1n, accepted_at: new Date(2_000) },
        { id: 'earlier', amount: 1n, accepted_at: new Date(1_000) },
      ],
      3n,
      2n,
    );

    expect(allocation.total_winning_stake).toBe(2n);
    expect(allocation.total_payout).toBe(3n);
    expect(allocation.payout_by_bet.get('earlier')).toBe(2n);
    expect(allocation.payout_by_bet.get('later')).toBe(1n);
    expect(
      [...allocation.payout_by_bet.values()].reduce(
        (total, payout) => total + payout,
        0n,
      ),
    ).toBe(allocation.total_payout);
  });
});
