import { describe, expect, it } from 'vitest';
import { evaluateHand, uniqueHighestIndex, type CardCode } from '@/modules/teen-patti/teen-patti.rank';
import { splitPot } from '@/modules/teen-patti/teen-patti.payout';

const hand = (a: CardCode, b: CardCode, c: CardCode) => evaluateHand([a, b, c]);

describe('teen-patti.rank', () => {
  it('ranks trail above pure sequence', () => {
    const trail = hand('AS', 'AH', 'AD');
    const pure = hand('AS', '2S', '3S');
    expect(trail.category).toBe('trail');
    expect(pure.category).toBe('pure_sequence');
    expect(trail.rank_key > pure.rank_key).toBe(true);
  });

  it('treats A-2-3 as the highest sequence, above A-K-Q', () => {
    const wheel = hand('AS', '2H', '3D');
    const broadway = hand('AS', 'KH', 'QD');
    expect(wheel.category).toBe('sequence');
    expect(broadway.category).toBe('sequence');
    expect(wheel.rank_key > broadway.rank_key).toBe(true);
  });

  it('ranks flush above pair', () => {
    const flush = hand('AS', '9S', '4S');
    const pair = hand('AH', 'AD', 'KS');
    expect(flush.category).toBe('color');
    expect(pair.category).toBe('pair');
    expect(flush.rank_key > pair.rank_key).toBe(true);
  });

  it('returns null when two hands tie for highest', () => {
    const a = hand('AS', 'KH', '9D');
    const b = hand('AH', 'KD', '9C');
    const c = hand('2S', '3H', '7D');
    expect(a.rank_key).toBe(b.rank_key);
    expect(uniqueHighestIndex([a, b, c])).toBeNull();
  });

  it('picks a unique highest hand', () => {
    const winner = hand('AS', 'AH', 'AD');
    const second = hand('KS', 'KH', 'KD');
    const third = hand('2S', '3H', '7D');
    expect(uniqueHighestIndex([second, winner, third])).toBe(1);
  });
});

describe('teen-patti.payout', () => {
  it('splits the pot minus rake proportionally', () => {
    const split = splitPot(2000n, 500, [500n]);
    expect(split.rake).toBe(100n);
    expect(split.distributable).toBe(1900n);
    expect(split.payouts).toEqual([1900n]);
    expect(split.leftover).toBe(0n);
  });

  it('keeps leftover units with the house', () => {
    const split = splitPot(100n, 0, [30n, 40n]);
    expect(split.payouts[0]! + split.payouts[1]! + split.leftover).toBe(100n);
    expect(split.leftover).toBeGreaterThan(0n);
  });

  it('pays nothing when nobody bet the winner', () => {
    const split = splitPot(2000n, 500, []);
    expect(split.payouts).toEqual([]);
    expect(split.leftover).toBe(1900n);
  });
});
