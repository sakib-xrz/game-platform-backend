import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { resolveGameIdentitySync } from '@/modules/game-bot/bot-identity';
import {
  LUCKY_77_SLOT_MAP,
  type Lucky77SlotCode,
} from './lucky-77.constant';
import type {
  Lucky77BetPlacedPayload,
  Lucky77PublicIdentity,
  Lucky77TopWinner,
} from './lucky-77.types';

const RETRYABLE_POSTGRES_CODES = ['40001', '40P01'] as const;

export const isRetryableTransactionError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? `${error.name}\n${error.message}\n${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`
      : String(error);

  // pg adapter / Prisma may surface serialization failures as P2034, P2010,
  // or a plain TransactionWriteConflict message depending on path.
  if (
    message.includes('TransactionWriteConflict') ||
    message.includes('could not serialize access') ||
    message.includes('serialization failure')
  ) {
    return true;
  }

  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;

  // Driver-adapter raw queries surface PostgreSQL serialization failures as
  // P2010 rather than Prisma's P2034 transaction-conflict code. Inspect both
  // metadata (whose nesting varies by adapter version) and the stable rendered
  // database-code fragment so raw and model operations get identical retries.
  return RETRYABLE_POSTGRES_CODES.some(
    (code) =>
      message.includes(`"${code}"`) ||
      message.includes(`Code: \`${code}\``),
  );
};

export const withSerializableRetry = async <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 8,
): Promise<T> => {
  let last_error: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 10000,
      });
    } catch (error) {
      last_error = error;
      if (isRetryableTransactionError(error) && attempt < attempts) {
        // Backoff under multi-player concurrent bets so retries do not keep
        // colliding on the same serialization boundary.
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 35 + Math.floor(Math.random() * 40)),
        );
        continue;
      }
      throw error;
    }
  }

  throw last_error;
};

export const calculatePayout = (
  amount: bigint,
  numerator: bigint,
  denominator: bigint,
): bigint => {
  if (denominator <= 0n) throw new Error('Invalid payout denominator');
  return (amount * numerator) / denominator;
};

/** Player-facing multiplier label, e.g. "8x" or "3/2x". */
export const formatPayoutMultiplier = (
  numerator: bigint | number | string,
  denominator: bigint | number | string,
): string => {
  try {
    const n = BigInt(numerator);
    const d = BigInt(denominator);
    if (d === 0n) return '—';
    if (n % d === 0n) return `${n / d}x`;
    return `${n.toString()}/${d.toString()}x`;
  } catch {
    return '—';
  }
};

type OptionWithPayout = {
  payout_numerator: bigint | number | string;
  payout_denominator: bigint | number | string;
};

export const withPayoutMultiplier = <T extends OptionWithPayout>(option: T) => ({
  ...option,
  payout_multiplier: formatPayoutMultiplier(
    option.payout_numerator,
    option.payout_denominator,
  ),
});

export const withPayoutMultipliers = <T extends OptionWithPayout>(
  options: T[],
) => options.map(withPayoutMultiplier);

export type Lucky77WinnerAggregateInput = {
  user_id: string;
  winning_stake: bigint;
  bet_count: number;
  first_bet_at: Date;
};

export type Lucky77WinnerRanking = Lucky77WinnerAggregateInput & {
  total_payout: bigint;
};

export type Lucky77WinningBetInput = {
  user_id: string;
  amount: bigint;
  accepted_at: Date;
};

export const buildLucky77BetPlacedPayload = (
  bet: {
    id: string;
    round_id: string;
    option_id: string;
    amount: bigint;
    accepted_at: Date;
    total_amount: bigint;
    bet_count: number;
    first_bet_at: Date;
    last_bet_at: Date;
  },
  bettor: Lucky77PublicIdentity,
): Lucky77BetPlacedPayload => ({
  bet_id: bet.id,
  round_id: bet.round_id,
  option_id: bet.option_id,
  amount: bet.amount.toString(),
  accepted_at: bet.accepted_at.toISOString(),
  total_amount: bet.total_amount.toString(),
  bet_count: bet.bet_count,
  first_bet_at: bet.first_bet_at.toISOString(),
  last_bet_at: bet.last_bet_at.toISOString(),
  bettor,
});

/**
 * Gross payout descending, earliest accepted winning bet ascending, then user
 * id ascending. The API and worker both use this ordering for a stable podium.
 */
export const compareLucky77WinnerRankings = (
  left: Lucky77WinnerRanking,
  right: Lucky77WinnerRanking,
): number => {
  if (left.total_payout !== right.total_payout) {
    return left.total_payout > right.total_payout ? -1 : 1;
  }
  const accepted_at_difference =
    left.first_bet_at.getTime() - right.first_bet_at.getTime();
  if (accepted_at_difference !== 0) return accepted_at_difference;
  return left.user_id < right.user_id
    ? -1
    : left.user_id > right.user_id
      ? 1
      : 0;
};

export const rankLucky77WinnerAggregates = (
  aggregates: Lucky77WinnerAggregateInput[],
  payout_numerator: bigint,
  payout_denominator: bigint,
  limit = 3,
): Lucky77TopWinner[] =>
  aggregates
    .map((aggregate): Lucky77WinnerRanking => ({
      ...aggregate,
      total_payout: calculatePayout(
        aggregate.winning_stake,
        payout_numerator,
        payout_denominator,
      ),
    }))
    .sort(compareLucky77WinnerRankings)
    .slice(0, Math.max(0, limit))
    .map((winner, index) => {
      const identity = resolveGameIdentitySync(winner.user_id);
      return {
        rank: index + 1,
        user_id: winner.user_id,
        display_name: identity.display_name,
        avatar_url: identity.avatar_url,
        winning_stake: winner.winning_stake.toString(),
        bet_count: winner.bet_count,
        total_payout: winner.total_payout.toString(),
        first_bet_at: winner.first_bet_at.toISOString(),
      };
    });

export const buildLucky77TopWinners = (
  bets: Lucky77WinningBetInput[],
  payout_numerator: bigint,
  payout_denominator: bigint,
  limit = 3,
): Lucky77TopWinner[] => {
  const users = new Map<string, Lucky77WinnerAggregateInput>();
  for (const bet of bets) {
    const existing = users.get(bet.user_id);
    if (existing) {
      existing.winning_stake += bet.amount;
      existing.bet_count += 1;
      if (bet.accepted_at < existing.first_bet_at) {
        existing.first_bet_at = bet.accepted_at;
      }
      continue;
    }
    users.set(bet.user_id, {
      user_id: bet.user_id,
      winning_stake: bet.amount,
      bet_count: 1,
      first_bet_at: bet.accepted_at,
    });
  }
  return rankLucky77WinnerAggregates(
    [...users.values()],
    payout_numerator,
    payout_denominator,
    limit,
  );
};

export const slotIndexesForOption = (code: string): number[] => {
  const indexes: number[] = [];
  for (let index = 0; index < LUCKY_77_SLOT_MAP.length; index += 1) {
    if (LUCKY_77_SLOT_MAP[index] === code) indexes.push(index);
  }
  return indexes;
};

export const pickWeightedOption = <T extends { probability_weight: bigint }>(
  options: T[],
  random_value: bigint,
): T => {
  const total_weight = options.reduce(
    (sum, item) => sum + item.probability_weight,
    0n,
  );
  if (total_weight <= 0n) {
    throw new Error('Lucky 77 config has no positive probability weight');
  }
  if (random_value < 0n || random_value >= total_weight) {
    throw new Error('Random value is outside the configured weight range');
  }
  let cursor = 0n;
  for (const option of options) {
    cursor += option.probability_weight;
    if (random_value < cursor) return option;
  }
  return options[options.length - 1]!;
};

export const pickUniformSlotIndex = (
  option_code: string,
  random_value: bigint,
): number => {
  const indexes = slotIndexesForOption(option_code);
  if (!indexes.length) {
    throw new Error(`Lucky 77 slot map has no slots for ${option_code}`);
  }
  if (random_value < 0n || random_value >= BigInt(indexes.length)) {
    throw new Error('Slot random value is outside the matching-slot range');
  }
  return indexes[Number(random_value)]!;
};

export const isLucky77SlotCode = (value: string): value is Lucky77SlotCode =>
  (LUCKY_77_SLOT_MAP as readonly string[]).includes(value);
