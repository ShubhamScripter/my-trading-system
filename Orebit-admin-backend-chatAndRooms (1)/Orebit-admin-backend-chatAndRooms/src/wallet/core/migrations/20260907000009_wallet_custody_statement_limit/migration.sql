BEGIN;
SET LOCAL search_path=pg_catalog;
DO $row_guard$
DECLARE definition TEXT;
  original CONSTANT TEXT := $old$  SELECT count(*) INTO amount FROM wallet_core.custody_addresses existing
    WHERE existing.currency_chain_id=NEW.currency_chain_id AND existing.kind=NEW.kind AND existing.retired_at IS NULL;
  IF amount>=10000 THEN RAISE EXCEPTION 'custody address kind limit exceeded'; END IF;
$old$;
  entry CONSTANT TEXT := E'BEGIN\n  SELECT binding.is_token';
  locked CONSTANT TEXT := $locked$BEGIN
  IF TG_OP='INSERT' THEN
    -- Match Admin's binding-before-address lock order without changing retirement locking.
    PERFORM 1 FROM wallet_core.currencies binding WHERE binding.id=NEW.currency_chain_id FOR NO KEY UPDATE;
  END IF;
  SELECT binding.is_token$locked$;
BEGIN
  SELECT pg_get_functiondef(procedure.oid) INTO STRICT definition FROM pg_proc procedure
    WHERE procedure.proname='guard_custody_address' AND procedure.pronargs=0
      AND procedure.pronamespace=(SELECT typnamespace FROM pg_type
        WHERE oid=pg_typeof(NULL::wallet_core.custody_addresses)::oid);
  IF strpos(definition,locked)>0 AND strpos(definition,'SELECT count(*) INTO amount')=0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,original,'')))<>length(original)
    OR (length(definition)-length(replace(definition,entry,'')))<>length(entry)
    OR strpos(definition,locked)>0 THEN RAISE EXCEPTION 'custody row guard contract changed'; END IF;
  EXECUTE replace(replace(replace(definition,original,''),entry,locked),'; amount BIGINT;', ';');
END;
$row_guard$;

-- Transition rows make the cap one aggregate per binding/kind, rather than one per inserted row.
CREATE OR REPLACE FUNCTION wallet_core.guard_custody_address_statement_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,wallet_core AS $$
DECLARE binding_id UUID; membership RECORD; amount BIGINT;
BEGIN
  FOR binding_id IN SELECT DISTINCT currency_chain_id FROM inserted_custody_addresses ORDER BY currency_chain_id LOOP
    -- Row locks alone do not invalidate an old REPEATABLE READ snapshot. One physical version
    -- per affected binding makes a stale competing writer fail serialization without changing data.
    UPDATE wallet_core.currencies binding SET id=binding.id WHERE binding.id=binding_id;
  END LOOP;
  FOR membership IN SELECT DISTINCT currency_chain_id,kind FROM inserted_custody_addresses ORDER BY currency_chain_id,kind LOOP
    SELECT count(*) INTO amount FROM wallet_core.custody_addresses address
      WHERE address.currency_chain_id=membership.currency_chain_id AND address.kind=membership.kind AND address.retired_at IS NULL;
    IF amount>10000 THEN RAISE EXCEPTION 'custody address kind limit exceeded' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wallet_core.guard_custody_address_statement_limit() FROM PUBLIC;
DROP TRIGGER IF EXISTS custody_addresses_statement_limit ON wallet_core.custody_addresses;
CREATE TRIGGER custody_addresses_statement_limit AFTER INSERT ON wallet_core.custody_addresses
REFERENCING NEW TABLE AS inserted_custody_addresses FOR EACH STATEMENT
EXECUTE FUNCTION wallet_core.guard_custody_address_statement_limit();

DO $liquid_identity$
DECLARE relation_oid REGCLASS:=pg_typeof(NULL::wallet_core.custody_addresses)::text::regclass;
  index_oid OID; expected_predicate TEXT; actual RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_core.custody_addresses WHERE retired_at IS NULL
    GROUP BY currency_chain_id,kind HAVING count(*)>10000) THEN
    RAISE EXCEPTION 'existing custody address kind limit exceeded' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM wallet_core.custody_addresses WHERE retired_at IS NULL AND kind IN ('HOT','COLD')
    GROUP BY currency_chain_id,address_identity HAVING count(*)>1) THEN
    RAISE EXCEPTION 'existing custody HOT/COLD identity overlap' USING ERRCODE='23514';
  END IF;
  SELECT index.oid INTO index_oid FROM pg_class index JOIN pg_class relation ON relation.oid=relation_oid
    WHERE index.relnamespace=relation.relnamespace AND index.relname='custody_addresses_active_liquid_identity';
  expected_predicate:=format('((retired_at IS NULL) AND (kind = ANY (ARRAY[''HOT''::%s, ''COLD''::%s])))',
    pg_typeof(NULL::wallet_core."WalletAddressKind"),pg_typeof(NULL::wallet_core."WalletAddressKind"));
  IF index_oid IS NOT NULL THEN
    SELECT index.indisunique,index.indisvalid,index.indisready,index.indrelid,index.indnatts,index.indnkeyatts,
      index.indexprs,pg_get_expr(index.indpred,index.indrelid) predicate,
      pg_get_indexdef(index.indexrelid,1,true) first_key,pg_get_indexdef(index.indexrelid,2,true) second_key,
      access.amname INTO actual FROM pg_index index JOIN pg_class relation ON relation.oid=index.indexrelid
      JOIN pg_am access ON access.oid=relation.relam WHERE index.indexrelid=index_oid;
    IF NOT FOUND OR NOT actual.indisunique OR NOT actual.indisvalid OR NOT actual.indisready
      OR actual.indrelid<>relation_oid OR actual.indnatts<>2 OR actual.indnkeyatts<>2 OR actual.indexprs IS NOT NULL
      OR actual.predicate IS DISTINCT FROM expected_predicate OR actual.first_key<>'currency_chain_id'
      OR actual.second_key<>'address_identity' OR actual.amname<>'btree' THEN
      RAISE EXCEPTION 'custody liquid identity index contract changed';
    END IF;
  ELSE
    EXECUTE format('CREATE UNIQUE INDEX custody_addresses_active_liquid_identity ON %s (currency_chain_id,address_identity)
      WHERE retired_at IS NULL AND kind IN (''HOT'',''COLD'')',relation_oid);
  END IF;
END;
$liquid_identity$;
COMMIT;
