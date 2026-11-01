/** Aggregates per-kind probe success so Admin can distinguish complete from partial evidence. */
export const reconciliationComponentCountSql = (wallet: string): string => `
  SELECT component.run_item_id::text,component.kind::text,count(*)::text total,
    (count(*) FILTER(WHERE component.selected_balance IS NOT NULL))::text succeeded
  FROM ${wallet}.wallet_reconciliation_components component
  WHERE component.run_item_id=ANY($1::uuid[])
  GROUP BY component.run_item_id,component.kind
  ORDER BY component.run_item_id,component.kind`;

/** Selects only failed or mismatched probes that need operator attention. */
export const reconciliationAnomalySql = (wallet: string): string => `
  SELECT component.id::text,component.run_item_id::text,component.kind::text,
    component.currency_chain_id::text,component.custody_address_id::text,
    component.wallet_address,component.binance_reference,component.attempts_used,
    component.accepted_raw_decimal,component.selected_balance::text,component.safe_error_code::text,
    component.total_admin_stake_balance::text,component.total_admin_manual_stake_balance::text,
    component.total_balance::text,component.stake_selected_source::text,component.stake_total_mismatch
  FROM ${wallet}.wallet_reconciliation_components component
  WHERE component.run_item_id=ANY($1::uuid[]) AND (component.selected_balance IS NULL
    OR component.stake_total_mismatch)
  ORDER BY component.run_item_id,component.kind,component.id`;
