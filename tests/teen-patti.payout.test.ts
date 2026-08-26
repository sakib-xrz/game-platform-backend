import { describe, expect, it } from 'vitest';
import {
  allocateTeenPattiFixedDoublePayouts,
  allocateTeenPattiUserPayouts,
  calculateHumanFixedDoublePayout,
} from '@/modules/teen-patti/teen-patti.payout';

describe('Teen Patti fixed double human payout', () => {
  it('pays exactly 2× stake regardless of how large other stakes would be in a pool', () => {
    // Regression: previously parimutuel pool included bot stakes, so a human
    // bet of 100 could pay far more or less than 200 depending on bots.
    const allocation = allocateTeenPattiFixedDoublePayouts([
      { id: 'human-win', amount: 100n, is_winning: true },
      { id: 'human-loss', amount: 50n, is_winning: false },
    ]);

    expect(calculateHumanFixedDoublePayout(100n)).toBe(200n);
    expect(allocation.total_winning_stake).toBe(100n);
    expect(allocation.total_payout).toBe(200n);
    expect(allocation.payout_by_bet.get('human-win')).toBe(200n);
    expect(allocation.payout_by_bet.get('human-loss')).toBe(0n);
  });

  it('doubles each winning bet independently when the user has multiple bets', () => {
    const allocation = allocateTeenPattiFixedDoublePayouts([
      { id: 'win-a', amount: 100n, is_winning: true },
      { id: 'win-b', amount: 250n, is_winning: true },
      { id: 'loss', amount: 10_000n, is_winning: false },
    ]);

    expect(allocation.total_winning_stake).toBe(350n);
    expect(allocation.total_payout).toBe(700n);
    expect(allocation.payout_by_bet.get('win-a')).toBe(200n);
    expect(allocation.payout_by_bet.get('win-b')).toBe(500n);
    expect(allocation.payout_by_bet.get('loss')).toBe(0n);
  });

  it('returns zeros when the user did not bet the winner', () => {
    const allocation = allocateTeenPattiFixedDoublePayouts([
      { id: 'loss-a', amount: 100n, is_winning: false },
      { id: 'loss-b', amount: 50_000n, is_winning: false },
    ]);

    expect(allocation.total_winning_stake).toBe(0n);
    expect(allocation.total_payout).toBe(0n);
    expect(allocation.payout_by_bet.get('loss-a')).toBe(0n);
    expect(allocation.payout_by_bet.get('loss-b')).toBe(0n);
  });
});

describe('Teen Patti user payout allocation', () => {
  it('makes repeated winning bets pay exactly like their grouped stake', () => {
    const repeated = allocateTeenPattiUserPayouts(
      [
        { id: 'winning-b', amount: 1n, is_winning: true },
        { id: 'losing', amount: 100n, is_winning: false },
        { id: 'winning-a', amount: 1n, is_winning: true },
      ],
      5n,
      3n,
    );
    const grouped = allocateTeenPattiUserPayouts(
      [{ id: 'grouped', amount: 2n, is_winning: true }],
      5n,
      3n,
    );

    expect(repeated.total_winning_stake).toBe(2n);
    expect(repeated.total_payout).toBe(3n);
    expect(repeated.total_payout).toBe(grouped.total_payout);
    expect(repeated.payout_by_bet.get('winning-a')).toBe(2n);
    expect(repeated.payout_by_bet.get('winning-b')).toBe(1n);
    expect(repeated.payout_by_bet.get('losing')).toBe(0n);
    expect(
      [...repeated.payout_by_bet.values()].reduce(
        (total, payout) => total + payout,
        0n,
      ),
    ).toBe(repeated.total_payout);
  });

  it('allocates rounding units deterministically regardless of input order', () => {
    const first = allocateTeenPattiUserPayouts(
      [
        { id: 'bet-b', amount: 1n, is_winning: true },
        { id: 'bet-a', amount: 1n, is_winning: true },
      ],
      5n,
      3n,
    );
    const reversed = allocateTeenPattiUserPayouts(
      [
        { id: 'bet-a', amount: 1n, is_winning: true },
        { id: 'bet-b', amount: 1n, is_winning: true },
      ],
      5n,
      3n,
    );

    expect([...first.payout_by_bet.entries()]).toEqual([
      ['bet-b', 1n],
      ['bet-a', 2n],
    ]);
    expect(first.payout_by_bet.get('bet-a')).toBe(
      reversed.payout_by_bet.get('bet-a'),
    );
    expect(first.payout_by_bet.get('bet-b')).toBe(
      reversed.payout_by_bet.get('bet-b'),
    );
  });

  it('returns explicit zero allocations when the user did not bet the winner', () => {
    const allocation = allocateTeenPattiUserPayouts(
      [
        { id: 'loss-a', amount: 100n, is_winning: false },
        { id: 'loss-b', amount: 500n, is_winning: false },
      ],
      950n,
      100n,
    );

    expect(allocation.total_winning_stake).toBe(0n);
    expect(allocation.total_payout).toBe(0n);
    expect(allocation.payout_by_bet).toEqual(
      new Map([
        ['loss-a', 0n],
        ['loss-b', 0n],
      ]),
    );
  });
});
