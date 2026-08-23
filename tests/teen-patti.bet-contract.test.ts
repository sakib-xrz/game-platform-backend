import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeenPattiService from '@/modules/teen-patti/teen-patti.services';

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    idempotencyRecord: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    teenPattiBet: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    wallet: { findFirst: vi.fn() },
    walletLedger: { create: vi.fn() },
    outboxEvent: { createMany: vi.fn() },
  };
  return {
    tx,
    globalIdempotencyFindUnique: vi.fn(),
    ensureWallet: vi.fn(),
    acceptedDates: [] as Date[],
  };
});

vi.mock('@/lib/prisma', () => ({
  default: {
    idempotencyRecord: { findUnique: mocks.globalIdempotencyFindUnique },
  },
}));

vi.mock('@/modules/greedy/greedy.utils', () => ({
  withSerializableRetry: async <T>(
    operation: (tx: typeof mocks.tx) => Promise<T>,
  ) => operation(mocks.tx),
}));

vi.mock('@/modules/wallet/wallet.services', () => ({
  ensureWallet: mocks.ensureWallet,
  WalletInitializationRequiredError: class extends Error {},
  withWalletInitializationRetry: async <T>(
    _user_id: string,
    operation: () => Promise<T>,
  ) => operation(),
}));

const round_id = 'cm12345678901234567890123';
const hand_a = 'cm22345678901234567890123';
const hand_b = 'cm32345678901234567890123';

const barrier = (option_id: string, enabled_chip_amount: bigint | null) => ({
  id: round_id,
  game_id: 'teen-game',
  game_code: 'TEEN_PATTI',
  game_status: 'active',
  runtime_round_id: round_id,
  status: 'betting_open',
  betting_ends_at: new Date('2026-08-23T00:01:00.000Z'),
  server_now: new Date('2026-08-23T00:00:00.000Z'),
  option_id,
  enabled_chip_amount,
  min_bet: 10n,
  max_single_bet: 10_000n,
  max_round_bet: 50_000n,
});

const queueRawSuccess = (
  option_id: string,
  amount: bigint,
  wallet_version: number,
) => {
  mocks.tx.$queryRaw
    .mockResolvedValueOnce([{ id: `idempotency-${wallet_version}` }])
    .mockResolvedValueOnce([barrier(option_id, amount)])
    .mockResolvedValueOnce([
      {
        id: 'wallet-1',
        balance_before: 10_000n,
        balance_after: 10_000n - amount,
        version: wallet_version,
      },
    ]);
};

const queueAggregates = (
  exposure: bigint,
  user_total: bigint,
  bet_count: number,
  option_total: bigint,
  round_bet_count: number,
  first_bet_at: Date,
  last_bet_at: Date,
) => {
  mocks.tx.teenPattiBet.aggregate
    .mockResolvedValueOnce({ _sum: { amount: exposure } })
    .mockResolvedValueOnce({
      _sum: { amount: user_total },
      _count: { _all: bet_count },
      _min: { accepted_at: first_bet_at },
      _max: { accepted_at: last_bet_at },
    })
    .mockResolvedValueOnce({ _sum: { amount: option_total } })
    .mockResolvedValueOnce({ _count: { _all: round_bet_count } });
};

describe('Teen Patti bet transaction contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acceptedDates.length = 0;
    mocks.tx.walletLedger.create.mockResolvedValue({ id: 'ledger-1' });
    mocks.tx.idempotencyRecord.update.mockResolvedValue({});
    mocks.tx.outboxEvent.createMany.mockResolvedValue({ count: 3 });
    mocks.tx.teenPattiBet.findMany.mockResolvedValue([
      { user_id: 'player-1' },
    ]);
    mocks.tx.teenPattiBet.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => ({
        id: data.id,
        accepted_at:
          mocks.acceptedDates.shift() ??
          new Date('2026-08-23T00:00:01.000Z'),
      }),
    );
  });

  it('accepts repeated taps on the same hand and then another hand', async () => {
    const first_at = new Date('2026-08-23T00:00:01.000Z');
    const second_at = new Date('2026-08-23T00:00:02.000Z');
    const third_at = new Date('2026-08-23T00:00:03.000Z');
    mocks.acceptedDates.push(first_at, second_at, third_at);

    queueRawSuccess(hand_a, 100n, 1);
    queueRawSuccess(hand_a, 100n, 2);
    queueRawSuccess(hand_b, 500n, 3);
    queueAggregates(0n, 100n, 1, 100n, 1, first_at, first_at);
    queueAggregates(100n, 200n, 2, 200n, 2, first_at, second_at);
    queueAggregates(200n, 500n, 1, 500n, 3, third_at, third_at);

    const first = await TeenPattiService.placeBet('player-1', {
      round_id,
      option_id: hand_a,
      amount: '100',
      client_request_id: 'request-000001',
    });
    const second = await TeenPattiService.placeBet('player-1', {
      round_id,
      option_id: hand_a,
      amount: '100',
      client_request_id: 'request-000002',
    });
    const third = await TeenPattiService.placeBet('player-1', {
      round_id,
      option_id: hand_b,
      amount: '500',
      client_request_id: 'request-000003',
    });

    expect([first.option_id, second.option_id, third.option_id]).toEqual([
      hand_a,
      hand_a,
      hand_b,
    ]);
    expect(mocks.tx.teenPattiBet.create).toHaveBeenCalledTimes(3);
    expect(
      mocks.tx.teenPattiBet.create.mock.calls.map(
        ([call]) => call.data.option_version_id,
      ),
    ).toEqual([hand_a, hand_a, hand_b]);
    expect(
      mocks.tx.outboxEvent.createMany.mock.calls.map(
        ([call]) => call.data[1].payload.round_bet_count,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('rejects an arbitrary amount even when it is within min/max limits', async () => {
    mocks.tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'idempotency-invalid-chip' }])
      .mockResolvedValueOnce([barrier(hand_a, null)]);

    await expect(
      TeenPattiService.placeBet('player-1', {
        round_id,
        option_id: hand_a,
        amount: '250',
        client_request_id: 'request-invalid-chip',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Bet amount is not an enabled chip denomination',
    });
    expect(mocks.tx.teenPattiBet.create).not.toHaveBeenCalled();
    expect(mocks.tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it('writes the public aggregate event beside private bet and wallet events', async () => {
    const accepted_at = new Date('2026-08-23T00:00:02.000Z');
    const first_bet_at = new Date('2026-08-23T00:00:01.000Z');
    mocks.acceptedDates.push(accepted_at);
    queueRawSuccess(hand_a, 500n, 9);
    queueAggregates(200n, 700n, 2, 1_700n, 9, first_bet_at, accepted_at);
    mocks.tx.teenPattiBet.findMany.mockResolvedValue([
      { user_id: 'player-1' },
      { user_id: 'player-2' },
      { user_id: 'player-3' },
    ]);

    await TeenPattiService.placeBet('player-1', {
      round_id,
      option_id: hand_a,
      amount: '500',
      client_request_id: 'request-public-event',
    });

    const events = mocks.tx.outboxEvent.createMany.mock.calls[0]![0].data;
    expect(events.map((event: { event_type: string }) => event.event_type)).toEqual([
      'teen_patti.bet.accepted',
      'teen_patti.bet.placed',
      'wallet.balance.updated',
    ]);
    expect(events[1]).toMatchObject({
      event_type: 'teen_patti.bet.placed',
      socket_room: 'game:teen-patti',
      payload: {
        round_id,
        option_id: hand_a,
        user_id: 'player-1',
        display_name: 'Player ayer-1',
        avatar_url: null,
        amount: '500',
        accepted_at: accepted_at.toISOString(),
        user_total_amount: '700',
        option_total_amount: '1700',
        bet_count: 2,
        first_bet_at: first_bet_at.toISOString(),
        last_bet_at: accepted_at.toISOString(),
        player_count: 3,
        round_bet_count: 9,
      },
    });
    expect(events[1].payload).not.toHaveProperty('wallet_balance');
    expect(events[1].payload).not.toHaveProperty('client_request_id');
  });
});
