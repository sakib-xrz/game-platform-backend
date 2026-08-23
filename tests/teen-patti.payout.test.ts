import { describe, expect, it } from 'vitest';
import { allocateTeenPattiUserPayouts } from '@/modules/teen-patti/teen-patti.payout';

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
