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
  algorithm_suffix: 'biased-v1' | 'natural-v1';
  entropy_digest: string;
};

const calculatePayout = (
  amount: bigint,
  payout_numerator: bigint,
  payout_denominator: bigint,
): bigint => (amount * payout_numerator) / payout_denominator;

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

const botAdvantageScore = (
  option_id: string,
  bets: BiasedBetStake[],
  option: BiasedOption,
): bigint => {
  let bot_win = 0n;
  let human_win = 0n;
  for (const bet of bets) {
    if (bet.option_id !== option_id) continue;
    if (bet.is_bot) {
      bot_win += calculatePayout(bet.amount, option.payout_numerator, option.payout_denominator);
    } else {
      human_win += calculatePayout(bet.amount, option.payout_numerator, option.payout_denominator);
    }
  }
  let human_loss = 0n;
  for (const bet of bets) {
    if (bet.is_bot || bet.option_id === option_id) continue;
    human_loss += bet.amount;
  }
  return bot_win + human_loss - human_win;
};

export const pickBiasedWinner = (input: PickBiasedWinnerInput): PickBiasedWinnerResult => {
  const human_bet_count = input.bets.filter((bet) => !bet.is_bot).length;
  const use_bias =
    human_bet_count >= input.min_human_bets_before_bias &&
    input.bets.some((bet) => bet.is_bot);

  if (!use_bias || !input.options.length) {
    return pickNaturalWinner(input.options);
  }

  const human_win_pool = input.options.filter((option) => humanNetWin(option.id, input.bets, option) > 0n);
  const bot_favor_pool = input.options.filter(
    (option) => botAdvantageScore(option.id, input.bets, option) >= 0n,
  );

  const roll = Math.random();
  const pick_from_human = roll < input.target_human_win_rate && human_win_pool.length > 0;
  const pool = pick_from_human
    ? human_win_pool
    : bot_favor_pool.length
      ? bot_favor_pool
      : input.options;

  const weighted = pool.map((option) => ({
    option,
    weight: pick_from_human
      ? humanNetWin(option.id, input.bets, option)
      : botAdvantageScore(option.id, input.bets, option),
  }));
  const total_weight = weighted.reduce(
    (sum, item) => sum + (item.weight > 0n ? item.weight : 1n),
    0n,
  );
  const random = secureRandomBigIntBelow(total_weight);
  let cursor = 0n;
  const fallback = weighted.at(-1)?.option;
  if (!fallback) throw new Error('No winner options configured');
  let winner = fallback;
  for (const item of weighted) {
    cursor += item.weight > 0n ? item.weight : 1n;
    if (random.value < cursor) {
      winner = item.option;
      break;
    }
  }

  return {
    option_id: winner.id,
    algorithm_suffix: 'biased-v1',
    entropy_digest: random.entropy_digest,
  };
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
