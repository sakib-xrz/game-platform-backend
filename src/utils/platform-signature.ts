import crypto from 'crypto';
import { sha256 } from '@/utils/hash';

export const PLATFORM_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export const generatePlatformSigningSecret = (): string =>
  crypto.randomBytes(32).toString('hex');

export const buildPlatformSignaturePayload = (input: {
  timestamp: string;
  method: string;
  path: string;
  raw_body: Buffer | string;
}): string => {
  const body = typeof input.raw_body === 'string' ? input.raw_body : input.raw_body.toString('utf8');
  const body_hash = sha256(body);
  return `${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${body_hash}`;
};

export const signPlatformRequest = (
  signing_secret: string,
  input: {
    timestamp: string;
    method: string;
    path: string;
    raw_body: Buffer | string;
  },
): string => {
  const payload = buildPlatformSignaturePayload(input);
  return crypto.createHmac('sha256', signing_secret).update(payload).digest('hex');
};

const timingSafeEqualHex = (left: string, right: string): boolean => {
  try {
    const left_buffer = Buffer.from(left, 'hex');
    const right_buffer = Buffer.from(right, 'hex');
    if (left_buffer.length !== right_buffer.length) return false;
    return crypto.timingSafeEqual(left_buffer, right_buffer);
  } catch {
    return false;
  }
};

export const verifyPlatformRequestSignature = (
  signing_secret: string,
  signature: string,
  input: {
    timestamp: string;
    method: string;
    path: string;
    raw_body: Buffer | string;
  },
): boolean => {
  const expected = signPlatformRequest(signing_secret, input);
  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
};

export const parsePlatformTimestamp = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return trimmed.length >= 13 ? parsed : parsed * 1000;
};

export const assertPlatformTimestampFresh = (
  timestamp_ms: number,
  now_ms: number = Date.now(),
  max_skew_ms: number = PLATFORM_SIGNATURE_MAX_SKEW_MS,
): void => {
  if (Math.abs(now_ms - timestamp_ms) > max_skew_ms) {
    throw new Error('Platform request timestamp is outside the allowed window');
  }
};

export const maskSigningSecret = (signing_secret: string): string =>
  signing_secret.length <= 8
    ? `${signing_secret.slice(0, 2)}…`
    : `${signing_secret.slice(0, 8)}…`;
