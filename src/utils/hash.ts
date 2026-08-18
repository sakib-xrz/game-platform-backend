import crypto from 'crypto';

export const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const stableRequestHash = (value: unknown): string =>
  sha256(JSON.stringify(value, Object.keys((value ?? {}) as object).sort()));
