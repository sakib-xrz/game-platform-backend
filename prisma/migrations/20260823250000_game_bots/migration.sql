-- CreateEnum
CREATE TYPE "game_bot_status" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "game_bots" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "persona_seed" INTEGER NOT NULL DEFAULT 0,
    "status" "game_bot_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_bot_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "target_human_win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "min_bots_per_round" INTEGER NOT NULL DEFAULT 2,
    "max_bots_per_round" INTEGER NOT NULL DEFAULT 8,
    "min_human_bets_before_bias" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_bot_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_bots_status_updated_at_idx" ON "game_bots"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "game_bot_policies_code_key" ON "game_bot_policies"("code");

-- AlterTable
ALTER TABLE "greedy_bets" ALTER COLUMN "wallet_id" DROP NOT NULL;
ALTER TABLE "greedy_bets" ALTER COLUMN "wallet_debit_ledger_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "teen_patti_bets" ALTER COLUMN "wallet_id" DROP NOT NULL;
ALTER TABLE "teen_patti_bets" ALTER COLUMN "wallet_debit_ledger_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "lucky_77_bets" ALTER COLUMN "wallet_id" DROP NOT NULL;
ALTER TABLE "lucky_77_bets" ALTER COLUMN "wallet_debit_ledger_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "greedy_classic_bets" ALTER COLUMN "wallet_id" DROP NOT NULL;
ALTER TABLE "greedy_classic_bets" ALTER COLUMN "wallet_debit_ledger_id" DROP NOT NULL;
