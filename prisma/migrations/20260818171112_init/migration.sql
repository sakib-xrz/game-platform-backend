-- CreateEnum
CREATE TYPE "game_status" AS ENUM ('active', 'paused', 'maintenance', 'disabled');

-- CreateEnum
CREATE TYPE "greedy_runtime_status" AS ENUM ('stopped', 'running', 'paused', 'degraded');

-- CreateEnum
CREATE TYPE "config_version_status" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "greedy_round_status" AS ENUM ('created', 'betting_open', 'betting_locked', 'result_ready', 'drawing', 'result_revealed', 'settling', 'settled', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "wallet_ledger_type" AS ENUM ('bet_debit', 'win_credit', 'bet_refund', 'admin_credit', 'admin_debit', 'bonus_credit', 'purchase_credit', 'withdrawal_debit', 'reversal_credit', 'reversal_debit');

-- CreateEnum
CREATE TYPE "settlement_outcome" AS ENUM ('win', 'loss', 'refunded');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'processing', 'published', 'failed');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('system', 'admin', 'user');

-- CreateTable
CREATE TABLE "currencies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "currency_id" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_id" TEXT,
    "type" "wallet_ledger_type" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_before" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "game_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_runtime_state" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "current_round_id" TEXT,
    "active_config_version_id" TEXT,
    "status" "greedy_runtime_status" NOT NULL DEFAULT 'stopped',
    "last_round_number" BIGINT NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_runtime_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_config_versions" (
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

    CONSTRAINT "greedy_config_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_chip_value_versions" (
    "id" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_chip_value_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_option_versions" (
    "id" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT,
    "display_order" INTEGER NOT NULL,
    "payout_numerator" BIGINT NOT NULL,
    "payout_denominator" BIGINT NOT NULL DEFAULT 1,
    "probability_weight" BIGINT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_option_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_rounds" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "round_number" BIGINT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "status" "greedy_round_status" NOT NULL DEFAULT 'created',
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

    CONSTRAINT "greedy_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_round_results" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "winning_option_version_id" TEXT NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "config_version_id" TEXT NOT NULL,
    "entropy_digest" TEXT NOT NULL,
    "audit_hash" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at" TIMESTAMP(3),

    CONSTRAINT "greedy_round_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_bets" (
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

    CONSTRAINT "greedy_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_bet_settlements" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "bet_id" TEXT NOT NULL,
    "result_id" TEXT,
    "outcome" "settlement_outcome" NOT NULL,
    "payout_amount" BIGINT NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_bet_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_user_payouts" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "winning_bet_count" INTEGER NOT NULL,
    "total_winning_stake" BIGINT NOT NULL,
    "total_payout" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_user_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "greedy_user_refunds" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "total_bet_amount" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "greedy_user_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'processing',
    "http_status" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "socket_room" TEXT,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_leases" (
    "id" TEXT NOT NULL,
    "lease_key" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE INDEX "wallets_user_id_idx" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_currency_id_key" ON "wallets"("user_id", "currency_id");

-- CreateIndex
CREATE INDEX "wallet_ledger_wallet_id_created_at_idx" ON "wallet_ledger"("wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_ledger_user_id_created_at_idx" ON "wallet_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_ledger_game_id_created_at_idx" ON "wallet_ledger"("game_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_ledger_reference_type_reference_id_idx" ON "wallet_ledger"("reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "games_code_key" ON "games"("code");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_runtime_state_game_id_key" ON "greedy_runtime_state"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_runtime_state_current_round_id_key" ON "greedy_runtime_state"("current_round_id");

-- CreateIndex
CREATE INDEX "greedy_config_versions_game_id_status_idx" ON "greedy_config_versions"("game_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_config_versions_game_id_version_key" ON "greedy_config_versions"("game_id", "version");

-- CreateIndex
CREATE INDEX "greedy_chip_value_versions_config_version_id_is_enabled_idx" ON "greedy_chip_value_versions"("config_version_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_chip_value_versions_config_version_id_amount_key" ON "greedy_chip_value_versions"("config_version_id", "amount");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_chip_value_versions_config_version_id_display_order_key" ON "greedy_chip_value_versions"("config_version_id", "display_order");

-- CreateIndex
CREATE INDEX "greedy_option_versions_config_version_id_is_enabled_idx" ON "greedy_option_versions"("config_version_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_option_versions_config_version_id_code_key" ON "greedy_option_versions"("config_version_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_option_versions_config_version_id_display_order_key" ON "greedy_option_versions"("config_version_id", "display_order");

-- CreateIndex
CREATE INDEX "greedy_rounds_game_id_status_idx" ON "greedy_rounds"("game_id", "status");

-- CreateIndex
CREATE INDEX "greedy_rounds_status_betting_ends_at_idx" ON "greedy_rounds"("status", "betting_ends_at");

-- CreateIndex
CREATE INDEX "greedy_rounds_created_at_idx" ON "greedy_rounds"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_rounds_game_id_round_number_key" ON "greedy_rounds"("game_id", "round_number");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_round_results_round_id_key" ON "greedy_round_results"("round_id");

-- CreateIndex
CREATE INDEX "greedy_round_results_generated_at_idx" ON "greedy_round_results"("generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_bets_wallet_debit_ledger_id_key" ON "greedy_bets"("wallet_debit_ledger_id");

-- CreateIndex
CREATE INDEX "greedy_bets_round_id_user_id_idx" ON "greedy_bets"("round_id", "user_id");

-- CreateIndex
CREATE INDEX "greedy_bets_round_id_option_version_id_idx" ON "greedy_bets"("round_id", "option_version_id");

-- CreateIndex
CREATE INDEX "greedy_bets_user_id_created_at_idx" ON "greedy_bets"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_bets_user_id_client_request_id_key" ON "greedy_bets"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_bet_settlements_bet_id_key" ON "greedy_bet_settlements"("bet_id");

-- CreateIndex
CREATE INDEX "greedy_bet_settlements_round_id_outcome_idx" ON "greedy_bet_settlements"("round_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_user_payouts_wallet_ledger_id_key" ON "greedy_user_payouts"("wallet_ledger_id");

-- CreateIndex
CREATE INDEX "greedy_user_payouts_user_id_created_at_idx" ON "greedy_user_payouts"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_user_payouts_round_id_user_id_key" ON "greedy_user_payouts"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_user_refunds_wallet_ledger_id_key" ON "greedy_user_refunds"("wallet_ledger_id");

-- CreateIndex
CREATE INDEX "greedy_user_refunds_user_id_created_at_idx" ON "greedy_user_refunds"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "greedy_user_refunds_round_id_user_id_key" ON "greedy_user_refunds"("round_id", "user_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_idempotency_key_key" ON "idempotency_records"("user_id", "scope", "idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_locked_by_locked_at_idx" ON "outbox_events"("locked_by", "locked_at");

-- CreateIndex
CREATE UNIQUE INDEX "worker_leases_lease_key_key" ON "worker_leases"("lease_key");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currency_id_fkey" FOREIGN KEY ("currency_id") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_runtime_state" ADD CONSTRAINT "greedy_runtime_state_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_runtime_state" ADD CONSTRAINT "greedy_runtime_state_current_round_id_fkey" FOREIGN KEY ("current_round_id") REFERENCES "greedy_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_runtime_state" ADD CONSTRAINT "greedy_runtime_state_active_config_version_id_fkey" FOREIGN KEY ("active_config_version_id") REFERENCES "greedy_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_config_versions" ADD CONSTRAINT "greedy_config_versions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_chip_value_versions" ADD CONSTRAINT "greedy_chip_value_versions_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "greedy_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_option_versions" ADD CONSTRAINT "greedy_option_versions_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "greedy_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_rounds" ADD CONSTRAINT "greedy_rounds_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_rounds" ADD CONSTRAINT "greedy_rounds_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "greedy_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_round_results" ADD CONSTRAINT "greedy_round_results_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "greedy_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_round_results" ADD CONSTRAINT "greedy_round_results_winning_option_version_id_fkey" FOREIGN KEY ("winning_option_version_id") REFERENCES "greedy_option_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_round_results" ADD CONSTRAINT "greedy_round_results_config_version_id_fkey" FOREIGN KEY ("config_version_id") REFERENCES "greedy_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "greedy_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_option_version_id_fkey" FOREIGN KEY ("option_version_id") REFERENCES "greedy_option_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bets" ADD CONSTRAINT "greedy_bets_wallet_debit_ledger_id_fkey" FOREIGN KEY ("wallet_debit_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bet_settlements" ADD CONSTRAINT "greedy_bet_settlements_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "greedy_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bet_settlements" ADD CONSTRAINT "greedy_bet_settlements_bet_id_fkey" FOREIGN KEY ("bet_id") REFERENCES "greedy_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_bet_settlements" ADD CONSTRAINT "greedy_bet_settlements_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "greedy_round_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_payouts" ADD CONSTRAINT "greedy_user_payouts_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "greedy_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_payouts" ADD CONSTRAINT "greedy_user_payouts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_payouts" ADD CONSTRAINT "greedy_user_payouts_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_refunds" ADD CONSTRAINT "greedy_user_refunds_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "greedy_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_refunds" ADD CONSTRAINT "greedy_user_refunds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "greedy_user_refunds" ADD CONSTRAINT "greedy_user_refunds_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
