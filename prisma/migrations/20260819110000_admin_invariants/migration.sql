-- Lifecycle records carry mutable status, but their approved/request/config
-- evidence is immutable once recorded.
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
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.required_approvals IS DISTINCT FROM NEW.required_approvals
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'admin approval request evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_admin_idempotency_record() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin idempotency records are immutable';
  END IF;
  IF OLD.admin_user_id IS DISTINCT FROM NEW.admin_user_id
     OR OLD.scope IS DISTINCT FROM NEW.scope
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'admin idempotency request evidence is immutable';
  END IF;
  IF OLD.status IN ('completed', 'failed') AND ROW(OLD.status, OLD.http_status, OLD.response_body)
     IS DISTINCT FROM ROW(NEW.status, NEW.http_status, NEW.response_body) THEN
    RAISE EXCEPTION 'admin idempotency result is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_idempotency_records_immutable
  BEFORE UPDATE OR DELETE ON "admin_idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION protect_admin_idempotency_record();

CREATE OR REPLACE FUNCTION protect_greedy_config_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD.game_id IS DISTINCT FROM NEW.game_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'greedy configuration identity is immutable';
  END IF;
  IF OLD.status <> 'draft' AND ROW(OLD.betting_duration_ms, OLD.lock_duration_ms,
       OLD.drawing_duration_ms, OLD.result_duration_ms, OLD.min_bet,
       OLD.max_single_bet, OLD.max_round_bet, OLD.notes)
     IS DISTINCT FROM ROW(NEW.betting_duration_ms, NEW.lock_duration_ms,
       NEW.drawing_duration_ms, NEW.result_duration_ms, NEW.min_bet,
       NEW.max_single_bet, NEW.max_round_bet, NEW.notes) THEN
    RAISE EXCEPTION 'reviewed and historical greedy configurations are immutable';
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'review_pending') OR
    (OLD.status = 'review_pending' AND NEW.status = 'published') OR
    (OLD.status = 'published' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid greedy configuration status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER greedy_config_versions_lifecycle_protected
  BEFORE UPDATE ON "greedy_config_versions"
  FOR EACH ROW EXECUTE FUNCTION protect_greedy_config_lifecycle();

CREATE OR REPLACE FUNCTION protect_greedy_config_child() RETURNS trigger AS $$
DECLARE
  config_id TEXT;
  config_status config_version_status;
BEGIN
  config_id := COALESCE(NEW.config_version_id, OLD.config_version_id);
  SELECT status INTO config_status FROM greedy_config_versions WHERE id = config_id;
  IF config_status IS DISTINCT FROM 'draft'::config_version_status THEN
    RAISE EXCEPTION 'options and chips of reviewed configurations are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER greedy_option_versions_config_protected
  BEFORE INSERT OR UPDATE OR DELETE ON "greedy_option_versions"
  FOR EACH ROW EXECUTE FUNCTION protect_greedy_config_child();

CREATE TRIGGER greedy_chip_values_config_protected
  BEFORE INSERT OR UPDATE OR DELETE ON "greedy_chip_value_versions"
  FOR EACH ROW EXECUTE FUNCTION protect_greedy_config_child();

CREATE OR REPLACE FUNCTION protect_ready_admin_asset() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' AND ROW(OLD.object_key, OLD.bucket, OLD.content_type,
       OLD.byte_size, OLD.checksum_sha256, OLD.cdn_url, OLD.uploaded_by_admin_id,
       OLD.completed_at, OLD.created_at)
     IS DISTINCT FROM ROW(NEW.object_key, NEW.bucket, NEW.content_type,
       NEW.byte_size, NEW.checksum_sha256, NEW.cdn_url, NEW.uploaded_by_admin_id,
       NEW.completed_at, NEW.created_at) THEN
    RAISE EXCEPTION 'published admin asset evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ready_admin_assets_immutable
  BEFORE UPDATE ON "admin_assets"
  FOR EACH ROW EXECUTE FUNCTION protect_ready_admin_asset();
