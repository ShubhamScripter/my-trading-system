BEGIN;

CREATE TYPE price_conversion."PriceViewResolutionStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');
CREATE TYPE price_conversion."PriceViewResolutionReason" AS ENUM (
  'CONFIGURED_PROVIDER',
  'SENSITIVE_FALLBACK_PROVIDER',
  'ALCHEMY_FALLBACK_SECONDARY',
  'VIEW_FAILURE_SECONDARY',
  'SECONDARY_UNAVAILABLE'
);

CREATE TABLE price_conversion.price_view_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  selected_provider_id UUID REFERENCES price_conversion.price_providers(id),
  configured_provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  secondary_provider_id UUID REFERENCES price_conversion.price_providers(id),
  sensitive_resolution_id UUID REFERENCES price_conversion.price_resolutions(id),
  reason price_conversion."PriceViewResolutionReason" NOT NULL,
  status price_conversion."PriceViewResolutionStatus" NOT NULL,
  safe_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_view_resolutions_selected_status_check CHECK (
    (status = 'AVAILABLE') = (selected_provider_id IS NOT NULL)
  ),
  CONSTRAINT price_view_resolutions_provider_pair_check CHECK (
    secondary_provider_id IS NULL OR configured_provider_id <> secondary_provider_id
  )
);

CREATE INDEX price_view_resolutions_currency_created
  ON price_conversion.price_view_resolutions (currency_id, created_at DESC, id DESC);
CREATE INDEX price_view_resolutions_selected_provider_created
  ON price_conversion.price_view_resolutions (selected_provider_id, created_at DESC);
CREATE INDEX price_view_resolutions_sensitive_resolution_idx
  ON price_conversion.price_view_resolutions (sensitive_resolution_id)
  WHERE sensitive_resolution_id IS NOT NULL;
CREATE INDEX price_view_resolutions_status_created
  ON price_conversion.price_view_resolutions (status, created_at DESC);

CREATE TRIGGER price_view_resolutions_append_only
  BEFORE UPDATE OR DELETE ON price_conversion.price_view_resolutions
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_view_resolutions_no_truncate
  BEFORE TRUNCATE ON price_conversion.price_view_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();

CREATE FUNCTION price_conversion.resolve_money_batch_for_ledger(currency_ids UUID[])
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
    c.status = 'DISABLED',
    settings.security_state::text
  FROM latest r
  JOIN price_conversion.currencies c
    ON c.id = r.currency_id AND c.kind = 'CRYPTO'
  JOIN price_conversion.price_providers p
    ON p.id = r.effective_provider_id
  JOIN price_conversion.price_snapshots snapshot
    ON snapshot.id = r.effective_snapshot_id
    AND snapshot.currency_id = r.currency_id
    AND snapshot.provider_id = r.effective_provider_id
    AND snapshot.price_usd = r.effective_price_usd
    AND snapshot.observed_at = r.observed_at
  CROSS JOIN price_conversion.price_settings settings
  ORDER BY r.currency_id
$$;

REVOKE ALL ON FUNCTION price_conversion.resolve_money_batch_for_ledger(UUID[]) FROM PUBLIC;

COMMIT;
