-- AlterTable
ALTER TABLE "platform_apps" ADD COLUMN "signing_secret" TEXT;
ALTER TABLE "platform_apps" ADD COLUMN "signing_secret_previous" TEXT;

-- Backfill existing rows with deterministic placeholder secrets; rotate in admin after deploy
UPDATE "platform_apps"
SET "signing_secret" = md5(random()::text || "id" || clock_timestamp()::text)
  || md5("package_name" || clock_timestamp()::text || random()::text)
WHERE "signing_secret" IS NULL;

ALTER TABLE "platform_apps" ALTER COLUMN "signing_secret" SET NOT NULL;
