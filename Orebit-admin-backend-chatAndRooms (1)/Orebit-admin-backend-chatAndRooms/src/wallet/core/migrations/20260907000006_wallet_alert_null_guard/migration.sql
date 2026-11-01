BEGIN;
DO $alert_null_guard$
DECLARE definition TEXT; original_count INTEGER; corrected_count INTEGER;
  original CONSTANT TEXT := 'IF NOT v_valid THEN';
  corrected CONSTANT TEXT := 'IF v_valid IS DISTINCT FROM true THEN';
BEGIN
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='validate_wallet_alert_payload' AND procedure.pronargs=0
      AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
        WHERE oid=pg_typeof(NULL::wallet_core.wallet_alerts)::oid);
  original_count:=(length(definition)-length(replace(definition,original,'')))/length(original);
  corrected_count:=(length(definition)-length(replace(definition,corrected,'')))/length(corrected);
  IF original_count=0 AND corrected_count=3 THEN RETURN; END IF;
  IF original_count<>3 OR corrected_count<>0 THEN
    RAISE EXCEPTION 'wallet alert null guard contract changed';
  END IF;
  -- SQL NULL is not validation success; preserve every existing category and payload rule.
  EXECUTE replace(definition,original,corrected);
END;
$alert_null_guard$;
COMMIT;
