BEGIN;

-- Validate existing history instead of rewriting invalid or uncapped financial evidence.
ALTER TABLE price_conversion.price_snapshots
  ADD CONSTRAINT price_snapshots_finite_price CHECK (price_usd <> 'NaN'::numeric),
  ADD COLUMN received_at TIMESTAMPTZ,
  ADD COLUMN asset_updated_at TIMESTAMPTZ;
ALTER TABLE price_conversion.price_view_snapshots
  ADD CONSTRAINT price_view_snapshots_finite_price CHECK (price <> 'NaN'::numeric),
  ADD COLUMN received_at TIMESTAMPTZ,
  ADD COLUMN asset_updated_at TIMESTAMPTZ;
COMMENT ON COLUMN price_conversion.price_snapshots.received_at IS
  'Actual response receipt time for new quotes; NULL means historical receipt is unknown.';
COMMENT ON COLUMN price_conversion.price_view_snapshots.received_at IS
  'Actual response receipt time for new quotes; NULL means historical receipt is unknown.';
ALTER TABLE price_conversion.price_resolutions
  ADD CONSTRAINT price_resolutions_finite_amounts CHECK ('NaN'::numeric <> ALL(ARRAY[
    effective_price_usd,primary_price_usd,comparison_price_usd,fallback_price_usd,
    difference_bps,absolute_difference_usd,difference_numerator,difference_denominator])),
  ADD CONSTRAINT price_resolutions_quote_ranges CHECK (
    (primary_price_usd IS NULL OR primary_price_usd>0)
    AND (comparison_price_usd IS NULL OR comparison_price_usd>0)
    AND (fallback_price_usd IS NULL OR fallback_price_usd>0)
    AND (difference_denominator IS NULL OR difference_denominator>0)),
  ADD CONSTRAINT price_resolutions_deviation_cap CHECK (
    (difference_bps IS NULL OR difference_bps BETWEEN 0 AND 100000)
    AND (difference_numerator IS NULL OR (difference_denominator IS NOT NULL
      AND difference_numerator BETWEEN 0 AND difference_denominator*10))
    AND (absolute_difference_usd IS NULL OR (primary_price_usd IS NOT NULL
      AND absolute_difference_usd BETWEEN 0 AND primary_price_usd*10)));

-- Cadence and source freshness are independent. Every provider gets the same ten-minute window.
ALTER TABLE price_conversion.price_providers
  DROP CONSTRAINT price_providers_freshness_check,
  ALTER COLUMN freshness_seconds SET DEFAULT 600;
UPDATE price_conversion.price_providers SET freshness_seconds=600 WHERE freshness_seconds<>600;
ALTER TABLE price_conversion.price_providers
  ADD CONSTRAINT price_providers_freshness_check CHECK (freshness_seconds=600);

-- Keep unsupported legacy fiat rows for old snapshots, but never expose them as new view choices.
UPDATE price_conversion.price_view_fiats SET enabled=false WHERE code NOT IN (
  'AED','ARS','AUD','BDT','BHD','BMD','BRL','CAD','CHF','CLP','CNY','CZK','DKK','EUR','GBP',
  'GEL','HKD','HUF','IDR','ILS','INR','JPY','KRW','KWD','LKR','MMK','MXN','MYR','NGN','NOK',
  'NZD','PHP','PKR','PLN','RUB','SAR','SEK','SGD','THB','TRY','TWD','UAH','USD','VND','ZAR');
ALTER TABLE price_conversion.price_view_fiats
  ADD CONSTRAINT price_view_fiats_supported_visibility CHECK (NOT enabled OR code IN (
    'AED','ARS','AUD','BDT','BHD','BMD','BRL','CAD','CHF','CLP','CNY','CZK','DKK','EUR','GBP',
    'GEL','HKD','HUF','IDR','ILS','INR','JPY','KRW','KWD','LKR','MMK','MXN','MYR','NGN','NOK',
    'NZD','PHP','PKR','PLN','RUB','SAR','SEK','SGD','THB','TRY','TWD','UAH','USD','VND','ZAR'));

ALTER TABLE price_conversion.currency_provider_refs
  ADD COLUMN retired_at TIMESTAMPTZ,
  DROP CONSTRAINT currency_provider_refs_currency_id_provider_id_key,
  DROP CONSTRAINT currency_provider_refs_provider_id_external_id_key;
CREATE UNIQUE INDEX currency_provider_refs_current_currency_provider
  ON price_conversion.currency_provider_refs(currency_id,provider_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX currency_provider_refs_current_provider_asset
  ON price_conversion.currency_provider_refs(provider_id,external_id) WHERE retired_at IS NULL;

CREATE FUNCTION price_conversion.guard_provider_reference_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,price_conversion AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'provider reference history cannot be deleted' USING ERRCODE='23514';
  ELSIF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider reference must start current' USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.retired_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['active','retired_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','retired_at']) THEN
      RAISE EXCEPTION 'provider reference identity is immutable; retire and replace it' USING ERRCODE='23514';
    END IF;
    IF NEW.retired_at IS NOT NULL THEN NEW.retired_at:=clock_timestamp(); END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER currency_provider_refs_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON price_conversion.currency_provider_refs
  FOR EACH ROW EXECUTE FUNCTION price_conversion.guard_provider_reference_history();
CREATE TRIGGER currency_provider_refs_no_truncate
  BEFORE TRUNCATE ON price_conversion.currency_provider_refs
  FOR EACH STATEMENT EXECUTE FUNCTION price_conversion.reject_append_only();
REVOKE ALL ON FUNCTION price_conversion.guard_provider_reference_history() FROM PUBLIC;

-- Both pre-Wallet and contracted schemas use these functions; only current refs satisfy activation.
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
REVOKE ALL ON FUNCTION price_conversion.current_price_config_revision() FROM PUBLIC;
DO $$ BEGIN
  IF to_regrole('orebit_price_conversion_writer') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION price_conversion.current_price_config_revision() TO orebit_price_conversion_writer;
  END IF;
END $$;

-- The real global history query otherwise sorts every VIEW resolution before returning one page.
CREATE INDEX price_view_resolutions_created_cursor
  ON price_conversion.price_view_resolutions(created_at DESC,id DESC);
COMMENT ON COLUMN price_conversion.price_config_changes.config IS
  'Immutable accepted configuration payload; revision zero is the legacy seed shape, not a complete current settings snapshot.';

COMMIT;
