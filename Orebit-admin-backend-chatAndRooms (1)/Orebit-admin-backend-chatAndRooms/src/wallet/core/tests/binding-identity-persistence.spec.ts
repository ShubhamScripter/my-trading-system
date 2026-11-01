import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyWalletCurrencyConfiguration } from '../wallet-core.currency-configuration.js';
import type { WalletCoreClient } from '../wallet-core.database.js';

test('OFF binding identity persistence writes every permitted identity field', async () => {
  let bindingUpsert = '';
  const client = { release() {}, async query(sql: string) {
    if (sql.includes('SELECT master.symbol')) return { rows: [{ symbol: 'COIN', name: 'Coin',
      kind: 'CRYPTO', pricing_status: 'ACTIVE', desired_state: 'OFF',
      binance_reference: null, logo_object_key: null, view_currency_enabled: false,
      geo_countries: [], geo_continents: [], access_level: 'ALL', available_for: 'BOTH',
      listing_kind: 'PERMANENT', listing_start_at: null, delist_at: null,
      show_before_listing: false, premium_early_access_at: null,
      premium_early_access_ops: [], so_early_access_at: null, so_early_access_ops: [],
      maintain_users: false, maintain_so: false, show_balance_users: true,
      show_balance_so: true, post_delist_ops: [], after_delist_mode: null,
      auto_exchange_to_currency_id: null, auto_exchange_fee_bps: null, leave_days: null,
      after_leave_action: null, after_leave_to_currency_id: null, after_leave_fee_bps: null,
    }], rowCount: 1 };
    if (sql.includes('currency_provider_refs reference')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT currency_id::text,chain_id::text')) return { rows: [{
      currency_id: '01980000-0000-7000-8000-000000000001',
      chain_id: '01980000-0000-7000-8000-000000000002', provider_coin_id: 1,
      blockchain_reference: 'old-token', is_token: true, is_native: false,
      token_contract_address: '0xold', blockchain_precision: 18,
      desired_state: 'OFF', provider_state: 'ACTIVATED',
    }], rowCount: 1 };
    if (sql.includes('INSERT INTO wallet_core_test.currencies')) bindingUpsert = sql;
    if (sql.includes('SELECT kind::text,wallet_address')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  } } as WalletCoreClient;
  await applyWalletCurrencyConfiguration(client, {
    id: '01980000-0000-7000-8000-000000000001', symbol: 'COIN', name: 'Coin',
    providerRefs: [], viewEnabled: false, geoCountryDeny: [], geoContinentDeny: [],
    accessLevel: 'ALL', availableFor: 'BOTH', listingKind: 'PERMANENT',
    showBeforeListing: false, premiumOperations: [], soOperations: [],
    postDelistOperations: [], desiredState: 'OFF', maintenanceAudiences: [],
    showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{
      id: '01980000-0000-7000-8000-000000000003',
      chainId: '01980000-0000-7000-8000-000000000002', providerCoinId: 2,
      blockchainReference: 'new-native', isToken: false, blockchainPrecision: 8,
      desiredState: 'OFF', hotWalletAddresses: [], coldWalletAddresses: [],
      stakingWalletAddresses: [],
    }],
  }, 8, [{ providerChainId: 1, providerCoinId: 2, currencyName: 'New Native',
    tokenAddress: null, isBaseCurrency: true, isStake: true, blockchainPrecision: 8,
    providerState: 'ACTIVATED', revision: 3 }],
  new Map([['01980000-0000-7000-8000-000000000002', true]]), {
    wallet: 'wallet_core_test', price: 'price_conversion_test', ledger: 'ledger_test',
    admin: 'admin_test',
  });

  assert.match(bindingUpsert, /DO UPDATE SET[\s\S]*provider_coin_id=EXCLUDED\.provider_coin_id/);
  assert.match(bindingUpsert, /is_token=EXCLUDED\.is_token/);
  assert.match(bindingUpsert, /is_native=EXCLUDED\.is_native/);
  assert.match(bindingUpsert, /token_contract_address=EXCLUDED\.token_contract_address/);
});
