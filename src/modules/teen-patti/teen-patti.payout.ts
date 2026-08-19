export type PotSplit = {
  pot: bigint;
  rake: bigint;
  distributable: bigint;
  leftover: bigint;
  payouts: bigint[];
};

export const splitPot = (
  pot: bigint,
  rake_bps: number,
  winning_stakes: bigint[],
): PotSplit => {
  if (pot < 0n) throw new Error('Pot cannot be negative');
  if (rake_bps < 0 || rake_bps > 2000) throw new Error('rake_bps must be between 0 and 2000');

  const rake = (pot * BigInt(rake_bps)) / 10000n;
  const distributable = pot - rake;
  const total_winning_stake = winning_stakes.reduce((sum, stake) => sum + stake, 0n);

  if (total_winning_stake <= 0n || distributable <= 0n) {
    return {
      pot,
      rake,
      distributable,
      leftover: distributable,
      payouts: winning_stakes.map(() => 0n),
    };
  }

  const payouts = winning_stakes.map((stake) => (distributable * stake) / total_winning_stake);
  const leftover = distributable - payouts.reduce((sum, payout) => sum + payout, 0n);
  return { pot, rake, distributable, leftover, payouts };
};
