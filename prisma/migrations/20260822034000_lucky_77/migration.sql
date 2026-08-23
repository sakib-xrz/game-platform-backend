-- CreateEnum
CREATE TYPE "lucky_77_runtime_status" AS ENUM ('stopped', 'running', 'paused', 'degraded');

-- CreateEnum
CREATE TYPE "lucky_77_round_status" AS ENUM ('created', 'betting_open', 'betting_locked', 'result_ready', 'drawing', 'result_revealed', 'settling', 'settled', 'closed', 'cancelled');

-- CreateTable
CREATE TABLE "lucky_77_runtime_state" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "current_round_id" TEXT,
    "active_config_version_id" TEXT,
    "status" "lucky_77_runtime_status" NOT NULL DEFAULT 'stopped',
    "last_round_number" BIGINT NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_runtime_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_config_versions" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "config_version_status" NOT NULL DEFAULT 'draft',
    "betting_duration_ms" INTEGER NOT NULL,
    "lock_duration_ms" INTEGER NOT NULL,
    "drawing_duration_ms" INTEGER NOT NULL,
    "result_duration_ms" INTEGER NOT NULL,
    "min_bet" BIGINT NOT NULL,
    "max_single_bet" BIGINT NOT NULL,
    "max_round_bet" BIGINT NOT NULL,
    "created_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "lucky_77_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_chip_value_versions" (
    "id" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_chip_value_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_option_versions" (
    "id" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT,
    "asset_id" TEXT,
    "display_order" INTEGER NOT NULL,
    "payout_numerator" BIGINT NOT NULL,
    "payout_denominator" BIGINT NOT NULL DEFAULT 1,
    "probability_weight" BIGINT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_option_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_rounds" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "round_number" BIGINT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "status" "lucky_77_round_status" NOT NULL DEFAULT 'created',
    "betting_started_at" TIMESTAMP(3),
    "betting_ends_at" TIMESTAMP(3),
    "locked_at" TIMESTAMP(3),
    "result_generated_at" TIMESTAMP(3),
    "drawing_started_at" TIMESTAMP(3),
    "result_reveal_at" TIMESTAMP(3),
    "settlement_started_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lucky_77_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_round_results" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "winning_option_version_id" TEXT NOT NULL,
    "winning_slot_index" INTEGER NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "entropy_digest" TEXT NOT NULL,
    "audit_hash" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at" TIMESTAMP(3),

    CONSTRAINT "lucky_77_round_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_bets" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "option_version_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "payout_numerator" BIGINT NOT NULL,
    "payout_denominator" BIGINT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "wallet_debit_ledger_id" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_bet_settlements" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "bet_id" TEXT NOT NULL,
    "result_id" TEXT,
    "outcome" "settlement_outcome" NOT NULL,
    "payout_amount" BIGINT NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_bet_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_user_payouts" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "winning_bet_count" INTEGER NOT NULL,
    "total_winning_stake" BIGINT NOT NULL,
    "total_payout" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_user_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lucky_77_user_refunds" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "total_bet_amount" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lucky_77_user_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_runtime_state_game_id_key" ON "lucky_77_runtime_state"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_runtime_state_current_round_id_key" ON "lucky_77_runtime_state"("current_round_id");

-- CreateIndex
CREATE INDEX "lucky_77_config_versions_game_id_status_idx" ON "lucky_77_config_versions"("game_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_config_versions_game_id_version_key" ON "lucky_77_config_versions"("game_id", "version");

-- CreateIndex
CREATE INDEX "lucky_77_chip_value_versions_config_version_id_is_enabled_idx" ON "lucky_77_chip_value_versions"("config_version_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_chip_value_versions_config_version_id_amount_key" ON "lucky_77_chip_value_versions"("config_version_id", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_chip_value_versions_config_version_id_display_or_key" ON "lucky_77_chip_value_versions"("config_version_id", "display_order");

-- CreateIndex
CREATE INDEX "lucky_77_option_versions_config_version_id_is_enabled_idx" ON "lucky_77_option_versions"("config_version_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_option_versions_config_version_id_code_key" ON "lucky_77_option_versions"("config_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_option_versions_config_version_id_display_order_key" ON "lucky_77_option_versions"("config_version_id", "display_order");

-- CreateIndex
CREATE INDEX "lucky_77_rounds_game_id_status_idx" ON "lucky_77_rounds"("game_id", "status");

-- CreateIndex
CREATE INDEX "lucky_77_rounds_status_betting_ends_at_idx" ON "lucky_77_rounds"("status", "betting_ends_at");

-- CreateIndex
CREATE INDEX "lucky_77_rounds_created_at_idx" ON "lucky_77_rounds"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_rounds_game_id_round_number_key" ON "lucky_77_rounds"("game_id", "round_number");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_round_results_round_id_key" ON "lucky_77_round_results"("round_id");

-- CreateIndex
CREATE INDEX "lucky_77_round_results_generated_at_idx" ON "lucky_77_round_results"("generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_bets_wallet_debit_ledger_id_key" ON "lucky_77_bets"("wallet_debit_ledger_id");

-- CreateIndex
CREATE INDEX "lucky_77_bets_round_id_user_id_idx" ON "lucky_77_bets"("round_id", "user_id");

-- CreateIndex
CREATE INDEX "lucky_77_bets_round_id_option_version_id_idx" ON "lucky_77_bets"("round_id", "option_version_id");

-- CreateIndex
CREATE INDEX "lucky_77_bets_user_id_created_at_idx" ON "lucky_77_bets"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_bets_user_id_client_request_id_key" ON "lucky_77_bets"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_bet_settlements_bet_id_key" ON "lucky_77_bet_settlements"("bet_id");

-- CreateIndex
CREATE INDEX "lucky_77_bet_settlements_round_id_outcome_idx" ON "lucky_77_bet_settlements"("round_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_user_payouts_wallet_ledger_id_key" ON "lucky_77_user_payouts"("wallet_ledger_id");

-- CreateIndex
CREATE INDEX "lucky_77_user_payouts_user_id_created_at_idx" ON "lucky_77_user_payouts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_user_payouts_round_id_user_id_key" ON "lucky_77_user_payouts"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_user_refunds_wallet_ledger_id_key" ON "lucky_77_user_refunds"("wallet_ledger_id");

-- CreateIndex
CREATE INDEX "lucky_77_user_refunds_user_id_created_at_idx" ON "lucky_77_user_refunds"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "lucky_77_user_refunds_round_id_user_id_key" ON "lucky_77_user_refunds"("round_id", "user_id");

-- AddForeignKey
ALTER TABLE "lucky_77_runtime_state" ADD CONSTRAINT "lucky_77_runtime_state_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_runtime_state" ADD CONSTRAINT "lucky_77_runtime_state_current_round_id_fkey" FOREIGN KEY ("current_round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_runtime_state" ADD CONSTRAINT "lucky_77_runtime_state_active_config_version_id_fkey" FOREIGN KEY ("active_config_version_id") REFERENCES "lucky_77_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_config_versions" ADD CONSTRAINT "lucky_77_config_versions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_chip_value_versions" ADD CONSTRAINT "lucky_77_chip_value_versions_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "lucky_77_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_option_versions" ADD CONSTRAINT "lucky_77_option_versions_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "lucky_77_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_option_versions" ADD CONSTRAINT "lucky_77_option_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "admin_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_rounds" ADD CONSTRAINT "lucky_77_rounds_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_rounds" ADD CONSTRAINT "lucky_77_rounds_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "lucky_77_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_round_results" ADD CONSTRAINT "lucky_77_round_results_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_round_results" ADD CONSTRAINT "lucky_77_round_results_winning_option_version_id_fkey" FOREIGN KEY ("winning_option_version_id") REFERENCES "lucky_77_option_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_round_results" ADD CONSTRAINT "lucky_77_round_results_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "lucky_77_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bets" ADD CONSTRAINT "lucky_77_bets_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bets" ADD CONSTRAINT "lucky_77_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bets" ADD CONSTRAINT "lucky_77_bets_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bets" ADD CONSTRAINT "lucky_77_bets_option_version_id_fkey" FOREIGN KEY ("option_version_id") REFERENCES "lucky_77_option_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bets" ADD CONSTRAINT "lucky_77_bets_wallet_debit_ledger_id_fkey" FOREIGN KEY ("wallet_debit_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bet_settlements" ADD CONSTRAINT "lucky_77_bet_settlements_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bet_settlements" ADD CONSTRAINT "lucky_77_bet_settlements_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "lucky_77_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_bet_settlements" ADD CONSTRAINT "lucky_77_bet_settlements_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "lucky_77_round_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_payouts" ADD CONSTRAINT "lucky_77_user_payouts_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_payouts" ADD CONSTRAINT "lucky_77_user_payouts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_payouts" ADD CONSTRAINT "lucky_77_user_payouts_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_refunds" ADD CONSTRAINT "lucky_77_user_refunds_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "lucky_77_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_refunds" ADD CONSTRAINT "lucky_77_user_refunds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lucky_77_user_refunds" ADD CONSTRAINT "lucky_77_user_refunds_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Result evidence is append-only. The worker may record the first reveal timestamp,
-- but no protected result field can ever be changed or deleted afterwards.
CREATE OR REPLACE FUNCTION prevent_lucky_77_result_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lucky 77 round results are immutable';
  END IF;
  IF ROW(OLD.id, OLD.round_id, OLD.winning_option_version_id, OLD.winning_slot_index, OLD.algorithm_version,
         OLD.config_version_id, OLD.entropy_digest, OLD.audit_hash, OLD.generated_at)
     IS DISTINCT FROM
     ROW(NEW.id, NEW.round_id, NEW.winning_option_version_id, NEW.winning_slot_index, NEW.algorithm_version,
         NEW.config_version_id, NEW.entropy_digest, NEW.audit_hash, NEW.generated_at) THEN
    RAISE EXCEPTION 'lucky 77 round result evidence is immutable';
  END IF;
  IF OLD.revealed_at IS NOT NULL AND NEW.revealed_at IS DISTINCT FROM OLD.revealed_at THEN
    RAISE EXCEPTION 'lucky 77 round result reveal timestamp is immutable once recorded';
  END IF;
  IF OLD.revealed_at IS NULL AND NEW.revealed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid lucky 77 round result mutation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lucky_77_round_results_immutable
  BEFORE UPDATE OR DELETE ON "lucky_77_round_results"
  FOR EACH ROW EXECUTE FUNCTION prevent_lucky_77_result_mutation();

-- Financial evidence rows are append-only (mirrors greedy financial immutability).
CREATE TRIGGER lucky_77_bets_append_only
  BEFORE UPDATE OR DELETE ON "lucky_77_bets"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER lucky_77_bet_settlements_append_only
  BEFORE UPDATE OR DELETE ON "lucky_77_bet_settlements"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER lucky_77_user_payouts_append_only
  BEFORE UPDATE OR DELETE ON "lucky_77_user_payouts"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER lucky_77_user_refunds_append_only
  BEFORE UPDATE OR DELETE ON "lucky_77_user_refunds"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
