BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS price_conversion;

CREATE TYPE price_conversion."PriceProviderCode" AS ENUM ('COINGECKO', 'ALCHEMY', 'COINMARKETCAP');
CREATE TYPE price_conversion."PriceProviderRole" AS ENUM ('PRIMARY', 'COMPARISON', 'FALLBACK');
CREATE TYPE price_conversion."CurrencyKind" AS ENUM ('CRYPTO', 'FIAT');
CREATE TYPE price_conversion."CurrencyStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE price_conversion."PriceFetchRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');
CREATE TYPE price_conversion."PriceResolutionReason" AS ENUM ('PRIMARY_CONFIRMED', 'FALLBACK_PRIMARY_FAILED', 'FALLBACK_DIVERGENCE', 'RECOVERED', 'STALE_DISPLAY', 'PRICE_UNAVAILABLE');

CREATE TABLE price_conversion.price_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code price_conversion."PriceProviderCode" NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sensitive_role price_conversion."PriceProviderRole" UNIQUE,
  view_enabled BOOLEAN NOT NULL DEFAULT false,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_providers_one_view_enabled ON price_conversion.price_providers (view_enabled) WHERE view_enabled;

CREATE TABLE price_conversion.price_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  divergence_threshold_bps INTEGER NOT NULL DEFAULT 500 CHECK (divergence_threshold_bps BETWEEN 0 AND 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE price_conversion.currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(32) NOT NULL CHECK (symbol = upper(symbol) AND symbol <> ''),
  name VARCHAR(128) NOT NULL CHECK (name <> ''),
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  kind price_conversion."CurrencyKind" NOT NULL,
  status price_conversion."CurrencyStatus" NOT NULL DEFAULT 'ACTIVE',
  viewable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, kind)
);

CREATE TABLE price_conversion.currency_provider_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  external_id VARCHAR(160) NOT NULL CHECK (external_id <> ''),
  symbol VARCHAR(64) NOT NULL CHECK (symbol <> ''),
  network VARCHAR(64),
  address VARCHAR(160),
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (currency_id, provider_id),
  UNIQUE (provider_id, external_id)
);

CREATE TABLE price_conversion.price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  price_usd NUMERIC(38, 18) NOT NULL CHECK (price_usd > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  response_hash CHAR(64) NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_snapshots_currency_provider_observed ON price_conversion.price_snapshots (currency_id, provider_id, observed_at DESC);

CREATE TABLE price_conversion.price_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  effective_provider_id UUID REFERENCES price_conversion.price_providers(id),
  effective_snapshot_id UUID REFERENCES price_conversion.price_snapshots(id),
  effective_price_usd NUMERIC(38, 18),
  observed_at TIMESTAMPTZ,
  primary_snapshot_id UUID,
  comparison_snapshot_id UUID,
  fallback_snapshot_id UUID,
  difference_bps BIGINT CHECK (difference_bps >= 0),
  reason price_conversion."PriceResolutionReason" NOT NULL,
  stale BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((effective_snapshot_id IS NULL) = (effective_price_usd IS NULL)),
  CHECK (effective_price_usd IS NULL OR effective_price_usd > 0)
);
CREATE INDEX price_resolutions_currency_created ON price_conversion.price_resolutions (currency_id, created_at DESC, id DESC);

CREATE TABLE price_conversion.price_fetch_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status price_conversion."PriceFetchRunStatus" NOT NULL,
  requested_count INTEGER NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
  observed_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  safe_error_code VARCHAR(64),
  worker_instance_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, scheduled_for)
);
CREATE INDEX price_fetch_runs_provider_created ON price_conversion.price_fetch_runs (provider_id, created_at DESC, id DESC);

CREATE FUNCTION price_conversion.reject_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'price conversion audit rows are append-only'; END;
$$;
CREATE TRIGGER price_snapshots_append_only BEFORE UPDATE OR DELETE ON price_conversion.price_snapshots FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_resolutions_append_only BEFORE UPDATE OR DELETE ON price_conversion.price_resolutions FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();

COMMIT;
