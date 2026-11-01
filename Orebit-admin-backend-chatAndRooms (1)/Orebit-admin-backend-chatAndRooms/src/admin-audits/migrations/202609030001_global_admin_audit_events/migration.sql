BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF to_regrole('orebit_admin_audit_owner') IS NULL THEN
    CREATE ROLE orebit_admin_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF to_regrole('orebit_admin_audit_writer') IS NULL THEN
    CREATE ROLE orebit_admin_audit_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF to_regrole('orebit_admin_audit_reader') IS NULL THEN
    CREATE ROLE orebit_admin_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$roles$;

DO $role_graph$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN (
      'orebit_admin_audit_owner',
      'orebit_admin_audit_writer',
      'orebit_admin_audit_reader'
    )
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit)
  ) OR EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE granted.rolname IN (
      'orebit_admin_audit_owner',
      'orebit_admin_audit_writer',
      'orebit_admin_audit_reader'
    ) OR member.rolname IN (
      'orebit_admin_audit_owner',
      'orebit_admin_audit_writer',
      'orebit_admin_audit_reader'
    )
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_ROLE_GRAPH_INVALID';
  END IF;
END;
$role_graph$;

ALTER ROLE orebit_admin_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE orebit_admin_audit_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE orebit_admin_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

CREATE SCHEMA IF NOT EXISTS admin;
REVOKE ALL ON SCHEMA admin FROM PUBLIC;

CREATE TABLE admin.admin_audit_events (
  id UUID PRIMARY KEY CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  event_key VARCHAR(200) NOT NULL UNIQUE CHECK (
    event_key = btrim(event_key, E' \t\n\r\f\v') AND event_key <> ''
  ),
  event_hash CHAR(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  domain VARCHAR(32) NOT NULL CHECK (domain IN ('WALLET_CORE', 'DEPOSIT')),
  action VARCHAR(96) NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)+$'),
  actor_kind VARCHAR(16) NOT NULL,
  actor_id UUID,
  session_id UUID,
  request_id UUID,
  run_id UUID,
  ip_address INET,
  device_id VARCHAR(128),
  subject_type VARCHAR(64) NOT NULL CHECK (subject_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  subject_id VARCHAR(128) NOT NULL CHECK (
    subject_id = btrim(subject_id, E' \t\n\r\f\v') AND subject_id <> ''
  ),
  reason VARCHAR(500) NOT NULL CHECK (
    reason = btrim(reason, E' \t\n\r\f\v') AND reason <> ''
  ),
  before_json JSONB CHECK (before_json IS NULL OR (
    jsonb_typeof(before_json) = 'object' AND octet_length(before_json::text) <= 65536
  )),
  after_json JSONB CHECK (after_json IS NULL OR (
    jsonb_typeof(after_json) = 'object' AND octet_length(after_json::text) <= 65536
  )),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata_json) = 'object' AND octet_length(metadata_json::text) <= 65536
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (actor_kind = 'ADMIN' AND actor_id IS NOT NULL AND session_id IS NOT NULL
      AND request_id IS NOT NULL AND run_id IS NULL AND ip_address IS NOT NULL
      AND device_id IS NOT NULL
      AND device_id = btrim(device_id, E' \t\n\r\f\v') AND device_id <> '')
    OR
    (actor_kind = 'SYSTEM' AND actor_id IS NULL AND session_id IS NULL
      AND request_id IS NULL AND run_id IS NOT NULL AND ip_address IS NULL
      AND device_id IS NULL)
  )
);

CREATE INDEX admin_audit_events_created_idx
  ON admin.admin_audit_events (created_at DESC, id DESC);
CREATE INDEX admin_audit_events_domain_action_created_idx
  ON admin.admin_audit_events (domain, action, created_at DESC, id DESC);
CREATE INDEX admin_audit_events_actor_created_idx
  ON admin.admin_audit_events (actor_id, created_at DESC, id DESC);
CREATE INDEX admin_audit_events_run_created_idx
  ON admin.admin_audit_events (run_id, created_at DESC, id DESC);
CREATE INDEX admin_audit_events_subject_created_idx
  ON admin.admin_audit_events (subject_type, subject_id, created_at DESC, id DESC);

CREATE FUNCTION admin.reject_admin_audit_row_mutation_v1()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'ADMIN_AUDIT_IMMUTABLE' USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION admin.reject_admin_audit_truncate_v1()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'ADMIN_AUDIT_IMMUTABLE' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER admin_audit_events_reject_row_mutation
BEFORE UPDATE OR DELETE ON admin.admin_audit_events
FOR EACH ROW EXECUTE FUNCTION admin.reject_admin_audit_row_mutation_v1();

CREATE TRIGGER admin_audit_events_reject_truncate
BEFORE TRUNCATE ON admin.admin_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION admin.reject_admin_audit_truncate_v1();

CREATE FUNCTION admin.append_admin_audit_event_v1(
  p_id uuid, p_event_key text, p_domain text, p_action text,
  p_actor_kind text, p_actor_id uuid, p_session_id uuid, p_request_id uuid,
  p_run_id uuid, p_ip_address inet, p_device_id text,
  p_subject_type text, p_subject_id text, p_reason text,
  p_before_json jsonb, p_after_json jsonb, p_metadata_json jsonb
) RETURNS TABLE (audit_event_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_hash text;
  v_inserted_id uuid;
  v_existing_id uuid;
  v_existing_hash text;
  v_event_key text := btrim(p_event_key, E' \t\n\r\f\v');
  v_subject_id text := btrim(p_subject_id, E' \t\n\r\f\v');
  v_reason text := btrim(p_reason, E' \t\n\r\f\v');
  v_device_id text := btrim(p_device_id, E' \t\n\r\f\v');
  v_before jsonb := COALESCE(p_before_json, '{}'::jsonb);
  v_after jsonb := COALESCE(p_after_json, '{}'::jsonb);
  v_metadata jsonb := COALESCE(p_metadata_json, '{}'::jsonb);
  v_contract jsonb := $admin_audit_contract$
{"actions":[
{"domain":"WALLET_CORE","actions":["SETTINGS.SAVED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":[null],"afterStatuses":["DRAFT"]},
{"domain":"WALLET_CORE","actions":["SETTINGS.PUSHED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":["DRAFT"],"afterStatuses":["LIVE"]},
{"domain":"WALLET_CORE","actions":["SETTINGS.SCHEDULED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":["DRAFT"],"afterStatuses":["SCHEDULED"]},
{"domain":"WALLET_CORE","actions":["SETTINGS.SCHEDULE_APPLIED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["SYSTEM"],"beforeStatuses":["SCHEDULED"],"afterStatuses":["LIVE"]},
{"domain":"WALLET_CORE","actions":["SETTINGS.SCHEDULE_REJECTED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["SYSTEM"],"beforeStatuses":["SCHEDULED"],"afterStatuses":["REJECTED"]},
{"domain":"WALLET_CORE","actions":["LOGO.UPLOADED"],"subjects":["LOGO_ASSET"],"before":["stored"],"after":["stored","mediaType","width","height","bytes"],"requiredMetadata":["sourceFormat"],"optionalMetadata":[],"actors":["ADMIN"],"constraints":{"reason":"wallet-logo-upload","requiredBefore":["stored"],"requiredAfter":["stored","mediaType","width","height","bytes"],"fixedBefore":{"stored":false},"fixedAfter":{"stored":true,"mediaType":"image/webp"},"equalAfter":[["width","height"]]}},
{"domain":"WALLET_CORE","actions":["ADMIN_TIMEZONE.UPDATED"],"subjects":["ADMIN"],"before":["timezone"],"after":["timezone"],"requiredMetadata":["configurationRevision"],"optionalMetadata":[],"actors":["ADMIN"]},
{"domain":"WALLET_CORE","actions":["CATALOGUE.REFRESHED"],"subjects":["PROVIDER_CATALOGUE"],"before":["revision","itemCount"],"after":["revision","itemCount"],"requiredMetadata":["configurationRevision","source"],"optionalMetadata":[],"actors":["ADMIN"]},
{"domain":"WALLET_CORE","actions":["CHAIN.CREATED","CHAIN.UPDATED","CHAIN.IMPORTED"],"subjects":["CHAIN"],"before":["name","shortName","blockchainReference","availableFor","logoObjectKey"],"after":["name","shortName","blockchainReference","availableFor","logoObjectKey"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["importCatalogueRevision"],"actors":["ADMIN"]},
{"domain":"WALLET_CORE","actions":["CURRENCY.CREATED","CURRENCY.UPDATED","CURRENCY.IMPORTED"],"subjects":["CURRENCY"],"before":["symbol","name","kind","pricingStatus","desiredState","logoObjectKey"],"after":["symbol","name","kind","pricingStatus","desiredState","logoObjectKey"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["providerReferenceCount","chainBindingCount","importCatalogueRevision"],"actors":["ADMIN"]},
{"domain":"WALLET_CORE","actions":["PROVIDER_MAINTENANCE.PINNED","PROVIDER_MAINTENANCE.UNPINNED"],"subjects":["CHAIN","CURRENCY_CHAIN"],"before":["maintenancePinned","effectiveState"],"after":["maintenancePinned","effectiveState"],"requiredMetadata":["configurationRevision"],"optionalMetadata":[],"actors":["ADMIN"]},
{"domain":"WALLET_CORE","actions":["CHAIN.STATUS_CHANGED"],"subjects":["CHAIN"],"before":["desiredState","effectiveState","maintenancePinned"],"after":["desiredState","effectiveState","maintenancePinned"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["scheduledChangeId"],"actors":["ADMIN","SYSTEM"]},
{"domain":"WALLET_CORE","actions":["CURRENCY.STATUS_CHANGED"],"subjects":["CURRENCY","CURRENCY_CHAIN"],"before":["desiredState","effectiveState","showBalance"],"after":["desiredState","effectiveState","showBalance"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["scheduledChangeId"],"actors":["ADMIN","SYSTEM"]},
{"domain":"WALLET_CORE","actions":["PROVIDER_MAINTENANCE.ENTERED","PROVIDER_MAINTENANCE.RECOVERED"],"subjects":["CHAIN","CURRENCY","CURRENCY_CHAIN"],"before":["effectiveState","failureStreak","maintenancePinned"],"after":["effectiveState","failureStreak","maintenancePinned"],"requiredMetadata":["configurationRevision","providerReference"],"optionalMetadata":[],"actors":["SYSTEM"]},
{"domain":"WALLET_CORE","actions":["PRICE_MAINTENANCE.ENTERED","PRICE_MAINTENANCE.RECOVERED"],"subjects":["CHAIN","CURRENCY"],"before":["effectiveState","failureStreak","maintenancePinned"],"after":["effectiveState","failureStreak","maintenancePinned"],"requiredMetadata":["configurationRevision","providerReference"],"optionalMetadata":[],"actors":["SYSTEM"]},
{"domain":"WALLET_CORE","actions":["RECONCILIATION.COMPLETED"],"subjects":["RECONCILIATION_RUN"],"before":["status","partial"],"after":["status","partial"],"requiredMetadata":["currencyCount","warningCount"],"optionalMetadata":[],"actors":["SYSTEM"]},
{"domain":"WALLET_CORE","actions":["RECONCILIATION.WARNING_RAISED","RECONCILIATION.WARNING_CLEARED"],"subjects":["CURRENCY"],"before":["active","partial","shortfallPercent"],"after":["active","partial","shortfallPercent"],"requiredMetadata":["reconciliationRunId"],"optionalMetadata":[],"actors":["SYSTEM"]},
{"domain":"WALLET_CORE","actions":["DELISTING.FORFEITURE_POSTED"],"subjects":["LEDGER_JOURNAL"],"before":["balance"],"after":["balance"],"requiredMetadata":["currencyId","ownerType","ownerId","amount"],"optionalMetadata":[],"actors":["SYSTEM"]},
{"domain":"DEPOSIT","actions":["SETTINGS.SAVED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":[null],"afterStatuses":["DRAFT"]},
{"domain":"DEPOSIT","actions":["SETTINGS.PUSHED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":["DRAFT"],"afterStatuses":["LIVE"]},
{"domain":"DEPOSIT","actions":["SETTINGS.SCHEDULED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["ADMIN"],"beforeStatuses":["DRAFT"],"afterStatuses":["SCHEDULED"]},
{"domain":"DEPOSIT","actions":["SETTINGS.SCHEDULE_APPLIED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["SYSTEM"],"beforeStatuses":["SCHEDULED"],"afterStatuses":["LIVE"]},
{"domain":"DEPOSIT","actions":["SETTINGS.SCHEDULE_REJECTED"],"subjects":["SETTINGS_REVISION"],"before":["revision","status","effectiveAt"],"after":["revision","status","effectiveAt"],"requiredMetadata":["configurationRevision"],"optionalMetadata":["changelogId","safeErrorCode"],"actors":["SYSTEM"],"beforeStatuses":["SCHEDULED"],"afterStatuses":["REJECTED"]},
{"domain":"DEPOSIT","actions":["DEPOSIT.RELEASED","DEPOSIT.REJECTED","DEPOSIT.CANCELLED","DEPOSIT.MAINTENANCE_CANCELLED"],"subjects":["DEPOSIT"],"before":["status","bucket","visible"],"after":["status","bucket","visible"],"requiredMetadata":["currencyId","grossAmount"],"optionalMetadata":["feeAmount","ledgerJournalId","priceResolutionId","priceSnapshotId","priceBasis"],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["DEPOSIT.REVERIFICATION_HELD"],"subjects":["DEPOSIT"],"before":["status","bucket","visible"],"after":["status","bucket","visible"],"requiredMetadata":["currencyId","grossAmount","ledgerJournalId","blockerId"],"optionalMetadata":[],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["DEPOSIT.CLAWBACK_TO_ZERO_POSTED","DEPOSIT.CLAWBACK_NEGATIVE_POSTED"],"subjects":["DEPOSIT"],"before":["status","bucket","visible"],"after":["status","bucket","visible"],"requiredMetadata":["currencyId","ledgerJournalId","clawbackAmount"],"optionalMetadata":["shortfallAmount"],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["DEPOSIT.ACCOUNTING_REVERSAL_POSTED"],"subjects":["DEPOSIT"],"before":["status","bucket","visible"],"after":["status","bucket","visible"],"requiredMetadata":["currencyId","originalJournalId","reversalJournalId"],"optionalMetadata":[],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["DEPOSIT.STATUS_CHANGED"],"subjects":["DEPOSIT"],"before":["status","bucket","visible"],"after":["status","bucket","visible"],"requiredMetadata":["currencyId"],"optionalMetadata":["ledgerJournalId"],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["BLOCKER.WAIVED"],"subjects":["DEPOSIT_BLOCKER"],"before":["status"],"after":["status"],"requiredMetadata":["depositId","blockerKind"],"optionalMetadata":[],"actors":["ADMIN"]},
{"domain":"DEPOSIT","actions":["QUARANTINE.RETRIED","QUARANTINE.ASSIGNED","QUARANTINE.CREDIT_REQUESTED","QUARANTINE.RETAINED"],"subjects":["QUARANTINE"],"before":["status","assignedUserId"],"after":["status","assignedUserId"],"requiredMetadata":["currencyId","grossAmount"],"optionalMetadata":["depositId","ledgerJournalId","priceResolutionId","priceSnapshotId","priceBasis"],"actors":["ADMIN","SYSTEM"]},
{"domain":"DEPOSIT","actions":["KILL_SWITCH.ACTIVATED","KILL_SWITCH.CLEARED"],"subjects":["FEATURE_STATE"],"before":["killed"],"after":["killed"],"requiredMetadata":["configurationRevision"],"optionalMetadata":[],"actors":["ADMIN"]},
{"domain":"DEPOSIT","actions":["BULK_JOB.CREATED","BULK_JOB.RESUMED"],"subjects":["BULK_JOB"],"before":["status"],"after":["status"],"requiredMetadata":["actionKind","totalItems","attemptedCount","succeededCount","failedCount"],"optionalMetadata":["batchNumber","safeErrorCode"],"actors":["ADMIN"]},
{"domain":"DEPOSIT","actions":["BULK_JOB.STARTED","BULK_JOB.PAUSED","BULK_JOB.COMPLETED","BULK_JOB.COMPLETED_WITH_FAILURES","BULK_JOB.FAILED"],"subjects":["BULK_JOB"],"before":["status"],"after":["status"],"requiredMetadata":["actionKind","totalItems","attemptedCount","succeededCount","failedCount"],"optionalMetadata":["batchNumber","safeErrorCode"],"actors":["SYSTEM"]},
{"domain":"DEPOSIT","actions":["BULK_JOB.ITEM_SUCCEEDED","BULK_JOB.ITEM_FAILED"],"subjects":["BULK_JOB_ITEM"],"before":["status"],"after":["status"],"requiredMetadata":["bulkJobId","depositId","attempt"],"optionalMetadata":["ledgerJournalId","safeErrorCode"],"actors":["SYSTEM"]}
],"validators":{
"revision":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"configurationRevision":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"importCatalogueRevision":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"failureStreak":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"providerReferenceCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"chainBindingCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"itemCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"currencyCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"warningCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"batchNumber":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"totalItems":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"attemptedCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"succeededCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"failedCount":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"attempt":{"family":"integer","nullable":false,"minimum":0,"maximum":9007199254740991},
"width":{"family":"integer","nullable":false,"minimum":1,"maximum":500},
"height":{"family":"integer","nullable":false,"minimum":1,"maximum":500},
"bytes":{"family":"integer","nullable":false,"minimum":1,"maximum":1048576},
"amount":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"balance":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"grossAmount":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"feeAmount":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"clawbackAmount":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"shortfallAmount":{"family":"decimal","nullable":false,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18},
"shortfallPercent":{"family":"decimal","nullable":true,"minimum":"0","maxIntegerDigits":128,"maxFractionDigits":18,"nullableWhen":{"domain":"WALLET_CORE","actions":["RECONCILIATION.WARNING_RAISED","RECONCILIATION.WARNING_CLEARED"],"sections":["before","after"],"key":"partial","equals":true}},
"currencyId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"ownerId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"ledgerJournalId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"priceResolutionId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"priceSnapshotId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"blockerId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"originalJournalId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"reversalJournalId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"depositId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"reconciliationRunId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"bulkJobId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"scheduledChangeId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"changelogId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"assignedUserId":{"family":"uuid","nullable":true,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},
"maintenancePinned":{"family":"boolean","nullable":false},
"showBalance":{"family":"boolean","nullable":false},
"active":{"family":"boolean","nullable":false},
"partial":{"family":"boolean","nullable":false},
"visible":{"family":"boolean","nullable":false},
"killed":{"family":"boolean","nullable":false},
"stored":{"family":"boolean","nullable":false},
"effectiveAt":{"family":"timestamp","nullable":true,"format":"CANONICAL_UTC_4_DIGIT","fractionalDigits":[0,3]},
"status":{
  "family":"context-enum","nullable":false,"valuesBySubject":{
    "SETTINGS_REVISION":["DRAFT","SCHEDULED","LIVE","ARCHIVED","REJECTED"],
    "DEPOSIT":["PENDING","HELD","SUCCESS","FAILED","REJECTED","CANCELLED","QUARANTINED","RETRY_PENDING"],
    "DEPOSIT_BLOCKER":["PENDING","RESOLVED","WAIVED"],
    "QUARANTINE":["OPEN","RETRY_PENDING","ASSIGNED","RETAINED","SETTLED"],
    "BULK_JOB":["PENDING","RUNNING","PAUSED","COMPLETED","COMPLETED_WITH_FAILURES","FAILED"],
    "BULK_JOB_ITEM":["PENDING","RUNNING","SUCCEEDED","FAILED"],
    "RECONCILIATION_RUN":["SUCCESS","PARTIAL","FAILED"]
  }
},
"desiredState":{"family":"enum","nullable":false,"values":["ON","OFF","MAINTAIN","UPCOMING"]},
"effectiveState":{"family":"enum","nullable":false,"values":["ON","OFF","MAINTAIN","UPCOMING"]},
"bucket":{"family":"enum","nullable":false,"values":["AVAILABLE","HOLD","OREBIT_TREASURY","OREBIT_COLLECTION"]},
"ownerType":{"family":"enum","nullable":false,"values":["USER","MERCHANT"]},
"priceBasis":{"family":"enum","nullable":false,"values":["WEBHOOK_TIME","ADMIN_CREDIT_TIME"]},
"kind":{"family":"enum","nullable":false,"values":["CRYPTO","FIAT"]},
"pricingStatus":{"family":"enum","nullable":false,"values":["ACTIVE","DISABLED"]},
"availableFor":{"family":"enum","nullable":false,"values":["USER","MERCHANT","BOTH"]},
"source":{"family":"enum","nullable":false,"values":["BLOCKCHAIN"]},
"sourceFormat":{"family":"enum","nullable":false,"values":["PNG","JPEG","WEBP","AVIF"]},
"mediaType":{"family":"enum","nullable":false,"values":["image/webp"]},
"actionKind":{
  "family":"enum","nullable":false,"values":[
    "RELEASE","REJECT","MAINTENANCE_RELEASE","MAINTENANCE_CANCEL","REVERIFICATION_HOLD",
    "CLAWBACK_TO_ZERO","CLAWBACK_NEGATIVE","WAIT_FOR_SETTLEMENT","SCHEDULED_STATE_TRANSITION"
  ]
},
"name":{"family":"text","nullable":false,"minLength":1,"maxLength":128,"trim":"ASCII"},
"shortName":{"family":"text","nullable":false,"minLength":1,"maxLength":64,"trim":"ASCII"},
"blockchainReference":{"family":"text","nullable":false,"minLength":1,"maxLength":160,"trim":"ASCII"},
"logoObjectKey":{"family":"text","nullable":false,"minLength":1,"maxLength":255,"trim":"ASCII"},
"timezone":{"family":"text","nullable":false,"minLength":1,"maxLength":64,"trim":"ASCII"},
"symbol":{"family":"text","nullable":false,"minLength":1,"maxLength":32,"trim":"ASCII"},
"providerReference":{"family":"text","nullable":false,"minLength":1,"maxLength":160,"trim":"ASCII"},
"blockerKind":{"family":"text","nullable":false,"minLength":1,"maxLength":64,"trim":"ASCII"},
"safeErrorCode":{"family":"text","nullable":false,"minLength":1,"maxLength":64,"trim":"ASCII"}
}
}
$admin_audit_contract$::jsonb;
  v_action_contract jsonb;
  v_validator jsonb;
  v_nullable_when jsonb;
  v_enum_values jsonb;
  v_before_keys text[];
  v_after_keys text[];
  v_required_keys text[];
  v_optional_keys text[];
  v_entry record;
  v_text text;
  v_timestamp timestamp;
BEGIN
  IF p_id IS NULL
    OR p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR v_event_key IS NULL OR v_event_key = '' OR length(v_event_key) > 200
    OR v_reason IS NULL OR v_reason = '' OR char_length(v_reason) > 500
    OR p_subject_type IS NULL OR p_subject_type !~ '^[A-Z][A-Z0-9_]{0,63}$'
    OR v_subject_id IS NULL OR v_subject_id = '' OR char_length(v_subject_id) > 128
    OR jsonb_typeof(v_before) <> 'object' OR jsonb_typeof(v_after) <> 'object'
    OR jsonb_typeof(v_metadata) <> 'object'
    OR octet_length(v_before::text) > 65536 OR octet_length(v_after::text) > 65536
    OR octet_length(v_metadata::text) > 65536
    OR EXISTS (SELECT 1 FROM jsonb_each(v_before) WHERE jsonb_typeof(value) IN ('array','object'))
    OR EXISTS (SELECT 1 FROM jsonb_each(v_after) WHERE jsonb_typeof(value) IN ('array','object'))
    OR EXISTS (SELECT 1 FROM jsonb_each(v_metadata) WHERE jsonb_typeof(value) IN ('array','object'))
    OR NOT (
      (p_actor_kind = 'ADMIN' AND p_actor_id IS NOT NULL AND p_session_id IS NOT NULL
        AND p_request_id IS NOT NULL AND p_run_id IS NULL AND p_ip_address IS NOT NULL
        AND v_device_id IS NOT NULL AND v_device_id <> '' AND char_length(v_device_id) <= 128)
      OR
      (p_actor_kind = 'SYSTEM' AND p_actor_id IS NULL AND p_session_id IS NULL
        AND p_request_id IS NULL AND p_run_id IS NOT NULL AND p_ip_address IS NULL
        AND p_device_id IS NULL)
    )
  THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate INTO v_action_contract
  FROM jsonb_array_elements(v_contract->'actions') AS candidate
  WHERE candidate->>'domain' = p_domain AND (candidate->'actions') ? p_action;

  IF v_action_contract IS NULL
    OR NOT ((v_action_contract->'subjects') ? p_subject_type)
    OR NOT ((v_action_contract->'actors') ? p_actor_kind) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_before_keys
  FROM jsonb_array_elements_text(v_action_contract->'before');
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_after_keys
  FROM jsonb_array_elements_text(v_action_contract->'after');
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_required_keys
  FROM jsonb_array_elements_text(v_action_contract->'requiredMetadata');
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_optional_keys
  FROM jsonb_array_elements_text(v_action_contract->'optionalMetadata');

  IF v_before - v_before_keys <> '{}'::jsonb
    OR v_after - v_after_keys <> '{}'::jsonb
    OR v_metadata - (v_required_keys || v_optional_keys) <> '{}'::jsonb
    OR NOT (v_metadata ?& v_required_keys) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_action_contract ? 'beforeStatuses' AND (
      NOT ((v_action_contract->'beforeStatuses') @> jsonb_build_array(v_before->'status'))
      OR (v_before->'status' IS NULL AND v_before <> '{}'::jsonb)
    ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_action_contract ? 'afterStatuses'
    AND NOT ((v_action_contract->'afterStatuses') @> jsonb_build_array(v_after->'status')) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_action_contract ? 'constraints' AND (
      ((v_action_contract #>> '{constraints,reason}') IS NOT NULL
        AND v_reason <> v_action_contract #>> '{constraints,reason}')
      OR NOT (v_before ?& ARRAY(SELECT jsonb_array_elements_text(
        COALESCE(v_action_contract #> '{constraints,requiredBefore}', '[]'::jsonb))))
      OR NOT (v_after ?& ARRAY(SELECT jsonb_array_elements_text(
        COALESCE(v_action_contract #> '{constraints,requiredAfter}', '[]'::jsonb))))
      OR NOT (v_before @> COALESCE(v_action_contract #> '{constraints,fixedBefore}', '{}'::jsonb))
      OR NOT (v_after @> COALESCE(v_action_contract #> '{constraints,fixedAfter}', '{}'::jsonb))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          COALESCE(v_action_contract #> '{constraints,equalAfter}', '[]'::jsonb)) AS pair
        WHERE v_after->(pair->>0) IS DISTINCT FROM v_after->(pair->>1)
      )
    ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  CASE p_subject_type
    WHEN 'SETTINGS_REVISION' THEN
      IF v_subject_id !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
    WHEN 'LOGO_ASSET' THEN
      IF v_subject_id !~ '^[0-9a-f]{64}\.webp$' THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
    WHEN 'PROVIDER_CATALOGUE' THEN
      IF v_subject_id <> 'BLOCKCHAIN' THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
    WHEN 'CURRENCY', 'CURRENCY_CHAIN' THEN
      IF v_subject_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_subject_id := lower(v_subject_id);
    WHEN 'ADMIN', 'CHAIN', 'RECONCILIATION_RUN', 'LEDGER_JOURNAL', 'DEPOSIT',
      'DEPOSIT_BLOCKER', 'QUARANTINE', 'FEATURE_STATE', 'BULK_JOB', 'BULK_JOB_ITEM' THEN
      IF v_subject_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_subject_id := lower(v_subject_id);
    ELSE RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END CASE;

  IF EXISTS (SELECT 1 FROM jsonb_each(v_metadata) WHERE value = 'null'::jsonb) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF (v_metadata ? 'priceBasis') <> (v_metadata ? 'priceResolutionId')
    OR (v_metadata ? 'priceBasis') <> (v_metadata ? 'priceSnapshotId') THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN
    SELECT 'before'::text AS source, key, value FROM jsonb_each(v_before)
    UNION ALL SELECT 'after', key, value FROM jsonb_each(v_after)
    UNION ALL SELECT 'metadata', key, value FROM jsonb_each(v_metadata)
  LOOP
    v_validator := v_contract #> ARRAY['validators', v_entry.key];
    IF v_validator IS NULL THEN
      RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF v_entry.value = 'null'::jsonb
      AND COALESCE((v_validator->>'nullable')::boolean, false) THEN
      v_nullable_when := v_validator->'nullableWhen';
      IF v_nullable_when IS NOT NULL AND (
        v_nullable_when->>'domain' <> p_domain
        OR NOT ((v_nullable_when->'actions') ? p_action)
        OR NOT ((v_nullable_when->'sections') ? v_entry.source)
        OR (
          CASE v_entry.source
            WHEN 'before' THEN v_before
            WHEN 'after' THEN v_after
            ELSE v_metadata
          END -> (v_nullable_when->>'key')
        ) IS DISTINCT FROM v_nullable_when->'equals'
      ) THEN
        RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
      END IF;
      CONTINUE;
    ELSIF v_entry.value = 'null'::jsonb THEN
      RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_text := v_entry.value #>> '{}';

    CASE v_validator->>'family'
      WHEN 'integer' THEN
        IF jsonb_typeof(v_entry.value) <> 'number'
          OR v_entry.value::text !~ '^(0|[1-9][0-9]*)$'
          OR (v_entry.value::text)::numeric < (v_validator->>'minimum')::numeric
          OR (v_entry.value::text)::numeric > (v_validator->>'maximum')::numeric THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      WHEN 'decimal' THEN
        IF jsonb_typeof(v_entry.value) <> 'string'
          OR v_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
          OR v_text::numeric < (v_validator->>'minimum')::numeric
          OR length(split_part(v_text, '.', 1)) > (v_validator->>'maxIntegerDigits')::integer
          OR (position('.' IN v_text) > 0
            AND length(split_part(v_text, '.', 2)) > (v_validator->>'maxFractionDigits')::integer) THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      WHEN 'boolean' THEN
        IF jsonb_typeof(v_entry.value) <> 'boolean' THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      WHEN 'uuid' THEN
        v_text := btrim(v_text, E' \t\n\r\f\v');
        IF jsonb_typeof(v_entry.value) <> 'string'
          OR v_validator->>'trim' <> 'ASCII'
          OR v_validator->>'normalize' <> 'lowercase'
          OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(v_validator->'versions') AS version
            WHERE version = substring(v_text FROM 15 FOR 1)
          ) THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
        v_text := lower(v_text);
      WHEN 'enum' THEN
        IF jsonb_typeof(v_entry.value) <> 'string' OR NOT ((v_validator->'values') ? v_text) THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      WHEN 'context-enum' THEN
        v_enum_values := v_validator #> ARRAY['valuesBySubject', p_subject_type];
        IF jsonb_typeof(v_entry.value) <> 'string'
          OR v_enum_values IS NULL OR NOT (v_enum_values ? v_text) THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      WHEN 'timestamp' THEN
        BEGIN
          IF v_validator->>'format' <> 'CANONICAL_UTC_4_DIGIT'
            OR v_validator->'fractionalDigits' <> '[0,3]'::jsonb
            OR jsonb_typeof(v_entry.value) <> 'string'
            OR v_text !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{3})?Z$' THEN
            RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
          END IF;
          v_timestamp := v_text::timestamptz AT TIME ZONE 'UTC';
          IF (CASE WHEN v_text LIKE '%.%'
              THEN to_char(v_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ELSE to_char(v_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            END) <> v_text THEN
            RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END;
      WHEN 'text' THEN
        v_text := btrim(v_text, E' \t\n\r\f\v');
        IF v_validator->>'trim' <> 'ASCII'
          OR jsonb_typeof(v_entry.value) <> 'string'
          OR length(v_text) < (v_validator->>'minLength')::integer
          OR length(v_text) > (v_validator->>'maxLength')::integer THEN
          RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
        END IF;
      ELSE RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
    END CASE;

    IF jsonb_typeof(v_entry.value) = 'string'
      AND (v_validator->>'trim' = 'ASCII' OR v_validator->>'normalize' = 'lowercase') THEN
      IF v_entry.source = 'before' THEN
        v_before := jsonb_set(v_before, ARRAY[v_entry.key], to_jsonb(v_text), false);
      ELSIF v_entry.source = 'after' THEN
        v_after := jsonb_set(v_after, ARRAY[v_entry.key], to_jsonb(v_text), false);
      ELSE
        v_metadata := jsonb_set(v_metadata, ARRAY[v_entry.key], to_jsonb(v_text), false);
      END IF;
    END IF;
  END LOOP;

  v_hash := encode(public.digest(convert_to(jsonb_build_object(
    'domain', p_domain, 'action', p_action, 'actorKind', p_actor_kind,
    'actorId', p_actor_id, 'runId', p_run_id,
    'subjectType', p_subject_type, 'subjectId', v_subject_id,
    'reason', v_reason,
    'before', CASE WHEN p_before_json IS NULL THEN NULL ELSE v_before END,
    'after', CASE WHEN p_after_json IS NULL THEN NULL ELSE v_after END,
    'metadata', v_metadata
  )::text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO admin.admin_audit_events (
    id, event_key, event_hash, domain, action, actor_kind, actor_id,
    session_id, request_id, run_id, ip_address, device_id,
    subject_type, subject_id, reason, before_json, after_json, metadata_json
  ) VALUES (
    p_id, v_event_key, v_hash, p_domain, p_action, p_actor_kind, p_actor_id,
    p_session_id, p_request_id, p_run_id, p_ip_address, v_device_id,
    p_subject_type, v_subject_id, v_reason,
    CASE WHEN p_before_json IS NULL THEN NULL ELSE v_before END,
    CASE WHEN p_after_json IS NULL THEN NULL ELSE v_after END,
    v_metadata
  ) ON CONFLICT (event_key) DO NOTHING RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT v_inserted_id, false;
    RETURN;
  END IF;

  SELECT id, event_hash INTO v_existing_id, v_existing_hash
  FROM admin.admin_audit_events WHERE event_key = v_event_key;
  IF v_existing_id IS NULL OR v_existing_hash <> v_hash THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_EVENT_KEY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_existing_id, true;
END;
$function$;

ALTER TABLE admin.admin_audit_events OWNER TO orebit_admin_audit_owner;
ALTER FUNCTION admin.reject_admin_audit_row_mutation_v1() OWNER TO orebit_admin_audit_owner;
ALTER FUNCTION admin.reject_admin_audit_truncate_v1() OWNER TO orebit_admin_audit_owner;
ALTER FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
) OWNER TO orebit_admin_audit_owner;

REVOKE ALL ON admin.admin_audit_events FROM PUBLIC;
REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_writer;
REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_reader;
GRANT USAGE ON SCHEMA admin
  TO orebit_admin_audit_owner, orebit_admin_audit_writer, orebit_admin_audit_reader;
GRANT SELECT ON admin.admin_audit_events TO orebit_admin_audit_reader;
GRANT USAGE ON SCHEMA public TO orebit_admin_audit_owner;
GRANT EXECUTE ON FUNCTION public.digest(bytea, text) TO orebit_admin_audit_owner;

REVOKE ALL ON FUNCTION admin.reject_admin_audit_row_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.reject_admin_audit_truncate_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
) TO orebit_admin_audit_writer;

COMMIT;
