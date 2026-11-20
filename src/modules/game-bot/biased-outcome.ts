import { secureRandomBigIntBelow } from '@/utils/crypto-rng';

export type BiasedBetStake = {
  user_id: string;
  option_id: string;
  amount: bigint;
  is_bot: boolean;
};

export type BiasedOption = {
  id: string;
  probability_weight: bigint;
  payout_numerator: bigint;
  payout_denominator: bigint;
};

export type PickBiasedWinnerInput = {
  options: BiasedOption[];
  bets: BiasedBetStake[];
  target_human_win_rate: number;
  min_human_bets_before_bias: number;
  max_human_payout_per_round?: bigint;
  cooling_user_ids?: Iterable<string>;
  jackpot_blocked_user_ids?: Iterable<string>;
  jackpot_multiplier_threshold?: number;
  high_jackpot_allow_rate?: number;
  mid_jackpot_allow_rate?: number;
};

export type PickBiasedWinnerResult = {
  option_id: string;
  algorithm_suffix: 'biased-v4' | 'biased-v3' | 'natural-v1';
  entropy_digest: string;
};

const calculatePayout = (
  amount: bigint,
  payout_numerator: bigint,
  payout_denominator: bigint,
): bigint => (amount * payout_numerator) / payout_denominator;

const optionMultiplier = (option: BiasedOption): number => {
  if (option.payout_denominator <= 0n) return 0;
  return Number(option.payout_numerator) / Number(option.payout_denominator);
};

const humanStakeOnOption = (
  option_id: string,
  bets: BiasedBetStake[],
  excluded_users?: Set<string>,
): bigint => {
  let total = 0n;
  for (const bet of bets) {
    if (bet.is_bot) continue;
    if (excluded_users?.has(bet.user_id)) continue;
    if (bet.option_id === option_id) total += bet.amount;
  }
  return total;
};

const allHumanStakeOnOption = (option_id: string, bets: BiasedBetStake[]): bigint => {
  let total = 0n;
  for (const bet of bets) {
    if (bet.is_bot) continue;
    if (bet.option_id === option_id) total += bet.amount;
  }
  return total;
};

const humanPayoutIfWins = (
  option: BiasedOption,
  bets: BiasedBetStake[],
): bigint => {
  const stake = allHumanStakeOnOption(option.id, bets);
  if (stake <= 0n) return 0n;
  return calculatePayout(stake, option.payout_numerator, option.payout_denominator);
};

const humanNetWin = (
  option_id: string,
  bets: BiasedBetStake[],
  option: BiasedOption,
): bigint => {
  let human_stake_on_option = 0n;
  let human_stake_total = 0n;
  for (const bet of bets) {
    if (bet.is_bot) continue;
    human_stake_total += bet.amount;
    if (bet.option_id === option_id) human_stake_on_option += bet.amount;
  }
  if (human_stake_on_option === 0n) return 0n;
  const payout = calculatePayout(
    human_stake_on_option,
    option.payout_numerator,
    option.payout_denominator,
  );
  return payout - human_stake_total;
};

const clampRate = (rate: number, fallback = 0.40): number => {
  if (!Number.isFinite(rate)) return fallback;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
};

const toIdSet = (ids?: Iterable<string>): Set<string> => {
  if (!ids) return new Set();
  return ids instanceof Set ? ids : new Set(ids);
};

const rollUnitInterval = (): { value: number; entropy_digest: string } => {
  const random = secureRandomBigIntBelow(10_000n);
  return {
    value: Number(random.value) / 10_000,
    entropy_digest: random.entropy_digest,
  };
};

const pickWeighted = (
  items: Array<{ option: BiasedOption; weight: bigint }>,
  algorithm_suffix: PickBiasedWinnerResult['algorithm_suffix'],
  extra_entropy: string[] = [],
): PickBiasedWinnerResult => {
  const fallback = items.at(-1)?.option;
  if (!fallback) throw new Error('No winner options configured');

  const total_weight = items.reduce((sum, item) => sum + (item.weight > 0n ? item.weight : 0n), 0n);
  if (total_weight <= 0n) {
    const natural = pickNaturalWinner(items.map((item) => item.option));
    return { ...natural, algorithm_suffix };
  }

  const random = secureRandomBigIntBelow(total_weight);
  let cursor = 0n;
  let winner = fallback;
  for (const item of items) {
    if (item.weight <= 0n) continue;
    cursor += item.weight;
    if (random.value < cursor) {
      winner = item.option;
      break;
    }
  }

  return {
    option_id: winner.id,
    algorithm_suffix,
    entropy_digest: [random.entropy_digest, ...extra_entropy].join('|'),
  };
};

const withWeights = (options: BiasedOption[]) =>
  options.map((option) => ({
    option,
    weight: option.probability_weight > 0n ? option.probability_weight : 1n,
  }));

/** Drop options that would pay real users more than the round cap. */
const filterByPayoutCap = (
  options: BiasedOption[],
  bets: BiasedBetStake[],
  max_payout: bigint | undefined,
): BiasedOption[] => {
  if (max_payout === undefined || max_payout <= 0n) return options;
  return options.filter((option) => humanPayoutIfWins(option, bets) <= max_payout);
};

const lowestHumanPayoutOptions = (
  options: BiasedOption[],
  bets: BiasedBetStake[],
): BiasedOption[] => {
  if (!options.length) return options;
  let best = humanPayoutIfWins(options[0]!, bets);
  for (const option of options) {
    const payout = humanPayoutIfWins(option, bets);
    if (payout < best) best = payout;
  }
  return options.filter((option) => humanPayoutIfWins(option, bets) === best);
};

/**
 * Jackpot gate for the rare human-allowance path:
 * - multipliers under threshold: always eligible
 * - mid jackpots (>=25x, <45x): only with mid_jackpot_allow_rate
 * - high jackpots (>=45x): only with high_jackpot_allow_rate
 */
const filterHumanPathJackpots = (
  options: BiasedOption[],
  threshold: number,
  high_rate: number,
  mid_rate: number,
): { options: BiasedOption[]; entropy: string[] } => {
  const entropy: string[] = [];
  const safe: BiasedOption[] = [];
  const mid: BiasedOption[] = [];
  const high: BiasedOption[] = [];

  for (const option of options) {
    const mult = optionMultiplier(option);
    if (mult >= 45) high.push(option);
    else if (mult >= threshold) mid.push(option);
    else safe.push(option);
  }

  if (safe.length) return { options: safe, entropy };

  if (mid.length) {
    const roll = rollUnitInterval();
    entropy.push(roll.entropy_digest);
    if (roll.value < clampRate(mid_rate, 0.004)) return { options: mid, entropy };
  }

  if (high.length) {
    const roll = rollUnitInterval();
    entropy.push(roll.entropy_digest);
    if (roll.value < clampRate(high_rate, 0.00303)) return { options: high, entropy };
  }

  return { options: [], entropy };
};

/**
 * Revenue-first biased winners (v4):
 * - ~1.5% human-allowance path (configurable), preferring low multipliers
 * - jackpots (25x/45x) need a second ultra-rare roll
 * - cooling users' picks are blocked whenever another option exists
 * - round human payout cap rejects oversized winners
 */
export const pickBiasedWinner = (input: PickBiasedWinnerInput): PickBiasedWinnerResult => {
  const human_bet_count = input.bets.filter((bet) => !bet.is_bot).length;
  const use_bias =
    human_bet_count >= input.min_human_bets_before_bias &&
    input.bets.some((bet) => bet.is_bot);

  if (!use_bias || !input.options.length) {
    return pickNaturalWinner(input.options);
  }

  const cooling = toIdSet(input.cooling_user_ids);
  const jackpot_blocked = toIdSet(input.jackpot_blocked_user_ids);
  const jackpot_threshold = input.jackpot_multiplier_threshold ?? 25;
  const high_rate = input.high_jackpot_allow_rate ?? 0.00303;
  const mid_rate = input.mid_jackpot_allow_rate ?? 0.004;
  const max_payout = input.max_human_payout_per_round;

  const isForbidden = (option: BiasedOption): boolean => {
    for (const bet of input.bets) {
      if (bet.is_bot || bet.option_id !== option.id) continue;
      if (cooling.has(bet.user_id)) return true;
      if (
        jackpot_blocked.has(bet.user_id) &&
        optionMultiplier(option) >= jackpot_threshold
      ) {
        return true;
      }
    }
    return false;
  };

  // Active humans = not in cooling. Their stakes define the human-win pool.
  const human_options = input.options.filter(
    (option) => humanStakeOnOption(option.id, input.bets, cooling) > 0n && !isForbidden(option),
  );
  const house_options = input.options.filter(
    (option) => humanStakeOnOption(option.id, input.bets, cooling) === 0n && !isForbidden(option),
  );
  const non_forbidden = input.options.filter((option) => !isForbidden(option));
  const fallback_pool = non_forbidden.length ? non_forbidden : input.options;

  const rate = clampRate(input.target_human_win_rate, 0.40);
  const allowance_roll = rollUnitInterval();
  const pick_from_human = allowance_roll.value < rate && human_options.length > 0;

  let pool: BiasedOption[];
  const entropy: string[] = [allowance_roll.entropy_digest];

  if (pick_from_human) {
    const gated = filterHumanPathJackpots(
      human_options,
      jackpot_threshold,
      high_rate,
      mid_rate,
    );
    entropy.push(...gated.entropy);
    if (gated.options.length) {
      pool = gated.options;
    } else {
      // Human allowance rolled but jackpot gate refused — fall to house path.
      pool = house_options.length
        ? house_options
        : fallback_pool.filter((option) => humanNetWin(option.id, input.bets, option) <= 0n);
    }
  } else {
    pool = house_options.length
      ? house_options
      : fallback_pool.filter((option) => humanNetWin(option.id, input.bets, option) <= 0n);
  }

  const capped_primary = filterByPayoutCap(
    pool.length ? pool : fallback_pool,
    input.bets,
    max_payout,
  );
  const capped_fallback = filterByPayoutCap(fallback_pool, input.bets, max_payout);
  const safe_pool = capped_primary.length
    ? capped_primary
    : capped_fallback.length
      ? capped_fallback
      : lowestHumanPayoutOptions(fallback_pool, input.bets);

  return pickWeighted(withWeights(safe_pool.length ? safe_pool : fallback_pool), 'biased-v4', entropy);
};

export const pickNaturalWinner = (options: BiasedOption[]): PickBiasedWinnerResult => {
  const fallback = options.at(-1);
  if (!fallback) throw new Error('No winner options configured');
  const total_weight = options.reduce((sum, item) => sum + item.probability_weight, 0n);
  if (total_weight <= 0n) throw new Error('No positive probability weight configured');
  const random = secureRandomBigIntBelow(total_weight);
  let cursor = 0n;
  let winner = fallback;
  for (const option of options) {
    cursor += option.probability_weight;
    if (random.value < cursor) {
      winner = option;
      break;
    }
  }
  return {
    option_id: winner.id,
    algorithm_suffix: 'natural-v1',
    entropy_digest: random.entropy_digest,
  };
};

export const didHumansNetWinRound = (
  winning_option_id: string,
  bets: BiasedBetStake[],
  options: BiasedOption[],
): boolean => {
  const option = options.find((item) => item.id === winning_option_id);
  if (!option) return false;
  return humanNetWin(winning_option_id, bets, option) > 0n;
};
