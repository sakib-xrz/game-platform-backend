-- CreateEnum
CREATE TYPE "admin_role" AS ENUM ('super_admin', 'game_operator', 'finance_operator', 'support', 'auditor');

-- CreateEnum
CREATE TYPE "admin_status" AS ENUM ('active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "admin_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired', 'applied', 'failed');

-- CreateEnum
CREATE TYPE "admin_approval_decision" AS ENUM ('approve', 'reject');

-- CreateEnum
CREATE TYPE "admin_asset_status" AS ENUM ('pending', 'ready', 'rejected', 'deleted');

-- CreateEnum
CREATE TYPE "ops_alert_severity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "ops_alert_status" AS ENUM ('open', 'acknowledged', 'resolved');

-- AlterEnum
ALTER TYPE "config_version_status" ADD VALUE 'review_pending';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_role" "admin_role",
ADD COLUMN     "admin_user_id" TEXT,
ADD COLUMN     "approval_request_id" TEXT,
ADD COLUMN     "outcome" TEXT;

-- AlterTable
ALTER TABLE "greedy_option_versions" ADD COLUMN     "asset_id" TEXT;

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "admin_role" NOT NULL,
    "status" "admin_status" NOT NULL DEFAULT 'active',
    "force_password_change" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approval_requests" (
    "id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "requested_by_admin_id" TEXT NOT NULL,
    "status" "admin_approval_status" NOT NULL DEFAULT 'pending',
    "required_approvals" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "applied_at" TIMESTAMP(3),
    "execution_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approval_decisions" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "decision" "admin_approval_decision" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT 'default',
    "wallet_adjustment_threshold" BIGINT NOT NULL DEFAULT 10000,
    "approval_expiry_minutes" INTEGER NOT NULL DEFAULT 1440,
    "updated_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_assets" (
    "id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "status" "admin_asset_status" NOT NULL DEFAULT 'pending',
    "cdn_url" TEXT,
    "uploaded_by_admin_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_idempotency_records" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'processing',
    "http_status" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_alerts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "ops_alert_severity" NOT NULL,
    "status" "ops_alert_status" NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "metadata" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_users_role_status_idx" ON "admin_users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_revoked_at_idx" ON "admin_sessions"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "admin_sessions_idle_expires_at_idx" ON "admin_sessions"("idle_expires_at");

-- CreateIndex
CREATE INDEX "admin_sessions_absolute_expires_at_idx" ON "admin_sessions"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "admin_approval_requests_status_expires_at_idx" ON "admin_approval_requests"("status", "expires_at");

-- CreateIndex
CREATE INDEX "admin_approval_requests_target_type_target_id_idx" ON "admin_approval_requests"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_approval_requests_requested_by_admin_id_action_type_i_key" ON "admin_approval_requests"("requested_by_admin_id", "action_type", "idempotency_key");

-- CreateIndex
CREATE INDEX "admin_approval_decisions_admin_user_id_created_at_idx" ON "admin_approval_decisions"("admin_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_approval_decisions_request_id_admin_user_id_key" ON "admin_approval_decisions"("request_id", "admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_policies_code_key" ON "admin_policies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "admin_assets_object_key_key" ON "admin_assets"("object_key");

-- CreateIndex
CREATE INDEX "admin_assets_status_created_at_idx" ON "admin_assets"("status", "created_at");

-- CreateIndex
CREATE INDEX "admin_idempotency_records_expires_at_idx" ON "admin_idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_idempotency_records_admin_user_id_scope_idempotency_k_key" ON "admin_idempotency_records"("admin_user_id", "scope", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ops_alerts_dedupe_key_key" ON "ops_alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "ops_alerts_status_severity_last_seen_at_idx" ON "ops_alerts"("status", "severity", "last_seen_at");

-- CreateIndex
CREATE INDEX "ops_alerts_code_source_last_seen_at_idx" ON "ops_alerts"("code", "source", "last_seen_at");

-- AddForeignKey
ALTER TABLE "greedy_option_versions" ADD CONSTRAINT "greedy_option_versions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "admin_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "admin_approval_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_requested_by_admin_id_fkey" FOREIGN KEY ("requested_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approval_decisions" ADD CONSTRAINT "admin_approval_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "admin_approval_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approval_decisions" ADD CONSTRAINT "admin_approval_decisions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_policies" ADD CONSTRAINT "admin_policies_updated_by_admin_id_fkey" FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_assets" ADD CONSTRAINT "admin_assets_uploaded_by_admin_id_fkey" FOREIGN KEY ("uploaded_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_idempotency_records" ADD CONSTRAINT "admin_idempotency_records_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Result evidence is append-only. The worker may record the first reveal timestamp,
-- but no protected result field can ever be changed or deleted afterwards.
CREATE OR REPLACE FUNCTION prevent_greedy_result_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'greedy round results are immutable';
  END IF;
  IF ROW(OLD.id, OLD.round_id, OLD.winning_option_version_id, OLD.algorithm_version,
         OLD.config_version_id, OLD.entropy_digest, OLD.audit_hash, OLD.generated_at)
     IS DISTINCT FROM
     ROW(NEW.id, NEW.round_id, NEW.winning_option_version_id, NEW.algorithm_version,
         NEW.config_version_id, NEW.entropy_digest, NEW.audit_hash, NEW.generated_at) THEN
    RAISE EXCEPTION 'greedy round result evidence is immutable';
  END IF;
  IF OLD.revealed_at IS NOT NULL AND NEW.revealed_at IS DISTINCT FROM OLD.revealed_at THEN
    RAISE EXCEPTION 'greedy round result reveal timestamp is immutable once recorded';
  END IF;
  IF OLD.revealed_at IS NULL AND NEW.revealed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.revealed_at IS NULL AND NEW.revealed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid greedy round result mutation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER greedy_round_results_immutable
  BEFORE UPDATE OR DELETE ON "greedy_round_results"
  FOR EACH ROW EXECUTE FUNCTION prevent_greedy_result_mutation();

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
