import { sha256 } from '@/utils/hash';

const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Teen Patti audit data contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new Error('Teen Patti audit data contains an unsupported value');
};

export type TeenPattiCommitmentInput = {
  round_id: string;
  config_version_id: string;
  winning_option_id: string;
  algorithm_version: string;
  entropy_digest: string;
  hands: unknown;
  generated_at: Date;
};

/**
 * v1 commitments were produced from hand objects in this exact insertion order.
 * PostgreSQL JSONB does not preserve object-key order, so rebuild the original
 * producer shape before hashing a persisted legacy result.
 */
const legacyHandsJson = (hands: unknown): string => {
  if (!Array.isArray(hands)) return JSON.stringify(hands);

  return JSON.stringify(
    hands.map((hand) => {
      if (hand === null || typeof hand !== 'object' || Array.isArray(hand)) {
        return hand;
      }

      const value = hand as Record<string, unknown>;
      return {
        option_id: value.option_id,
        option_code: value.option_code,
        cards: value.cards,
        category: value.category,
        rank_key: value.rank_key,
      };
    }),
  );
};

/** Stable across JSONB persistence because every object key is sorted. */
export const buildTeenPattiResultCommitment = (
  input: TeenPattiCommitmentInput,
): string =>
  sha256(
    [
      input.round_id,
      input.config_version_id,
      input.winning_option_id,
      input.algorithm_version,
      input.entropy_digest,
      canonicalJson(input.hands),
      input.generated_at.toISOString(),
    ].join('|'),
  );

/** Compatibility verifier for results produced before canonical predeals. */
export const buildLegacyTeenPattiResultAuditHash = (
  input: TeenPattiCommitmentInput,
): string =>
  sha256(
    [
      input.round_id,
      input.config_version_id,
      input.winning_option_id,
      input.algorithm_version,
      input.entropy_digest,
      legacyHandsJson(input.hands),
      input.generated_at.toISOString(),
    ].join('|'),
  );
