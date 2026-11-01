BEGIN;
-- Nullable and without a default: existing append-only events are neither backfilled nor rewritten.
-- Readers calculate actual JSONB bytes for any legacy NULL size, including large Audit15/16 events.
ALTER TABLE admin.admin_audit_events ADD COLUMN payload_bytes integer
  CHECK (payload_bytes BETWEEN 0 AND 67174400);

DO $migration$
DECLARE
  definition text;
  old_columns constant text := $old_columns$subject_type, subject_id, reason, before_json, after_json, metadata_json
  ) VALUES ($old_columns$;
  new_columns constant text := $new_columns$subject_type, subject_id, reason, before_json, after_json, metadata_json, payload_bytes
  ) VALUES ($new_columns$;
  old_values constant text := $old_values$    v_metadata
  ) ON CONFLICT$old_values$;
  new_values constant text := $new_values$    v_metadata,
    (CASE WHEN p_before_json IS NULL THEN 0 ELSE octet_length(v_before::text) END)
    + (CASE WHEN p_after_json IS NULL THEN 0 ELSE octet_length(v_after::text) END)
    + octet_length(v_metadata::text)
  ) ON CONFLICT$new_values$;
BEGIN
  SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) INTO STRICT definition;
  IF (length(definition)-length(replace(definition,old_columns,''))) <> length(old_columns)
    OR (length(definition)-length(replace(definition,old_values,''))) <> length(old_values) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_PAYLOAD_SIZE_CONTRACT_UNEXPECTED';
  END IF;
  -- Derive bytes only on the existing successful INSERT path; identity/hash/ACL remain unchanged.
  EXECUTE replace(replace(definition,old_columns,new_columns),old_values,new_values);
END;
$migration$;
COMMIT;
