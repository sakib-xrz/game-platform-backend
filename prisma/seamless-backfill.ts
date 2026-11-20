/**
 * One-off recovery for seamless (host-wallet) players affected by the
 * missing-credit and orphaned-debit bugs.
 *
 *   # 1. Wins / cancelled-round refunds that were never sent to the host
 *   npx tsx prisma/seamless-backfill.ts payouts --app-id <platformAppId>            (dry run)
 *   npx tsx prisma/seamless-backfill.ts payouts --app-id <platformAppId> --apply
 *
 *   # 2. Bet debits the host took but whose bet never committed here.
 *   #    CSV from the host, one per line:  idempotencyKey,externalUserId,amount
 *   npx tsx prisma/seamless-backfill.ts orphans --app-id <id> --file orphans.csv            (dry run)
 *   npx tsx prisma/seamless-backfill.ts orphans --app-id <id> --file orphans.csv --apply
 *
 * --apply only INSERTS rows into seamless_wallet_transfers. The worker's
 * dispatcher delivers them to POST /internal/wallet/credit with deterministic
 * idempotency keys, so running this twice never pays twice.
 *
 * Only rounds whose bets were actually debited through the host wallet
 * (bet debit ledger metadata.seamless = true) are eligible, so nothing that
 * was played in local-wallet mode is ever credited to the host.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { Prisma } from '@/generated/prisma/client';
import { SeamlessWalletClient } from '@/modules/platform-integration/seamless-wallet.client';
import { seamlessKeys } from '@/modules/platform-integration/seamless-transfer.services';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes('--apply');
const app_id = flag('--app-id');

type Owed = {
  idempotency_key: string;
  type: 'game_payout' | 'game_refund';
  user_id: string;
  external_user_id: string;
  amount: bigint;
  game_code: string;
  round_id: string | null;
  reference_id: string;
};

const GAMES = [
  { code: 'GREEDY', bets: 'greedy_bets', payouts: 'greedy_user_payouts', refunds: 'greedy_user_refunds' },
  { code: 'GREEDY_CLASSIC', bets: 'greedy_classic_bets', payouts: 'greedy_classic_user_payouts', refunds: 'greedy_classic_user_refunds' },
  { code: 'LUCKY_77', bets: 'lucky_77_bets', payouts: 'lucky_77_user_payouts', refunds: 'lucky_77_user_refunds' },
  { code: 'TEEN_PATTI', bets: 'teen_patti_bets', payouts: 'teen_patti_user_payouts', refunds: 'teen_patti_user_refunds' },
] as const;

const findOwedCredits = async (platform_app_id: string): Promise<Owed[]> => {
  const owed: Owed[] = [];
  for (const game of GAMES) {
    for (const kind of ['payout', 'refund'] as const) {
      const table = kind === 'payout' ? game.payouts : game.refunds;
      const amount_col = kind === 'payout' ? 'total_payout' : 'total_bet_amount';
      const key_prefix = kind === 'payout' ? 'game-payout:' : 'game-refund:';
      const rows = await prisma.$queryRaw<Array<{
        round_id: string; user_id: string; external_user_id: string; amount: bigint;
      }>>(Prisma.sql`
        SELECT p.round_id, p.user_id, pu.external_user_id, p.${Prisma.raw(amount_col)} AS amount
        FROM ${Prisma.raw(table)} p
        JOIN platform_users pu ON pu.id = p.user_id AND pu.platform_app_id = ${platform_app_id}
        JOIN wallet_ledger pl ON pl.id = p.wallet_ledger_id
        WHERE p.${Prisma.raw(amount_col)} > 0
          -- the player's stake for this round really went through the host wallet
          AND EXISTS (
            SELECT 1 FROM ${Prisma.raw(game.bets)} b
            JOIN wallet_ledger bl ON bl.id = b.wallet_debit_ledger_id
            WHERE b.round_id = p.round_id AND b.user_id = p.user_id
              AND (bl.metadata->>'seamless') = 'true'
          )
          -- old Greedy code already sent its payouts over HTTP
          AND COALESCE(pl.metadata->>'seamless', 'false') <> 'true'
          -- not already queued / delivered by the new pipeline
          AND NOT EXISTS (
            SELECT 1 FROM seamless_wallet_transfers t
            WHERE t.idempotency_key = ${key_prefix} || p.round_id || ':' || p.user_id
          )
        ORDER BY p.created_at ASC
      `);
      for (const r of rows) {
        owed.push({
          idempotency_key:
            kind === 'payout'
              ? seamlessKeys.roundPayout(r.round_id, r.user_id)
              : seamlessKeys.roundRefund(r.round_id, r.user_id),
          type: kind === 'payout' ? 'game_payout' : 'game_refund',
          user_id: r.user_id,
          external_user_id: r.external_user_id,
          amount: r.amount,
          game_code: game.code,
          round_id: r.round_id,
          reference_id: r.round_id,
        });
      }
    }
  }
  return owed;
};

const findOrphanReversals = async (platform_app_id: string, file: string): Promise<Owed[]> => {
  const app = await prisma.platformApp.findUniqueOrThrow({ where: { id: platform_app_id } });
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.toLowerCase().startsWith('idempotency'));
  const owed: Owed[] = [];
  for (const line of lines) {
    const [key = '', external_user_id = '', amount_raw = ''] = line.split(',').map((v) => v.trim());
    if (!key.startsWith('game-bet:')) {
      console.log(`SKIP  ${key}: not a bet debit key`);
      continue;
    }
    const bet_id = key.slice('game-bet:'.length);
    const where = { where: { id: bet_id }, select: { id: true } } as const;
    const [a, b, c, d] = await Promise.all([
      prisma.greedyBet.findUnique(where),
      prisma.greedyClassicBet.findUnique(where),
      prisma.lucky77Bet.findUnique(where),
      prisma.teenPattiBet.findUnique(where),
    ]);
    if (a || b || c || d) {
      console.log(`SKIP  ${key}: bet exists here, debit was legitimate`);
      continue;
    }
    const user = await prisma.platformUser.findUnique({
      where: { platform_app_id_external_user_id: { platform_app_id, external_user_id } },
      select: { id: true },
    });
    if (!user) {
      console.log(`SKIP  ${key}: unknown external user ${external_user_id}`);
      continue;
    }
    const lookup = await SeamlessWalletClient.checkRemoteTransaction(app, key);
    if (lookup.status !== 'FOUND') {
      console.log(`SKIP  ${key}: host lookup ${lookup.status}${lookup.error ? ` (${lookup.error})` : ''}`);
      continue;
    }
    const amount = BigInt(amount_raw || String(lookup.amount ?? 0));
    if (lookup.amount !== undefined && BigInt(String(lookup.amount)) !== amount) {
      console.log(`SKIP  ${key}: amount mismatch csv=${amount} host=${lookup.amount}`);
      continue;
    }
    if (amount <= 0n) {
      console.log(`SKIP  ${key}: no amount`);
      continue;
    }
    owed.push({
      idempotency_key: seamlessKeys.betReversal(bet_id),
      type: 'game_refund',
      user_id: user.id,
      external_user_id,
      amount,
      game_code: 'UNKNOWN',
      round_id: null,
      reference_id: bet_id,
    });
  }
  return owed;
};

const main = async () => {
  if (!app_id || (mode !== 'payouts' && mode !== 'orphans')) {
    console.error('usage: payouts|orphans --app-id <id> [--file orphans.csv] [--apply]');
    process.exit(1);
  }
  const owed =
    mode === 'payouts'
      ? await findOwedCredits(app_id)
      : await findOrphanReversals(app_id, flag('--file') ?? '');

  const by_user = new Map<string, bigint>();
  for (const o of owed) {
    console.log(`OWE   ${o.idempotency_key}  ext_user=${o.external_user_id}  ${o.type}  ${o.amount}`);
    by_user.set(o.external_user_id, (by_user.get(o.external_user_id) ?? 0n) + o.amount);
  }
  console.log('\nTotals per host user:');
  for (const [user, total] of by_user) console.log(`  ${user}: ${total}`);
  console.log(`\n${owed.length} credit(s), ${[...by_user.values()].reduce((s, v) => s + v, 0n)} coins total.`);

  if (!apply) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to queue these credits.');
    return;
  }
  const result = await prisma.seamlessWalletTransfer.createMany({
    data: owed.map((o) => ({
      id: randomUUID(),
      idempotency_key: o.idempotency_key,
      direction: 'credit' as const,
      type: o.type,
      status: 'pending' as const,
      platform_app_id: app_id,
      user_id: o.user_id,
      external_user_id: o.external_user_id,
      amount: o.amount,
      game_code: o.game_code,
      round_id: o.round_id,
      reference_id: o.reference_id,
    })),
    skipDuplicates: true,
  });
  console.log(`\nQueued ${result.count} credit(s). The worker will deliver them within seconds.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
