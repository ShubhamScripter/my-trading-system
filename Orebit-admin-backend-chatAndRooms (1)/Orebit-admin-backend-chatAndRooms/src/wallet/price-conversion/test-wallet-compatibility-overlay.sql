BEGIN;

DO $wallet_price_test_compatibility$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'price_conversion' AND table_name = 'currencies'
      AND column_name = 'status'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'price_conversion' AND table_name = 'currencies'
        AND column_name = 'pricing_status'
    ) THEN
      RAISE EXCEPTION 'price test currency status columns are ambiguous';
    END IF;
    ALTER TABLE price_conversion.currencies RENAME COLUMN status TO pricing_status;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'price_conversion' AND table_name = 'currencies'
      AND column_name = 'pricing_status'
  ) THEN
    RAISE EXCEPTION 'price test currency pricing_status column is missing';
  END IF;
END;
$wallet_price_test_compatibility$;

CREATE OR REPLACE FUNCTION price_conversion.require_active_crypto_provider_ref() RETURNS trigger
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
    AND NEW.pricing_status IS NOT DISTINCT FROM OLD.pricing_status THEN
    RETURN NULL;
  END IF;

  SELECT kind, pricing_status INTO current_kind, current_status
  FROM price_conversion.currencies WHERE id = NEW.id;

  IF current_kind = 'CRYPTO' AND current_status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs reference
      WHERE reference.currency_id = NEW.id AND reference.active
    ) THEN
    RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_provider_ref() FROM PUBLIC;

CREATE OR REPLACE FUNCTION price_conversion.require_active_crypto_ref_after_mutation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
DECLARE
  old_currency_id UUID;
  new_currency_id UUID;
  affected_currency_id UUID;
BEGIN
  old_currency_id := OLD.currency_id;
  IF TG_OP = 'UPDATE' THEN
    new_currency_id := NEW.currency_id;
  END IF;

  FOR affected_currency_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[old_currency_id, new_currency_id]) AS ids(id)
    WHERE id IS NOT NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM price_conversion.currencies c
      WHERE c.id = affected_currency_id AND c.kind = 'CRYPTO'
        AND c.pricing_status = 'ACTIVE'
    ) AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs r
      WHERE r.currency_id = affected_currency_id AND r.active
    ) THEN
      RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_ref_after_mutation() FROM PUBLIC;

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
    c.pricing_status = 'DISABLED' OR c.auto_disabled,
    settings.security_state::text
  FROM latest r
  JOIN price_conversion.currencies c
    ON c.id = r.currency_id
    AND c.kind = 'CRYPTO'
    AND c.pricing_status = 'ACTIVE'
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

COMMIT;
