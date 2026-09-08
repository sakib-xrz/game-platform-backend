import httpStatus from 'http-status';
import { Prisma } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { getActiveBotIds } from '@/modules/game-bot/bot-identity';
import { getPagination } from '@/utils/pagination';
import type {
  AnalyticsOverviewQuery,
  AnalyticsUserDetailQuery,
  AnalyticsUsersQuery,
} from './analytics.validation';

const TIMEZONE = 'Asia/Dhaka';

type GameCode = 'GREEDY' | 'GREEDY_CLASSIC' | 'LUCKY_77' | 'TEEN_PATTI';

type GameTableSet = {
  code: GameCode;
  label: string;
  bets: string;
  payouts: string;
  refunds: string;
  rounds: string;
  options: string;
  settlements: string;
};

const GAME_TABLES: GameTableSet[] = [
  {
    code: 'GREEDY',
    label: 'Greedy',
    bets: 'greedy_bets',
    payouts: 'greedy_user_payouts',
    refunds: 'greedy_user_refunds',
    rounds: 'greedy_rounds',
    options: 'greedy_option_versions',
    settlements: 'greedy_bet_settlements',
  },
  {
    code: 'GREEDY_CLASSIC',
    label: 'Greedy Classic',
    bets: 'greedy_classic_bets',
    payouts: 'greedy_classic_user_payouts',
    refunds: 'greedy_classic_user_refunds',
    rounds: 'greedy_classic_rounds',
    options: 'greedy_classic_option_versions',
    settlements: 'greedy_classic_bet_settlements',
  },
  {
    code: 'LUCKY_77',
    label: 'Lucky 77',
    bets: 'lucky_77_bets',
    payouts: 'lucky_77_user_payouts',
    refunds: 'lucky_77_user_refunds',
    rounds: 'lucky_77_rounds',
    options: 'lucky_77_option_versions',
    settlements: 'lucky_77_bet_settlements',
  },
  {
    code: 'TEEN_PATTI',
    label: 'Teen Patti',
    bets: 'teen_patti_bets',
    payouts: 'teen_patti_user_payouts',
    refunds: 'teen_patti_user_refunds',
    rounds: 'teen_patti_rounds',
    options: 'teen_patti_option_versions',
    settlements: 'teen_patti_bet_settlements',
  },
];

const resolveWindow = (query: { from?: Date; to?: Date }) => {
  const now = new Date();
  const to = query.to ?? now;
  const from =
    query.from ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  if (from >= to) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Analytics from must be before to');
  }
  return { from, to };
};

const toBigInt = (value: string | number | bigint | null | undefined): bigint => {
  if (value === null || value === undefined) return 0n;
  return BigInt(value);
};

const money = (value: bigint) => value.toString();

type Totals = {
  accepted_stake: bigint;
  refunded_stake: bigint;
  payout: bigint;
};

const emptyTotals = (): Totals => ({
  accepted_stake: 0n,
  refunded_stake: 0n,
  payout: 0n,
});

const addTotals = (left: Totals, right: Totals): Totals => ({
  accepted_stake: left.accepted_stake + right.accepted_stake,
  refunded_stake: left.refunded_stake + right.refunded_stake,
  payout: left.payout + right.payout,
});

const profitOf = (totals: Totals) =>
  totals.accepted_stake - totals.refunded_stake - totals.payout;

/** Exclude bot stake/payouts so house profit reflects real players only. */
const excludeBotsSql = (column: string, botIds: string[]) => {
  if (botIds.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.raw(column)} NOT IN (${Prisma.join(botIds)})`;
};

const aggregateGameWindow = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
): Promise<Totals> => {
  const [bets, payouts, refunds] = await Promise.all([
    prisma.$queryRaw<Array<{ amount: string }>>(Prisma.sql`
      SELECT COALESCE(SUM(amount), 0)::text AS amount
      FROM ${Prisma.raw(tables.bets)}
      WHERE created_at >= ${from} AND created_at <= ${to}
      ${excludeBotsSql('user_id', botIds)}
    `),
    prisma.$queryRaw<Array<{ amount: string }>>(Prisma.sql`
      SELECT COALESCE(SUM(p.total_payout), 0)::text AS amount
      FROM ${Prisma.raw(tables.payouts)} p
      JOIN ${Prisma.raw(tables.rounds)} r ON r.id = p.round_id
      WHERE p.created_at >= ${from} AND p.created_at <= ${to}
      ${excludeBotsSql('p.user_id', botIds)}
    `),
    prisma.$queryRaw<Array<{ amount: string }>>(Prisma.sql`
      SELECT COALESCE(SUM(f.total_bet_amount), 0)::text AS amount
      FROM ${Prisma.raw(tables.refunds)} f
      JOIN ${Prisma.raw(tables.rounds)} r ON r.id = f.round_id
      WHERE f.created_at >= ${from} AND f.created_at <= ${to}
      ${excludeBotsSql('f.user_id', botIds)}
    `),
  ]);

  return {
    accepted_stake: toBigInt(bets[0]?.amount),
    refunded_stake: toBigInt(refunds[0]?.amount),
    payout: toBigInt(payouts[0]?.amount),
  };
};

const monthlySeriesForGame = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
) => {
  const [bets, payouts, refunds] = await Promise.all([
    prisma.$queryRaw<Array<{ month: string; amount: string }>>(Prisma.sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE}, 'YYYY-MM') AS month,
             COALESCE(SUM(amount), 0)::text AS amount
      FROM ${Prisma.raw(tables.bets)}
      WHERE created_at >= ${from} AND created_at <= ${to}
      ${excludeBotsSql('user_id', botIds)}
      GROUP BY month
      ORDER BY month
    `),
    prisma.$queryRaw<Array<{ month: string; amount: string }>>(Prisma.sql`
      SELECT to_char((p.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE}, 'YYYY-MM') AS month,
             COALESCE(SUM(p.total_payout), 0)::text AS amount
      FROM ${Prisma.raw(tables.payouts)} p
      JOIN ${Prisma.raw(tables.rounds)} r ON r.id = p.round_id
      WHERE p.created_at >= ${from} AND p.created_at <= ${to}
      ${excludeBotsSql('p.user_id', botIds)}
      GROUP BY month
      ORDER BY month
    `),
    prisma.$queryRaw<Array<{ month: string; amount: string }>>(Prisma.sql`
      SELECT to_char((f.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE}, 'YYYY-MM') AS month,
             COALESCE(SUM(f.total_bet_amount), 0)::text AS amount
      FROM ${Prisma.raw(tables.refunds)} f
      JOIN ${Prisma.raw(tables.rounds)} r ON r.id = f.round_id
      WHERE f.created_at >= ${from} AND f.created_at <= ${to}
      ${excludeBotsSql('f.user_id', botIds)}
      GROUP BY month
      ORDER BY month
    `),
  ]);

  const map = new Map<string, Totals>();
  const bucket = (month: string) => {
    const existing = map.get(month) ?? emptyTotals();
    map.set(month, existing);
    return existing;
  };
  for (const row of bets) bucket(row.month).accepted_stake += toBigInt(row.amount);
  for (const row of refunds) bucket(row.month).refunded_stake += toBigInt(row.amount);
  for (const row of payouts) bucket(row.month).payout += toBigInt(row.amount);
  return map;
};

const monthlyDepositsWithdrawals = async (from: Date, to: Date) => {
  const [deposits, withdrawals] = await Promise.all([
    prisma.$queryRaw<Array<{ month: string; amount: string }>>(Prisma.sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE}, 'YYYY-MM') AS month,
             COALESCE(SUM(converted_amount), 0)::text AS amount
      FROM platform_coin_deposits
      WHERE created_at >= ${from} AND created_at <= ${to}
      GROUP BY month
      ORDER BY month
    `),
    prisma.$queryRaw<Array<{ month: string; amount: string }>>(Prisma.sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE}, 'YYYY-MM') AS month,
             COALESCE(SUM(transferred_amount), 0)::text AS amount
      FROM platform_coin_withdrawals
      WHERE created_at >= ${from} AND created_at <= ${to}
      GROUP BY month
      ORDER BY month
    `),
  ]);
  return { deposits, withdrawals };
};

const excludeBotsListSql = (botIds: string[]) => {
  if (botIds.length === 0) return Prisma.empty;
  return Prisma.sql`AND user_id NOT IN (${Prisma.join(botIds)})`;
};

/** Real humans who placed at least one bet in the window (bots excluded). */
const countHumanPlayers = async (from: Date, to: Date, botIds: string[]) => {
  const unions = GAME_TABLES.map(
    (tables) => Prisma.sql`
      SELECT DISTINCT user_id
      FROM ${Prisma.raw(tables.bets)}
      WHERE created_at >= ${from} AND created_at <= ${to}
      ${excludeBotsListSql(botIds)}
    `,
  );
  const rows = await prisma.$queryRaw<Array<{ total: string }>>(Prisma.sql`
    SELECT COUNT(*)::text AS total
    FROM (
      SELECT DISTINCT players.user_id
      FROM (
        ${Prisma.join(unions, ' UNION ')}
      ) players
      INNER JOIN platform_users pu ON pu.id = players.user_id
    ) counted
  `);
  return Number(rows[0]?.total ?? 0);
};

/**
 * Humans whose betting net is negative in the window.
 * Company profit from a user = -(bet + win + refund ledger) = coins the house kept.
 */
const countHumanLosers = async (from: Date, to: Date, botIds: string[]) => {
  const rows = await prisma.$queryRaw<Array<{ total: string }>>(Prisma.sql`
    SELECT COUNT(*)::text AS total
    FROM (
      SELECT wl.user_id
      FROM wallet_ledger wl
      INNER JOIN platform_users pu ON pu.id = wl.user_id
      WHERE wl.created_at >= ${from}
        AND wl.created_at <= ${to}
        AND wl.type IN ('bet_debit', 'win_credit', 'bet_refund')
        ${excludeBotsListSql(botIds)}
      GROUP BY wl.user_id
      HAVING SUM(wl.amount) < 0
    ) losers
  `);
  return Number(rows[0]?.total ?? 0);
};

const getOverview = async (query: AnalyticsOverviewQuery) => {
  const { from, to } = resolveWindow(query);
  const botIds = [...(await getActiveBotIds())];

  const perGame = await Promise.all(
    GAME_TABLES.map(async (tables) => {
      const totals = await aggregateGameWindow(tables, from, to, botIds);
      return { tables, totals };
    }),
  );

  const overall = perGame.reduce((acc, row) => addTotals(acc, row.totals), emptyTotals());
  const company_profit = profitOf(overall);

  const [depositAgg, withdrawalAgg, human_players, human_losers] = await Promise.all([
    prisma.platformCoinDeposit.aggregate({
      where: { created_at: { gte: from, lte: to } },
      _sum: { converted_amount: true },
      _count: { _all: true },
    }),
    prisma.platformCoinWithdrawal.aggregate({
      where: { created_at: { gte: from, lte: to } },
      _sum: { transferred_amount: true },
      _count: { _all: true },
    }),
    countHumanPlayers(from, to, botIds),
    countHumanLosers(from, to, botIds),
  ]);

  const points_converted = depositAgg._sum.converted_amount ?? 0n;
  const withdrawals = withdrawalAgg._sum.transferred_amount ?? 0n;

  const monthlyMaps = await Promise.all(
    GAME_TABLES.map((tables) => monthlySeriesForGame(tables, from, to, botIds)),
  );
  const { deposits: depositMonths, withdrawals: withdrawalMonths } =
    await monthlyDepositsWithdrawals(from, to);

  const monthKeys = new Set<string>();
  for (const map of monthlyMaps) for (const key of map.keys()) monthKeys.add(key);
  for (const row of depositMonths) monthKeys.add(row.month);
  for (const row of withdrawalMonths) monthKeys.add(row.month);

  const depositByMonth = new Map(depositMonths.map((row) => [row.month, toBigInt(row.amount)]));
  const withdrawalByMonth = new Map(
    withdrawalMonths.map((row) => [row.month, toBigInt(row.amount)]),
  );

  const monthly_series = [...monthKeys].sort().map((month) => {
    const totals = monthlyMaps.reduce((acc, map) => addTotals(acc, map.get(month) ?? emptyTotals()), emptyTotals());
    return {
      month,
      sales: money(totals.accepted_stake),
      points_converted: money(depositByMonth.get(month) ?? 0n),
      withdrawals: money(withdrawalByMonth.get(month) ?? 0n),
      accepted_stake: money(totals.accepted_stake),
      refunded_stake: money(totals.refunded_stake),
      payout: money(totals.payout),
      profit: money(profitOf(totals)),
    };
  });

  return {
    timezone: TIMEZONE,
    window: { from, to },
    summary: {
      sales: money(overall.accepted_stake),
      points_converted: money(points_converted),
      /** House coins kept from real humans: stake − refunds − payouts */
      profit: money(company_profit),
      accepted_stake: money(overall.accepted_stake),
      refunded_stake: money(overall.refunded_stake),
      payout: money(overall.payout),
      withdrawals: money(withdrawals),
      deposit_count: depositAgg._count._all,
      withdrawal_count: withdrawalAgg._count._all,
      human_players,
      human_losers,
    },
    by_game: perGame.map(({ tables, totals }) => ({
      game_code: tables.code,
      game_name: tables.label,
      sales: money(totals.accepted_stake),
      accepted_stake: money(totals.accepted_stake),
      refunded_stake: money(totals.refunded_stake),
      payout: money(totals.payout),
      profit: money(profitOf(totals)),
    })),
    monthly_series,
  };
};

const listUsers = async (query: AnalyticsUsersQuery) => {
  const { from, to } = resolveWindow(query);
  const pagination = getPagination(query.page, query.limit);
  const limitSql = Prisma.raw(String(pagination.limit));
  const offsetSql = Prisma.raw(String(pagination.skip));
  const botIds = await getActiveBotIds();
  const search = query.search.trim();
  const playersOnly = query.players_only !== false;

  const platformFilters: Prisma.Sql[] = [];
  if (botIds.length) {
    platformFilters.push(Prisma.sql`pu.id NOT IN (${Prisma.join(botIds)})`);
  }
  if (query.platform_app_id) {
    platformFilters.push(Prisma.sql`pu.platform_app_id = ${query.platform_app_id}`);
  }
  if (search) {
    const pattern = `%${search}%`;
    platformFilters.push(Prisma.sql`(
      pu.external_user_id ILIKE ${pattern}
      OR pu.email ILIKE ${pattern}
      OR pu.display_name ILIKE ${pattern}
    )`);
  }

  const platformWhere =
    platformFilters.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(platformFilters, ' AND ')}`
      : Prisma.sql``;

  const sortColumnMap = {
    lost: 'lost',
    won: 'won',
    coins_added: 'coins_added',
    net_result: 'net_result',
    balance: 'balance',
    company_profit: 'company_profit',
  } as const;
  const sortColumn = sortColumnMap[query.sort] ?? 'company_profit';
  const sortDir = query.sort_dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  const activityFilter = playersOnly
    ? Prisma.sql`WHERE e.bet_total > 0`
    : Prisma.sql``;

  const rows = await prisma.$queryRaw<
    Array<{
      platform_user_id: string;
      external_user_id: string;
      email: string;
      display_name: string;
      app_name: string;
      package_name: string;
      balance: string;
      coins_added: string;
      won: string;
      bet_total: string;
      refunded: string;
      net_result: string;
      lost: string;
      company_profit: string;
    }>
  >(Prisma.sql`
    WITH ledger_agg AS (
      SELECT
        wl.user_id,
        COALESCE(SUM(CASE WHEN wl.type IN ('purchase_credit', 'admin_credit') THEN wl.amount ELSE 0 END), 0) AS coins_added,
        COALESCE(SUM(CASE WHEN wl.type = 'win_credit' THEN wl.amount ELSE 0 END), 0) AS won,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_debit' THEN -wl.amount ELSE 0 END), 0) AS bet_total,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_refund' THEN wl.amount ELSE 0 END), 0) AS refunded,
        COALESCE(SUM(CASE WHEN wl.type IN ('bet_debit', 'win_credit', 'bet_refund') THEN wl.amount ELSE 0 END), 0) AS net_result
      FROM wallet_ledger wl
      WHERE wl.created_at >= ${from}
        AND wl.created_at <= ${to}
      GROUP BY wl.user_id
    ),
    enriched AS (
      SELECT
        pu.id AS platform_user_id,
        pu.external_user_id,
        pu.email,
        pu.display_name,
        pa.app_name,
        pa.package_name,
        COALESCE(la.coins_added, 0) AS coins_added,
        COALESCE(la.won, 0) AS won,
        COALESCE(la.bet_total, 0) AS bet_total,
        COALESCE(la.refunded, 0) AS refunded,
        COALESCE(la.net_result, 0) AS net_result,
        GREATEST(-COALESCE(la.net_result, 0), 0) AS lost,
        -COALESCE(la.net_result, 0) AS company_profit,
        COALESCE(w.balance, 0) AS balance
      FROM platform_users pu
      INNER JOIN platform_apps pa ON pa.id = pu.platform_app_id
      LEFT JOIN ledger_agg la ON la.user_id = pu.id
      LEFT JOIN (
        SELECT w.user_id, w.balance
        FROM wallets w
        INNER JOIN currencies c ON c.id = w.currency_id
        WHERE c.code = 'COIN' AND c.is_active = true
      ) w ON w.user_id = pu.id
      ${platformWhere}
    )
    SELECT
      platform_user_id,
      external_user_id,
      email,
      display_name,
      app_name,
      package_name,
      coins_added::text AS coins_added,
      won::text AS won,
      bet_total::text AS bet_total,
      refunded::text AS refunded,
      net_result::text AS net_result,
      lost::text AS lost,
      company_profit::text AS company_profit,
      balance::text AS balance
    FROM enriched e
    ${activityFilter}
    ORDER BY ${Prisma.raw(`e.${sortColumn}`)} ${sortDir}, e.platform_user_id ASC
    LIMIT ${limitSql}
    OFFSET ${offsetSql}
  `);

  const countRows = await prisma.$queryRaw<Array<{ total: string }>>(Prisma.sql`
    WITH ledger_agg AS (
      SELECT
        wl.user_id,
        COALESCE(SUM(CASE WHEN wl.type = 'bet_debit' THEN -wl.amount ELSE 0 END), 0) AS bet_total
      FROM wallet_ledger wl
      WHERE wl.created_at >= ${from}
        AND wl.created_at <= ${to}
      GROUP BY wl.user_id
    ),
    enriched AS (
      SELECT
        pu.id AS platform_user_id,
        COALESCE(la.bet_total, 0) AS bet_total
      FROM platform_users pu
      INNER JOIN platform_apps pa ON pa.id = pu.platform_app_id
      LEFT JOIN ledger_agg la ON la.user_id = pu.id
      ${platformWhere}
    )
    SELECT COUNT(*)::text AS total
    FROM enriched e
    ${activityFilter}
  `);

  return {
    items: rows.map((row) => ({
      platform_user_id: row.platform_user_id,
      external_user_id: row.external_user_id,
      email: row.email,
      display_name: row.display_name,
      app_name: row.app_name,
      package_name: row.package_name,
      balance: row.balance,
      coins_added: row.coins_added,
      won: row.won,
      lost: row.lost,
      company_profit: row.company_profit,
      bet_total: row.bet_total,
      refunded: row.refunded,
      net_result: row.net_result,
    })),
    total: Number(countRows[0]?.total ?? 0),
    ...pagination,
  };
};

const getUserDetail = async (user_id: string, query: AnalyticsUserDetailQuery) => {
  const { from, to } = resolveWindow(query);
  const pagination = getPagination(query.page, query.limit);
  const botIds = await getActiveBotIds();
  if (botIds.includes(user_id)) {
    throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  }

  const user = await prisma.platformUser.findUnique({
    where: { id: user_id },
    select: {
      id: true,
      external_user_id: true,
      email: true,
      display_name: true,
      photo_url: true,
      created_at: true,
      platform_app: { select: { id: true, app_name: true, package_name: true } },
    },
  });
  if (!user) throw new AppError(httpStatus.NOT_FOUND, 'User not found');

  const wallet = await prisma.wallet.findFirst({
    where: { user_id, currency: { code: 'COIN', is_active: true } },
    select: { balance: true },
  });

  const ledgerRows = await prisma.$queryRaw<
    Array<{
      coins_added: string;
      won: string;
      bet_total: string;
      refunded: string;
      net_result: string;
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(CASE WHEN type IN ('purchase_credit', 'admin_credit') THEN amount ELSE 0 END), 0)::text AS coins_added,
      COALESCE(SUM(CASE WHEN type = 'win_credit' THEN amount ELSE 0 END), 0)::text AS won,
      COALESCE(SUM(CASE WHEN type = 'bet_debit' THEN -amount ELSE 0 END), 0)::text AS bet_total,
      COALESCE(SUM(CASE WHEN type = 'bet_refund' THEN amount ELSE 0 END), 0)::text AS refunded,
      COALESCE(SUM(CASE WHEN type IN ('bet_debit', 'win_credit', 'bet_refund') THEN amount ELSE 0 END), 0)::text AS net_result
    FROM wallet_ledger
    WHERE user_id = ${user_id}
      AND created_at >= ${from}
      AND created_at <= ${to}
  `);

  const coins_added = ledgerRows[0]?.coins_added ?? '0';
  const won = ledgerRows[0]?.won ?? '0';
  const bet_total = ledgerRows[0]?.bet_total ?? '0';
  const refunded = ledgerRows[0]?.refunded ?? '0';
  const net_result = ledgerRows[0]?.net_result ?? '0';
  const net = toBigInt(net_result);
  const company_profit = (-net).toString();
  const lost = (net < 0n ? -net : 0n).toString();

  const betUnions = GAME_TABLES.map(
    (tables) => Prisma.sql`
      SELECT
        ${tables.code} AS game_code,
        ${tables.label} AS game_name,
        b.id AS bet_id,
        b.round_id,
        b.amount AS amount,
        o.code AS option_code,
        o.name AS option_name,
        s.outcome::text AS outcome,
        COALESCE(s.payout_amount, 0) AS payout_amount,
        b.created_at
      FROM ${Prisma.raw(tables.bets)} b
      INNER JOIN ${Prisma.raw(tables.options)} o ON o.id = b.option_version_id
      LEFT JOIN ${Prisma.raw(tables.settlements)} s ON s.bet_id = b.id
      WHERE b.user_id = ${user_id}
        AND b.created_at >= ${from}
        AND b.created_at <= ${to}
    `,
  );

  const [gameRows, gameCountRows, perGameRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        game_code: string;
        game_name: string;
        bet_id: string;
        round_id: string;
        amount: bigint;
        option_code: string;
        option_name: string;
        outcome: string | null;
        payout_amount: bigint;
        created_at: Date;
      }>
    >(Prisma.sql`
      SELECT *
      FROM (
        ${Prisma.join(betUnions, ' UNION ALL ')}
      ) games
      ORDER BY created_at DESC
      LIMIT ${Prisma.raw(String(pagination.limit))}
      OFFSET ${Prisma.raw(String(pagination.skip))}
    `),
    prisma.$queryRaw<Array<{ total: string }>>(Prisma.sql`
      SELECT COUNT(*)::text AS total
      FROM (
        ${Prisma.join(betUnions, ' UNION ALL ')}
      ) games
    `),
    prisma.$queryRaw<
      Array<{
        game_code: string;
        game_name: string;
        bet_count: string;
        bet_total: string;
        payout_total: string;
      }>
    >(Prisma.sql`
      SELECT
        game_code,
        game_name,
        COUNT(*)::text AS bet_count,
        COALESCE(SUM(amount), 0)::text AS bet_total,
        COALESCE(SUM(payout_amount), 0)::text AS payout_total
      FROM (
        ${Prisma.join(betUnions, ' UNION ALL ')}
      ) games
      GROUP BY game_code, game_name
      ORDER BY game_name
    `),
  ]);

  return {
    user: {
      platform_user_id: user.id,
      external_user_id: user.external_user_id,
      email: user.email,
      display_name: user.display_name,
      photo_url: user.photo_url,
      created_at: user.created_at,
      app_name: user.platform_app.app_name,
      package_name: user.platform_app.package_name,
      platform_app_id: user.platform_app.id,
    },
    window: { from, to },
    summary: {
      balance: (wallet?.balance ?? 0n).toString(),
      coins_added,
      won,
      lost,
      company_profit,
      bet_total,
      refunded,
      net_result,
    },
    by_game: perGameRows.map((row) => ({
      game_code: row.game_code,
      game_name: row.game_name,
      bet_count: Number(row.bet_count),
      bet_total: row.bet_total,
      payout_total: row.payout_total,
      company_profit: (toBigInt(row.bet_total) - toBigInt(row.payout_total)).toString(),
    })),
    game_records: {
      items: gameRows.map((row) => ({
        game_code: row.game_code,
        game_name: row.game_name,
        bet_id: row.bet_id,
        round_id: row.round_id,
        amount: row.amount.toString(),
        option_code: row.option_code,
        option_name: row.option_name,
        outcome: row.outcome,
        payout_amount: row.payout_amount.toString(),
        created_at: row.created_at,
      })),
      total: Number(gameCountRows[0]?.total ?? 0),
      ...pagination,
    },
  };
};

const AnalyticsService = {
  getOverview,
  listUsers,
  getUserDetail,
};

export default AnalyticsService;
