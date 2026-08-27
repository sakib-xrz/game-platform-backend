import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { resolveGameIdentitySync } from '@/modules/game-bot/bot-identity';
import type {
  GreedyClassicBetPlacedPayload,
  GreedyClassicPublicIdentity,
  GreedyClassicTopWinner,
} from './greedy-classic.types';

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

/**
 * 0-based wheel index for the winning option. Callers must pass enabled
 * options already ordered by display_order ascending (same order the UI uses).
 */
export const winningOptionIndex = (
  options: Array<{ id: string }>,
  winning_option_id: string,
): number => {
  const index = options.findIndex((option) => option.id === winning_option_id);
  if (index < 0) {
    throw new Error('Winning option is not present in the enabled option list');
  }
  return index;
};

export type GreedyClassicWinnerAggregateInput = {
  user_id: string;
  winning_stake: bigint;
  bet_count: number;
  first_bet_at: Date;
};

export type GreedyClassicWinnerRanking = GreedyClassicWinnerAggregateInput & {
  total_payout: bigint;
};

export type GreedyClassicWinningBetInput = {
  user_id: string;
  amount: bigint;
  accepted_at: Date;
};

export type GreedyClassicSettlementBetInput = {
  id: string;
  amount: bigint;
  accepted_at: Date;
};

export type GreedyClassicPayoutAllocation = {
  total_winning_stake: bigint;
  total_payout: bigint;
  payout_by_bet: Map<string, bigint>;
};

export const buildGreedyClassicBetPlacedPayload = (
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
  bettor: GreedyClassicPublicIdentity,
): GreedyClassicBetPlacedPayload => ({
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
 * Ranking is deterministic across API and worker processes: gross payout
 * descending, earliest accepted winning bet ascending, then user id ascending.
 */
export const compareGreedyClassicWinnerRankings = (
  left: GreedyClassicWinnerRanking,
  right: GreedyClassicWinnerRanking,
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

export const rankGreedyClassicWinnerAggregates = (
  aggregates: GreedyClassicWinnerAggregateInput[],
  payout_numerator: bigint,
  payout_denominator: bigint,
  limit = 3,
): GreedyClassicTopWinner[] =>
  aggregates
    .map((aggregate): GreedyClassicWinnerRanking => ({
      ...aggregate,
      total_payout: calculatePayout(
        aggregate.winning_stake,
        payout_numerator,
        payout_denominator,
      ),
    }))
    .sort(compareGreedyClassicWinnerRankings)
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

/** Aggregate all winning bet records per user before applying the multiplier. */
export const buildGreedyClassicTopWinners = (
  bets: GreedyClassicWinningBetInput[],
  payout_numerator: bigint,
  payout_denominator: bigint,
  limit = 3,
): GreedyClassicTopWinner[] => {
  const users = new Map<string, GreedyClassicWinnerAggregateInput>();

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

  return rankGreedyClassicWinnerAggregates(
    [...users.values()],
    payout_numerator,
    payout_denominator,
    limit,
  );
};

/**
 * Applies payout math once to the user's aggregate winning stake. Individual
 * settlement rows receive their floor payout plus any remaining atomic units
 * in accepted-at/id order, so their sum always equals the wallet credit.
 */
export const allocateGreedyClassicWinningBetPayouts = (
  bets: GreedyClassicSettlementBetInput[],
  payout_numerator: bigint,
  payout_denominator: bigint,
): GreedyClassicPayoutAllocation => {
  const ordered_bets = [...bets].sort((left, right) => {
    const accepted_at_difference =
      left.accepted_at.getTime() - right.accepted_at.getTime();
    if (accepted_at_difference !== 0) return accepted_at_difference;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const total_winning_stake = ordered_bets.reduce(
    (total, bet) => total + bet.amount,
    0n,
  );
  const total_payout = calculatePayout(
    total_winning_stake,
    payout_numerator,
    payout_denominator,
  );
  const payout_by_bet = new Map<string, bigint>();
  let allocated_payout = 0n;

  for (const bet of ordered_bets) {
    const payout = calculatePayout(
      bet.amount,
      payout_numerator,
      payout_denominator,
    );
    payout_by_bet.set(bet.id, payout);
    allocated_payout += payout;
  }

  let rounding_remainder = total_payout - allocated_payout;
  if (rounding_remainder < 0n) {
    throw new Error(
      'Aggregate Greedy Classic payout is below allocated settlements',
    );
  }
  for (const bet of ordered_bets) {
    if (rounding_remainder === 0n) break;
    payout_by_bet.set(bet.id, (payout_by_bet.get(bet.id) ?? 0n) + 1n);
    rounding_remainder -= 1n;
  }
  if (rounding_remainder !== 0n) {
    throw new Error(
      'Greedy Classic payout rounding remainder could not be allocated',
    );
  }

  return { total_winning_stake, total_payout, payout_by_bet };
};
