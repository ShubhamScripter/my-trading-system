BEGIN;

CREATE TYPE price_conversion."PriceConfigChangeStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED');
CREATE TABLE price_conversion.price_admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID, session_id VARCHAR(128), request_id UUID, ip_address INET, device_id VARCHAR(128),
  action VARCHAR(64) NOT NULL, reason VARCHAR(500) NOT NULL, before_json JSONB NOT NULL DEFAULT '{}'::jsonb, after_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_admin_audit_created ON price_conversion.price_admin_audit (created_at DESC, id DESC);
CREATE TABLE price_conversion.price_config_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), revision BIGINT NOT NULL, status price_conversion."PriceConfigChangeStatus" NOT NULL DEFAULT 'DRAFT',
  effective_at TIMESTAMPTZ, changelog VARCHAR(1000) NOT NULL, actor_id UUID, config JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_at TIMESTAMPTZ,
  UNIQUE (revision), CHECK ((status <> 'SCHEDULED') OR effective_at IS NOT NULL)
);
CREATE INDEX price_config_changes_due ON price_conversion.price_config_changes (status, effective_at) WHERE status = 'SCHEDULED';
CREATE FUNCTION price_conversion.reject_price_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'price admin audit rows are append-only'; END; $$;
CREATE TRIGGER price_admin_audit_append_only BEFORE UPDATE OR DELETE ON price_conversion.price_admin_audit FOR EACH ROW EXECUTE FUNCTION price_conversion.reject_price_audit_mutation();

COMMIT;
