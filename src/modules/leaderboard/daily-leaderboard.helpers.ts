export type LeaderboardPeriod = 'today' | 'yesterday';

export type LeaderboardGameCode =
  | 'greedy'
  | 'greedy-classic'
  | 'teen-patti'
  | 'lucky-77';

export type GameTableSet = {
  code: LeaderboardGameCode;
  bets: string;
  payouts: string;
  refunds: string;
  rounds: string;
};

/** Asia/Dhaka is UTC+6 year-round (no daylight saving). */
export const LEADERBOARD_TIMEZONE = 'Asia/Dhaka';
export const LEADERBOARD_TZ_OFFSET_MS = 6 * 60 * 60 * 1000;

export const LEADERBOARD_TOP_LIMIT = 50;
export const LEADERBOARD_TODAY_CACHE_TTL_SECONDS = 15;
export const LEADERBOARD_YESTERDAY_CACHE_TTL_SECONDS = 300;

export const GAME_TABLES: Record<LeaderboardGameCode, GameTableSet> = {
  greedy: {
    code: 'greedy',
    bets: 'greedy_bets',
    payouts: 'greedy_user_payouts',
    refunds: 'greedy_user_refunds',
    rounds: 'greedy_rounds',
  },
  'greedy-classic': {
    code: 'greedy-classic',
    bets: 'greedy_classic_bets',
    payouts: 'greedy_classic_user_payouts',
    refunds: 'greedy_classic_user_refunds',
    rounds: 'greedy_classic_rounds',
  },
  'teen-patti': {
    code: 'teen-patti',
    bets: 'teen_patti_bets',
    payouts: 'teen_patti_user_payouts',
    refunds: 'teen_patti_user_refunds',
    rounds: 'teen_patti_rounds',
  },
  'lucky-77': {
    code: 'lucky-77',
    bets: 'lucky_77_bets',
    payouts: 'lucky_77_user_payouts',
    refunds: 'lucky_77_user_refunds',
    rounds: 'lucky_77_rounds',
  },
};

export const isLeaderboardGameCode = (
  value: string,
): value is LeaderboardGameCode => value in GAME_TABLES;

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatLeaderboardDate = (year: number, month: number, day: number): string =>
  `${year}-${pad2(month + 1)}-${pad2(day)}`;

/**
 * Calendar day window in Asia/Dhaka, returned as exclusive-end UTC instants.
 * Activity is attributed by the round's created_at falling inside [from, to).
 */
export function getLeaderboardDayWindow(
  period: LeaderboardPeriod,
  now: Date = new Date(),
): {
  from: Date;
  to: Date;
  date: string;
  resetsAt: Date;
} {
  const dhakaNow = new Date(now.getTime() + LEADERBOARD_TZ_OFFSET_MS);
  const year = dhakaNow.getUTCFullYear();
  const month = dhakaNow.getUTCMonth();
  const day = dhakaNow.getUTCDate();

  const todayStartUtc = new Date(Date.UTC(year, month, day) - LEADERBOARD_TZ_OFFSET_MS);
  const tomorrowStartUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);
  const yesterdayStartUtc = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000);

  if (period === 'yesterday') {
    const yesterdayDhaka = new Date(dhakaNow.getTime() - 24 * 60 * 60 * 1000);
    return {
      from: yesterdayStartUtc,
      to: todayStartUtc,
      date: formatLeaderboardDate(
        yesterdayDhaka.getUTCFullYear(),
        yesterdayDhaka.getUTCMonth(),
        yesterdayDhaka.getUTCDate(),
      ),
      resetsAt: tomorrowStartUtc,
    };
  }

  return {
    from: todayStartUtc,
    to: tomorrowStartUtc,
    date: formatLeaderboardDate(year, month, day),
    resetsAt: tomorrowStartUtc,
  };
}

export function netProfitOf(params: {
  totalPayout: bigint;
  totalRefund: bigint;
  totalBet: bigint;
}): bigint {
  return params.totalPayout + params.totalRefund - params.totalBet;
}

export function formatDisplayName(userId: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim();
  if (userId.startsWith('usr_')) {
    const trimmed = userId.replace('usr_', '');
    return `Player ${trimmed.slice(0, 4)}`;
  }
  if (userId.length > 8) {
    return `User ${userId.slice(0, 3)}..${userId.slice(-3)}`;
  }
  return `Player ${userId}`;
}

export function leaderboardCacheKey(
  gameCode: LeaderboardGameCode,
  period: LeaderboardPeriod,
  date: string,
): string {
  return `leaderboard:v1:${gameCode}:${period}:${date}`;
}

export type AggregatedPlayerRow = {
  userId: string;
  totalBet: bigint;
  totalPayout: bigint;
  totalRefund: bigint;
  winCount: number;
  netProfit: bigint;
};

export function mapAggregateRow(row: {
  user_id: string;
  total_bet: string | number | bigint | null;
  total_payout: string | number | bigint | null;
  total_refund: string | number | bigint | null;
  win_count: string | number | null;
}): AggregatedPlayerRow {
  const totalBet = BigInt(row.total_bet ?? 0);
  const totalPayout = BigInt(row.total_payout ?? 0);
  const totalRefund = BigInt(row.total_refund ?? 0);
  return {
    userId: row.user_id,
    totalBet,
    totalPayout,
    totalRefund,
    winCount: Number(row.win_count ?? 0),
    netProfit: netProfitOf({ totalPayout, totalRefund, totalBet }),
  };
}

export function rankByNetProfit(rows: AggregatedPlayerRow[]): AggregatedPlayerRow[] {
  return [...rows].sort((left, right) => {
    if (right.netProfit !== left.netProfit) {
      return right.netProfit > left.netProfit ? 1 : -1;
    }
    if (right.totalPayout !== left.totalPayout) {
      return right.totalPayout > left.totalPayout ? 1 : -1;
    }
    return left.userId.localeCompare(right.userId);
  });
}
