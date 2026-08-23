import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformUserStatus } from '@/generated/prisma/client';
import PlatformIntegrationService from '@/modules/platform-integration/platform-integration.services';

const mocks = vi.hoisted(() => ({
  platformUserFindUnique: vi.fn(),
  platformCoinDepositFindUnique: vi.fn(),
  platformCoinWithdrawalFindUnique: vi.fn(),
  transaction: vi.fn(),
  ensureWallet: vi.fn(),
  creditPlatformPurchase: vi.fn(),
  debitPlatformWithdrawal: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    platformUser: {
      findUnique: mocks.platformUserFindUnique,
    },
    platformCoinDeposit: {
      findUnique: mocks.platformCoinDepositFindUnique,
    },
    platformCoinWithdrawal: {
      findUnique: mocks.platformCoinWithdrawalFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@/modules/wallet/wallet.services', () => ({
  ensureWallet: mocks.ensureWallet,
  creditPlatformPurchase: mocks.creditPlatformPurchase,
  debitPlatformWithdrawal: mocks.debitPlatformWithdrawal,
}));

const platform_app = {
  id: 'app-1',
  app_name: 'Greedy Live',
  package_name: 'com.example.greedy',
  sha_key: 'AABBCCDD',
  status: 'active' as const,
};

const existing_user = {
  id: 'platform-user-1',
  platform_app_id: 'app-1',
  external_user_id: 'app-user-123',
  email: 'user@example.com',
  display_name: 'Rashid',
  photo_url: null,
  status: PlatformUserStatus.active,
  created_at: new Date('2026-08-23T00:00:00.000Z'),
  updated_at: new Date('2026-08-23T00:00:00.000Z'),
};

describe('PlatformIntegrationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformUserFindUnique.mockReset();
    mocks.platformCoinDepositFindUnique.mockReset();
    mocks.platformCoinWithdrawalFindUnique.mockReset();
    mocks.transaction.mockReset();
    mocks.ensureWallet.mockReset();
    mocks.creditPlatformPurchase.mockReset();
    mocks.debitPlatformWithdrawal.mockReset();
    mocks.ensureWallet.mockResolvedValue({ balance: 0n });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({}),
    );
  });

  it('creates a synced user with zero balance', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(null);

    mocks.transaction.mockImplementationOnce(async (callback) => {
      const tx = {
        platformUser: {
          create: vi.fn().mockResolvedValue(existing_user),
        },
        auditLog: {
          create: vi.fn(),
        },
      };
      mocks.ensureWallet.mockResolvedValueOnce({ balance: 0n });
      return callback(tx);
    });

    const result = await PlatformIntegrationService.syncPlatformUser(platform_app, {
      external_user_id: 'app-user-123',
      email: 'user@example.com',
      name: 'Rashid',
      photo_url: null,
    });

    expect(result.created).toBe(true);
    expect(result.balance).toBe('0');
    expect(result.external_user_id).toBe('app-user-123');
  });

  it('returns existing deposit on idempotent coin credit', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.platformCoinDepositFindUnique.mockResolvedValue({
      external_user_id: 'app-user-123',
      received_amount: 500n,
      converted_amount: 500n,
      wallet_ledger: { balance_after: 1500n },
    });

    const result = await PlatformIntegrationService.creditPlatformUserCoins(platform_app, {
      external_user_id: 'app-user-123',
      amount: '500',
      client_request_id: 'purchase-001',
    });

    expect(result.idempotent).toBe(true);
    expect(result.received_amount).toBe('500');
    expect(result.converted_amount).toBe('500');
    expect(result.balance).toBe('1500');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('credits coins 1:1 for a new deposit', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.platformCoinDepositFindUnique.mockResolvedValue(null);
    mocks.creditPlatformPurchase.mockResolvedValue({
      ledger: { id: 'ledger-1' },
      balance_after: 500n,
    });

    mocks.transaction.mockImplementationOnce(async (callback) => {
      const tx = {
        platformCoinDeposit: {
          create: vi.fn().mockResolvedValue({ id: 'deposit-1' }),
        },
        auditLog: {
          create: vi.fn(),
        },
      };
      return callback(tx);
    });

    const result = await PlatformIntegrationService.creditPlatformUserCoins(platform_app, {
      external_user_id: 'app-user-123',
      amount: '500',
      client_request_id: 'purchase-002',
    });

    expect(result.idempotent).toBe(false);
    expect(result.received_amount).toBe('500');
    expect(result.converted_amount).toBe('500');
    expect(result.balance).toBe('500');
    expect(mocks.creditPlatformPurchase).toHaveBeenCalledWith(expect.anything(), {
      user_id: 'platform-user-1',
      amount: 500n,
      reference_type: 'platform_coin_deposit',
      reference_id: 'purchase-002',
      metadata: expect.objectContaining({
        external_user_id: 'app-user-123',
        received_amount: '500',
        converted_amount: '500',
      }),
    });
  });

  it('returns balance for an existing user', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.ensureWallet.mockResolvedValue({ balance: 750n });

    const result = await PlatformIntegrationService.getPlatformUserCoins(
      platform_app,
      'app-user-123',
    );

    expect(result.balance).toBe('750');
    expect(result.currency).toBe('COIN');
  });

  it('rejects withdrawal when balance is insufficient', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.platformCoinWithdrawalFindUnique.mockResolvedValue(null);
    mocks.ensureWallet.mockResolvedValue({ balance: 300n });

    await expect(
      PlatformIntegrationService.withdrawPlatformUserCoins(platform_app, {
        external_user_id: 'app-user-123',
        amount: '500',
        client_request_id: 'withdraw-001',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Insufficient wallet balance for withdrawal',
      errors: {
        balance: ['300'],
        requested_amount: ['500'],
        shortfall: ['200'],
        currency: ['COIN'],
      },
    });
  });

  it('withdraws coins 1:1 to the app', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.platformCoinWithdrawalFindUnique.mockResolvedValue(null);
    mocks.ensureWallet.mockResolvedValue({ balance: 800n });
    mocks.debitPlatformWithdrawal.mockResolvedValue({
      ledger: { id: 'ledger-2' },
      balance_after: 300n,
    });

    mocks.transaction.mockImplementationOnce(async (callback) => {
      const tx = {
        platformCoinWithdrawal: {
          create: vi.fn().mockResolvedValue({ id: 'withdrawal-1' }),
        },
        auditLog: {
          create: vi.fn(),
        },
      };
      return callback(tx);
    });

    const result = await PlatformIntegrationService.withdrawPlatformUserCoins(platform_app, {
      external_user_id: 'app-user-123',
      amount: '500',
      client_request_id: 'withdraw-002',
    });

    expect(result.idempotent).toBe(false);
    expect(result.requested_amount).toBe('500');
    expect(result.transferred_amount).toBe('500');
    expect(result.balance).toBe('300');
    expect(mocks.debitPlatformWithdrawal).toHaveBeenCalledWith(expect.anything(), {
      user_id: 'platform-user-1',
      amount: 500n,
      reference_type: 'platform_coin_withdrawal',
      reference_id: 'withdraw-002',
      metadata: expect.objectContaining({
        external_user_id: 'app-user-123',
        requested_amount: '500',
        transferred_amount: '500',
      }),
    });
  });

  it('returns existing withdrawal on idempotent coin withdraw', async () => {
    mocks.platformUserFindUnique.mockResolvedValue(existing_user);
    mocks.platformCoinWithdrawalFindUnique.mockResolvedValue({
      external_user_id: 'app-user-123',
      requested_amount: 500n,
      transferred_amount: 500n,
      wallet_ledger: { balance_after: 100n },
    });

    const result = await PlatformIntegrationService.withdrawPlatformUserCoins(platform_app, {
      external_user_id: 'app-user-123',
      amount: '500',
      client_request_id: 'withdraw-003',
    });

    expect(result.idempotent).toBe(true);
    expect(result.transferred_amount).toBe('500');
    expect(result.balance).toBe('100');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
