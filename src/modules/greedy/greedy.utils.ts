import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

const RETRYABLE_POSTGRES_CODES = ['40001', '40P01'] as const;

export const isRetryableTransactionError = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;

  // Driver-adapter raw queries surface PostgreSQL serialization failures as
  // P2010 rather than Prisma's P2034 transaction-conflict code. Inspect both
  // metadata (whose nesting varies by adapter version) and the stable rendered
  // database-code fragment so raw and model operations get identical retries.
  const details = `${JSON.stringify(error.meta ?? {})}\n${error.message}`;
  return RETRYABLE_POSTGRES_CODES.some(
    (code) =>
      details.includes(`"${code}"`) ||
      details.includes(`Code: \`${code}\``),
  );
};

export const withSerializableRetry = async <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 4,
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
        // A small jitter keeps simultaneous wallet updates from repeatedly
        // colliding again on the exact same retry boundary.
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 20 + Math.floor(Math.random() * 20)),
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
