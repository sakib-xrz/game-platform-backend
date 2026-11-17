import crypto from 'node:crypto';

// Nonce cache to prevent replay attacks (kept for 10 minutes)
const seenNonces = new Map<string, number>();

function pruneSeenNonces() {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [nonce, time] of seenNonces.entries()) {
    if (time < tenMinutesAgo) {
      seenNonces.delete(nonce);
    }
  }
}

/**
 * Builds the canonical message for HMAC-SHA256 signing.
 * Lines:
 * 1: v1
 * 2: METHOD (uppercase)
 * 3: path and query exactly as requested (e.g. /api/v1/internal/wallet/debit)
 * 4: timestamp (unix seconds as string)
 * 5: nonce (32 hex characters)
 * 6: hex sha256 of raw request body (or sha256 of empty string)
 */
export function buildCanonicalSignatureMessage(
  method: string,
  pathAndQuery: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string = '',
): string {
  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const bodyHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');

  const normalizedPath = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  return [
    'v1',
    method.toUpperCase(),
    normalizedPath,
    timestamp,
    nonce,
    bodyHash,
  ].join('\n');
}

/**
 * Signs a request using the wallet signing secret.
 * Returns formatted as `v1={64_hex_chars}`
 */
export function signCanonicalRequest(
  secret: string,
  method: string,
  pathAndQuery: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string = '',
): string {
  const canonical = buildCanonicalSignatureMessage(method, pathAndQuery, timestamp, nonce, rawBody);
  const hmac = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  return `v1=${hmac}`;
}

/**
 * Generates headers for an outgoing signed call to 3rd-party wallet API.
 */
export function generateSignedHeaders(
  secret: string,
  method: string,
  pathAndQuery: string,
  rawBody: Buffer | string = '',
  operatorId = 'games',
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signCanonicalRequest(secret, method, pathAndQuery, timestamp, nonce, rawBody);

  return {
    'Content-Type': 'application/json',
    'X-Operator-Id': operatorId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

/**
 * Verifies an incoming signed call from games or 3rd-party provider.
 */
export function verifyCanonicalSignature(
  secrets: string[],
  method: string,
  pathAndQuery: string,
  headers: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
  },
  rawBody: Buffer | string = '',
  options: { checkTimestamp?: boolean; checkNonce?: boolean } = {},
): { valid: boolean; reason?: string } {
  const { timestamp, nonce, signature } = headers;

  if (!timestamp || !nonce || !signature) {
    return { valid: false, reason: 'Missing X-Timestamp, X-Nonce, or X-Signature header' };
  }

  if (!/^\d+$/.test(timestamp)) {
    return { valid: false, reason: 'X-Timestamp must be a numeric unix timestamp' };
  }

  if (!/^v1=[0-9a-f]{64}$/i.test(signature)) {
    return { valid: false, reason: 'X-Signature must match format v1={64_hex_chars}' };
  }

  // Check timestamp freshness within 5 minutes (300 seconds)
  if (options.checkTimestamp !== false) {
    const sent = Number.parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - sent) > 300) {
      return { valid: false, reason: 'Request timestamp is older than 5 minutes or in future' };
    }
  }

  // Nonce replay protection
  if (options.checkNonce !== false) {
    if (seenNonces.has(nonce)) {
      return { valid: false, reason: 'X-Nonce has already been used within the last 10 minutes' };
    }
  }

  const canonical = buildCanonicalSignatureMessage(method, pathAndQuery, timestamp, nonce, rawBody);
  const gotSig = Buffer.from(signature.slice(3), 'hex');

  const validSecret = secrets.some((secret) => {
    if (!secret) return false;
    const wantSig = crypto.createHmac('sha256', secret).update(canonical).digest();
    return wantSig.length === gotSig.length && crypto.timingSafeEqual(wantSig, gotSig);
  });

  if (!validSecret) {
    return { valid: false, reason: 'Signature verification failed against configured secrets' };
  }

  if (options.checkNonce !== false) {
    seenNonces.set(nonce, Date.now());
    if (seenNonces.size > 2000) {
      pruneSeenNonces();
    }
  }

  return { valid: true };
}

