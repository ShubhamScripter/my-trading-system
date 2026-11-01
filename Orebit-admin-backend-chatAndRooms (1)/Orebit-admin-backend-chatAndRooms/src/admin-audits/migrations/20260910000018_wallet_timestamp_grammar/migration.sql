BEGIN;
DO $migration$
DECLARE
  definition text;
  original text;
  rules jsonb;
  path text[];
  field text;
  marker constant text := '$configuration_contract$';
  old_rule constant jsonb := $old_rule${"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"}$old_rule$::jsonb;
  new_rule constant jsonb := $new_rule${"type":"string","min":1,"max":33554432,"pattern":"^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]+)?)?Z$"}$new_rule$::jsonb;
BEGIN
  SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) INTO STRICT definition;
  original := split_part(definition,marker,2);
  IF original = '' THEN RAISE EXCEPTION 'ADMIN_AUDIT_TIMESTAMP_CONTRACT_UNEXPECTED'; END IF;
  rules := original::jsonb;
  FOREACH field IN ARRAY ARRAY['listingStartsAt','premiumEarlyAccessAt','soEarlyAccessAt','delistAt'] LOOP
    FOREACH path SLICE 1 IN ARRAY ARRAY[
      ARRAY['WALLET_CORE','CURRENCY','fields',field,'','',''],
      ARRAY['WALLET_CORE','SETTINGS_REVISION','fields','currencies','items','fields',field]
    ] LOOP
      path := array_remove(path,'');
      IF rules #> path IS DISTINCT FROM old_rule THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_TIMESTAMP_CONTRACT_UNEXPECTED';
      END IF;
      rules := jsonb_set(rules,path,new_rule,false);
    END LOOP;
  END LOOP;
  -- Change only eight nested timestamp descriptors. No history values are rewritten or rounded.
  EXECUTE replace(definition,marker||original||marker,marker||rules::text||marker);
END;
$migration$;
COMMIT;
