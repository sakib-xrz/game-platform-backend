import crypto from 'node:crypto';

export type PlayerTokenClaims = {
  sub: string;
  app: string;
  username?: string;
  avatarUrl?: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Sign an HS256 JWT player token.
 * Expire in 15 minutes (900 seconds) by default as required by the games integration spec.
 */
export function signPlayerToken(
  payload: {
    sub: string;
    app: string;
    username?: string;
    avatarUrl?: string;
  },
  secret: string,
  expiresInSeconds: number = 15 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims: PlayerTokenClaims = {
    sub: String(payload.sub),
    app: String(payload.app),
    username: payload.username || undefined,
    avatarUrl: payload.avatarUrl || undefined,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const message = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${message}.${encodedSignature}`;
}

export const generatePlayerToken = signPlayerToken;

/**
 * Verify and decode an HS256 JWT player token.
 * Supports a single secret or an array of secrets (for zero-downtime key rotation).
 */
export function verifyPlayerToken(
  token: string,
  secretOrSecrets: string | string[],
): { valid: boolean; claims?: PlayerTokenClaims; reason?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Token is missing or not a string' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Invalid JWT format (must have 3 parts)' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return { valid: false, reason: 'Empty token segment' };
  }

  try {
    const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];
    const message = `${encodedHeader}.${encodedPayload}`;
    const left = Buffer.from(encodedSignature);

    const matchesSecret = secrets.some((sec) => {
      if (!sec) return false;
      const expectedSig = crypto.createHmac('sha256', sec).update(message).digest();
      const right = Buffer.from(base64UrlEncode(expectedSig));
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    });

    if (!matchesSecret) {
      return { valid: false, reason: 'Invalid signature' };
    }

    const payload: PlayerTokenClaims = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    // Expiry check
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      return { valid: false, reason: 'Token has expired' };
    }

    if (!payload.sub || !payload.app) {
      return { valid: false, reason: 'Missing sub or app claim' };
    }

    return { valid: true, claims: payload };
  } catch (err: any) {
    return { valid: false, reason: err.message || 'Failed to decode token' };
  }
}
