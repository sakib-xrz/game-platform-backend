import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { redisClient } from '@/infrastructure/redis/redis.client';
import { getActiveBotIds } from '@/modules/game-bot/bot-identity';
import {
  GAME_TABLES,
  LEADERBOARD_TOP_LIMIT,
  LEADERBOARD_TODAY_CACHE_TTL_SECONDS,
  LEADERBOARD_YESTERDAY_CACHE_TTL_SECONDS,
  formatDisplayName,
  getLeaderboardDayWindow,
  isLeaderboardGameCode,
  leaderboardCacheKey,
  mapAggregateRow,
  type AggregatedPlayerRow,
  type GameTableSet,
  type LeaderboardGameCode,
  type LeaderboardPeriod,
} from './daily-leaderboard.helpers';

export interface DailyLeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  netProfit: string;
  totalPayout: string;
  winCount: number;
  isCurrentUser: boolean;
}

export interface CurrentUserStanding {
  rank: number | null;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  netProfit: string;
  totalPayout: string;
  totalBet: string;
  winCount: number;
}

export interface DailyLeaderboardResponse {
  gameCode: LeaderboardGameCode;
  period: LeaderboardPeriod;
  date: string;
  serverTime: string;
  resetsAt: string;
  totalParticipants: number;
  entries: DailyLeaderboardEntry[];
  currentUser: CurrentUserStanding | null;
}

type CachedBoard = {
  date: string;
  resetsAt: string;
  totalParticipants: number;
  entries: Array<Omit<DailyLeaderboardEntry, 'isCurrentUser'>>;
};

type Profile = { displayName: string; avatarUrl: string | null };

const excludeBotsSql = (column: string, botIds: string[]) => {
  if (botIds.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.raw(column)} NOT IN (${Prisma.join(botIds)})`;
};

const loadProfiles = async (userIds: string[]): Promise<Map<string, Profile>> => {
  const unique = [...new Set(userIds.filter(Boolean))];
  const profileMap = new Map<string, Profile>();
  if (!unique.length) return profileMap;

  const platformUsers = await prisma.platformUser.findMany({
    where: {
      OR: [{ id: { in: unique } }, { external_user_id: { in: unique } }],
    },
    select: {
      id: true,
      external_user_id: true,
      display_name: true,
      photo_url: true,
    },
  });

  for (const user of platformUsers) {
    const profile = {
      displayName: user.display_name,
      avatarUrl: user.photo_url,
    };
    profileMap.set(user.id, profile);
    profileMap.set(user.external_user_id, profile);
  }
  return profileMap;
};

const playerStatsCte = (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
) => Prisma.sql`
  WITH bet_totals AS (
    SELECT
      b.user_id,
      SUM(b.amount) AS total_bet
    FROM ${Prisma.raw(tables.bets)} b
    INNER JOIN ${Prisma.raw(tables.rounds)} r ON r.id = b.round_id
    WHERE r.created_at >= ${from}
      AND r.created_at < ${to}
      ${excludeBotsSql('b.user_id', botIds)}
    GROUP BY b.user_id
  ),
  payout_totals AS (
    SELECT
      p.user_id,
      SUM(p.total_payout) AS total_payout,
      COUNT(*)::int AS win_count
    FROM ${Prisma.raw(tables.payouts)} p
    INNER JOIN ${Prisma.raw(tables.rounds)} r ON r.id = p.round_id
    WHERE r.created_at >= ${from}
      AND r.created_at < ${to}
      ${excludeBotsSql('p.user_id', botIds)}
    GROUP BY p.user_id
  ),
  refund_totals AS (
    SELECT
      f.user_id,
      SUM(f.total_bet_amount) AS total_refund
    FROM ${Prisma.raw(tables.refunds)} f
    INNER JOIN ${Prisma.raw(tables.rounds)} r ON r.id = f.round_id
    WHERE r.created_at >= ${from}
      AND r.created_at < ${to}
      ${excludeBotsSql('f.user_id', botIds)}
    GROUP BY f.user_id
  ),
  all_users AS (
    SELECT user_id FROM bet_totals
    UNION
    SELECT user_id FROM payout_totals
    UNION
    SELECT user_id FROM refund_totals
  ),
  player_stats AS (
    SELECT
      u.user_id,
      COALESCE(b.total_bet, 0) AS total_bet,
      COALESCE(p.total_payout, 0) AS total_payout,
      COALESCE(f.total_refund, 0) AS total_refund,
      COALESCE(p.win_count, 0) AS win_count,
      (
        COALESCE(p.total_payout, 0)
        + COALESCE(f.total_refund, 0)
        - COALESCE(b.total_bet, 0)
      ) AS net_profit
    FROM all_users u
    LEFT JOIN bet_totals b ON b.user_id = u.user_id
    LEFT JOIN payout_totals p ON p.user_id = u.user_id
    LEFT JOIN refund_totals f ON f.user_id = u.user_id
  )
`;

/**
 * Aggregate stake / payout / refund by user, attributed to the day the round
 * was created so a midnight-crossing settlement stays with its round.
 */
const queryPlayerAggregates = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
  options?: { userId?: string; profitableOnly?: boolean; limit?: number },
): Promise<AggregatedPlayerRow[]> => {
  const userFilter = options?.userId
    ? Prisma.sql`AND player_stats.user_id = ${options.userId}`
    : Prisma.empty;
  const havingFilter = options?.profitableOnly
    ? Prisma.sql`AND player_stats.net_profit > 0`
    : Prisma.empty;
  const limitClause =
    typeof options?.limit === 'number'
      ? Prisma.sql`LIMIT ${options.limit}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      user_id: string;
      total_bet: string;
      total_payout: string;
      total_refund: string;
      win_count: number;
    }>
  >(Prisma.sql`
    ${playerStatsCte(tables, from, to, botIds)}
    SELECT
      player_stats.user_id,
      player_stats.total_bet::text AS total_bet,
      player_stats.total_payout::text AS total_payout,
      player_stats.total_refund::text AS total_refund,
      player_stats.win_count
    FROM player_stats
    WHERE TRUE
      ${userFilter}
      ${havingFilter}
    ORDER BY
      player_stats.net_profit DESC,
      player_stats.total_payout DESC,
      player_stats.user_id ASC
    ${limitClause}
  `);

  return rows.map(mapAggregateRow);
};

const countProfitableParticipants = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ total: string }>>(Prisma.sql`
    ${playerStatsCte(tables, from, to, botIds)}
    SELECT COUNT(*)::text AS total
    FROM player_stats
    WHERE player_stats.net_profit > 0
  `);
  return Number(rows[0]?.total ?? 0);
};

const countPlayersAhead = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
  netProfit: bigint,
): Promise<number> => {
  const rows = await prisma.$queryRaw<Array<{ higher: string }>>(Prisma.sql`
    ${playerStatsCte(tables, from, to, botIds)}
    SELECT COUNT(*)::text AS higher
    FROM player_stats
    WHERE player_stats.net_profit > ${netProfit}
  `);
  return Number(rows[0]?.higher ?? 0);
};

const readCachedBoard = async (key: string): Promise<CachedBoard | null> => {
  if (!redisClient.isReady) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedBoard;
  } catch {
    return null;
  }
};

const writeCachedBoard = async (
  key: string,
  board: CachedBoard,
  ttlSeconds: number,
): Promise<void> => {
  if (!redisClient.isReady) return;
  try {
    await redisClient.set(key, JSON.stringify(board), { EX: ttlSeconds });
  } catch {
    // Cache is best-effort; board still serves from the database.
  }
};

const buildCachedBoard = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  date: string,
  resetsAt: Date,
  botIds: string[],
): Promise<CachedBoard> => {
  const [aggregates, totalParticipants] = await Promise.all([
    queryPlayerAggregates(tables, from, to, botIds, {
      profitableOnly: true,
      limit: LEADERBOARD_TOP_LIMIT,
    }),
    countProfitableParticipants(tables, from, to, botIds),
  ]);

  const profiles = await loadProfiles(aggregates.map((row) => row.userId));
  const entries = aggregates.map((row, index) => {
    const profile = profiles.get(row.userId);
    return {
      rank: index + 1,
      userId: row.userId,
      displayName: formatDisplayName(row.userId, profile?.displayName),
      avatarUrl: profile?.avatarUrl ?? null,
      netProfit: row.netProfit.toString(),
      totalPayout: row.totalPayout.toString(),
      winCount: row.winCount,
    };
  });

  return {
    date,
    resetsAt: resetsAt.toISOString(),
    totalParticipants,
    entries,
  };
};

const resolveCallerStanding = async (
  tables: GameTableSet,
  from: Date,
  to: Date,
  botIds: string[],
  currentUserId: string,
  boardEntries: CachedBoard['entries'],
): Promise<CurrentUserStanding> => {
  const profiles = await loadProfiles([currentUserId]);
  const profile = profiles.get(currentUserId);
  const inBoard = boardEntries.find((entry) => entry.userId === currentUserId);
  const callerRows = await queryPlayerAggregates(tables, from, to, botIds, {
    userId: currentUserId,
  });
  const caller = callerRows[0];
  const totalBet = (caller?.totalBet ?? 0n).toString();

  if (inBoard) {
    return {
      rank: inBoard.rank,
      userId: inBoard.userId,
      displayName: inBoard.displayName,
      avatarUrl: inBoard.avatarUrl,
      netProfit: inBoard.netProfit,
      totalPayout: inBoard.totalPayout,
      totalBet,
      winCount: inBoard.winCount,
    };
  }

  const netProfit = caller?.netProfit ?? 0n;
  const rank =
    caller && netProfit > 0n
      ? (await countPlayersAhead(tables, from, to, botIds, netProfit)) + 1
      : null;

  return {
    rank,
    userId: currentUserId,
    displayName: formatDisplayName(currentUserId, profile?.displayName),
    avatarUrl: profile?.avatarUrl ?? null,
    netProfit: netProfit.toString(),
    totalPayout: (caller?.totalPayout ?? 0n).toString(),
    totalBet,
    winCount: caller?.winCount ?? 0,
  };
};

export const getDailyLeaderboard = async (
  gameCode: string,
  period: LeaderboardPeriod = 'today',
  currentUserId?: string,
): Promise<DailyLeaderboardResponse> => {
  const now = new Date();
  const window = getLeaderboardDayWindow(period, now);

  if (!isLeaderboardGameCode(gameCode)) {
    return {
      gameCode: gameCode as LeaderboardGameCode,
      period,
      date: window.date,
      serverTime: now.toISOString(),
      resetsAt: window.resetsAt.toISOString(),
      totalParticipants: 0,
      entries: [],
      currentUser: null,
    };
  }

  const tables = GAME_TABLES[gameCode];
  const cacheKey = leaderboardCacheKey(gameCode, period, window.date);
  const ttl =
    period === 'today'
      ? LEADERBOARD_TODAY_CACHE_TTL_SECONDS
      : LEADERBOARD_YESTERDAY_CACHE_TTL_SECONDS;

  const botIds = [...(await getActiveBotIds())];

  let board = await readCachedBoard(cacheKey);
  if (!board) {
    board = await buildCachedBoard(
      tables,
      window.from,
      window.to,
      window.date,
      window.resetsAt,
      botIds,
    );
    await writeCachedBoard(cacheKey, board, ttl);
  }

  const entries: DailyLeaderboardEntry[] = board.entries.map((entry) => ({
    ...entry,
    isCurrentUser: Boolean(currentUserId && entry.userId === currentUserId),
  }));

  const currentUser = currentUserId
    ? await resolveCallerStanding(
        tables,
        window.from,
        window.to,
        botIds,
        currentUserId,
        board.entries,
      )
    : null;

  return {
    gameCode,
    period,
    date: board.date,
    serverTime: now.toISOString(),
    resetsAt: board.resetsAt,
    totalParticipants: board.totalParticipants,
    entries,
    currentUser,
  };
};

export const DailyLeaderboardService = {
  getDailyLeaderboard,
};

export default DailyLeaderboardService;
