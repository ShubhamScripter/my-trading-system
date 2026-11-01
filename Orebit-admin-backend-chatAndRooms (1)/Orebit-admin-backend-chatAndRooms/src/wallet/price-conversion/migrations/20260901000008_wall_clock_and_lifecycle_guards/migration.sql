BEGIN;

CREATE OR REPLACE FUNCTION price_conversion.resolve_money_batch_for_ledger(currency_ids UUID[])
RETURNS TABLE (
  resolution_id UUID,
  currency_id UUID,
  price_usd NUMERIC(38,18),
  provider TEXT,
  snapshot_id UUID,
  observed_at TIMESTAMPTZ,
  kind TEXT,
  stale BOOLEAN,
  disabled BOOLEAN,
  security_state TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (r.currency_id) r.*
    FROM price_conversion.price_resolutions r
    WHERE r.currency_id = ANY(currency_ids)
    ORDER BY r.currency_id, r.created_at DESC, r.id DESC
  )
  SELECT
    r.id,
    r.currency_id,
    r.effective_price_usd,
    p.code::text,
    r.effective_snapshot_id,
    r.observed_at,
    c.kind::text,
    r.stale,
    c.status = 'DISABLED' OR c.auto_disabled,
    settings.security_state::text
  FROM latest r
  JOIN price_conversion.currencies c
    ON c.id = r.currency_id
    AND c.kind = 'CRYPTO'
    AND c.status = 'ACTIVE'
    AND NOT c.auto_disabled
  JOIN price_conversion.price_providers p
    ON p.id = r.effective_provider_id AND p.enabled
  JOIN price_conversion.price_snapshots snapshot
    ON snapshot.id = r.effective_snapshot_id
    AND snapshot.currency_id = r.currency_id
    AND snapshot.provider_id = r.effective_provider_id
    AND snapshot.price_usd = r.effective_price_usd
    AND snapshot.observed_at = r.observed_at
  CROSS JOIN price_conversion.price_settings settings
  WHERE NOT r.stale
    AND settings.security_state = 'HEALTHY'
    AND r.observed_at >= statement_timestamp()
      - make_interval(secs => p.freshness_seconds)
  ORDER BY r.currency_id
$$;

REVOKE ALL ON FUNCTION price_conversion.resolve_money_batch_for_ledger(UUID[]) FROM PUBLIC;

CREATE FUNCTION price_conversion.guard_price_config_change_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.changelog IS DISTINCT FROM OLD.changelog
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.config IS DISTINCT FROM OLD.config
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'price config identity and payload are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('SCHEDULED', 'ARCHIVED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('LIVE', 'REJECTED', 'ARCHIVED'))
    OR (OLD.status = 'LIVE' AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'illegal price config lifecycle transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.effective_at IS DISTINCT FROM OLD.effective_at AND NOT (
    OLD.status = 'DRAFT' AND NEW.status = 'SCHEDULED'
      AND OLD.effective_at IS NULL AND NEW.effective_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'illegal price config effective_at lifecycle change';
  END IF;
  IF NEW.status = 'SCHEDULED' AND NEW.effective_at IS NULL THEN
    RAISE EXCEPTION 'SCHEDULED price config requires effective_at';
  END IF;
  IF NEW.applied_at IS DISTINCT FROM OLD.applied_at AND NOT (
    OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL AND NEW.status = 'LIVE'
  ) THEN
    RAISE EXCEPTION 'illegal price config applied_at lifecycle change';
  END IF;
  IF NEW.status = 'LIVE' AND NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'LIVE price config requires applied_at';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_config_changes_update_guard
  BEFORE UPDATE ON price_conversion.price_config_changes
  FOR EACH ROW EXECUTE FUNCTION price_conversion.guard_price_config_change_update();

CREATE FUNCTION price_conversion.guard_price_fetch_run_update() RETURNS trigger
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
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'RUNNING' AND NEW.status IN ('SUCCESS', 'FAILED', 'SKIPPED'))
    OR (OLD.status = 'FAILED' AND NEW.status = 'RUNNING')
  ) THEN
    RAISE EXCEPTION 'illegal price fetch lifecycle transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count AND NOT (
    NEW.status = 'RUNNING' AND NEW.attempt_count = OLD.attempt_count + 1
  ) THEN
    RAISE EXCEPTION 'illegal price fetch attempt lifecycle change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_fetch_runs_update_guard
  BEFORE UPDATE ON price_conversion.price_fetch_runs
  FOR EACH ROW EXECUTE FUNCTION price_conversion.guard_price_fetch_run_update();

CREATE FUNCTION price_conversion.guard_price_notification_update() RETURNS trigger
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
  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status AND NOT (
    (OLD.delivery_status IN ('PENDING', 'FAILED', 'PROCESSING')
      AND NEW.delivery_status = 'PROCESSING')
    OR (OLD.delivery_status = 'PROCESSING'
      AND NEW.delivery_status IN ('SENT', 'FAILED', 'DEAD'))
  ) THEN
    RAISE EXCEPTION 'illegal price notification lifecycle transition: % -> %',
      OLD.delivery_status, NEW.delivery_status;
  END IF;
  IF NEW.attempt_count < OLD.attempt_count
    OR NEW.attempt_count > OLD.attempt_count + 1
    OR (NEW.attempt_count = OLD.attempt_count + 1 AND NEW.delivery_status <> 'PROCESSING') THEN
    RAISE EXCEPTION 'illegal price notification attempt lifecycle change';
  END IF;
  IF NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
    AND NOT (OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL
      AND NEW.delivery_status = 'SENT') THEN
    RAISE EXCEPTION 'illegal price notification delivered_at lifecycle change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_admin_notifications_update_guard
  BEFORE UPDATE ON price_conversion.price_admin_notifications
  FOR EACH ROW EXECUTE FUNCTION price_conversion.guard_price_notification_update();

COMMIT;
