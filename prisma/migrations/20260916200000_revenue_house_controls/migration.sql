-- Revenue house controls: tighter human win rate, more bots, player cooling / jackpot lock.

ALTER TABLE "game_bot_policies"
  ALTER COLUMN "target_human_win_rate" SET DEFAULT 0.015,
  ALTER COLUMN "min_bots_per_round" SET DEFAULT 6,
  ALTER COLUMN "max_bots_per_round" SET DEFAULT 10;

ALTER TABLE "game_bot_policies"
  ADD COLUMN IF NOT EXISTS "max_human_payout_per_round" BIGINT NOT NULL DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS "win_streak_trigger" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS "cooling_rounds_after_streak" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "cooling_rounds_after_big_win" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS "cooling_rounds_after_jackpot" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "jackpot_cooldown_rounds" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS "jackpot_multiplier_threshold" DOUBLE PRECISION NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS "high_jackpot_allow_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.00303,
  ADD COLUMN IF NOT EXISTS "mid_jackpot_allow_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.004;

UPDATE "game_bot_policies"
SET
  "target_human_win_rate" = 0.015,
  "min_bots_per_round" = 6,
  "max_bots_per_round" = 10,
  "max_human_payout_per_round" = 300000,
  "win_streak_trigger" = 2,
  "cooling_rounds_after_streak" = 15,
  "cooling_rounds_after_big_win" = 20,
  "cooling_rounds_after_jackpot" = 50,
  "jackpot_cooldown_rounds" = 300,
  "jackpot_multiplier_threshold" = 25,
  "high_jackpot_allow_rate" = 0.00303,
  "mid_jackpot_allow_rate" = 0.004,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'default';

CREATE TABLE IF NOT EXISTS "game_player_risk_states" (
  "user_id" TEXT NOT NULL,
  "cooling_remaining" INTEGER NOT NULL DEFAULT 0,
  "win_streak" INTEGER NOT NULL DEFAULT 0,
  "jackpot_cooldown_remaining" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_player_risk_states_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX IF NOT EXISTS "game_player_risk_states_cooling_remaining_idx"
  ON "game_player_risk_states"("cooling_remaining");
