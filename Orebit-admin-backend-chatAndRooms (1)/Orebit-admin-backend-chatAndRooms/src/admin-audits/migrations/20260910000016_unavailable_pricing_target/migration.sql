BEGIN;
DO $migration$
DECLARE
  definition text;
  old_guard constant text := $old$IF NOT admin.validate_admin_audit_configuration_node_v1(v_entry.value,v_configuration_contract #> ARRAY[p_domain,p_subject_type]) THEN$old$;
  new_guard constant text := $new$IF NOT (COALESCE(
        p_domain = 'PRICE_CONVERSION' AND p_action = 'SETTINGS.SCHEDULE_REJECTED'
        AND v_before->'config' = 'null'::jsonb AND v_after->'config' = 'null'::jsonb
        AND v_metadata ? 'configChangeId' AND v_metadata->>'safeErrorCode' = 'CONFIGURATION_INVALID',false)
        OR admin.validate_admin_audit_configuration_node_v1(v_entry.value,v_configuration_contract #> ARRAY[p_domain,p_subject_type])) THEN$new$;
BEGIN
  SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) INTO STRICT definition;
  IF (length(definition)-length(replace(definition,old_guard,''))) <> length(old_guard) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_UNAVAILABLE_TARGET_CONTRACT_UNEXPECTED';
  END IF;
  -- Required target UUID and safe code are still validated by the existing scalar loop.
  -- Both explicit nulls identify unavailable malformed evidence; no unrelated live snapshot is substituted.
  EXECUTE replace(definition,old_guard,new_guard);
END;
$migration$;
COMMIT;
