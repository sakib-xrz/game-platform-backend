import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  ensureWallet,
  WalletInitializationRequiredError,
  withWalletInitializationRetry,
} from '@/modules/wallet/wallet.services';

describe('direct bet wallet initialization', () => {
  it('initializes and returns a cold wallet with one follow-up database query', async () => {
    const created_at = new Date('2026-08-21T00:00:00.000Z');
    const walletFindFirst = vi.fn().mockResolvedValue(null);
    const queryRaw = vi.fn().mockResolvedValue([
      {
        wallet_id: 'wallet-id',
        user_id: 'new-player',
        currency_id: 'currency-id',
        balance: 0n,
        version: 0,
        wallet_created_at: created_at,
        wallet_updated_at: created_at,
        currency_code: 'COIN',
        currency_name: 'Coin',
        currency_symbol: '●',
        currency_is_active: true,
        currency_created_at: created_at,
        currency_updated_at: created_at,
      },
    ]);
    const tx = {
      wallet: { findFirst: walletFindFirst },
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;

    await expect(ensureWallet('new-player', tx)).resolves.toMatchObject({
      id: 'wallet-id',
      balance: 0n,
      version: 0,
      currency: { code: 'COIN', is_active: true },
    });
    expect(walletFindFirst).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('initializes a new player once when a direct bet precedes any snapshot', async () => {
    let wallet_exists = false;
    const operation = vi.fn(async () => {
      if (!wallet_exists) throw new WalletInitializationRequiredError();
      return { accepted: true };
    });
    const initialize = vi.fn(async () => {
      wallet_exists = true;
    });

    await expect(
      withWalletInitializationRetry('new-player', operation, initialize),
    ).resolves.toEqual({ accepted: true });
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith('new-player');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not add an initialization query for an existing wallet', async () => {
    const operation = vi.fn(async () => ({ accepted: true }));
    const initialize = vi.fn(async () => undefined);

    await expect(
      withWalletInitializationRetry('existing-player', operation, initialize),
    ).resolves.toEqual({ accepted: true });
    expect(operation).toHaveBeenCalledOnce();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('retries only once if initialization cannot make the wallet visible', async () => {
    const operation = vi.fn(async () => {
      throw new WalletInitializationRequiredError();
    });
    const initialize = vi.fn(async () => undefined);

    await expect(
      withWalletInitializationRetry('missing-player', operation, initialize),
    ).rejects.toBeInstanceOf(WalletInitializationRequiredError);
    expect(initialize).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
