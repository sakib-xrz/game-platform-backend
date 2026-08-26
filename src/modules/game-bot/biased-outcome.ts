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
};

export type PickBiasedWinnerResult = {
  option_id: string;
  algorithm_suffix: 'biased-v3' | 'natural-v1';
  entropy_digest: string;
};

const calculatePayout = (
  amount: bigint,
  payout_numerator: bigint,
  payout_denominator: bigint,
): bigint => (amount * payout_numerator) / payout_denominator;

const humanStakeOnOption = (option_id: string, bets: BiasedBetStake[]): bigint => {
  let total = 0n;
  for (const bet of bets) {
    if (!bet.is_bot && bet.option_id === option_id) total += bet.amount;
  }
  return total;
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

const clampRate = (rate: number): number => {
  if (!Number.isFinite(rate)) return 0.15;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
};

const pickWeighted = (
  items: Array<{ option: BiasedOption; weight: bigint }>,
  algorithm_suffix: PickBiasedWinnerResult['algorithm_suffix'],
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
    entropy_digest: random.entropy_digest,
  };
};

/**
 * Random-looking winners with house/bot bias:
 * - ~target_human_win_rate: draw among options humans actually bet (config weights)
 * - otherwise: draw among options with ZERO human stake using natural probability_weight
 *   (so high-payout picks like ham cannot dominate when humans sat on them)
 */
export const pickBiasedWinner = (input: PickBiasedWinnerInput): PickBiasedWinnerResult => {
  const human_bet_count = input.bets.filter((bet) => !bet.is_bot).length;
  const use_bias =
    human_bet_count >= input.min_human_bets_before_bias &&
    input.bets.some((bet) => bet.is_bot);

  if (!use_bias || !input.options.length) {
    return pickNaturalWinner(input.options);
  }

  const human_options = input.options.filter(
    (option) => humanStakeOnOption(option.id, input.bets) > 0n,
  );
  // Hard rule: house path never lands on something a human already bet.
  const house_options = input.options.filter(
    (option) => humanStakeOnOption(option.id, input.bets) === 0n,
  );

  const rate = clampRate(input.target_human_win_rate);
  const roll = Number(secureRandomBigIntBelow(10_000n).value) / 10_000;
  const pick_from_human = roll < rate && human_options.length > 0;

  const pool = pick_from_human
    ? human_options
    : house_options.length
      ? house_options
      : // Humans covered every option — fall back to ones that do not net-pay humans.
        input.options.filter((option) => humanNetWin(option.id, input.bets, option) <= 0n);

  const safe_pool = pool.length ? pool : input.options;
  const weighted = safe_pool.map((option) => ({
    option,
    weight: option.probability_weight > 0n ? option.probability_weight : 1n,
  }));

  return pickWeighted(weighted, 'biased-v3');
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
