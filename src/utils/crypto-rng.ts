import crypto from 'crypto';
import { sha256 } from './hash';

export type SecureRandomResult = {
  value: bigint;
  entropy_digest: string;
};

export const secureRandomBigIntBelow = (
  max_exclusive: bigint,
): SecureRandomResult => {
  if (max_exclusive <= 0n) throw new Error('max_exclusive must be positive');

  const bit_length = max_exclusive.toString(2).length;
  const byte_length = Math.ceil(bit_length / 8);
  const max_range = 1n << BigInt(byte_length * 8);
  const acceptable_limit = max_range - (max_range % max_exclusive);

  for (;;) {
    const entropy = crypto.randomBytes(byte_length);
    const candidate = BigInt(`0x${entropy.toString('hex') || '0'}`);
    if (candidate < acceptable_limit) {
      return {
        value: candidate % max_exclusive,
        entropy_digest: sha256(entropy),
      };
    }
  }
};
