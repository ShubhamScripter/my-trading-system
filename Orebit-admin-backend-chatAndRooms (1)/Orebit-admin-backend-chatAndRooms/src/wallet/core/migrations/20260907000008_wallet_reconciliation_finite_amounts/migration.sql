BEGIN;
DO $finite_amounts$
DECLARE target RECORD; expression TEXT; existing RECORD;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    (pg_typeof(NULL::wallet_core.wallet_reconciliation_items)::text::regclass,
      'wallet_reconciliation_items_finite_amounts',
      'hot_cold_balance, staking_balance, binance_balance, total_custody_balance, required_backing, user_merchant_balance, treasury_balance, collection_balance, shortfall_percent, applied_reconciliation_alert_percent, price_usd, ledger_signed_total, ledger_positive_total'),
    (pg_typeof(NULL::wallet_core.wallet_reconciliation_components)::text::regclass,
      'wallet_reconciliation_components_finite_amounts',
      'selected_balance, total_admin_stake_balance, total_admin_manual_stake_balance, total_balance')
  ) AS targets(relation_oid, constraint_name, fields) LOOP
    -- NUMERIC typmods reject infinities, but NaN compares above zero and equals itself.
    -- NULL provider/price fields remain legal; one NaN makes this predicate false.
    expression := format('(''NaN''::numeric <> ALL (ARRAY[%s]))', target.fields);
    SELECT contype, convalidated, pg_get_expr(conbin, conrelid) AS expression INTO existing
      FROM pg_constraint WHERE conrelid=target.relation_oid AND conname=target.constraint_name;
    IF FOUND THEN
      IF existing.contype<>'c' OR NOT existing.convalidated OR existing.expression<>expression THEN
        RAISE EXCEPTION 'wallet finite amount constraint contract changed';
      END IF;
    ELSE
      -- Validate existing evidence; any malformed historical row aborts without rewriting it.
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)',
        target.relation_oid, target.constraint_name, expression);
    END IF;
  END LOOP;
END;
$finite_amounts$;
COMMIT;
