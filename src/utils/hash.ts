import crypto from 'crypto';

export const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/** Deterministic JSON encoding that survives PostgreSQL JSONB key reordering. */
export const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'bigint') return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().flatMap((key) => {
        const item = (input as Record<string, unknown>)[key];
        return item === undefined ? [] : [[key, normalize(item)]];
      }));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

export const stableRequestHash = (value: unknown): string =>
  sha256(canonicalJson(value));
