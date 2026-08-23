import { describe, expect, it } from 'vitest';
import {
  buildPlatformSignaturePayload,
  parsePlatformTimestamp,
  signPlatformRequest,
  verifyPlatformRequestSignature,
} from '@/utils/platform-signature';

describe('platform signature', () => {
  const secret = 'test-signing-secret';
  const input = {
    timestamp: '1730000000',
    method: 'POST',
    path: '/api/v1/integrations/users/sync',
    raw_body: Buffer.from(JSON.stringify({ external_user_id: 'user-1' }), 'utf8'),
  };

  it('builds a stable payload', () => {
    expect(buildPlatformSignaturePayload(input)).toContain('/api/v1/integrations/users/sync');
  });

  it('signs and verifies a request', () => {
    const signature = signPlatformRequest(secret, input);
    expect(verifyPlatformRequestSignature(secret, signature, input)).toBe(true);
    expect(verifyPlatformRequestSignature('wrong-secret', signature, input)).toBe(false);
  });

  it('rejects tampered bodies', () => {
    const signature = signPlatformRequest(secret, input);
    expect(
      verifyPlatformRequestSignature(secret, signature, {
        ...input,
        raw_body: Buffer.from('{"external_user_id":"user-2"}', 'utf8'),
      }),
    ).toBe(false);
  });

  it('parses second and millisecond timestamps', () => {
    expect(parsePlatformTimestamp('1730000000')).toBe(1730000000000);
    expect(parsePlatformTimestamp('1730000000123')).toBe(1730000000123);
  });
});
