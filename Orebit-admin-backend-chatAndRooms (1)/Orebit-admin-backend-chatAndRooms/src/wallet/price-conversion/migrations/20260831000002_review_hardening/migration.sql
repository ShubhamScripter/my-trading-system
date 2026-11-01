BEGIN;

ALTER TYPE price_conversion."PriceFetchRunStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TABLE price_conversion.price_fetch_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE price_conversion.price_resolutions
  ADD CONSTRAINT price_resolutions_primary_snapshot_fkey FOREIGN KEY (primary_snapshot_id) REFERENCES price_conversion.price_snapshots(id),
  ADD CONSTRAINT price_resolutions_comparison_snapshot_fkey FOREIGN KEY (comparison_snapshot_id) REFERENCES price_conversion.price_snapshots(id),
  ADD CONSTRAINT price_resolutions_fallback_snapshot_fkey FOREIGN KEY (fallback_snapshot_id) REFERENCES price_conversion.price_snapshots(id);
ALTER TABLE price_conversion.currencies
  ADD COLUMN IF NOT EXISTS chain_codes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS binance_symbol VARCHAR(64),
  ADD COLUMN IF NOT EXISTS logo_storage_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS geo_countries TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS kyc_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS access_audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS listing_kind VARCHAR(32) NOT NULL DEFAULT 'PERMANENT',
  ADD COLUMN IF NOT EXISTS listing_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delist_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS early_access_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delist_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS listing_state VARCHAR(32) NOT NULL DEFAULT 'LISTED';
ALTER TABLE price_conversion.price_settings
  ADD COLUMN IF NOT EXISTS coingecko_cap INTEGER,
  ADD COLUMN IF NOT EXISTS alchemy_cap INTEGER,
  ADD COLUMN IF NOT EXISTS coinmarketcap_cap INTEGER;

COMMIT;
