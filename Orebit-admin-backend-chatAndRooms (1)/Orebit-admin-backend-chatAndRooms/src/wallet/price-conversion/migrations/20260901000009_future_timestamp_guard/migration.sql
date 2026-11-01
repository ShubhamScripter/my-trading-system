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
    AND snapshot.observed_at >= statement_timestamp()
      - make_interval(secs => p.freshness_seconds)
    AND snapshot.observed_at <= statement_timestamp() + interval '60 seconds'
  ORDER BY r.currency_id
$$;

REVOKE ALL ON FUNCTION price_conversion.resolve_money_batch_for_ledger(UUID[]) FROM PUBLIC;

COMMIT;
