-- CreateEnum
CREATE TYPE "platform_user_status" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "platform_app_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "photo_url" TEXT,
    "status" "platform_user_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_coin_deposits" (
    "id" TEXT NOT NULL,
    "platform_app_id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "received_amount" BIGINT NOT NULL,
    "converted_amount" BIGINT NOT NULL,
    "wallet_ledger_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_coin_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_users_platform_app_id_email_idx" ON "platform_users"("platform_app_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_platform_app_id_external_user_id_key" ON "platform_users"("platform_app_id", "external_user_id");

-- CreateIndex
CREATE INDEX "platform_coin_deposits_platform_user_id_created_at_idx" ON "platform_coin_deposits"("platform_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_coin_deposits_platform_app_id_client_request_id_key" ON "platform_coin_deposits"("platform_app_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_coin_deposits_wallet_ledger_id_key" ON "platform_coin_deposits"("wallet_ledger_id");

-- AddForeignKey
ALTER TABLE "platform_users" ADD CONSTRAINT "platform_users_platform_app_id_fkey" FOREIGN KEY ("platform_app_id") REFERENCES "platform_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_coin_deposits" ADD CONSTRAINT "platform_coin_deposits_platform_app_id_fkey" FOREIGN KEY ("platform_app_id") REFERENCES "platform_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_coin_deposits" ADD CONSTRAINT "platform_coin_deposits_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_coin_deposits" ADD CONSTRAINT "platform_coin_deposits_wallet_ledger_id_fkey" FOREIGN KEY ("wallet_ledger_id") REFERENCES "wallet_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
