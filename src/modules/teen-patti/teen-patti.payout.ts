export type PotSplit = {
  pot: bigint;
  rake: bigint;
  distributable: bigint;
  leftover: bigint;
  payouts: bigint[];
};

export type TeenPattiSettlementBetInput = {
  id: string;
  amount: bigint;
  is_winning: boolean;
};

export type TeenPattiUserPayoutAllocation = {
  total_winning_stake: bigint;
  total_payout: bigint;
  payout_by_bet: Map<string, bigint>;
};

/** Stake-inclusive fixed double: bet 100 → payout 200. */
export const calculateHumanFixedDoublePayout = (amount: bigint): bigint => {
  if (amount < 0n) throw new Error('Bet amount cannot be negative');
  return amount * 2n;
};

/**
 * Human winners receive exactly 2× their own stake, independent of other
 * players' (including bots') bets and independent of rake.
 */
export const allocateTeenPattiFixedDoublePayouts = (
  bets: TeenPattiSettlementBetInput[],
): TeenPattiUserPayoutAllocation => {
  const payout_by_bet = new Map<string, bigint>();
  let total_winning_stake = 0n;
  let total_payout = 0n;

  for (const bet of bets) {
    if (bet.amount < 0n) throw new Error('Bet amount cannot be negative');
    if (payout_by_bet.has(bet.id)) throw new Error(`Duplicate bet id: ${bet.id}`);

    if (bet.is_winning) {
      const payout = calculateHumanFixedDoublePayout(bet.amount);
      payout_by_bet.set(bet.id, payout);
      total_winning_stake += bet.amount;
      total_payout += payout;
    } else {
      payout_by_bet.set(bet.id, 0n);
    }
  }

  return {
    total_winning_stake,
    total_payout,
    payout_by_bet,
  };
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

/**
 * Calculates a user's payout once from their aggregate winning stake, then
 * allocates that exact amount across their winning settlement rows. Fractional
 * units use largest-remainder order with the bet id as a stable tie-break.
 * Losing bets are always present in the result with a zero payout.
 */
export const allocateTeenPattiUserPayouts = (
  bets: TeenPattiSettlementBetInput[],
  distributable: bigint,
  total_winning_stake: bigint,
): TeenPattiUserPayoutAllocation => {
  if (distributable < 0n) throw new Error('Distributable pot cannot be negative');
  if (total_winning_stake < 0n) throw new Error('Total winning stake cannot be negative');

  const payout_by_bet = new Map<string, bigint>();
  const winning_bets: TeenPattiSettlementBetInput[] = [];
  let user_winning_stake = 0n;

  for (const bet of bets) {
    if (bet.amount < 0n) throw new Error('Bet amount cannot be negative');
    if (payout_by_bet.has(bet.id)) throw new Error(`Duplicate bet id: ${bet.id}`);

    payout_by_bet.set(bet.id, 0n);
    if (bet.is_winning) {
      winning_bets.push(bet);
      user_winning_stake += bet.amount;
    }
  }

  if (user_winning_stake === 0n) {
    return {
      total_winning_stake: user_winning_stake,
      total_payout: 0n,
      payout_by_bet,
    };
  }
  if (total_winning_stake === 0n) {
    throw new Error('Total winning stake must be positive when the user has a winning stake');
  }
  if (user_winning_stake > total_winning_stake) {
    throw new Error('User winning stake cannot exceed total winning stake');
  }
  if (distributable === 0n) {
    return {
      total_winning_stake: user_winning_stake,
      total_payout: 0n,
      payout_by_bet,
    };
  }

  const total_payout =
    (distributable * user_winning_stake) / total_winning_stake;
  const ranked_winning_bets = winning_bets.map((bet) => {
    const numerator = distributable * bet.amount;
    const payout = numerator / total_winning_stake;
    payout_by_bet.set(bet.id, payout);
    return {
      id: bet.id,
      remainder: numerator % total_winning_stake,
    };
  });
  const allocated_payout = [...payout_by_bet.values()].reduce(
    (total, payout) => total + payout,
    0n,
  );
  let rounding_units = total_payout - allocated_payout;

  if (rounding_units < 0n) {
    throw new Error('Aggregate Teen Patti payout is below allocated settlements');
  }

  ranked_winning_bets.sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  for (const bet of ranked_winning_bets) {
    if (rounding_units === 0n) break;
    payout_by_bet.set(bet.id, (payout_by_bet.get(bet.id) ?? 0n) + 1n);
    rounding_units -= 1n;
  }
  if (rounding_units !== 0n) {
    throw new Error('Teen Patti payout rounding units could not be allocated');
  }

  return {
    total_winning_stake: user_winning_stake,
    total_payout,
    payout_by_bet,
  };
};
