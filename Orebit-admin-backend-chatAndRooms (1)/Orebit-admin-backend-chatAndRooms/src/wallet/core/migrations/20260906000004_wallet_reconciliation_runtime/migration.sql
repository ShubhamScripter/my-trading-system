BEGIN;
CREATE TYPE wallet_core."WalletReconciliationAlertBasis" AS ENUM ('SIGNED','POSITIVE_ONLY');
ALTER TABLE wallet_core.wallet_settings ADD COLUMN reconciliation_alert_basis
  wallet_core."WalletReconciliationAlertBasis" NOT NULL DEFAULT 'SIGNED';
ALTER TABLE wallet_core.wallet_reconciliation_runs
  ALTER COLUMN status DROP NOT NULL,
  ADD COLUMN expected_currency_count INTEGER CHECK (expected_currency_count>=0),
  ADD COLUMN include_treasury BOOLEAN,
  ADD COLUMN include_collection BOOLEAN,
  ADD COLUMN applied_reconciliation_alert_basis wallet_core."WalletReconciliationAlertBasis";
ALTER TABLE wallet_core.wallet_reconciliation_items
  ALTER COLUMN hot_cold_balance TYPE NUMERIC(78,18),
  ALTER COLUMN staking_balance TYPE NUMERIC(78,18),
  ALTER COLUMN total_custody_balance TYPE NUMERIC(78,18),
  ALTER COLUMN required_backing TYPE NUMERIC(78,18),
  ALTER COLUMN user_merchant_balance TYPE NUMERIC(78,18),
  ADD COLUMN ledger_signed_total NUMERIC(78,18),
  ADD COLUMN ledger_positive_total NUMERIC(78,18) CHECK (ledger_positive_total>=0),
  ADD COLUMN applied_reconciliation_alert_basis wallet_core."WalletReconciliationAlertBasis";
-- Preserve raw provider fields; only the derived two-source staking selection needs one extra digit.
ALTER TABLE wallet_core.wallet_reconciliation_components ALTER COLUMN selected_balance TYPE NUMERIC(39,18);
DO $$ DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid=pg_typeof(NULL::wallet_core.wallet_reconciliation_items)::text::regclass AND contype='c'
      AND pg_get_constraintdef(oid) ~ '^CHECK \(\((user_merchant_balance|treasury_balance|collection_balance) >=' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',pg_typeof(NULL::wallet_core.wallet_reconciliation_items),constraint_name);
  END LOOP;
END $$;
ALTER TABLE wallet_core.wallet_reconciliation_items DROP CONSTRAINT wallet_reconciliation_items_partial_reasons_check;
ALTER TABLE wallet_core.wallet_reconciliation_items ADD CONSTRAINT wallet_reconciliation_items_partial_reasons_check CHECK
  (partial_reasons <@ ARRAY['ENCRYPTION_FAILED','AUTHENTICATION_FAILED','UNAUTHORIZED_IP','PROVIDER_MAINTENANCE',
    'PROVIDER_DISABLED','PROVIDER_NOT_FOUND','PROVIDER_REJECTED','TIMEOUT','TRANSPORT_ERROR','RESPONSE_TOO_LARGE',
    'INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE','STAKING_TOTAL_MISMATCH']::text[]);

ALTER TABLE wallet_core.custody_addresses
  ADD COLUMN created_revision BIGINT NOT NULL DEFAULT 0 CHECK (created_revision>=0),
  ADD COLUMN retired_revision BIGINT,
  ADD COLUMN retired_at TIMESTAMPTZ,
  ADD CONSTRAINT custody_address_retirement_pair CHECK (
    (retired_at IS NULL AND retired_revision IS NULL)
    OR (retired_at IS NOT NULL AND retired_revision>created_revision));
ALTER TABLE wallet_core.custody_addresses DROP CONSTRAINT custody_addresses_currency_chain_id_kind_address_identity_key;
CREATE UNIQUE INDEX custody_addresses_active_identity ON wallet_core.custody_addresses
  (currency_chain_id,kind,address_identity) WHERE retired_at IS NULL;
CREATE INDEX custody_addresses_revision_membership ON wallet_core.custody_addresses
  (currency_chain_id,created_revision,retired_revision,id);
CREATE TRIGGER custody_addresses_no_delete BEFORE DELETE ON wallet_core.custody_addresses
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER custody_addresses_no_truncate BEFORE TRUNCATE ON wallet_core.custody_addresses
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE OR REPLACE FUNCTION wallet_core.guard_custody_address() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE is_token BOOLEAN; is_evm BOOLEAN; policy BIGINT; identity TEXT; lock_group TEXT; amount BIGINT;
BEGIN
  SELECT binding.is_token,chain.is_evm,COALESCE(setting.policy_revision,0)
    INTO is_token,is_evm,policy FROM wallet_core.currencies binding
    JOIN wallet_core.chains chain ON chain.id=binding.chain_id
    LEFT JOIN wallet_core.currency_settings setting ON setting.currency_id=binding.currency_id
    WHERE binding.id=NEW.currency_chain_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'currency-chain binding not found'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['retired_at','retired_revision']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['retired_at','retired_revision']) OR OLD.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'custody address identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.retired_at IS NULL OR NEW.retired_revision IS DISTINCT FROM policy OR policy<=OLD.created_revision THEN
      RAISE EXCEPTION 'custody address retirement revision invalid' USING ERRCODE='23514';
    END IF;
    NEW.retired_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF NEW.retired_at IS NOT NULL OR NEW.retired_revision IS NOT NULL
    OR NEW.created_revision NOT IN (0,policy) THEN
    RAISE EXCEPTION 'custody address must start active at current revision' USING ERRCODE='23514';
  END IF;
  NEW.created_revision:=policy;
  NEW.wallet_address:=btrim(NEW.wallet_address,E' \t\n\r\f\v');
  IF NEW.wallet_address='' THEN RAISE EXCEPTION 'wallet address is required'; END IF;
  identity:=CASE WHEN is_evm THEN lower(NEW.wallet_address) ELSE NEW.wallet_address END;
  IF NEW.address_identity<>identity THEN RAISE EXCEPTION 'wallet address comparison identity mismatch'; END IF;
  IF NEW.kind='STAKING' AND is_token THEN RAISE EXCEPTION 'staking address requires a native binding'; END IF;
  lock_group:=CASE WHEN NEW.kind IN ('HOT','COLD') THEN 'LIQUID' ELSE 'STAKING' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.currency_chain_id::text||':'||lock_group,910001));
  SELECT count(*) INTO amount FROM wallet_core.custody_addresses existing
    WHERE existing.currency_chain_id=NEW.currency_chain_id AND existing.kind=NEW.kind AND existing.retired_at IS NULL;
  IF amount>=10000 THEN RAISE EXCEPTION 'custody address kind limit exceeded'; END IF;
  IF NEW.kind IN ('HOT','COLD') AND EXISTS (SELECT 1 FROM wallet_core.custody_addresses existing
    WHERE existing.currency_chain_id=NEW.currency_chain_id AND existing.address_identity=NEW.address_identity
      AND existing.retired_at IS NULL AND existing.kind<>NEW.kind AND existing.kind IN ('HOT','COLD')) THEN
    RAISE EXCEPTION 'wallet address cannot be both HOT and COLD';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.guard_reconciliation_run() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reconciliation history is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.currency_count<>0 OR NEW.warning_count<>0
      OR NEW.safe_error_code IS NOT NULL OR NEW.expected_currency_count IS NULL OR NEW.include_treasury IS NULL
      OR NEW.include_collection IS NULL OR NEW.applied_reconciliation_alert_basis IS NULL THEN
      RAISE EXCEPTION 'reconciliation run must start pending with a complete snapshot' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wallet_core.cronjob_runs job WHERE job.id=NEW.id
      AND job.job_name='wallet-reconciliation' AND job.scheduled_for=NEW.scheduled_for AND job.status='RUNNING') THEN
      RAISE EXCEPTION 'reconciliation run requires its claimed cron identity' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wallet_core.wallet_settings setting WHERE setting.id
      AND setting.reconciliation_alert_percent=NEW.applied_reconciliation_alert_percent
      AND setting.include_treasury=NEW.include_treasury AND setting.include_collection=NEW.include_collection
      AND setting.reconciliation_alert_basis=NEW.applied_reconciliation_alert_basis)
      OR NEW.applied_configuration_revision IS DISTINCT FROM COALESCE(
        (SELECT revision FROM wallet_core.configuration_changes WHERE status='LIVE'),0) THEN
      RAISE EXCEPTION 'reconciliation capture configuration mismatch' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IS NOT NULL THEN RAISE EXCEPTION 'sealed reconciliation run is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','currency_count','warning_count','safe_error_code','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','currency_count','warning_count','safe_error_code','completed_at']) THEN
    RAISE EXCEPTION 'reconciliation snapshot is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IS NULL THEN
    RAISE EXCEPTION 'pending reconciliation snapshot is immutable' USING ERRCODE='23514';
  ELSIF NEW.completed_at IS NULL OR NEW.completed_at<NEW.created_at THEN
    RAISE EXCEPTION 'reconciliation seal requires completion time' USING ERRCODE='23514';
  END IF;
  IF NEW.safe_error_code IS NOT NULL AND NEW.safe_error_code NOT IN
    ('LEDGER_UNAVAILABLE','SNAPSHOT_UNAVAILABLE','PERSISTENCE_FAILED','AUDIT_FAILED') THEN
    RAISE EXCEPTION 'reconciliation safe reason invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER wallet_reconciliation_runs_append_only ON wallet_core.wallet_reconciliation_runs;
CREATE TRIGGER wallet_reconciliation_runs_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON wallet_core.wallet_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_reconciliation_run();

CREATE OR REPLACE FUNCTION wallet_core.validate_reconciliation_run_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE run_id UUID; header wallet_core.wallet_reconciliation_runs; items BIGINT; partial BIGINT; warnings BIGINT; captured BIGINT;
BEGIN
  IF TG_TABLE_NAME='wallet_reconciliation_runs' THEN run_id:=NEW.id;
  ELSIF TG_OP='DELETE' THEN run_id:=OLD.run_id; ELSE run_id:=NEW.run_id; END IF;
  SELECT run.* INTO header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=run_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='wallet_reconciliation_runs' AND TG_OP='INSERT' THEN
    SELECT count(*) INTO captured FROM wallet_core.state_events event WHERE event.run_id=header.id
      AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY';
    IF captured<>header.expected_currency_count OR EXISTS (
      SELECT 1 FROM wallet_core.state_events currency JOIN wallet_core.currencies binding ON binding.currency_id=currency.subject_id
      WHERE currency.run_id=header.id AND currency.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND currency.subject_type='CURRENCY'
        AND NOT EXISTS (SELECT 1 FROM wallet_core.state_events event WHERE event.run_id=header.id
          AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY_CHAIN' AND event.subject_id=binding.id)) THEN
      RAISE EXCEPTION 'reconciliation capture set incomplete' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT count(*),count(*) FILTER(WHERE item.status='PARTIAL') INTO items,partial
    FROM wallet_core.wallet_reconciliation_items item WHERE item.run_id=header.id;
  IF header.status IS NULL THEN
    IF items>header.expected_currency_count THEN RAISE EXCEPTION 'reconciliation exceeds captured currency count'; END IF;
    RETURN NULL;
  END IF;
  SELECT count(*) INTO warnings FROM wallet_core.wallet_reconciliation_items item WHERE item.run_id=header.id
    AND NOT item.shortfall_suppressed AND item.required_backing>0
    AND (item.required_backing-item.total_custody_balance)*100>item.required_backing*header.applied_reconciliation_alert_percent;
  IF header.warning_count<>warnings OR header.currency_count<>items
    OR (header.status='FAILED' AND header.safe_error_code IS NULL)
    OR (header.status<>'FAILED' AND header.safe_error_code IS NOT NULL) THEN
    RAISE EXCEPTION 'reconciliation terminal counters or reason mismatch' USING ERRCODE='23514';
  END IF;
  IF (header.status='FAILED' AND items<>0) OR (header.status='SUCCESS' AND partial<>0)
    OR (header.status='PARTIAL' AND (items=0 OR partial=0))
    OR (header.status<>'FAILED' AND header.expected_currency_count IS NOT NULL AND
      (items<>header.expected_currency_count OR header.currency_count<>items)) THEN
    RAISE EXCEPTION 'reconciliation run status does not match its items';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION wallet_core.require_pending_reconciliation_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE run_id UUID; run_status wallet_core."WalletReconciliationRunStatus";
BEGIN
  IF TG_TABLE_NAME='wallet_reconciliation_items' THEN run_id:=NEW.run_id;
  ELSIF TG_TABLE_NAME='wallet_reconciliation_components' THEN
    SELECT item.run_id INTO run_id FROM wallet_core.wallet_reconciliation_items item WHERE item.id=NEW.run_item_id;
  ELSE
    SELECT item.run_id INTO run_id FROM wallet_core.wallet_reconciliation_components component
      JOIN wallet_core.wallet_reconciliation_items item ON item.id=component.run_item_id WHERE component.id=NEW.component_id;
    IF NOT EXISTS (SELECT 1 FROM wallet_core.wallet_reconciliation_components component WHERE component.id=NEW.component_id
      AND component.xmin=pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'attempt requires original component transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT run.status INTO run_status FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=run_id FOR SHARE;
  IF NOT FOUND OR run_status IS NOT NULL THEN RAISE EXCEPTION 'reconciliation parent is sealed or missing' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_items_open_parent BEFORE INSERT ON wallet_core.wallet_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION wallet_core.require_pending_reconciliation_parent();
CREATE TRIGGER reconciliation_components_open_parent BEFORE INSERT ON wallet_core.wallet_reconciliation_components
FOR EACH ROW EXECUTE FUNCTION wallet_core.require_pending_reconciliation_parent();
CREATE TRIGGER reconciliation_attempts_open_parent BEFORE INSERT ON wallet_core.wallet_reconciliation_attempts
FOR EACH ROW EXECUTE FUNCTION wallet_core.require_pending_reconciliation_parent();
-- Capture rows share the header's insertion transaction; later retries cannot add or change facts.
CREATE UNIQUE INDEX reconciliation_capture_subject ON wallet_core.state_events(run_id,subject_type,subject_id)
  WHERE event_type='RECONCILIATION.CONFIG_SNAPSHOT';
CREATE FUNCTION wallet_core.guard_reconciliation_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE header wallet_core.wallet_reconciliation_runs; keys TEXT[]; evidence JSONB; binding JSONB; key TEXT;
BEGIN
  SELECT run.* INTO header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=NEW.run_id
    AND run.xmin=pg_current_xact_id()::xid AND run.status IS NULL FOR SHARE;
  IF NOT FOUND OR NEW.actor_id IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation capture requires original pending transaction' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(name ORDER BY name) INTO keys FROM jsonb_object_keys(NEW.payload) name;
  IF NEW.subject_type='CURRENCY' THEN
    IF keys IS DISTINCT FROM ARRAY['binanceReference','collection','price','treasury','userMerchant','userMerchantPositive']
      OR NOT EXISTS (SELECT 1 FROM wallet_core.currency_settings setting
        JOIN price_conversion.currencies currency ON currency.id=setting.currency_id
        WHERE setting.currency_id=NEW.subject_id AND currency.kind='CRYPTO'
          AND to_jsonb(setting.binance_reference) IS NOT DISTINCT FROM NULLIF(NEW.payload->'binanceReference','null')) THEN
      RAISE EXCEPTION 'reconciliation currency snapshot mismatch' USING ERRCODE='23514';
    END IF;
    FOREACH key IN ARRAY ARRAY['userMerchant','userMerchantPositive','treasury','collection'] LOOP
      IF jsonb_typeof(NEW.payload->key) IS DISTINCT FROM 'string'
        OR (NEW.payload->>key) !~ '^-?(0|[1-9][0-9]{0,59})([.][0-9]{1,18})?$'
        OR (key IN ('treasury','collection') AND abs((NEW.payload->>key)::numeric)>=1e20) THEN
        RAISE EXCEPTION 'reconciliation Ledger capture amount invalid' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF (NEW.payload->>'userMerchantPositive')::numeric<GREATEST(0,(NEW.payload->>'userMerchant')::numeric) THEN
      RAISE EXCEPTION 'reconciliation positive Ledger capture invalid' USING ERRCODE='23514';
    END IF;
    evidence:=NEW.payload->'price';
    IF evidence IS DISTINCT FROM 'null'::jsonb THEN
      IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'reconciliation price snapshot invalid'; END IF;
      SELECT array_agg(name ORDER BY name) INTO keys FROM jsonb_object_keys(evidence) name;
      IF EXISTS (SELECT 1 FROM jsonb_each(evidence) value WHERE value.key<>'usedFallback' AND jsonb_typeof(value.value)<>'string') THEN
        RAISE EXCEPTION 'reconciliation price snapshot scalar type invalid';
      END IF;
      IF keys IS DISTINCT FROM ARRAY['observedAt','priceUsd','provider','resolutionId','resolutionReason','snapshotId','usedFallback']
        OR jsonb_typeof(evidence->'usedFallback') IS DISTINCT FROM 'boolean'
        OR NOT EXISTS (
          SELECT 1 FROM price_conversion.price_resolutions resolution
          JOIN price_conversion.price_snapshots snapshot ON snapshot.id=resolution.effective_snapshot_id
            AND snapshot.currency_id=resolution.currency_id AND snapshot.provider_id=resolution.effective_provider_id
            AND snapshot.price_usd=resolution.effective_price_usd AND snapshot.observed_at=resolution.observed_at
          JOIN price_conversion.price_providers provider ON provider.id=resolution.effective_provider_id
          WHERE resolution.id=(evidence->>'resolutionId')::uuid AND resolution.currency_id=NEW.subject_id
            AND snapshot.id=(evidence->>'snapshotId')::uuid AND provider.code::text=evidence->>'provider'
            AND resolution.effective_price_usd=(evidence->>'priceUsd')::numeric
            AND resolution.observed_at=(evidence->>'observedAt')::timestamptz
            AND resolution.reason::text=evidence->>'resolutionReason' AND NOT resolution.stale
            AND resolution.reason IN ('PRIMARY_CONFIRMED','RECOVERED','FALLBACK_PRIMARY_FAILED','FALLBACK_DIVERGENCE')
            AND (evidence->>'usedFallback')::boolean=(resolution.reason IN ('FALLBACK_PRIMARY_FAILED','FALLBACK_DIVERGENCE'))
            AND resolution.created_at<=header.valuation_at AND snapshot.created_at<=header.valuation_at
            AND resolution.observed_at<=header.valuation_at+interval '60 seconds') THEN
        RAISE EXCEPTION 'reconciliation price snapshot mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF NEW.subject_type='CURRENCY_CHAIN' THEN
    SELECT jsonb_build_object('currencyId',currency.id,'chainShortName',chain.short_name,'currencyName',currency.name,
      'blockchainPrecision',link.blockchain_precision,'isToken',link.is_token,'isNative',link.is_native)
      INTO binding FROM wallet_core.currencies link JOIN wallet_core.chains chain ON chain.id=link.chain_id
      JOIN price_conversion.currencies currency ON currency.id=link.currency_id WHERE link.id=NEW.subject_id;
    IF binding IS NULL OR NEW.payload IS DISTINCT FROM binding OR NOT EXISTS (
      SELECT 1 FROM wallet_core.state_events capture WHERE capture.run_id=NEW.run_id
        AND capture.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND capture.subject_type='CURRENCY'
        AND capture.subject_id=(binding->>'currencyId')::uuid) THEN
      RAISE EXCEPTION 'reconciliation binding snapshot mismatch' USING ERRCODE='23514';
    END IF;
  ELSE RAISE EXCEPTION 'reconciliation capture subject invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_capture_guard BEFORE INSERT ON wallet_core.state_events
FOR EACH ROW WHEN (NEW.event_type='RECONCILIATION.CONFIG_SNAPSHOT') EXECUTE FUNCTION wallet_core.guard_reconciliation_capture();

CREATE FUNCTION wallet_core.validate_reconciliation_capture_item() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE header wallet_core.wallet_reconciliation_runs; capture JSONB; signed_total NUMERIC; positive_total NUMERIC; price JSONB;
BEGIN
  SELECT run.* INTO STRICT header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=NEW.run_id;
  SELECT event.payload INTO capture FROM wallet_core.state_events event WHERE event.run_id=NEW.run_id
    AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY' AND event.subject_id=NEW.currency_id;
  IF capture IS NULL THEN RAISE EXCEPTION 'reconciliation item capture missing' USING ERRCODE='23514'; END IF;
  signed_total:=(capture->>'userMerchant')::numeric
    +CASE WHEN header.include_treasury THEN (capture->>'treasury')::numeric ELSE 0 END
    +CASE WHEN header.include_collection THEN (capture->>'collection')::numeric ELSE 0 END;
  positive_total:=(capture->>'userMerchantPositive')::numeric
    +CASE WHEN header.include_treasury THEN GREATEST((capture->>'treasury')::numeric,0) ELSE 0 END
    +CASE WHEN header.include_collection THEN GREATEST((capture->>'collection')::numeric,0) ELSE 0 END;
  IF NEW.ledger_signed_total IS DISTINCT FROM signed_total OR NEW.ledger_positive_total IS DISTINCT FROM positive_total
    OR NEW.user_merchant_balance IS DISTINCT FROM (capture->>'userMerchant')::numeric
    OR NEW.treasury_balance IS DISTINCT FROM (capture->>'treasury')::numeric
    OR NEW.collection_balance IS DISTINCT FROM (capture->>'collection')::numeric
    OR NEW.applied_reconciliation_alert_basis IS DISTINCT FROM header.applied_reconciliation_alert_basis
    OR NEW.applied_reconciliation_alert_percent<>header.applied_reconciliation_alert_percent
    OR NEW.applied_configuration_revision<>header.applied_configuration_revision OR NEW.comparison_rule<>header.comparison_rule
    OR NEW.required_backing<>GREATEST(0,CASE WHEN header.applied_reconciliation_alert_basis='SIGNED' THEN signed_total ELSE positive_total END)
    OR (NOT NEW.shortfall_suppressed AND NEW.required_backing>0 AND NEW.shortfall_percent IS DISTINCT FROM
      trunc(GREATEST(NEW.required_backing-NEW.total_custody_balance,0)*100/NEW.required_backing,18)) THEN
    RAISE EXCEPTION 'reconciliation item Ledger capture mismatch' USING ERRCODE='23514';
  END IF;
  price:=capture->'price';
  IF NEW.price_resolution_id IS DISTINCT FROM (price->>'resolutionId')::uuid
    OR NEW.price_snapshot_id IS DISTINCT FROM (price->>'snapshotId')::uuid
    OR NEW.price_provider::text IS DISTINCT FROM price->>'provider'
    OR NEW.price_usd IS DISTINCT FROM (price->>'priceUsd')::numeric
    OR NEW.price_observed_at IS DISTINCT FROM (price->>'observedAt')::timestamptz
    OR NEW.price_resolution_reason::text IS DISTINCT FROM price->>'resolutionReason'
    OR NEW.price_used_fallback IS DISTINCT FROM (price->>'usedFallback')::boolean THEN
    RAISE EXCEPTION 'reconciliation item price capture mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_item_capture_guard BEFORE INSERT ON wallet_core.wallet_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_reconciliation_capture_item();
CREATE UNIQUE INDEX reconciliation_component_address_once ON wallet_core.wallet_reconciliation_components(run_item_id,custody_address_id)
  WHERE custody_address_id IS NOT NULL;
CREATE OR REPLACE FUNCTION wallet_core.validate_reconciliation_component() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE item wallet_core.wallet_reconciliation_items; header wallet_core.wallet_reconciliation_runs; capture JSONB; stake_sum NUMERIC;
BEGIN
  SELECT row.* INTO item FROM wallet_core.wallet_reconciliation_items row WHERE row.id=NEW.run_item_id
    AND row.xmin=pg_current_xact_id()::xid;
  IF NOT FOUND THEN RAISE EXCEPTION 'component requires original item transaction' USING ERRCODE='23514'; END IF;
  SELECT run.* INTO STRICT header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=item.run_id;
  SELECT event.payload INTO capture FROM wallet_core.state_events event WHERE event.run_id=item.run_id
    AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY' AND event.subject_id=item.currency_id;
  IF NEW.kind='BINANCE' THEN
    IF NEW.binance_reference IS DISTINCT FROM capture->>'binanceReference' THEN
      RAISE EXCEPTION 'reconciliation Binance capture mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM wallet_core.state_events event JOIN wallet_core.custody_addresses address
      ON address.currency_chain_id=event.subject_id WHERE event.run_id=item.run_id
      AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY_CHAIN'
      AND event.subject_id=NEW.currency_chain_id AND (event.payload->>'currencyId')::uuid=item.currency_id
      AND address.id=NEW.custody_address_id AND address.kind::text=NEW.kind::text
      AND address.created_revision<=header.applied_configuration_revision
      AND (address.retired_revision IS NULL OR address.retired_revision>header.applied_configuration_revision)
      AND (NEW.kind<>'STAKING' OR event.payload->'isNative'='true')) THEN
    RAISE EXCEPTION 'reconciliation address capture membership mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.selected_balance IS NOT NULL THEN
    IF NEW.accepted_raw_decimal !~ '^[0-9]+([.][0-9]+)?$'
      OR (NEW.accepted_raw_decimal)::numeric>=1e20
      OR (NEW.accepted_raw_decimal)::numeric IS DISTINCT FROM (CASE WHEN NEW.kind='STAKING' THEN NEW.total_balance ELSE NEW.selected_balance END) THEN
      RAISE EXCEPTION 'reconciliation raw decimal evidence mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.kind='STAKING' THEN
      stake_sum:=NEW.total_admin_stake_balance+NEW.total_admin_manual_stake_balance;
      IF NEW.stake_total_mismatch IS DISTINCT FROM (NEW.total_balance<>stake_sum)
        OR NEW.selected_balance IS DISTINCT FROM (CASE WHEN NEW.total_balance=stake_sum THEN NEW.total_balance ELSE stake_sum END)
        OR NEW.stake_selected_source::text IS DISTINCT FROM (CASE WHEN NEW.total_balance=stake_sum THEN 'REPORTED_TOTAL' ELSE 'COMPONENT_SUM' END) THEN
        RAISE EXCEPTION 'reconciliation staking evidence mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION wallet_core.validate_reconciliation_buckets() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE item wallet_core.wallet_reconciliation_items; header wallet_core.wallet_reconciliation_runs;
  hot_cold NUMERIC; staking NUMERIC; binance NUMERIC; failed BIGINT; actual BIGINT; expected BIGINT; reasons TEXT[];
BEGIN
  -- Components cannot be appended after the item's transaction; one deferred aggregate per item suffices.
  IF TG_TABLE_NAME<>'wallet_reconciliation_items' THEN RETURN NULL; END IF;
  SELECT row.* INTO item FROM wallet_core.wallet_reconciliation_items row WHERE row.id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT run.* INTO STRICT header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=item.run_id;
  SELECT COALESCE(sum(selected_balance) FILTER(WHERE kind IN ('HOT','COLD')),0),
    COALESCE(sum(selected_balance) FILTER(WHERE kind='STAKING'),0),COALESCE(sum(selected_balance) FILTER(WHERE kind='BINANCE'),0),
    count(*) FILTER(WHERE selected_balance IS NULL),count(*) INTO hot_cold,staking,binance,failed,actual
    FROM wallet_core.wallet_reconciliation_components WHERE run_item_id=item.id;
  SELECT count(*) INTO expected FROM wallet_core.state_events event JOIN wallet_core.custody_addresses address
    ON address.currency_chain_id=event.subject_id WHERE event.run_id=item.run_id
    AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY_CHAIN'
    AND (event.payload->>'currencyId')::uuid=item.currency_id AND address.created_revision<=header.applied_configuration_revision
    AND (address.retired_revision IS NULL OR address.retired_revision>header.applied_configuration_revision)
    AND (address.kind<>'STAKING' OR event.payload->'isNative'='true');
  SELECT expected+CASE WHEN payload->>'binanceReference' IS NULL THEN 0 ELSE 1 END INTO expected
    FROM wallet_core.state_events WHERE run_id=item.run_id AND event_type='RECONCILIATION.CONFIG_SNAPSHOT'
      AND subject_type='CURRENCY' AND subject_id=item.currency_id;
  SELECT COALESCE(array_agg(DISTINCT reason ORDER BY reason),'{}') INTO reasons FROM (
    SELECT safe_error_code::text reason FROM wallet_core.wallet_reconciliation_components WHERE run_item_id=item.id AND safe_error_code IS NOT NULL
    UNION SELECT 'STAKING_TOTAL_MISMATCH' FROM wallet_core.wallet_reconciliation_components WHERE run_item_id=item.id AND stake_total_mismatch
    UNION SELECT 'PRICE_UNAVAILABLE' WHERE item.price_resolution_id IS NULL) evidence;
  IF item.hot_cold_balance<>hot_cold OR item.staking_balance<>staking OR item.binance_balance<>binance
    OR actual IS DISTINCT FROM expected OR item.shortfall_suppressed IS DISTINCT FROM (failed>0)
    OR (SELECT array_agg(reason ORDER BY reason) FROM unnest(item.partial_reasons) reason) IS DISTINCT FROM NULLIF(reasons,'{}') THEN
    RAISE EXCEPTION 'reconciliation component/address evidence mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Preserve the mature guards, changing only their bounded numeric locals and the narrow retry condition.
DO $forward$
DECLARE definition TEXT; original TEXT; name TEXT;
BEGIN
  FOREACH name IN ARRAY ARRAY['validate_reconciliation_attempt_set'] LOOP
    SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
      WHERE procedure.proname=name AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
        WHERE oid=pg_typeof(NULL::wallet_core.wallet_reconciliation_runs)::oid);
    IF strpos(definition,'numeric(38,18)')=0 AND strpos(definition,'NUMERIC(38,18)')=0 THEN
      RAISE EXCEPTION 'reconciliation numeric guard contract changed';
    END IF;
    EXECUTE replace(replace(definition,'NUMERIC(38,18)','NUMERIC(78,18)'),'numeric(38,18)','numeric(78,18)');
  END LOOP;
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='guard_cronjob_run_lease' AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
      WHERE oid=pg_typeof(NULL::wallet_core.cronjob_runs)::oid);
  original:=$old$ELSIF OLD.status = 'FAILED' AND NEW.status = 'RUNNING' THEN$old$;
  IF (length(definition)-length(replace(definition,original,'')))<>length(original) THEN
    RAISE EXCEPTION 'reconciliation cron retry contract changed';
  END IF;
  EXECUTE replace(definition,original,$new$ELSIF NEW.status='RUNNING' AND (OLD.status='FAILED' OR
    (OLD.status='PARTIAL' AND OLD.job_name='wallet-reconciliation' AND EXISTS
      (SELECT 1 FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=OLD.id
        AND run.scheduled_for=OLD.scheduled_for AND run.status IS NULL))) THEN$new$);
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='validate_reconciliation_price_evidence' AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
      WHERE oid=pg_typeof(NULL::wallet_core.wallet_reconciliation_items)::oid);
  original:='resolution.observed_at <= v_valuation_at';
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'reconciliation price time guard contract changed'; END IF;
  EXECUTE replace(definition,original,original||' + interval ''60 seconds''');
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='validate_wallet_alert_payload' AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
      WHERE oid=pg_typeof(NULL::wallet_core.wallet_alerts)::oid);
  original:=$old$'INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE'$old$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'reconciliation alert reason contract changed'; END IF;
  EXECUTE replace(replace(definition,original,original||',''STAKING_TOTAL_MISMATCH'''),'{0,19}','{0,59}');
END;
$forward$;
REVOKE ALL ON FUNCTION wallet_core.guard_reconciliation_capture() FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_core.validate_reconciliation_capture_item() FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_core.guard_reconciliation_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION wallet_core.require_pending_reconciliation_parent() FROM PUBLIC;
REVOKE UPDATE,DELETE ON wallet_core.custody_addresses FROM orebit_wallet_core_admin_writer;
GRANT UPDATE(retired_at,retired_revision) ON wallet_core.custody_addresses TO orebit_wallet_core_admin_writer;
GRANT UPDATE(status,currency_count,warning_count,safe_error_code,completed_at)
  ON wallet_core.wallet_reconciliation_runs TO orebit_wallet_core_lifecycle_writer;
COMMIT;
