import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transferFindUnique: vi.fn(),
  transferUpdateMany: vi.fn(),
  transferCreateMany: vi.fn(),
  greedyClassicBetFindUnique: vi.fn(),
  platformAppFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const client: any = {
    seamlessWalletTransfer: {
      findUnique: mocks.transferFindUnique,
      updateMany: mocks.transferUpdateMany,
      createMany: mocks.transferCreateMany,
    },
    greedyClassicBet: { findUnique: mocks.greedyClassicBetFindUnique },
    platformApp: { findUnique: mocks.platformAppFindUnique },
    // Run the callback with the same client acting as the transaction.
    $transaction: (fn: (tx: any) => Promise<unknown>) => fn(client),
    // Immediate-dispatch claim: nothing claimed in these unit tests.
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { default: client };
});

import {
  compensateFailedSeamlessBet,
  seamlessKeys,
} from '@/modules/platform-integration/seamless-transfer.services';
import { SeamlessWalletClient } from '@/modules/platform-integration/seamless-wallet.client';

let host: http.Server;
let base_url = '';
const seen_nonces = new Set<string>();
let credit_calls = 0;
let lookup_status: 'found' | 'not_found' = 'not_found';

beforeAll(async () => {
  host = http.createServer((req, res) => {
    const nonce = String(req.headers['x-nonce'] ?? '');
    // Replay protection like a real host: a reused nonce is rejected.
    if (seen_nonces.has(nonce)) {
      res.writeHead(401).end(JSON.stringify({ code: 'NONCE_REPLAY' }));
      return;
    }
    seen_nonces.add(nonce);
    if (req.url?.startsWith('/internal/wallet/transaction/')) {
      res.writeHead(lookup_status === 'found' ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify(
          lookup_status === 'found'
            ? { found: true, type: 'debit', amount: 5000 }
            : { found: false },
        ),
      );
      return;
    }
    if (req.url === '/internal/wallet/credit') {
      credit_calls += 1;
      // First attempt fails with a transient 503.
      if (credit_calls === 1) {
        res.writeHead(503).end('busy');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, balance: 1000, txId: 'tx-1' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => host.listen(0, resolve));
  base_url = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => host.close(() => resolve())));

const app = () => ({
  id: 'app-1',
  app_name: 'Kotha live',
  app_key: 'kotha',
  package_name: 'com.kotha',
  wallet_mode: 'seamless',
  wallet_base_url: base_url,
  signing_secret: 'secret',
  signing_secret_previous: null,
});

const debitRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'transfer-1',
  idempotency_key: seamlessKeys.betDebit('bet-1'),
  status: 'pending',
  platform_app_id: 'app-1',
  user_id: 'local-user-13',
  external_user_id: '13',
  amount: 5000n,
  game_code: 'GREEDY_CLASSIC',
  round_id: 'round-1',
  reference_id: 'bet-1',
  host_confirmed_at: null,
  created_at: new Date(),
  attempt_count: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
  mocks.transferCreateMany.mockResolvedValue({ count: 1 });
  mocks.platformAppFindUnique.mockResolvedValue(app());
});

describe('orphaned bet debit compensation', () => {
  it('refunds a host-confirmed debit whose bet never committed', async () => {
    mocks.transferFindUnique.mockResolvedValue(
      debitRow({ host_confirmed_at: new Date() }),
    );
    mocks.greedyClassicBetFindUnique.mockResolvedValue(null);

    await compensateFailedSeamlessBet('bet-1');

    expect(mocks.transferUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'transfer-1', status: 'pending' },
        data: expect.objectContaining({ status: 'reversed' }),
      }),
    );
    const queued = mocks.transferCreateMany.mock.calls[0]![0].data[0];
    expect(queued).toMatchObject({
      idempotency_key: 'game-bet-reversal:bet-1',
      direction: 'credit',
      type: 'game_refund',
      amount: 5000n,
      external_user_id: '13',
    });
  });

  it('does not refund when the bet actually committed', async () => {
    mocks.transferFindUnique.mockResolvedValue(
      debitRow({ host_confirmed_at: new Date() }),
    );
    mocks.greedyClassicBetFindUnique.mockResolvedValue({ id: 'bet-1' });

    await compensateFailedSeamlessBet('bet-1');

    expect(mocks.transferCreateMany).not.toHaveBeenCalled();
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('never refunds an unconfirmed debit the host does not hold', async () => {
    lookup_status = 'not_found';
    mocks.transferFindUnique.mockResolvedValue(debitRow());
    mocks.greedyClassicBetFindUnique.mockResolvedValue(null);

    await compensateFailedSeamlessBet('bet-1');

    expect(mocks.transferCreateMany).not.toHaveBeenCalled();
    // Kept pending (grace window) instead of voided or reversed.
    const statuses = mocks.transferUpdateMany.mock.calls.map((c) => c[0].data.status);
    expect(statuses).not.toContain('reversed');
    expect(statuses).not.toContain('voided');
  });

  it('refunds an unconfirmed (timed-out) debit once the host lookup finds it', async () => {
    lookup_status = 'found';
    mocks.transferFindUnique.mockResolvedValue(debitRow());
    mocks.greedyClassicBetFindUnique.mockResolvedValue(null);

    await compensateFailedSeamlessBet('bet-1');

    expect(mocks.transferCreateMany.mock.calls[0]![0].data[0].idempotency_key).toBe(
      'game-bet-reversal:bet-1',
    );
  });
});

describe('credit client', () => {
  it('signs every retry with a fresh nonce so replay protection does not reject it', async () => {
    credit_calls = 0;
    const result = await SeamlessWalletClient.creditRemotePayout(app(), {
      externalUserId: '13',
      amount: 100000n,
      idempotencyKey: 'game-payout:round-1:local-user-13',
      type: 'game_payout',
    });
    expect(credit_calls).toBe(2);
    expect(result.txId).toBe('tx-1');
  });

  it('treats an unreachable host lookup as UNKNOWN, not NOT_FOUND', async () => {
    const lookup = await SeamlessWalletClient.checkRemoteTransaction(
      { ...app(), wallet_base_url: 'http://127.0.0.1:1' },
      'game-bet:x',
    );
    expect(lookup.status).toBe('UNKNOWN');
  });
});
