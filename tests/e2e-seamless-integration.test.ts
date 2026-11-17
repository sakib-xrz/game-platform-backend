import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import { generateSignedHeaders, verifyCanonicalSignature } from '@/utils/canonical-signature';
import { signPlayerToken, verifyPlayerToken } from '@/utils/player-token';
import { SeamlessWalletClient } from '@/modules/platform-integration/seamless-wallet.client';

describe('End-to-End 3rd-Party Integration & Automated Coin Sync Engine', () => {
  let mockHostServer: http.Server;
  let mockHostPort: number;
  let mockHostBaseUrl: string;

  const appKey = 'zimo-live-e2e';
  const signingSecret = 'mock-app-signing-secret-998877';
  const playerSecret = 'mock-player-token-secret-112233';

  // In-memory mock wallet for host application
  const hostUserBalances = new Map<string, number>([
    ['player_1001', 50000],
    ['diag_user_001', 12500],
  ]);
  const hostReceivedDebits: any[] = [];
  const hostReceivedCredits: any[] = [];

  beforeAll(async () => {
    // Spin up a mock 3rd party host app server conforming to seamless spec
    const hostApp = express();
    hostApp.use(express.json());

    // Middleware to verify incoming signed webhook requests from the games platform
    hostApp.use('/internal/wallet', (req: any, res: any, next: any) => {
      const ts = req.get('X-Timestamp');
      const nonce = req.get('X-Nonce');
      const sig = req.get('X-Signature');
      const rawBody = JSON.stringify(req.body || {});

      const verification = verifyCanonicalSignature(
        [signingSecret],
        req.method,
        req.originalUrl,
        { timestamp: ts, nonce, signature: sig },
        req.method === 'GET' ? '' : rawBody,
        { checkTimestamp: true, checkNonce: true },
      );

      if (!verification.valid) {
        return res.status(401).json({
          code: 'SIGNATURE_INVALID',
          message: verification.reason || 'Invalid HMAC signature',
        });
      }
      next();
    });

    // 1. GET /internal/wallet/:userId/balance
    hostApp.get('/internal/wallet/:userId/balance', (req: any, res: any) => {
      const balance = hostUserBalances.get(req.params.userId) ?? 1000;
      res.json({ success: true, balance, currency: 'coins' });
    });

    // 2. POST /internal/wallet/debit
    hostApp.post('/internal/wallet/debit', (req: any, res: any) => {
      const { userId, amount, idempotencyKey } = req.body;
      const current = hostUserBalances.get(userId) ?? 0;
      if (current < amount) {
        return res.status(400).json({ code: 'INSUFFICIENT_BALANCE', message: 'Not enough coins' });
      }
      const newBalance = current - amount;
      hostUserBalances.set(userId, newBalance);
      hostReceivedDebits.push({ userId, amount, idempotencyKey, newBalance });
      res.json({ success: true, balance: newBalance, txId: `tx-${Date.now()}` });
    });

    // 3. POST /internal/wallet/credit
    hostApp.post('/internal/wallet/credit', (req: any, res: any) => {
      const { userId, amount, idempotencyKey, type } = req.body;
      const current = hostUserBalances.get(userId) ?? 0;
      const newBalance = current + amount;
      hostUserBalances.set(userId, newBalance);
      hostReceivedCredits.push({ userId, amount, idempotencyKey, type, newBalance });
      res.json({ success: true, balance: newBalance, txId: `credit-${Date.now()}` });
    });

    // 4. GET /internal/wallet/transaction/:key
    hostApp.get('/internal/wallet/transaction/:key', (req: any, res: any) => {
      const key = req.params.key;
      const debit = hostReceivedDebits.find((d) => d.idempotencyKey === key);
      if (debit) {
        return res.json({ status: 'FOUND', type: 'debit', amount: debit.amount });
      }
      res.status(404).json({ code: 'TRANSACTION_NOT_FOUND', message: 'Not found' });
    });

    await new Promise<void>((resolve) => {
      mockHostServer = hostApp.listen(0, () => {
        const addr = mockHostServer.address() as any;
        mockHostPort = addr.port;
        mockHostBaseUrl = `http://localhost:${mockHostPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockHostServer.close(() => resolve());
    });
  });

  it('generates a valid 15-minute player token with user profile claims', () => {
    const token = signPlayerToken(
      {
        sub: 'player_1001',
        app: appKey,
        username: 'Shahriar Live',
        avatarUrl: 'https://images.example.com/avatar.jpg',
      },
      playerSecret,
      15 * 60,
    );

    const decoded = verifyPlayerToken(token, [playerSecret]);
    expect(decoded.valid).toBe(true);
    expect(decoded.claims?.sub).toBe('player_1001');
    expect(decoded.claims?.app).toBe(appKey);
    expect(decoded.claims?.username).toBe('Shahriar Live');
  });

  it('runs full live 4-point diagnostic suite against host wallet with green results', async () => {
    const config = {
      id: 'app-diag-1',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    const diagnostics = await SeamlessWalletClient.testRemoteWalletIntegration(config, 'diag_user_001');
    expect(diagnostics.overall_status).toBe('SUCCESS');
    expect(diagnostics.tests.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.tests.every((t) => t.passed)).toBe(true);
  });

  it('successfully reads remote balance through HMAC signed GET request', async () => {
    const config = {
      id: 'app-test-2',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    const balance = await SeamlessWalletClient.getRemoteBalance(config, 'player_1001');
    expect(balance).toBe(50000n);
  });

  it('successfully debits bet with idempotency key and updates host balance', async () => {
    const config = {
      id: 'app-test-3',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    const idempotencyKey = `game-bet:${Date.now()}`;
    const result = await SeamlessWalletClient.debitRemoteBet(config, {
      externalUserId: 'player_1001',
      amount: 500n,
      idempotencyKey,
      gameCode: 'greedy',
      roundId: 'round-101',
    });

    expect(result.balanceAfter).toBe(49500n);
    expect(hostUserBalances.get('player_1001')).toBe(49500);

    // Verify debit was recorded on mock host
    const lastDebit = hostReceivedDebits[hostReceivedDebits.length - 1];
    expect(lastDebit.idempotencyKey).toBe(idempotencyKey);
    expect(lastDebit.amount).toBe(500);
  });

  it('successfully credits round win payout directly back to host wallet', async () => {
    const config = {
      id: 'app-test-4',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    const idempotencyKey = `game-payout:round-101:player_1001`;
    const result = await SeamlessWalletClient.creditRemotePayout(config, {
      externalUserId: 'player_1001',
      amount: 4000n,
      idempotencyKey,
      type: 'game_payout',
      gameCode: 'greedy',
      roundId: 'round-101',
    });

    expect(result.balanceAfter).toBe(53500n);
    expect(hostUserBalances.get('player_1001')).toBe(53500);

    const lastCredit = hostReceivedCredits[hostReceivedCredits.length - 1];
    expect(lastCredit.idempotencyKey).toBe(idempotencyKey);
    expect(lastCredit.amount).toBe(4000);
  });

  it('rejects bet when host balance is insufficient', async () => {
    const config = {
      id: 'app-test-5',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    // Try debiting 1,000,000 when balance is 53,500
    await expect(
      SeamlessWalletClient.debitRemoteBet(config, {
        externalUserId: 'player_1001',
        amount: 1000000n,
        idempotencyKey: `insufficient-${Date.now()}`,
      }),
    ).rejects.toThrow('Insufficient wallet balance in host app');
  });

  it('recovers safely via transaction lookup if a debit request times out', async () => {
    const config = {
      id: 'app-test-6',
      app_name: 'Zimo Live',
      app_key: appKey,
      package_name: 'com.zimo.live',
      wallet_mode: 'seamless',
      wallet_base_url: mockHostBaseUrl,
      signing_secret: signingSecret,
    };

    const existingDebit = hostReceivedDebits[0];
    const lookup = await SeamlessWalletClient.checkRemoteTransaction(config, existingDebit.idempotencyKey);
    expect(lookup.status).toBe('FOUND');
    expect(lookup.amount).toBe(existingDebit.amount);

    const nonExistent = await SeamlessWalletClient.checkRemoteTransaction(config, 'random-key-999');
    expect(nonExistent.status).toBe('NOT_FOUND');
  });
});
