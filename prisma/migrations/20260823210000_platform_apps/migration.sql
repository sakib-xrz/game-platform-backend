-- CreateEnum
CREATE TYPE "platform_app_status" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "platform_apps" (
    "id" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "sha_key" TEXT NOT NULL,
    "status" "platform_app_status" NOT NULL DEFAULT 'active',
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_apps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_apps_package_name_key" ON "platform_apps"("package_name");

-- CreateIndex
CREATE INDEX "platform_apps_status_updated_at_idx" ON "platform_apps"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "platform_apps" ADD CONSTRAINT "platform_apps_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
