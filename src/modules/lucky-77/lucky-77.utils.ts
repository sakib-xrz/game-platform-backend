import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import {
  LUCKY_77_SLOT_MAP,
  type Lucky77SlotCode,
} from './lucky-77.constant';

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
