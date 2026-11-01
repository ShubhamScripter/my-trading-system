BEGIN;

-- Reference mutation must preserve the same final-state invariant as currency activation.
CREATE FUNCTION price_conversion.require_active_crypto_ref_after_mutation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
DECLARE
  old_currency_id UUID;
  new_currency_id UUID;
  affected_currency_id UUID;
BEGIN
  old_currency_id := OLD.currency_id;
  IF TG_OP = 'UPDATE' THEN
    new_currency_id := NEW.currency_id;
  END IF;

  FOR affected_currency_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[old_currency_id, new_currency_id]) AS ids(id)
    WHERE id IS NOT NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM price_conversion.currencies c
      WHERE c.id = affected_currency_id AND c.kind = 'CRYPTO' AND c.status = 'ACTIVE'
    ) AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs r
      WHERE r.currency_id = affected_currency_id AND r.active
    ) THEN
      RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_ref_after_mutation() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER currency_provider_refs_active_crypto_guard
  AFTER UPDATE OR DELETE ON price_conversion.currency_provider_refs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION price_conversion.require_active_crypto_ref_after_mutation();

COMMIT;
