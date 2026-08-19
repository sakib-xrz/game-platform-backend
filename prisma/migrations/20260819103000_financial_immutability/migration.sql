-- Financial, wagering, settlement, payout/refund, and approval evidence rows
-- are append-only. Operational status transitions are represented by new rows
-- or explicit parent status fields; historical money/evidence rows are never
-- edited or deleted from the database.
CREATE OR REPLACE FUNCTION prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON "wallet_ledger"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER greedy_bets_append_only
  BEFORE UPDATE OR DELETE ON "greedy_bets"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER greedy_bet_settlements_append_only
  BEFORE UPDATE OR DELETE ON "greedy_bet_settlements"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER greedy_user_payouts_append_only
  BEFORE UPDATE OR DELETE ON "greedy_user_payouts"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER greedy_user_refunds_append_only
  BEFORE UPDATE OR DELETE ON "greedy_user_refunds"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER admin_approval_decisions_append_only
  BEFORE UPDATE OR DELETE ON "admin_approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION prevent_approval_payload_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin approval requests are not deletable';
  END IF;
  IF OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
     OR OLD.requested_by_admin_id IS DISTINCT FROM NEW.requested_by_admin_id
     OR OLD.action_type IS DISTINCT FROM NEW.action_type
     OR OLD.target_type IS DISTINCT FROM NEW.target_type
     OR OLD.target_id IS DISTINCT FROM NEW.target_id
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'admin approval request evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_approval_request_evidence_immutable
  BEFORE UPDATE OR DELETE ON "admin_approval_requests"
  FOR EACH ROW EXECUTE FUNCTION prevent_approval_payload_mutation();
