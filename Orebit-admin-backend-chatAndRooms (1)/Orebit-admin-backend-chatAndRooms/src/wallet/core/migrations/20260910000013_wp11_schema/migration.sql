BEGIN;

-- Display denominations are not holdings. Preserve every existing fiat UUID and business identity.
INSERT INTO price_conversion.currencies(id,symbol,name,decimals,kind,pricing_status)
  SELECT gen_random_uuid(),code,code,18,'FIAT','ACTIVE'
  FROM price_conversion.price_view_fiats WHERE code IN (
    'AED','ARS','AUD','BDT','BHD','BMD','BRL','CAD','CHF','CLP','CNY','CZK','DKK','EUR','GBP',
    'GEL','HKD','HUF','IDR','ILS','INR','JPY','KRW','KWD','LKR','MMK','MXN','MYR','NGN','NOK',
    'NZD','PHP','PKR','PLN','RUB','SAR','SEK','SGD','THB','TRY','TWD','UAH','USD','VND','ZAR')
  ON CONFLICT(symbol,kind) DO NOTHING;

ALTER TABLE wallet_core.wallet_settings
  ADD COLUMN default_currency_ids UUID[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT wallet_settings_default_currency_count CHECK (
    cardinality(default_currency_ids)<=10 AND COALESCE(array_ndims(default_currency_ids),1)=1);
CREATE FUNCTION wallet_core.guard_default_currency_ids() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
BEGIN
  IF cardinality(NEW.default_currency_ids)<>(SELECT count(DISTINCT chosen.currency_id)
      FROM unnest(NEW.default_currency_ids) AS chosen(currency_id))
    OR EXISTS (SELECT 1 FROM unnest(NEW.default_currency_ids) AS chosen(currency_id) WHERE NOT EXISTS (
      SELECT 1 FROM price_conversion.currencies c WHERE c.id=chosen.currency_id AND c.kind='CRYPTO')) THEN
    RAISE EXCEPTION 'default Wallet currencies must be distinct existing cryptocurrencies' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wallet_settings_default_currency_guard
  BEFORE INSERT OR UPDATE OF default_currency_ids ON wallet_core.wallet_settings
  FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_default_currency_ids();
REVOKE ALL ON FUNCTION wallet_core.guard_default_currency_ids() FROM PUBLIC;

-- Preserve the exact old outbound identities, never infer an asset name from website display text.
ALTER TABLE wallet_core.chains ADD COLUMN blockchain_reference VARCHAR(160);
ALTER TABLE wallet_core.currencies ADD COLUMN blockchain_reference VARCHAR(160);
UPDATE wallet_core.chains SET blockchain_reference=short_name;
UPDATE wallet_core.currencies binding SET blockchain_reference=catalogue.currency_name
  FROM wallet_core.chains chain,wallet_core.provider_catalogue_currencies catalogue
  WHERE chain.id=binding.chain_id AND catalogue.provider_chain_id=chain.provider_chain_id
    AND catalogue.provider_coin_id=binding.provider_coin_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wallet_core.currencies WHERE blockchain_reference IS NULL) THEN
    RAISE EXCEPTION 'blockchain reference backfill requires matching imported provider coin catalogue' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE wallet_core.chains ALTER COLUMN blockchain_reference SET NOT NULL,
  ADD CONSTRAINT chains_blockchain_reference_check CHECK (
    blockchain_reference=btrim(blockchain_reference) AND blockchain_reference<>'');
ALTER TABLE wallet_core.currencies ALTER COLUMN blockchain_reference SET NOT NULL,
  ADD CONSTRAINT currencies_blockchain_reference_check CHECK (
    blockchain_reference=btrim(blockchain_reference) AND blockchain_reference<>'');

-- Wallet's older contract migration replaced these functions after Pricing migration deployment.
DO $current_refs$
DECLARE name TEXT; definition TEXT;
BEGIN
  FOREACH name IN ARRAY ARRAY['require_active_crypto_provider_ref','require_active_crypto_ref_after_mutation'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
      WHERE p.pronamespace='price_conversion'::regnamespace AND p.proname=name AND p.pronargs=0;
    IF strpos(definition,'retired_at IS NULL')=0 THEN
      IF strpos(definition,'AND r.active')>0 THEN
        definition:=replace(definition,'AND r.active','AND r.active AND r.retired_at IS NULL');
      ELSIF strpos(definition,'AND reference.active')>0 THEN
        definition:=replace(definition,'AND reference.active','AND reference.active AND reference.retired_at IS NULL');
      ELSE RAISE EXCEPTION 'provider reference activation guard contract changed'; END IF;
      EXECUTE definition;
    END IF;
  END LOOP;
END;
$current_refs$;
REVOKE UPDATE,DELETE ON price_conversion.currency_provider_refs FROM orebit_wallet_core_admin_writer;
GRANT UPDATE(active,retired_at) ON price_conversion.currency_provider_refs TO orebit_wallet_core_admin_writer;
GRANT EXECUTE ON FUNCTION price_conversion.current_price_config_revision() TO orebit_price_conversion_writer;

-- Each immutable item already proves captured membership and unique (run,currency) identity.
-- Therefore pending inserts need no repeated run-wide recount; seal verifies all counters once.
DROP TRIGGER wallet_reconciliation_items_status_guard ON wallet_core.wallet_reconciliation_items;
CREATE OR REPLACE FUNCTION wallet_core.validate_reconciliation_run_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE header wallet_core.wallet_reconciliation_runs; items BIGINT; partial BIGINT; warnings BIGINT; captured BIGINT;
BEGIN
  SELECT run.* INTO header FROM wallet_core.wallet_reconciliation_runs run WHERE run.id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN
    SELECT count(*) INTO captured FROM wallet_core.state_events event WHERE event.run_id=header.id
      AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY';
    IF captured<>header.expected_currency_count OR EXISTS (
      SELECT 1 FROM wallet_core.state_events currency JOIN wallet_core.currencies binding ON binding.currency_id=currency.subject_id
      WHERE currency.run_id=header.id AND currency.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND currency.subject_type='CURRENCY'
        AND NOT EXISTS (SELECT 1 FROM wallet_core.state_events event WHERE event.run_id=header.id
          AND event.event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND event.subject_type='CURRENCY_CHAIN' AND event.subject_id=binding.id)) THEN
      RAISE EXCEPTION 'reconciliation capture set incomplete' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
  END IF;
  IF header.status IS NULL THEN RETURN NULL; END IF;
  SELECT count(*),count(*) FILTER(WHERE item.status='PARTIAL'),
    count(*) FILTER(WHERE NOT item.shortfall_suppressed AND item.required_backing>0
      AND (item.required_backing-item.total_custody_balance)*100>item.required_backing*header.applied_reconciliation_alert_percent)
    INTO items,partial,warnings FROM wallet_core.wallet_reconciliation_items item WHERE item.run_id=header.id;
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

ALTER TABLE wallet_core.wallet_reconciliation_items
  DROP CONSTRAINT wallet_reconciliation_items_partial_reasons_check,
  ADD CONSTRAINT wallet_reconciliation_items_partial_reasons_check CHECK
  (partial_reasons <@ ARRAY['ENCRYPTION_FAILED','AUTHENTICATION_FAILED','UNAUTHORIZED_IP','PROVIDER_MAINTENANCE',
    'PROVIDER_DISABLED','PROVIDER_NOT_FOUND','PROVIDER_REJECTED','TIMEOUT','TRANSPORT_ERROR','RESPONSE_TOO_LARGE',
    'INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE','STAKING_TOTAL_MISMATCH','CUSTODY_NOT_CONFIGURED']::text[]);

DO $reconciliation_evidence$
DECLARE definition TEXT; original TEXT;
BEGIN
  SELECT pg_get_functiondef('wallet_core.guard_reconciliation_capture()'::regprocedure) INTO definition;
  original:=$old$'chainShortName',chain.short_name,'currencyName',currency.name$old$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'binding capture guard contract changed'; END IF;
  EXECUTE replace(definition,original,$new$'chainShortName',chain.blockchain_reference,'currencyName',link.blockchain_reference$new$);

  SELECT pg_get_functiondef('wallet_core.validate_reconciliation_buckets()'::regprocedure) INTO definition;
  original:='item.shortfall_suppressed IS DISTINCT FROM (failed>0)';
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'reconciliation suppression guard contract changed'; END IF;
  definition:=replace(definition,original,
    'item.shortfall_suppressed IS DISTINCT FROM (failed>0 OR (expected=0 AND item.required_backing>0))');
  original:=$old$UNION SELECT 'PRICE_UNAVAILABLE' WHERE item.price_resolution_id IS NULL$old$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'reconciliation reason guard contract changed'; END IF;
  EXECUTE replace(definition,original,original||$new$
    UNION SELECT 'CUSTODY_NOT_CONFIGURED' WHERE expected=0 AND item.required_backing>0$new$);

  SELECT pg_get_functiondef('wallet_core.validate_wallet_alert_payload()'::regprocedure) INTO definition;
  original:=$old$'INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE','STAKING_TOTAL_MISMATCH'$old$;
  IF strpos(definition,original)=0 THEN RAISE EXCEPTION 'reconciliation alert reason guard contract changed'; END IF;
  EXECUTE replace(definition,original,original||',''CUSTODY_NOT_CONFIGURED''');
END;
$reconciliation_evidence$;

-- The unique constraint on these same two columns already supplies this index and its protection.
DROP INDEX wallet_core.wallet_reconciliation_attempts_component_idx;

-- Each history branch can take one ordered page without scanning unrelated capture/state events.
CREATE INDEX state_events_history_state_cursor ON wallet_core.state_events(created_at DESC,id DESC)
  WHERE event_type IN ('CHAIN.STATUS_CHANGED','CURRENCY.STATUS_CHANGED');
CREATE INDEX state_events_history_provider_cursor ON wallet_core.state_events(created_at DESC,id DESC)
  WHERE event_type IN ('PROVIDER_MAINTENANCE.ENTERED','PROVIDER_MAINTENANCE.RECOVERED',
    'PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED');

COMMIT;
