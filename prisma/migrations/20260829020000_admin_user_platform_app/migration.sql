-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN "platform_app_id" TEXT;

-- CreateIndex
CREATE INDEX "admin_users_platform_app_id_idx" ON "admin_users"("platform_app_id");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_platform_app_id_fkey" FOREIGN KEY ("platform_app_id") REFERENCES "platform_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
