BEGIN;
DO $capture_set$
DECLARE definition TEXT;
  original CONSTANT TEXT := 'IF NEW.status IS NOT NULL OR NEW.completed_at IS NOT NULL';
  replacement CONSTANT TEXT := $guard$IF NEW.expected_currency_count IS DISTINCT FROM (
      SELECT count(*) FROM price_conversion.currencies currency
      JOIN wallet_core.currency_settings setting ON setting.currency_id=currency.id
      WHERE currency.kind='CRYPTO') THEN
      RAISE EXCEPTION 'reconciliation capture currency set mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.status IS NOT NULL OR NEW.completed_at IS NOT NULL$guard$;
BEGIN
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='guard_reconciliation_run' AND procedure.pronargs=0
      AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
        WHERE oid=pg_typeof(NULL::wallet_core.wallet_reconciliation_runs)::oid);
  IF (length(definition)-length(replace(definition,original,'')))<>length(original)
    OR strpos(definition,'reconciliation capture currency set mismatch')>0 THEN
    RAISE EXCEPTION 'reconciliation capture set guard contract changed';
  END IF;
  -- Only the original INSERT snapshot is compared; later configuration cannot invalidate a saved run.
  EXECUTE replace(definition,original,replacement);
END;
$capture_set$;
COMMIT;
