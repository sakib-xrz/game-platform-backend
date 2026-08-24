import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {
    platformUser: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    wallet: {
      findMany: vi.fn(),
    },
    walletLedger: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    platformApp: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import prisma from '@/lib/prisma';
import PlatformUserService from '@/modules/platform-user/platform-user.services';

describe('PlatformUserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists platform users with balances', async () => {
    const created_at = new Date('2026-08-23T10:00:00.000Z');
    const updated_at = new Date('2026-08-23T11:00:00.000Z');
    vi.mocked(prisma.platformUser.findMany).mockResolvedValue([
      {
        id: 'user-1',
        platform_app_id: 'app-1',
        external_user_id: 'rashed',
        email: 'rashed@example.com',
        display_name: 'Rashed',
        photo_url: null,
        status: 'active',
        created_at,
        updated_at,
        platform_app: { app_name: 'Max Live pro', package_name: 'com.example.app' },
      },
    ] as never);
    vi.mocked(prisma.platformUser.count).mockResolvedValue(1);
    vi.mocked(prisma.wallet.findMany).mockResolvedValue([
      { user_id: 'user-1', balance: 700n },
    ] as never);

    const result = await PlatformUserService.listAdminPlatformUsers({
      search: 'rashed',
      page: 1,
      limit: 20,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        external_user_id: 'rashed',
        display_name: 'Rashed',
        balance: '700',
        app_name: 'Max Live pro',
      }),
    ]);
    expect(result.total).toBe(1);
  });

  it('maps ledger entries to deposit and withdrawal types', async () => {
    vi.mocked(prisma.platformUser.findUnique).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(prisma.walletLedger.findMany).mockResolvedValue([
      {
        id: 'ledger-1',
        type: 'purchase_credit',
        amount: 1000n,
        balance_before: 0n,
        balance_after: 1000n,
        reference_type: 'platform_coin_deposit',
        reference_id: 'credit-1',
        metadata: null,
        created_at: new Date('2026-08-23T10:00:00.000Z'),
      },
      {
        id: 'ledger-2',
        type: 'withdrawal_debit',
        amount: -300n,
        balance_before: 1000n,
        balance_after: 700n,
        reference_type: 'platform_coin_withdrawal',
        reference_id: 'withdraw-1',
        metadata: null,
        created_at: new Date('2026-08-23T11:00:00.000Z'),
      },
    ] as never);
    vi.mocked(prisma.walletLedger.count).mockResolvedValue(2);

    const result = await PlatformUserService.listAdminPlatformUserLedger('user-1', {
      page: 1,
      limit: 50,
    });

    expect(result.items).toEqual([
      expect.objectContaining({ type: 'deposit', amount: '1000', client_request_id: 'credit-1' }),
      expect.objectContaining({ type: 'withdrawal', amount: '300', client_request_id: 'withdraw-1' }),
    ]);
  });
});
