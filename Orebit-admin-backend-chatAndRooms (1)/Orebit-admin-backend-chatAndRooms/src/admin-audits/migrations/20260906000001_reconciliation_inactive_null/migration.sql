BEGIN;
DO $migration$
DECLARE
  definition TEXT;
  old_condition CONSTANT TEXT := $old_null${"domain":"WALLET_CORE","actions":["RECONCILIATION.WARNING_RAISED","RECONCILIATION.WARNING_CLEARED"],"sections":["before","after"],"key":"partial","equals":true}$old_null$;
  new_condition CONSTANT TEXT := $new_null${"domain":"WALLET_CORE","actions":["RECONCILIATION.WARNING_RAISED","RECONCILIATION.WARNING_CLEARED"],"sections":["before","after"],"key":"partial","equals":true,"allowInactive":true}$new_null$;
  old_guard CONSTANT TEXT := $old_guard$) IS DISTINCT FROM v_nullable_when->'equals'$old_guard$;
  new_guard CONSTANT TEXT := $new_guard$) IS DISTINCT FROM v_nullable_when->'equals'
        AND NOT (COALESCE((v_nullable_when->>'allowInactive')::boolean,false)
          AND (CASE v_entry.source WHEN 'before' THEN v_before WHEN 'after' THEN v_after ELSE v_metadata END
            -> 'active') IS NOT DISTINCT FROM 'false'::jsonb)$new_guard$;
BEGIN
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
  WHERE procedure.proname='append_admin_audit_event_v1' AND procedure.pronargs=17
    AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
      WHERE oid=pg_typeof(NULL::admin.admin_audit_events)::oid);
  IF strpos(definition,new_condition)>0 AND strpos(definition,new_guard)>0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,old_condition,'')))<>length(old_condition)
    OR (length(definition)-length(replace(definition,old_guard,'')))<>length(old_guard) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RECONCILIATION_CONTRACT_UNEXPECTED';
  END IF;
  -- Replace only the closed nullable condition; CREATE OR REPLACE preserves signature, owner and ACL.
  EXECUTE replace(replace(definition,old_condition,new_condition),old_guard,new_guard);
END;
$migration$;
COMMIT;
