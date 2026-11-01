BEGIN;

CREATE OR REPLACE FUNCTION price_conversion.guard_price_fetch_run_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'price fetch run identity is immutable';
  END IF;
  IF OLD.status IN ('SUCCESS', 'SKIPPED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal price fetch run is immutable';
  END IF;
  IF NEW.status = 'RUNNING' THEN
    IF OLD.status NOT IN ('FAILED', 'RUNNING')
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.worker_instance_id = ''
      OR NEW.started_at IS NULL
      OR NEW.started_at IS NOT DISTINCT FROM OLD.started_at
      OR NEW.finished_at IS NOT NULL
      OR NEW.safe_error_code IS NOT NULL
      OR NEW.next_retry_at IS NOT NULL THEN
      RAISE EXCEPTION 'illegal price fetch retry claim lifecycle';
    END IF;
  ELSIF NEW.status IN ('SUCCESS', 'FAILED', 'SKIPPED') THEN
    IF OLD.status <> 'RUNNING'
      OR NEW.attempt_count <> OLD.attempt_count
      OR NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.finished_at IS NULL
      OR (NEW.status IN ('SUCCESS', 'SKIPPED')
        AND (NEW.safe_error_code IS NOT NULL OR NEW.next_retry_at IS NOT NULL))
      OR (NEW.status = 'FAILED' AND NEW.safe_error_code IS NULL) THEN
      RAISE EXCEPTION 'illegal price fetch terminal lifecycle';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'illegal price fetch lifecycle transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION price_conversion.guard_price_notification_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'price notification identity and payload are immutable';
  END IF;
  IF OLD.delivery_status IN ('SENT', 'DEAD') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal price notification is immutable';
  END IF;
  IF NEW.delivery_status = 'PROCESSING' THEN
    IF OLD.delivery_status NOT IN ('PENDING', 'FAILED', 'PROCESSING')
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.claimed_at IS NULL
      OR NEW.claimed_by IS NULL OR NEW.claimed_by = ''
      OR NEW.claim_token IS NULL
      OR NEW.next_attempt_at IS NOT NULL
      OR NEW.safe_error_code IS NOT NULL
      OR NEW.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'illegal price notification claim lifecycle';
    END IF;
  ELSIF NEW.delivery_status IN ('SENT', 'FAILED', 'DEAD') THEN
    IF OLD.delivery_status <> 'PROCESSING'
      OR NEW.attempt_count <> OLD.attempt_count
      OR NEW.claimed_at IS NOT NULL
      OR NEW.claimed_by IS NOT NULL
      OR NEW.claim_token IS NOT NULL
      OR (NEW.delivery_status = 'SENT' AND (
        NEW.delivered_at IS NULL OR NEW.next_attempt_at IS NOT NULL OR NEW.safe_error_code IS NOT NULL))
      OR (NEW.delivery_status = 'FAILED' AND (
        NEW.delivered_at IS NOT NULL OR NEW.next_attempt_at IS NULL OR NEW.safe_error_code IS NULL))
      OR (NEW.delivery_status = 'DEAD' AND (
        NEW.delivered_at IS NOT NULL OR NEW.next_attempt_at IS NOT NULL OR NEW.safe_error_code IS NULL)) THEN
      RAISE EXCEPTION 'illegal price notification terminal lifecycle';
    END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'illegal price notification lifecycle transition';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
