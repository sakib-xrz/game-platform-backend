-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "big_wins_mode" AS ENUM ('careful', 'balanced', 'open');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "game_player_risk_states"
  ADD COLUMN IF NOT EXISTS "lifetime_net_profit" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lifetime_payout" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lifetime_wagered" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rolling_8d_net_profit" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rolling_8d_payout" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rolling_8d_wagered" BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "game_player_risk_states_lifetime_net_profit_idx"
  ON "game_player_risk_states"("lifetime_net_profit");

-- CreateTable
CREATE TABLE IF NOT EXISTS "game_house_profit_configs" (
    "id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "target_house_profit_pct" DOUBLE PRECISION NOT NULL DEFAULT 60.0,
    "target_player_rtp_pct" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "max_daily_loss_coins" BIGINT NOT NULL DEFAULT 3000000,
    "give_back_lost_pct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "give_back_window_days" INTEGER NOT NULL DEFAULT 8,
    "big_wins_mode" "big_wins_mode" NOT NULL DEFAULT 'balanced',
    "weekly_guarantee_enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_weekly_profit_pct" DOUBLE PRECISION NOT NULL DEFAULT 55.0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_house_profit_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "game_house_profit_configs_game_code_key"
  ON "game_house_profit_configs"("game_code");

-- Seed default configurations
INSERT INTO "game_house_profit_configs" (
  "id", "game_code", "target_house_profit_pct", "target_player_rtp_pct",
  "max_daily_loss_coins", "give_back_lost_pct", "give_back_window_days",
  "big_wins_mode", "weekly_guarantee_enabled", "min_weekly_profit_pct",
  "created_at", "updated_at"
)
VALUES
  ('config_default', 'default', 60.0, 40.0, 3000000, 10.0, 8, 'balanced', true, 55.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('config_greedy', 'greedy', 60.0, 40.0, 3000000, 10.0, 8, 'balanced', true, 55.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('config_greedy_classic', 'greedy-classic', 60.0, 40.0, 3000000, 10.0, 8, 'balanced', true, 55.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('config_lucky_77', 'lucky-77', 60.0, 40.0, 3000000, 10.0, 8, 'balanced', true, 55.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('config_teen_patti', 'teen-patti', 60.0, 40.0, 3000000, 10.0, 8, 'balanced', true, 55.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("game_code") DO NOTHING;

-- CreateTable
CREATE TABLE IF NOT EXISTS "daily_game_house_stats" (
    "id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "stat_date" TEXT NOT NULL,
    "total_wagered" BIGINT NOT NULL DEFAULT 0,
    "total_paid_out" BIGINT NOT NULL DEFAULT 0,
    "house_profit" BIGINT NOT NULL DEFAULT 0,
    "house_kept_pct" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "total_bets" INTEGER NOT NULL DEFAULT 0,
    "total_players" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_game_house_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "daily_game_house_stats_stat_date_idx"
  ON "daily_game_house_stats"("stat_date");

CREATE INDEX IF NOT EXISTS "daily_game_house_stats_game_code_idx"
  ON "daily_game_house_stats"("game_code");

CREATE UNIQUE INDEX IF NOT EXISTS "daily_game_house_stats_game_code_stat_date_key"
  ON "daily_game_house_stats"("game_code", "stat_date");

