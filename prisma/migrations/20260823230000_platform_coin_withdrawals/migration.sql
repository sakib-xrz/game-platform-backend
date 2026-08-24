-- CreateTable
CREATE TABLE "platform_coin_withdrawals" (
    "id" TEXT NOT NULL,
    "platform_app_id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "requested_amount" BIGINT NOT NULL,
    "transferred_amount" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_coin_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_coin_withdrawals_platform_user_id_created_at_idx" ON "platform_coin_withdrawals"("platform_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_coin_withdrawals_platform_app_id_client_request_id_key" ON "platform_coin_withdrawals"("platform_app_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_coin_withdrawals_wallet_ledger_id_key" ON "platform_coin_withdrawals"("wallet_ledger_id");

-- AddForeignKey
ALTER TABLE "platform_coin_withdrawals" ADD CONSTRAINT "platform_coin_withdrawals_platform_app_id_fkey" FOREIGN KEY ("platform_app_id") REFERENCES "platform_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_coin_withdrawals" ADD CONSTRAINT "platform_coin_withdrawals_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_coin_withdrawals" ADD CONSTRAINT "platform_coin_withdrawals_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
