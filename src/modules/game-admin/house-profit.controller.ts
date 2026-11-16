import type { Request, Response } from 'express';
import httpStatus from 'http-status';
import prisma from '@/lib/prisma';
import {
  getGameHouseProfitConfig,
  getDailyHouseStat,
  getRolling7DayHouseStat,
  getTodayDateString,
  DEFAULT_HOUSE_PROFIT_CONFIG,
} from '@/modules/game-bot/profit-steering.service';
import { logger } from '@/utils/logger';

export class HouseProfitAdminController {
  /**
   * Get comprehensive overview similar to Tecsior Operator Console:
   * - High-level summary (today, rolling 7 days, 30 days)
   * - By-game performance breakdown
   * - Daily historical chart data (with green/red profit flags)
   */
  static getOverview = async (req: Request, res: Response): Promise<void> => {
    try {
      const period = (req.query.period as string) || 'daily'; // 'daily' | 'weekly' | 'monthly'
      const today = getTodayDateString();

      // Supported game keys
      const gameCodes = ['greedy', 'greedy-classic', 'lucky-77', 'teen-patti'];

      // 1. Fetch Today's Overall Stats
      const todayOverall = await getDailyHouseStat('all', today);

      // 2. Fetch Rolling 7-day Overall Stats
      const weeklyOverall = await getRolling7DayHouseStat('all', today);

      // 3. Fetch By-Game Breakdown for Today
      const gameRows = await Promise.all(
        gameCodes.map(async (code) => {
          const stat = await getDailyHouseStat(code, today);
          const config = await getGameHouseProfitConfig(code);

          let status: 'meeting_target' | 'losing' | 'no_bets' = 'no_bets';
          if (stat.total_bets > 0) {
            if (stat.house_kept_pct >= config.target_house_profit_pct) {
              status = 'meeting_target';
            } else if (stat.house_profit < 0n) {
              status = 'losing';
            } else {
              status = 'meeting_target';
            }
          }

          const paidBackPct =
            stat.total_wagered > 0n
              ? (Number(stat.total_paid_out) / Number(stat.total_wagered)) * 100
              : 0;

          return {
            game_code: code,
            game_name: code
              .split('-')
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' '),
            players: stat.total_players,
            bets: stat.total_bets,
            wagered: stat.total_wagered.toString(),
            paid_out: stat.total_paid_out.toString(),
            paid_back_pct: Number(paidBackPct.toFixed(1)),
            house_kept_pct: Number(stat.house_kept_pct.toFixed(1)),
            house_profit: stat.house_profit.toString(),
            target_pct: config.target_house_profit_pct,
            status,
          };
        }),
      );

      // 4. Fetch Daily History for Chart (Last 14 days)
      const chartDates: string[] = [];
      const end = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        chartDates.push(d.toISOString().slice(0, 10));
      }

      const dailyStats = await prisma.dailyGameHouseStat.findMany({
        where: {
          game_code: 'all',
          stat_date: { in: chartDates },
        },
        orderBy: { stat_date: 'asc' },
      });

      const dailyStatMap = new Map(dailyStats.map((s) => [s.stat_date, s]));
      const chartData = chartDates.map((date) => {
        const row = dailyStatMap.get(date);
        const wagered = row?.total_wagered ?? 0n;
        const paid_out = row?.total_paid_out ?? 0n;
        const profit = row?.house_profit ?? 0n;
        const kept_pct = row?.house_kept_pct ?? 0;
        const bets = row?.total_bets ?? 0;
        const players = row?.total_players ?? 0;

        return {
          date,
          wagered: wagered.toString(),
          paid_out: paid_out.toString(),
          house_profit: profit.toString(),
          house_kept_pct: Number(kept_pct.toFixed(1)),
          bets,
          players,
          is_profit: profit >= 0n,
        };
      });

      // Target summary counts
      const meetingTargetCount = gameRows.filter((r) => r.status === 'meeting_target').length;
      const losingCount = gameRows.filter((r) => r.status === 'losing').length;
      const noBetsCount = gameRows.filter((r) => r.status === 'no_bets').length;

      const summaryWagered =
        period === 'weekly' ? weeklyOverall.total_wagered : todayOverall.total_wagered;
      const summaryPaidOut =
        period === 'weekly' ? weeklyOverall.total_paid_out : todayOverall.total_paid_out;
      const summaryProfit =
        period === 'weekly' ? weeklyOverall.house_profit : todayOverall.house_profit;
      const summaryKeptPct =
        period === 'weekly' ? weeklyOverall.house_kept_pct : todayOverall.house_kept_pct;
      const summaryBets =
        period === 'weekly' ? weeklyOverall.total_bets : todayOverall.total_bets;
      const summaryPlayers =
        period === 'weekly' ? weeklyOverall.total_players : todayOverall.total_players;

      const paidBackPct =
        summaryWagered > 0n
          ? (Number(summaryPaidOut) / Number(summaryWagered)) * 100
          : 0;

      res.status(httpStatus.OK).json({
        success: true,
        data: {
          period,
          summary: {
            house_profit: summaryProfit.toString(),
            house_kept_pct: Number(summaryKeptPct.toFixed(1)),
            total_wagered: summaryWagered.toString(),
            total_paid_out: summaryPaidOut.toString(),
            paid_back_pct: Number(paidBackPct.toFixed(1)),
            total_players: summaryPlayers,
            total_bets: summaryBets,
            target_status: {
              meeting_target: meetingTargetCount,
              losing: losingCount,
              no_bets: noBetsCount,
            },
          },
          games: gameRows,
          daily_chart: chartData,
        },
      });
    } catch (error) {
      logger.error('Failed to get house profit overview', { error });
      res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: 'Failed to retrieve house profit overview',
      });
    }
  };

  /** Get config for a specific game */
  static getConfig = async (req: Request, res: Response): Promise<void> => {
    try {
      const game_code = req.params.game_code || 'default';
      const config = await getGameHouseProfitConfig(game_code);

      res.status(httpStatus.OK).json({
        success: true,
        data: {
          ...config,
          max_daily_loss_coins: config.max_daily_loss_coins.toString(),
        },
      });
    } catch (error) {
      logger.error('Failed to get house profit config', { error, params: req.params });
      res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: 'Failed to retrieve configuration',
      });
    }
  };

  /** Update house profit configuration */
  static updateConfig = async (req: Request, res: Response): Promise<void> => {
    try {
      const game_code = req.params.game_code || 'default';
      const {
        target_house_profit_pct,
        target_player_rtp_pct,
        max_daily_loss_coins,
        give_back_lost_pct,
        give_back_window_days,
        big_wins_mode,
        weekly_guarantee_enabled,
        min_weekly_profit_pct,
      } = req.body;

      const updated = await prisma.gameHouseProfitConfig.upsert({
        where: { game_code },
        create: {
          game_code,
          target_house_profit_pct:
            typeof target_house_profit_pct === 'number'
              ? target_house_profit_pct
              : DEFAULT_HOUSE_PROFIT_CONFIG.target_house_profit_pct,
          target_player_rtp_pct:
            typeof target_player_rtp_pct === 'number'
              ? target_player_rtp_pct
              : DEFAULT_HOUSE_PROFIT_CONFIG.target_player_rtp_pct,
          max_daily_loss_coins: max_daily_loss_coins
            ? BigInt(max_daily_loss_coins)
            : DEFAULT_HOUSE_PROFIT_CONFIG.max_daily_loss_coins,
          give_back_lost_pct:
            typeof give_back_lost_pct === 'number'
              ? give_back_lost_pct
              : DEFAULT_HOUSE_PROFIT_CONFIG.give_back_lost_pct,
          give_back_window_days:
            typeof give_back_window_days === 'number'
              ? give_back_window_days
              : DEFAULT_HOUSE_PROFIT_CONFIG.give_back_window_days,
          big_wins_mode: big_wins_mode ?? DEFAULT_HOUSE_PROFIT_CONFIG.big_wins_mode,
          weekly_guarantee_enabled:
            weekly_guarantee_enabled ?? DEFAULT_HOUSE_PROFIT_CONFIG.weekly_guarantee_enabled,
          min_weekly_profit_pct:
            typeof min_weekly_profit_pct === 'number'
              ? min_weekly_profit_pct
              : DEFAULT_HOUSE_PROFIT_CONFIG.min_weekly_profit_pct,
        },
        update: {
          ...(typeof target_house_profit_pct === 'number' && { target_house_profit_pct }),
          ...(typeof target_player_rtp_pct === 'number' && { target_player_rtp_pct }),
          ...(max_daily_loss_coins !== undefined && {
            max_daily_loss_coins: BigInt(max_daily_loss_coins),
          }),
          ...(typeof give_back_lost_pct === 'number' && { give_back_lost_pct }),
          ...(typeof give_back_window_days === 'number' && { give_back_window_days }),
          ...(big_wins_mode && { big_wins_mode }),
          ...(weekly_guarantee_enabled !== undefined && { weekly_guarantee_enabled }),
          ...(typeof min_weekly_profit_pct === 'number' && { min_weekly_profit_pct }),
        },
      });

      res.status(httpStatus.OK).json({
        success: true,
        data: {
          ...updated,
          max_daily_loss_coins: updated.max_daily_loss_coins.toString(),
        },
      });
    } catch (error) {
      logger.error('Failed to update house profit config', { error, body: req.body });
      res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        message: 'Failed to update configuration',
      });
    }
  };
}

export default HouseProfitAdminController;

