BEGIN;
DO $alert_string_guard$
DECLARE definition TEXT;
  original CONSTANT TEXT := 'SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_object_keys(NEW.payload) keys(key);';
  replacement CONSTANT TEXT := $guard$-- Wallet financial alert scalar strings v1.
  IF NEW.category IN ('SHORTFALL','PARTIAL_DATA','STAKING_TOTAL_MISMATCH') AND EXISTS (
    SELECT 1 FROM unnest(CASE NEW.category
      WHEN 'SHORTFALL' THEN ARRAY['runId','itemId','currencyId','custodyBalance',
        'requiredBacking','shortfallPercent','thresholdPercent']
      WHEN 'PARTIAL_DATA' THEN ARRAY['runId','itemId','currencyId']
      ELSE ARRAY['runId','itemId','componentId','currencyId','reportedTotal','componentSum','selectedSource']
    END) required_key
    WHERE jsonb_typeof(NEW.payload->required_key) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'invalid wallet alert payload' USING ERRCODE = '23514';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_object_keys(NEW.payload) keys(key);$guard$;
BEGIN
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='validate_wallet_alert_payload' AND procedure.pronargs=0
      AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
        WHERE oid=pg_typeof(NULL::wallet_core.wallet_alerts)::oid);
  IF (length(definition)-length(replace(definition,original,'')))<>length(original)
    OR strpos(definition,'IF NOT v_valid THEN')>0
    OR (length(definition)-length(replace(definition,'IF v_valid IS DISTINCT FROM true THEN','')))
      <>3*length('IF v_valid IS DISTINCT FROM true THEN') THEN
    RAISE EXCEPTION 'wallet alert string guard contract changed';
  END IF;
  IF strpos(definition,replacement)>0 THEN RETURN; END IF;
  IF strpos(definition,'Wallet financial alert scalar strings v1.')>0 THEN
    RAISE EXCEPTION 'wallet alert string guard contract changed';
  END IF;
  -- Keep the existing category/key/value rules, genuine reason arrays and suppression booleans.
  EXECUTE replace(definition,original,replacement);
END;
$alert_string_guard$;
COMMIT;
