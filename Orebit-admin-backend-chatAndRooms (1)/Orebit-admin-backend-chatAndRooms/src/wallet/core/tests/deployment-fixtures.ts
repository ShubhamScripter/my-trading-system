import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {createReconciliationCurrencyFixture,captureReconciliationFixture,
  isolateReconciliationConfiguration} from './reconciliation-price-fixture.js';
export const TABLES = [
  'admin_preferences', 'chains', 'configuration_changes', 'cronjob_runs',
  'currencies', 'currency_settings', 'custody_addresses', 'delisting_executions',
  'legacy_currency_chain_codes', 'provider_catalogue_chains',
  'provider_catalogue_currencies', 'state_events', 'user_preferences',
  'wallet_alert_events', 'wallet_alerts', 'wallet_logo_asset_references',
  'wallet_logo_assets', 'wallet_notification_outbox',
  'wallet_reconciliation_attempts', 'wallet_reconciliation_components',
  'wallet_reconciliation_items', 'wallet_reconciliation_runs', 'wallet_settings',
] as const;
export const SAFE_ERRORS = ['ENCRYPTION_FAILED','AUTHENTICATION_FAILED','UNAUTHORIZED_IP',
  'PROVIDER_MAINTENANCE','PROVIDER_DISABLED','PROVIDER_NOT_FOUND','PROVIDER_REJECTED',
  'TIMEOUT','TRANSPORT_ERROR','RESPONSE_TOO_LARGE','INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE'] as const;
export const INDEX_MANIFEST: Readonly<Record<string, string>> = {
  chains_provider_state_idx: 'provider_state, id', currency_settings_state_idx: 'desired_state, price_readiness, currency_id',
  currency_settings_listing_due_idx: 'listing_start_at, currency_id', currency_settings_delist_due_idx: 'delist_at, currency_id',
  currencies_binding_read_idx: 'currency_id, chain_id, id',
  custody_addresses_binding_kind_idx: 'currency_chain_id, kind, address_identity, id', wallet_reconciliation_runs_cursor_idx: 'created_at DESC, id DESC',
  wallet_reconciliation_items_currency_cursor_idx: 'currency_id, created_at DESC, id DESC', wallet_reconciliation_components_item_idx: 'run_item_id, kind, id',
  wallet_reconciliation_attempts_component_idx: 'component_id, attempt_ordinal', wallet_alerts_status_idx: 'status, category, currency_id',
  wallet_notification_outbox_pending_idx: 'status, next_attempt_at, created_at, id', cronjob_runs_status_idx: 'job_name, status, scheduled_for', cronjob_runs_reclaim_idx: 'job_name, status, lease_expires_at, scheduled_for, id',
  delisting_executions_status_idx: 'status, deadline, id', configuration_changes_schedule_idx: 'status, effective_at',
};

export async function insertFailedStakingComponent(client: pg.PoolClient): Promise<string> {
  const currencyId = await createReconciliationCurrencyFixture(client);
  const chainId = randomUUID();
  const bindingId = randomUUID();
  const addressId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const componentId = randomUUID();
  const providerId = String(BigInt(Date.now()) * 1000n + BigInt(process.pid) + 1n);
  const shortName = `S${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
  await client.query(`INSERT INTO wallet_core_test.chains
    (id,provider_chain_id,short_name,name,is_evm) VALUES ($1,$2,$3,'Stake test',false)`,
  [chainId, providerId, shortName]);
  await client.query(`INSERT INTO wallet_core_test.currencies
    (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
    VALUES ($1,$2,$3,$4,false,true,18)`, [bindingId, currencyId, chainId, providerId]);
  await client.query(`INSERT INTO wallet_core_test.custody_addresses
    (id,currency_chain_id,kind,wallet_address,address_identity)
    VALUES ($1,$2,'STAKING','StakeAddress','StakeAddress')`, [addressId, bindingId]);
  await isolateReconciliationConfiguration(client, [currencyId]);
  await captureReconciliationFixture(client,runId,currencyId,null);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
    (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
     total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
     collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
     applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
     ledger_signed_total,ledger_positive_total,applied_reconciliation_alert_basis)
    VALUES ($1,$2,$3,'PARTIAL',0,0,0,0,0,0,0,0,
      ARRAY['TIMEOUT','PRICE_UNAVAILABLE'],true,NULL,
      5,0,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',0,0,'SIGNED')`, [itemId, runId, currencyId]);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
    (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,safe_error_code)
    VALUES ($1,$2,'STAKING',$3,$4,1,'TIMEOUT')`, [componentId, itemId, bindingId, addressId]);
  return componentId;
}
