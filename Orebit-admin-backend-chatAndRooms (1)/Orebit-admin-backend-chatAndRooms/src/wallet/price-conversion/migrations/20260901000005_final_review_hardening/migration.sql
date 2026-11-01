BEGIN;

ALTER TYPE price_conversion."NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE price_conversion.price_admin_notifications
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN safe_error_code VARCHAR(64),
  ADD COLUMN claimed_at TIMESTAMPTZ,
  ADD COLUMN claimed_by VARCHAR(128),
  ADD CONSTRAINT price_admin_notifications_attempt_check CHECK (attempt_count >= 0);
CREATE INDEX price_admin_notifications_provider_idx
  ON price_conversion.price_admin_notifications (provider_id, created_at DESC);
CREATE INDEX price_admin_notifications_currency_idx
  ON price_conversion.price_admin_notifications (currency_id, created_at DESC);
CREATE INDEX price_admin_notifications_retry_idx
  ON price_conversion.price_admin_notifications (delivery_status, next_attempt_at, created_at);

CREATE TEMP TABLE price_provider_call_stats_preflight ON COMMIT DROP AS
  SELECT count(*)::bigint AS row_count FROM price_conversion.price_provider_usage;
ALTER TABLE price_conversion.price_provider_usage RENAME TO price_provider_call_stats;
ALTER TABLE price_conversion.price_provider_call_stats
  RENAME CONSTRAINT price_provider_usage_pkey TO price_provider_call_stats_pkey;
ALTER TABLE price_conversion.price_provider_call_stats
  RENAME CONSTRAINT price_provider_usage_provider_id_fkey TO price_provider_call_stats_provider_id_fkey;
ALTER INDEX price_conversion.price_provider_usage_period_idx
  RENAME TO price_provider_call_stats_period_idx;
ALTER TABLE price_conversion.price_provider_call_stats
  DROP COLUMN warning_emitted,
  DROP COLUMN hard_stop_emitted;
DO $$
BEGIN
  IF (SELECT row_count FROM price_provider_call_stats_preflight)
    <> (SELECT count(*) FROM price_conversion.price_provider_call_stats) THEN
    RAISE EXCEPTION 'price provider call-stat row-count preflight failed';
  END IF;
END;
$$;

ALTER TABLE price_conversion.price_settings
  DROP COLUMN coingecko_cap,
  DROP COLUMN alchemy_cap,
  DROP COLUMN coinmarketcap_cap;
ALTER TABLE price_conversion.price_providers
  DROP COLUMN daily_call_cap,
  DROP COLUMN monthly_call_cap;

ALTER TABLE price_conversion.currencies
  ADD CONSTRAINT currencies_auto_exchange_target_check CHECK (
    after_delist_mode IS DISTINCT FROM 'AUTO_EXCHANGE'
    OR auto_exchange_to_currency_id IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT currencies_leave_policy_check CHECK (
    after_delist_mode IS DISTINCT FROM 'LEAVE'
    OR (leave_days IS NOT NULL AND after_leave_mode IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT currencies_after_leave_target_check CHECK (
    after_leave_mode IS DISTINCT FROM 'AUTO_EXCHANGE'
    OR after_leave_auto_exchange_to_currency_id IS NOT NULL
  ) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM price_conversion.currencies
    WHERE after_delist_mode = 'AUTO_EXCHANGE' AND auto_exchange_to_currency_id IS NULL
  ) THEN
    ALTER TABLE price_conversion.currencies
      VALIDATE CONSTRAINT currencies_auto_exchange_target_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_conversion.currencies
    WHERE after_delist_mode = 'LEAVE' AND (leave_days IS NULL OR after_leave_mode IS NULL)
  ) THEN
    ALTER TABLE price_conversion.currencies
      VALIDATE CONSTRAINT currencies_leave_policy_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM price_conversion.currencies
    WHERE after_leave_mode = 'AUTO_EXCHANGE'
      AND after_leave_auto_exchange_to_currency_id IS NULL
  ) THEN
    ALTER TABLE price_conversion.currencies
      VALIDATE CONSTRAINT currencies_after_leave_target_check;
  END IF;
END;
$$;

ALTER TABLE price_conversion.price_config_changes
  ADD COLUMN scope_key VARCHAR(160) NOT NULL DEFAULT 'GLOBAL';
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY scope_key ORDER BY created_at DESC, revision DESC, id DESC
  ) AS position
  FROM price_conversion.price_config_changes
  WHERE status = 'DRAFT'
)
UPDATE price_conversion.price_config_changes c
SET status = 'ARCHIVED'
FROM ranked WHERE c.id = ranked.id AND ranked.position > 1;
CREATE UNIQUE INDEX price_config_changes_one_draft_per_scope
  ON price_conversion.price_config_changes (scope_key) WHERE status = 'DRAFT';

CREATE TABLE price_conversion.price_view_fiats (
  code VARCHAR(3) PRIMARY KEY CHECK (code = upper(code)),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO price_conversion.price_view_fiats (code) VALUES
  ('AED'),('ARS'),('AUD'),('BDT'),('BHD'),('BMD'),('BRL'),('CAD'),('CHF'),('CLP'),
  ('CNY'),('CZK'),('DKK'),('EUR'),('GBP'),('GEL'),('HKD'),('HUF'),('IDR'),('ILS'),
  ('INR'),('JPY'),('KRW'),('KWD'),('LKR'),('MMK'),('MXN'),('MYR'),('NGN'),('NOK'),
  ('NZD'),('PHP'),('PKR'),('PLN'),('RUB'),('SAR'),('SEK'),('SGD'),('THB'),('TRY'),
  ('TWD'),('UAH'),('USD'),('VEF'),('VND'),('XDR'),('ZAR');

CREATE TABLE price_conversion.price_view_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  fiat_code VARCHAR(3) NOT NULL REFERENCES price_conversion.price_view_fiats(code),
  price NUMERIC(38,18) NOT NULL CHECK (price > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  response_hash CHAR(64) NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_view_snapshots_lookup ON price_conversion.price_view_snapshots
  (currency_id, fiat_code, provider_id, observed_at DESC, id DESC);
CREATE INDEX price_view_snapshots_provider_observed ON price_conversion.price_view_snapshots
  (provider_id, observed_at DESC);
CREATE INDEX price_view_snapshots_created_cursor ON price_conversion.price_view_snapshots
  (created_at DESC, id DESC);
CREATE TRIGGER price_view_snapshots_append_only
  BEFORE UPDATE OR DELETE ON price_conversion.price_view_snapshots
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();

CREATE TRIGGER price_snapshots_no_truncate BEFORE TRUNCATE ON price_conversion.price_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_resolutions_no_truncate BEFORE TRUNCATE ON price_conversion.price_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_view_snapshots_no_truncate BEFORE TRUNCATE ON price_conversion.price_view_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_fetch_runs_no_truncate BEFORE TRUNCATE ON price_conversion.price_fetch_runs
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_admin_notifications_no_truncate BEFORE TRUNCATE ON price_conversion.price_admin_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_admin_audit_no_truncate BEFORE TRUNCATE ON price_conversion.price_admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_config_changes_no_truncate BEFORE TRUNCATE ON price_conversion.price_config_changes
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();

COMMIT;
