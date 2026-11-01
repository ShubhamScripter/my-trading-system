BEGIN;

CREATE FUNCTION price_conversion.enforce_sensitive_crypto_currency() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM price_conversion.currencies c
    WHERE c.id = NEW.currency_id AND c.kind = 'CRYPTO'
  ) THEN
    RAISE EXCEPTION 'sensitive price rows require a CRYPTO currency';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION price_conversion.enforce_sensitive_crypto_currency() FROM PUBLIC;

CREATE TRIGGER aa_price_snapshots_crypto_only
  BEFORE INSERT OR UPDATE ON price_conversion.price_snapshots
  FOR EACH ROW EXECUTE FUNCTION price_conversion.enforce_sensitive_crypto_currency();

CREATE TRIGGER aa_price_resolutions_crypto_only
  BEFORE INSERT OR UPDATE ON price_conversion.price_resolutions
  FOR EACH ROW EXECUTE FUNCTION price_conversion.enforce_sensitive_crypto_currency();

COMMIT;
