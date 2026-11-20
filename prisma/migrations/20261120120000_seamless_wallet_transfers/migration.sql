-- Seamless wallet columns were introduced in the schema without a migration.
-- IF NOT EXISTS keeps this safe for databases that were synced with `db push`.
ALTER TABLE "platform_apps" ADD COLUMN IF NOT EXISTS "app_key" TEXT;
ALTER TABLE "platform_apps" ADD COLUMN IF NOT EXISTS "wallet_mode" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "platform_apps" ADD COLUMN IF NOT EXISTS "wallet_base_url" TEXT;
ALTER TABLE "platform_apps" ADD COLUMN IF NOT EXISTS "player_token_secret" TEXT;
ALTER TABLE "platform_apps" ADD COLUMN IF NOT EXISTS "allowed_origins" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "platform_apps_app_key_key" ON "platform_apps"("app_key");

-- CreateEnum
CREATE TYPE "seamless_transfer_direction" AS ENUM ('debit', 'credit');
CREATE TYPE "seamless_transfer_status" AS ENUM ('pending', 'processing', 'completed', 'voided', 'reversed');

-- CreateTable
CREATE TABLE "seamless_wallet_transfers" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "direction" "seamless_transfer_direction" NOT NULL,
    "type" TEXT NOT NULL,
    "status" "seamless_transfer_status" NOT NULL DEFAULT 'pending',
    "platform_app_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "game_code" TEXT NOT NULL,
    "round_id" TEXT,
    "reference_id" TEXT NOT NULL,
    "host_confirmed_at" TIMESTAMP(3),
    "host_tx_id" TEXT,
    "host_balance_after" BIGINT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seamless_wallet_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seamless_wallet_transfers_amount_positive" CHECK ("amount" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "seamless_wallet_transfers_idempotency_key_key" ON "seamless_wallet_transfers"("idempotency_key");
CREATE INDEX "seamless_wallet_transfers_direction_status_next_attempt_at_idx" ON "seamless_wallet_transfers"("direction", "status", "next_attempt_at");
CREATE INDEX "seamless_wallet_transfers_user_id_created_at_idx" ON "seamless_wallet_transfers"("user_id", "created_at");
CREATE INDEX "seamless_wallet_transfers_reference_id_idx" ON "seamless_wallet_transfers"("reference_id");
