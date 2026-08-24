import { describe, expect, it } from 'vitest';
import {
  creditPlatformUserCoinsSchema,
  externalUserIdParamSchema,
  syncPlatformUserSchema,
  withdrawPlatformUserCoinsSchema,
} from '@/modules/platform-integration/platform-integration.validation';

const credentials = {
  app_name: 'Greedy Live',
  package_name: 'com.example.greedy',
  sha_key: 'AABBCCDDEEFF00112233445566778899AABBCCDD',
};

describe('platform integration validation', () => {
  it('accepts a valid sync payload', () => {
    const parsed = syncPlatformUserSchema.parse({
      body: {
        ...credentials,
        external_user_id: 'app-user-123',
        email: 'user@example.com',
        name: 'Rashid',
        photo_url: 'https://cdn.example.com/a.jpg',
      },
    });

    expect(parsed.body.external_user_id).toBe('app-user-123');
    expect(parsed.body.app_name).toBe('Greedy Live');
  });

  it('accepts a valid coin credit payload', () => {
    const parsed = creditPlatformUserCoinsSchema.parse({
      body: {
        ...credentials,
        external_user_id: 'app-user-123',
        amount: '500',
        client_request_id: 'purchase-001',
      },
    });

    expect(parsed.body.amount).toBe('500');
  });

  it('accepts a valid coin withdraw payload', () => {
    const parsed = withdrawPlatformUserCoinsSchema.parse({
      body: {
        ...credentials,
        external_user_id: 'app-user-123',
        amount: '500',
        client_request_id: 'withdraw-001',
      },
    });

    expect(parsed.body.client_request_id).toBe('withdraw-001');
  });

  it('rejects non-positive coin amounts', () => {
    expect(() =>
      creditPlatformUserCoinsSchema.parse({
        body: {
          ...credentials,
          external_user_id: 'app-user-123',
          amount: '0',
          client_request_id: 'purchase-001',
        },
      }),
    ).toThrow();
  });

  it('accepts balance query credentials', () => {
    const parsed = externalUserIdParamSchema.parse({
      params: { external_user_id: 'app-user-123' },
      query: credentials,
    });

    expect(parsed.query.package_name).toBe('com.example.greedy');
    expect(parsed.query.sha_key).toBe(credentials.sha_key);
  });

  it('rejects balance requests without app credentials', () => {
    expect(() =>
      externalUserIdParamSchema.parse({
        params: { external_user_id: 'app-user-123' },
        query: { package_name: 'com.example.greedy' },
      }),
    ).toThrow();
  });
});
