import { describe, expect, it } from 'vitest';
import {
  buildCanonicalSignatureMessage,
  generateSignedHeaders,
  signCanonicalRequest,
  verifyCanonicalSignature,
} from '@/utils/canonical-signature';
import { generatePlayerToken, verifyPlayerToken } from '@/utils/player-token';
import crypto from 'node:crypto';

describe('Canonical HMAC Signature and Player Token Integration', () => {
  const secret = 'example-wallet-signing-secret';
  const method = 'POST';
  const path = '/api/v1/internal/wallet/debit';
  const ts = '1767225600';
  const nonce = '0123456789abcdef0123456789abcdef';
  const body = JSON.stringify({
    userId: 'u_1001',
    currency: 'coins',
    amount: 500,
    type: 'game_bet',
    idempotencyKey: 'game-bet:6718f0a2c3d4e5f601234567',
  });

  it('builds the canonical string matching the v1 specification', () => {
    const canonical = buildCanonicalSignatureMessage(method, path, ts, nonce, body);
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');

    expect(canonical).toBe(
      `v1\nPOST\n/api/v1/internal/wallet/debit\n1767225600\n0123456789abcdef0123456789abcdef\n${bodyHash}`,
    );
  });

  it('generates a valid signature in v1={64_hex} format', () => {
    const sig = signCanonicalRequest(secret, method, path, ts, nonce, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);

    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const expectedCanonical = `v1\nPOST\n/api/v1/internal/wallet/debit\n1767225600\n0123456789abcdef0123456789abcdef\n${bodyHash}`;
    const expectedHmac = crypto.createHmac('sha256', secret).update(expectedCanonical).digest('hex');
    expect(sig).toBe(`v1=${expectedHmac}`);
  });

  it('verifies valid signatures accurately', () => {
    const sig = signCanonicalRequest(secret, method, path, ts, nonce, body);
    const res = verifyCanonicalSignature(
      [secret],
      method,
      path,
      { timestamp: ts, nonce, signature: sig },
      body,
      { checkTimestamp: false, checkNonce: false },
    );
    expect(res.valid).toBe(true);
  });

  it('rejects tampered body or incorrect secret', () => {
    const sig = signCanonicalRequest(secret, method, path, ts, nonce, body);
    const tampered = verifyCanonicalSignature(
      [secret],
      method,
      path,
      { timestamp: ts, nonce, signature: sig },
      body + ' ',
      { checkTimestamp: false, checkNonce: false },
    );
    expect(tampered.valid).toBe(false);

    const wrongSecret = verifyCanonicalSignature(
      ['wrong-secret'],
      method,
      path,
      { timestamp: ts, nonce, signature: sig },
      body,
      { checkTimestamp: false, checkNonce: false },
    );
    expect(wrongSecret.valid).toBe(false);
  });

  it('rejects replayed nonce', () => {
    const uniqueNonce = crypto.randomBytes(16).toString('hex');
    const currentTs = Math.floor(Date.now() / 1000).toString();
    const sig = signCanonicalRequest(secret, method, path, currentTs, uniqueNonce, body);

    const firstAttempt = verifyCanonicalSignature(
      [secret],
      method,
      path,
      { timestamp: currentTs, nonce: uniqueNonce, signature: sig },
      body,
      { checkTimestamp: true, checkNonce: true },
    );
    expect(firstAttempt.valid).toBe(true);

    const secondAttempt = verifyCanonicalSignature(
      [secret],
      method,
      path,
      { timestamp: currentTs, nonce: uniqueNonce, signature: sig },
      body,
      { checkTimestamp: true, checkNonce: true },
    );
    expect(secondAttempt.valid).toBe(false);
    expect(secondAttempt.reason).toContain('already been used');
  });

  it('generates outgoing signed headers with all required fields', () => {
    const headers = generateSignedHeaders(secret, 'GET', '/api/v1/internal/wallet/u_1001/balance', '');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Operator-Id']).toBe('games');
    expect(headers['X-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(headers['X-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('issues and verifies player tokens correctly', () => {
    const playerSecret = 'player-token-secret-12345';
    const payload = {
      sub: 'user_9988',
      app: 'demo_app',
      username: 'Shahriar Player',
      avatarUrl: 'https://example.com/avatar.jpg',
    };

    const token = generatePlayerToken(payload, playerSecret, 900);
    expect(token).toBeTruthy();

    const verified = verifyPlayerToken(token, [playerSecret]);
    expect(verified.valid).toBe(true);
    expect(verified.claims?.sub).toBe('user_9988');
    expect(verified.claims?.app).toBe('demo_app');
    expect(verified.claims?.username).toBe('Shahriar Player');
  });

  it('rejects expired player tokens', () => {
    const playerSecret = 'player-token-secret-12345';
    const payload = {
      sub: 'user_9988',
      app: 'demo_app',
      username: 'Shahriar Player',
    };

    // 0 or negative lifetime -> expired
    const expiredToken = generatePlayerToken(payload, playerSecret, -10);
    const result = verifyPlayerToken(expiredToken, [playerSecret]);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });
});
