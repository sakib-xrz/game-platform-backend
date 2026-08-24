import { describe, expect, it } from 'vitest';
import { normalizePackageName, normalizeShaKey } from '@/modules/platform-app/platform-app.validation';

describe('platform-app validation helpers', () => {
  it('normalizes package names to lowercase', () => {
    expect(normalizePackageName(' COM.Example.App ')).toBe('com.example.app');
  });

  it('normalizes sha keys to uppercase hex without colons', () => {
    expect(normalizeShaKey('aa:bb:cc:dd')).toBe('AABBCCDD');
  });
});
