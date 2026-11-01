BEGIN;
ALTER TYPE price_conversion."PriceConfigChangeStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE price_conversion."NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'DEAD';
ALTER TYPE price_conversion."PriceNotificationType" ADD VALUE IF NOT EXISTS 'CONFIG_REJECTED';
CREATE TYPE price_conversion."PriceSecurityState" AS ENUM ('HEALTHY', 'DEGRADED');
ALTER TABLE price_conversion.price_settings
  ADD COLUMN security_state price_conversion."PriceSecurityState" NOT NULL DEFAULT 'HEALTHY';
ALTER TABLE price_conversion.price_admin_notifications
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN claim_token UUID,
  ADD CONSTRAINT price_admin_notifications_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 20),
  ADD CONSTRAINT price_admin_notifications_attempt_bound_check CHECK (attempt_count <= max_attempts);
CREATE TABLE price_conversion.price_notification_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL UNIQUE REFERENCES price_conversion.price_admin_notifications(id),
  notification_type price_conversion."PriceNotificationType" NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  safe_error_code VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_notification_dlq_created_cursor
  ON price_conversion.price_notification_dlq (created_at DESC, id DESC);
CREATE TABLE price_conversion.price_view_provider_health (
  provider_id UUID NOT NULL REFERENCES price_conversion.price_providers(id),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  healthy BOOLEAN NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  safe_error_code VARCHAR(64),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, currency_id)
);
CREATE INDEX price_view_provider_health_currency_idx
  ON price_conversion.price_view_provider_health (currency_id);
CREATE INDEX price_view_provider_health_unhealthy_idx
  ON price_conversion.price_view_provider_health (healthy, updated_at DESC) WHERE NOT healthy;
CREATE FUNCTION price_conversion.reject_price_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'price conversion history rows cannot be deleted'; END;
$$;
CREATE TRIGGER price_fetch_runs_no_delete BEFORE DELETE ON price_conversion.price_fetch_runs
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_price_history_delete();
CREATE TRIGGER price_admin_notifications_no_delete BEFORE DELETE ON price_conversion.price_admin_notifications
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_price_history_delete();
CREATE TRIGGER price_config_changes_no_delete BEFORE DELETE ON price_conversion.price_config_changes
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_price_history_delete();
CREATE TRIGGER price_notification_dlq_append_only BEFORE UPDATE OR DELETE ON price_conversion.price_notification_dlq
  FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_append_only();
CREATE TRIGGER price_notification_dlq_no_truncate BEFORE TRUNCATE ON price_conversion.price_notification_dlq
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
WITH provider_objects AS (
  SELECT c.id,
    jsonb_object_agg(provider.key, provider.value - 'dailyCallCap' - 'monthlyCallCap' - 'cap') AS providers
  FROM price_conversion.price_config_changes c
  CROSS JOIN LATERAL jsonb_each(c.config->'providers') provider
  WHERE c.status = 'SCHEDULED' AND jsonb_typeof(c.config->'providers') = 'object'
  GROUP BY c.id
)
UPDATE price_conversion.price_config_changes c
SET config = jsonb_set(
  jsonb_set(c.config, '{providers}', provider_objects.providers, true),
  '{currencyUpserts}',
  CASE
    WHEN jsonb_typeof(c.config->'currencyUpserts') = 'array' THEN c.config->'currencyUpserts'
    WHEN jsonb_typeof(c.config->'currencies') = 'array' THEN c.config->'currencies'
    ELSE '[]'::jsonb
  END, true
)
FROM provider_objects WHERE c.id = provider_objects.id;
UPDATE price_conversion.price_config_changes
SET status = 'ARCHIVED'
WHERE status = 'SCHEDULED'
  AND (
    jsonb_typeof(config->'settings') IS DISTINCT FROM 'object'
    OR jsonb_typeof(config->'providers') IS DISTINCT FROM 'object'
    OR jsonb_typeof(config->'currencyUpserts') IS DISTINCT FROM 'array'
  );
COMMIT;
