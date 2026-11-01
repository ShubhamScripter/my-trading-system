BEGIN;

-- On a clean install the Pricing capability role is created by Wallet contract03,
-- after Audit migrations. Restore only its existing checked append helper access here.
GRANT USAGE ON SCHEMA admin TO orebit_price_conversion_writer;
GRANT EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)
  TO orebit_price_conversion_writer;

COMMIT;
