BEGIN;
DO $migration$
DECLARE
  definition text;
  original text;
  contract jsonb;
  entry jsonb;
  expanded jsonb;
  actions jsonb := '[]'::jsonb;
  action_name text;
  changed integer := 0;
  scheduled_actions constant text[] := ARRAY['CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.UPDATED','CURRENCY.IMPORTED','PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED'];
  marker constant text := '$admin_audit_contract$';
  old_guard constant text := $old$  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_before_keys$old$;
  new_guard constant text := $new$  IF p_domain = 'WALLET_CORE' AND p_actor_kind = 'SYSTEM'
    AND p_action = ANY(ARRAY['CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.UPDATED','CURRENCY.IMPORTED','PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED'])
    AND NOT (v_metadata ? 'scheduledChangeId') THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_before_keys$new$;
BEGIN
  SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) INTO STRICT definition;
  original := split_part(definition,marker,2);
  IF original = '' THEN RAISE EXCEPTION 'ADMIN_AUDIT_SCHEDULED_BUSINESS_CONTRACT_UNEXPECTED'; END IF;
  contract := original::jsonb;
  -- Split grouped actions so CREATED retains its existing ADMIN-only rule.
  FOR entry IN SELECT value FROM jsonb_array_elements(contract->'actions') LOOP
    IF entry->>'domain' <> 'WALLET_CORE' OR NOT (entry->'actions' ?| scheduled_actions) THEN
      actions := actions || jsonb_build_array(entry);
      CONTINUE;
    END IF;
    FOR action_name IN SELECT jsonb_array_elements_text(entry->'actions') LOOP
      expanded := entry || jsonb_build_object('actions',jsonb_build_array(action_name));
      IF entry->>'domain' = 'WALLET_CORE' AND action_name = ANY(scheduled_actions) THEN
        IF entry->'actors' IS DISTINCT FROM '["ADMIN"]'::jsonb OR entry->'optionalMetadata' ? 'scheduledChangeId' THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_SCHEDULED_BUSINESS_CONTRACT_UNEXPECTED';
        END IF;
        expanded := expanded || jsonb_build_object('actors','["ADMIN","SYSTEM"]'::jsonb,
          'optionalMetadata',entry->'optionalMetadata' || '["scheduledChangeId"]'::jsonb);
        changed := changed + 1;
      END IF;
      actions := actions || jsonb_build_array(expanded);
    END LOOP;
  END LOOP;
  IF changed <> 6 OR (length(definition)-length(replace(definition,old_guard,''))) <> length(old_guard) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_SCHEDULED_BUSINESS_CONTRACT_UNEXPECTED';
  END IF;
  contract := jsonb_set(contract,'{actions}',actions,false);
  definition := replace(definition,marker||original||marker,marker||contract::text||marker);
  -- The existing scalar loop validates and normalizes the required schedule UUID.
  -- Full configuration validation, byte accounting, event hashes and writer ACL are unchanged.
  EXECUTE replace(definition,old_guard,new_guard);
END;
$migration$;
COMMIT;
