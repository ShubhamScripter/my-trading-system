BEGIN;

ALTER TYPE wallet_core."WalletAlertCategory" ADD VALUE 'PRICE_MAINTENANCE';
ALTER TYPE wallet_core."WalletAlertCategory" ADD VALUE 'DELISTING_PENDING';
ALTER TYPE wallet_core."WalletAlertCategory" ADD VALUE 'DELISTING_ACCOUNT_REVIEW';
ALTER TYPE wallet_core."WalletCronSafeReasonCode" ADD VALUE 'LIFECYCLE_PARTIAL';
ALTER TYPE wallet_core."WalletCronSafeReasonCode" ADD VALUE 'RECONCILIATION_PARTIAL';

ALTER TABLE wallet_core.delisting_executions
  ADD CONSTRAINT delisting_executions_positive_revision CHECK (policy_revision > 0),
  ADD CONSTRAINT delisting_executions_safe_reason CHECK (safe_error_code IS NULL OR safe_error_code IN (
    'PRICE_UNAVAILABLE','EXCHANGE_ADAPTER_UNAVAILABLE','ACCOUNT_REVIEW_REQUIRED','BALANCE_REMAINS',
    'LEDGER_ERROR','AUDIT_ERROR','UNEXPECTED_ERROR','TIMEOUT'));

CREATE FUNCTION wallet_core.require_pristine_delisting_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  IF NEW.status <> 'RUNNING' OR NEW.cursor IS NOT NULL OR NEW.cursor_ordinal <> 0
    OR NEW.processed_count <> 0 OR NEW.skipped_count <> 0 OR NEW.failed_count <> 0
    OR NEW.safe_error_code IS NOT NULL OR NEW.updated_at <> NEW.created_at THEN
    RAISE EXCEPTION 'delisting execution must start pristine' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delisting_executions_pristine_guard BEFORE INSERT ON wallet_core.delisting_executions
FOR EACH ROW EXECUTE FUNCTION wallet_core.require_pristine_delisting_execution();
REVOKE ALL ON FUNCTION wallet_core.require_pristine_delisting_execution() FROM PUBLIC;

-- Preserve existing status/reason combinations while adding the two runtime PARTIAL outcomes.
DO $$ DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
  WHERE conrelid=pg_typeof(NULL::wallet_core.cronjob_runs)::text::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%CONFIGURATION_REJECTED%';
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',pg_typeof(NULL::wallet_core.cronjob_runs),constraint_name);
END $$;
ALTER TABLE wallet_core.cronjob_runs ADD CONSTRAINT cronjob_runs_status_reason CHECK (
  (status IN ('RUNNING','SUCCESS') AND safe_error_code IS NULL)
  OR (status='PARTIAL' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'CONFIGURATION_REJECTED','PROVIDER_OBSERVATION_PARTIAL','LIFECYCLE_PARTIAL','RECONCILIATION_PARTIAL'))
  OR (status='FAILED' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'PROVIDER_OBSERVATION_FAILED','DEPENDENCY_UNAVAILABLE','UNEXPECTED_ERROR'))
  OR (status='SKIPPED' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'MISSED_SCHEDULE','CATCHUP_TRUNCATED')));

ALTER TABLE wallet_core.wallet_reconciliation_components ADD COLUMN wallet_address VARCHAR(512);
-- Old rows can only snapshot the currently linked address; new evidence captures it at insertion.
ALTER TABLE wallet_core.wallet_reconciliation_components DISABLE TRIGGER wallet_reconciliation_components_append_only;
UPDATE wallet_core.wallet_reconciliation_components component SET wallet_address=address.wallet_address
FROM wallet_core.custody_addresses address WHERE address.id=component.custody_address_id;
ALTER TABLE wallet_core.wallet_reconciliation_components ENABLE TRIGGER wallet_reconciliation_components_append_only;
ALTER TABLE wallet_core.wallet_reconciliation_components ADD CONSTRAINT reconciliation_component_address_snapshot
CHECK ((kind='BINANCE' AND wallet_address IS NULL) OR (kind<>'BINANCE' AND wallet_address IS NOT NULL
  AND wallet_address=btrim(wallet_address) AND wallet_address<>''));

CREATE FUNCTION wallet_core.snapshot_reconciliation_address() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE address TEXT;
BEGIN
  IF NEW.kind <> 'BINANCE' THEN
    SELECT custody.wallet_address INTO address FROM wallet_core.custody_addresses custody
    WHERE custody.id=NEW.custody_address_id;
    IF address IS NULL OR (NEW.wallet_address IS NOT NULL AND NEW.wallet_address IS DISTINCT FROM address) THEN
      RAISE EXCEPTION 'reconciliation address snapshot mismatch' USING ERRCODE='23514';
    END IF;
    NEW.wallet_address := address;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_reconciliation_components_address_snapshot_guard
BEFORE INSERT ON wallet_core.wallet_reconciliation_components
FOR EACH ROW EXECUTE FUNCTION wallet_core.snapshot_reconciliation_address();
REVOKE ALL ON FUNCTION wallet_core.snapshot_reconciliation_address() FROM PUBLIC;

-- Existing payload validation remains unchanged for the historical categories.
DROP TRIGGER wallet_alerts_payload_guard ON wallet_core.wallet_alerts;
CREATE TRIGGER wallet_alerts_payload_guard BEFORE INSERT OR UPDATE ON wallet_core.wallet_alerts
FOR EACH ROW WHEN (NEW.category::text NOT IN ('PRICE_MAINTENANCE','DELISTING_PENDING','DELISTING_ACCOUNT_REVIEW'))
EXECUTE FUNCTION wallet_core.validate_wallet_alert_payload();
DROP TRIGGER wallet_alert_events_payload_guard ON wallet_core.wallet_alert_events;
CREATE TRIGGER wallet_alert_events_payload_guard BEFORE INSERT ON wallet_core.wallet_alert_events
FOR EACH ROW WHEN (NEW.category::text NOT IN ('PRICE_MAINTENANCE','DELISTING_PENDING','DELISTING_ACCOUNT_REVIEW'))
EXECUTE FUNCTION wallet_core.validate_wallet_alert_payload();

CREATE FUNCTION wallet_core.validate_runtime_alert_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  keys TEXT[]; currency UUID; category TEXT; valid BOOLEAN;
  uuid_pattern CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF NEW.category::text NOT IN ('PRICE_MAINTENANCE','DELISTING_PENDING','DELISTING_ACCOUNT_REVIEW') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='wallet_alerts' THEN currency := NEW.currency_id; category := NEW.category::text;
  ELSE SELECT alert.currency_id,alert.category::text INTO currency,category
    FROM wallet_core.wallet_alerts alert WHERE alert.id=NEW.alert_id;
  END IF;
  SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(NEW.payload) object(key);
  valid := currency IS NOT NULL AND category=NEW.category::text
    AND jsonb_typeof(NEW.payload->'observedAt')='string'
    AND NEW.payload->>'observedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{3}([0-9]{3})?)?Z$';
  IF NEW.category::text='PRICE_MAINTENANCE' THEN
    valid := valid AND keys=ARRAY['currencyId','observedAt','priceReadiness']
      AND jsonb_typeof(NEW.payload->'currencyId')='string' AND NEW.payload->>'currencyId'=currency::text
      AND jsonb_typeof(NEW.payload->'priceReadiness')='string'
      AND NEW.payload->>'priceReadiness' IN ('HEALTHY','UNAVAILABLE');
  ELSE
    valid := valid AND jsonb_typeof(NEW.payload->'executionId')='string'
      AND NEW.payload->>'executionId' ~ uuid_pattern
      AND EXISTS (SELECT 1 FROM wallet_core.delisting_executions execution
        WHERE execution.id::text=NEW.payload->>'executionId' AND execution.currency_id=currency);
    IF NEW.category::text='DELISTING_PENDING' THEN
      valid := valid AND keys=ARRAY['executionId','observedAt','safeErrorCode']
        AND jsonb_typeof(NEW.payload->'safeErrorCode')='string' AND NEW.payload->>'safeErrorCode' IN (
          'PRICE_UNAVAILABLE','EXCHANGE_ADAPTER_UNAVAILABLE','ACCOUNT_REVIEW_REQUIRED','BALANCE_REMAINS',
          'LEDGER_ERROR','AUDIT_ERROR','UNEXPECTED_ERROR','TIMEOUT');
    ELSE
      valid := valid AND keys=ARRAY['accountId','accountStatus','bucket','executionId','observedAt','ownerId','ownerType']
        AND jsonb_typeof(NEW.payload->'accountId')='string' AND NEW.payload->>'accountId' ~ uuid_pattern
        AND jsonb_typeof(NEW.payload->'ownerId')='string' AND NEW.payload->>'ownerId' ~ uuid_pattern
        AND jsonb_typeof(NEW.payload->'ownerType')='string' AND NEW.payload->>'ownerType' IN ('USER','MERCHANT')
        AND jsonb_typeof(NEW.payload->'accountStatus')='string' AND NEW.payload->>'accountStatus' IN ('FROZEN','CLOSED')
        AND jsonb_typeof(NEW.payload->'bucket')='string'
        AND NEW.payload->>'bucket' IN ('AVAILABLE','HOLD','STAKED_FLEXIBLE','STAKED_LOCKED','BANKROLL');
    END IF;
  END IF;
  IF valid IS TRUE THEN
    BEGIN PERFORM (NEW.payload->>'observedAt')::timestamptz;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN valid := false;
    END;
  END IF;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'invalid runtime alert payload' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_alerts_runtime_payload_guard BEFORE INSERT OR UPDATE ON wallet_core.wallet_alerts
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_runtime_alert_payload();
CREATE TRIGGER wallet_alert_events_runtime_payload_guard BEFORE INSERT ON wallet_core.wallet_alert_events
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_runtime_alert_payload();
REVOKE ALL ON FUNCTION wallet_core.validate_runtime_alert_payload() FROM PUBLIC;

COMMIT;
