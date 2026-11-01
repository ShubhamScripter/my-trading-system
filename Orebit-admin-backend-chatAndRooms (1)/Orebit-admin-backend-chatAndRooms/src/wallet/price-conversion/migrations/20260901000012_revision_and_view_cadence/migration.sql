BEGIN;

-- A durable pre-HTTP claim makes each VIEW provider call at most once per schedule bucket.
CREATE TABLE price_conversion.price_view_fetch_buckets (
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, scheduled_for)
);

CREATE TRIGGER price_view_fetch_buckets_append_only
  BEFORE UPDATE OR DELETE ON price_conversion.price_view_fetch_buckets
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_view_fetch_buckets_no_truncate
  BEFORE TRUNCATE ON price_conversion.price_view_fetch_buckets
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();

-- Resolution rows stamp the live configuration revision without trusting application input.
CREATE FUNCTION price_conversion.current_price_config_revision() RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
  SELECT revision FROM price_conversion.price_settings WHERE id
$$;

ALTER TABLE price_conversion.price_resolutions
  ADD COLUMN config_revision BIGINT NOT NULL
    DEFAULT price_conversion.current_price_config_revision(),
  ADD CONSTRAINT price_resolutions_config_revision_check CHECK (config_revision >= 0);

CREATE INDEX price_resolutions_currency_revision_created
  ON price_conversion.price_resolutions (currency_id, config_revision, created_at DESC, id DESC);

-- Every live revision change fails closed before new provider data is resolved.
CREATE FUNCTION price_conversion.force_degraded_on_config_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, price_conversion
AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    NEW.security_state := 'DEGRADED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER price_settings_revision_degrades
  BEFORE UPDATE ON price_conversion.price_settings
  FOR EACH ROW EXECUTE FUNCTION price_conversion.force_degraded_on_config_revision();

-- Deferred validation permits currency-then-reference ordering inside one transaction.
CREATE FUNCTION price_conversion.require_active_crypto_provider_ref() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
DECLARE
  current_kind price_conversion."CurrencyKind";
  current_status price_conversion."CurrencyStatus";
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind
    AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  SELECT kind, status INTO current_kind, current_status
  FROM price_conversion.currencies WHERE id = NEW.id;

  IF current_kind = 'CRYPTO' AND current_status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs r
      WHERE r.currency_id = NEW.id AND r.active
    ) THEN
    RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_provider_ref() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER currencies_active_crypto_ref_guard
  AFTER INSERT OR UPDATE ON price_conversion.currencies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_conversion.require_active_crypto_provider_ref();

-- Money reads accept only the latest resolution for the current revision and exact live roles.
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
    effective.code::text,
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
  JOIN price_conversion.price_providers effective
    ON effective.id = r.effective_provider_id AND effective.enabled
  JOIN price_conversion.price_providers primary_provider
    ON primary_provider.enabled AND primary_provider.sensitive_role = 'PRIMARY'
  JOIN price_conversion.price_providers comparison_provider
    ON comparison_provider.enabled AND comparison_provider.sensitive_role = 'COMPARISON'
  JOIN price_conversion.price_providers fallback_provider
    ON fallback_provider.enabled AND fallback_provider.sensitive_role = 'FALLBACK'
  JOIN price_conversion.price_snapshots snapshot
    ON snapshot.id = r.effective_snapshot_id
    AND snapshot.currency_id = r.currency_id
    AND snapshot.provider_id = r.effective_provider_id
    AND snapshot.price_usd = r.effective_price_usd
    AND snapshot.observed_at = r.observed_at
  CROSS JOIN price_conversion.price_settings settings
  WHERE NOT r.stale
    AND settings.security_state = 'HEALTHY'
    AND r.config_revision = settings.revision
    AND r.configured_primary_provider_id = primary_provider.id
    AND r.configured_comparison_provider_id = comparison_provider.id
    AND r.configured_fallback_provider_id = fallback_provider.id
    AND (
      (r.reason IN ('PRIMARY_CONFIRMED', 'RECOVERED')
        AND r.effective_provider_id = primary_provider.id)
      OR (r.reason IN ('FALLBACK_PRIMARY_FAILED', 'FALLBACK_DIVERGENCE')
        AND r.effective_provider_id = fallback_provider.id)
    )
    AND snapshot.observed_at >= statement_timestamp()
      - make_interval(secs => effective.freshness_seconds)
    AND snapshot.observed_at <= statement_timestamp() + interval '60 seconds'
  ORDER BY r.currency_id
$$;

REVOKE ALL ON FUNCTION price_conversion.resolve_money_batch_for_ledger(UUID[]) FROM PUBLIC;

UPDATE price_conversion.price_settings
SET security_state = 'DEGRADED', updated_at = statement_timestamp()
WHERE id;

COMMIT;
