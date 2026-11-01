BEGIN;

CREATE TYPE price_conversion."PriceUsagePeriod" AS ENUM ('DAILY', 'MONTHLY');
CREATE TYPE price_conversion."CurrencyAudience" AS ENUM ('USER', 'MERCHANT', 'BOTH');
CREATE TYPE price_conversion."CurrencyAccessLevel" AS ENUM ('ALL', 'KYC_L1', 'KYC_L2');
CREATE TYPE price_conversion."CurrencyListingKind" AS ENUM ('PERMANENT', 'TIME_LIMITED');
CREATE TYPE price_conversion."CurrencyListingState" AS ENUM ('PRELISTED', 'LISTED', 'DELISTED', 'MAINTAIN');
CREATE TYPE price_conversion."AfterDelistMode" AS ENUM ('AUTO_EXCHANGE', 'LEAVE');
CREATE TYPE price_conversion."AfterLeaveMode" AS ENUM ('LOSS', 'AUTO_EXCHANGE');
CREATE TYPE price_conversion."PriceNotificationType" AS ENUM (
  'PROVIDER_FAILURE', 'PROVIDER_RECOVERY', 'CURRENCY_FAILOVER', 'CURRENCY_RECOVERY',
  'CURRENCY_DISABLED', 'VIEW_PROVIDER_SWITCH', 'USAGE_WARNING', 'USAGE_HARD_STOP',
  'PROVIDER_MAINTAIN'
);
CREATE TYPE price_conversion."NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

ALTER TABLE price_conversion.price_providers
  ADD COLUMN daily_call_cap INTEGER,
  ADD COLUMN monthly_call_cap INTEGER,
  ADD COLUMN refresh_interval_seconds INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN freshness_seconds INTEGER NOT NULL DEFAULT 120,
  ADD CONSTRAINT price_providers_daily_cap_check CHECK (daily_call_cap IS NULL OR daily_call_cap > 0),
  ADD CONSTRAINT price_providers_monthly_cap_check CHECK (monthly_call_cap IS NULL OR monthly_call_cap > 0),
  ADD CONSTRAINT price_providers_refresh_check CHECK (refresh_interval_seconds > 0),
  ADD CONSTRAINT price_providers_freshness_check CHECK (freshness_seconds >= refresh_interval_seconds),
  ADD CONSTRAINT price_providers_view_eligible_check CHECK (
    NOT view_enabled OR code IN ('COINGECKO', 'COINMARKETCAP')
  );
UPDATE price_conversion.price_providers
SET refresh_interval_seconds = CASE WHEN code = 'COINMARKETCAP' THEN 300 ELSE 60 END,
    freshness_seconds = CASE WHEN code = 'COINMARKETCAP' THEN 600 ELSE 120 END;

ALTER TABLE price_conversion.currencies
  ADD COLUMN geo_continents TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN access_level price_conversion."CurrencyAccessLevel" NOT NULL DEFAULT 'ALL',
  ADD COLUMN available_for price_conversion."CurrencyAudience" NOT NULL DEFAULT 'BOTH',
  ADD COLUMN show_before_listing BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN premium_early_access_ops TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN so_early_access_at TIMESTAMPTZ,
  ADD COLUMN so_early_access_ops TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN after_delist_mode price_conversion."AfterDelistMode",
  ADD COLUMN auto_exchange_to_currency_id UUID REFERENCES price_conversion.currencies(id),
  ADD COLUMN auto_exchange_fee_bps INTEGER,
  ADD COLUMN leave_days INTEGER,
  ADD COLUMN after_leave_mode price_conversion."AfterLeaveMode",
  ADD COLUMN after_leave_auto_exchange_to_currency_id UUID REFERENCES price_conversion.currencies(id),
  ADD COLUMN after_leave_auto_exchange_fee_bps INTEGER,
  ADD COLUMN post_delist_ops TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN auto_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT currencies_auto_exchange_fee_check CHECK (auto_exchange_fee_bps IS NULL OR auto_exchange_fee_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT currencies_after_leave_fee_check CHECK (after_leave_auto_exchange_fee_bps IS NULL OR after_leave_auto_exchange_fee_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT currencies_leave_days_check CHECK (leave_days IS NULL OR leave_days >= 0);
ALTER TABLE price_conversion.currencies
  ALTER COLUMN listing_kind DROP DEFAULT,
  ALTER COLUMN listing_kind TYPE price_conversion."CurrencyListingKind" USING listing_kind::price_conversion."CurrencyListingKind",
  ALTER COLUMN listing_kind SET DEFAULT 'PERMANENT',
  ALTER COLUMN listing_state DROP DEFAULT,
  ALTER COLUMN listing_state TYPE price_conversion."CurrencyListingState" USING listing_state::price_conversion."CurrencyListingState",
  ALTER COLUMN listing_state SET DEFAULT 'LISTED';

ALTER TABLE price_conversion.price_fetch_runs
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN next_retry_at TIMESTAMPTZ,
  ADD CONSTRAINT price_fetch_runs_attempt_check CHECK (attempt_count BETWEEN 1 AND 3);
UPDATE price_conversion.price_fetch_runs
SET started_at = COALESCE(started_at, created_at),
    finished_at = CASE WHEN status = 'RUNNING' THEN finished_at ELSE COALESCE(finished_at, created_at) END;

ALTER TABLE price_conversion.price_resolutions
  ALTER COLUMN difference_bps TYPE NUMERIC(38,18) USING difference_bps::NUMERIC,
  ADD COLUMN configured_primary_provider_id UUID REFERENCES price_conversion.price_providers(id),
  ADD COLUMN configured_comparison_provider_id UUID REFERENCES price_conversion.price_providers(id),
  ADD COLUMN configured_fallback_provider_id UUID REFERENCES price_conversion.price_providers(id),
  ADD COLUMN primary_price_usd NUMERIC(38,18),
  ADD COLUMN comparison_price_usd NUMERIC(38,18),
  ADD COLUMN fallback_price_usd NUMERIC(38,18),
  ADD COLUMN absolute_difference_usd NUMERIC(38,18),
  ADD COLUMN difference_numerator NUMERIC(78,0),
  ADD COLUMN difference_denominator NUMERIC(78,0);

CREATE TABLE price_conversion.price_provider_health (
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  healthy BOOLEAN NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  safe_error_code VARCHAR(64),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, currency_id)
);

CREATE TABLE price_conversion.price_provider_usage (
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  period_type price_conversion."PriceUsagePeriod" NOT NULL,
  period_start DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  warning_emitted BOOLEAN NOT NULL DEFAULT false,
  hard_stop_emitted BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, period_type, period_start)
);

CREATE TABLE price_conversion.price_admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type price_conversion."PriceNotificationType" NOT NULL,
  provider_id UUID REFERENCES price_conversion.price_providers(id),
  currency_id UUID REFERENCES price_conversion.currencies(id),
  dedupe_key VARCHAR(255) NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status price_conversion."NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX currency_provider_refs_provider_idx ON price_conversion.currency_provider_refs (provider_id);
CREATE INDEX currencies_auto_exchange_to_idx ON price_conversion.currencies (auto_exchange_to_currency_id);
CREATE INDEX currencies_after_leave_exchange_to_idx ON price_conversion.currencies (after_leave_auto_exchange_to_currency_id);
CREATE INDEX price_snapshots_provider_observed_idx ON price_conversion.price_snapshots (provider_id, observed_at DESC);
CREATE INDEX price_snapshots_created_cursor ON price_conversion.price_snapshots (created_at DESC, id DESC);
CREATE INDEX price_resolutions_created_cursor ON price_conversion.price_resolutions (created_at DESC, id DESC);
CREATE INDEX price_resolutions_effective_provider_idx ON price_conversion.price_resolutions (effective_provider_id);
CREATE INDEX price_resolutions_effective_snapshot_idx ON price_conversion.price_resolutions (effective_snapshot_id);
CREATE INDEX price_resolutions_primary_snapshot_idx ON price_conversion.price_resolutions (primary_snapshot_id);
CREATE INDEX price_resolutions_comparison_snapshot_idx ON price_conversion.price_resolutions (comparison_snapshot_id);
CREATE INDEX price_resolutions_fallback_snapshot_idx ON price_conversion.price_resolutions (fallback_snapshot_id);
CREATE INDEX price_resolutions_configured_primary_idx ON price_conversion.price_resolutions (configured_primary_provider_id);
CREATE INDEX price_resolutions_configured_comparison_idx ON price_conversion.price_resolutions (configured_comparison_provider_id);
CREATE INDEX price_resolutions_configured_fallback_idx ON price_conversion.price_resolutions (configured_fallback_provider_id);
CREATE INDEX price_fetch_runs_created_cursor ON price_conversion.price_fetch_runs (created_at DESC, id DESC);
CREATE INDEX price_fetch_runs_status_retry_idx ON price_conversion.price_fetch_runs (status, next_retry_at);
CREATE INDEX price_provider_health_currency_idx ON price_conversion.price_provider_health (currency_id);
CREATE INDEX price_provider_health_unhealthy_idx ON price_conversion.price_provider_health (healthy, updated_at DESC) WHERE NOT healthy;
CREATE INDEX price_provider_usage_period_idx ON price_conversion.price_provider_usage (period_type, period_start DESC);
CREATE INDEX price_admin_notifications_cursor ON price_conversion.price_admin_notifications (created_at DESC, id DESC);
CREATE INDEX price_admin_notifications_pending_idx ON price_conversion.price_admin_notifications (delivery_status, created_at);
CREATE INDEX price_config_changes_created_cursor ON price_conversion.price_config_changes (created_at DESC, id DESC);
CREATE UNIQUE INDEX price_config_changes_one_live ON price_conversion.price_config_changes ((status)) WHERE status = 'LIVE';

UPDATE price_conversion.price_providers SET sensitive_role = NULL, view_enabled = false;
UPDATE price_conversion.price_providers SET sensitive_role = 'PRIMARY', view_enabled = true WHERE code = 'COINGECKO';
UPDATE price_conversion.price_providers SET sensitive_role = 'COMPARISON' WHERE code = 'ALCHEMY';
UPDATE price_conversion.price_providers SET sensitive_role = 'FALLBACK' WHERE code = 'COINMARKETCAP';
INSERT INTO price_conversion.price_config_changes (revision, status, changelog, config, applied_at)
VALUES (
  0, 'LIVE', 'Default price conversion configuration',
  '{"providers":{"COINGECKO":{"enabled":true,"sensitiveRole":"PRIMARY","viewEnabled":true},"ALCHEMY":{"enabled":true,"sensitiveRole":"COMPARISON","viewEnabled":false},"COINMARKETCAP":{"enabled":true,"sensitiveRole":"FALLBACK","viewEnabled":false}}}'::jsonb,
  now()
) ON CONFLICT (revision) DO NOTHING;

COMMIT;
