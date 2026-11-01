import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walletCorePatchSchema } from '../wallet-core.dto.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import { DEFAULT_WALLET_SETTINGS, type WalletCoreConfigurationPatch } from '../wallet-core.types.js';

const patch = (basis?: string) => ({
  action: 'PUSH', expectedRevision: 0,
  reason: 'Choose reconciliation alert basis.',
  config: { settings: { ...DEFAULT_WALLET_SETTINGS, reconciliationAlertBasis: basis } },
});

test('accepts the two global reconciliation alert bases and rejects unknown values', () => {
  for (const basis of ['SIGNED', 'POSITIVE_ONLY']) {
    assert.equal(walletCorePatchSchema.safeParse(patch(basis)).success, true);
  }
  for (const basis of ['signed', 'NET_OWNER', '', 'UNKNOWN']) {
    assert.equal(walletCorePatchSchema.safeParse(patch(basis)).success, false);
  }
});

test('allows an omitted basis so saved and scheduled snapshots preserve the current setting', () => {
  const input = patch();
  delete input.config.settings.reconciliationAlertBasis;
  const parsed = walletCorePatchSchema.safeParse(input);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.config?.settings?.reconciliationAlertBasis, undefined);
  assert.equal(DEFAULT_WALLET_SETTINGS.reconciliationAlertBasis, 'SIGNED');
});

test('applies an optional basis with database COALESCE semantics', async () => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const client = { query: async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values }); return { rows: [], rowCount: 1 };
  } };
  const repository = new WalletCoreRepository({
    schemas: { wallet: 'wallet_core_test', price: 'price_conversion_test' },
  } as never);
  const { reconciliationAlertBasis: _, ...legacySettings } = DEFAULT_WALLET_SETTINGS;
  await repository.applySettings(client as never, legacySettings);
  await repository.applySettings(client as never, DEFAULT_WALLET_SETTINGS);
  const updates = calls.filter((call) => call.sql.includes('UPDATE wallet_core_test.wallet_settings'));
  assert.match(updates[0]!.sql,
    /reconciliation_alert_basis=COALESCE\(\$6::wallet_core_test\."WalletReconciliationAlertBasis",reconciliation_alert_basis\)/);
  assert.equal(updates[0]!.values[5], null);
  assert.equal(updates[1]!.values[5], 'SIGNED');
});

async function runCurrencyReplacement() {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const client = { query: async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (/SELECT id::text,is_evm FROM/.test(sql)) return { rows: [{
      id: '01990000-0000-7000-8000-000000000003', is_evm: true,
    }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const repository = new WalletCoreRepository({
    schemas: { wallet: 'wallet_core_test', price: 'price_conversion_test' },
  } as never);
  const bindingId = '01990000-0000-7000-8000-000000000002';
  const config = { currencies: [{
    id: '01990000-0000-7000-8000-000000000001', symbol: 'BTC', name: 'Bitcoin',
    providerRefs: [], logoObjectKey: undefined, viewEnabled: true, geoCountryDeny: [],
    geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH', listingKind: 'PERMANENT',
    showBeforeListing: false, premiumOperations: [], soOperations: [], postDelistOperations: [],
    desiredState: 'OFF', maintenanceAudiences: [],
    showBalanceInMaintenance: { USER: true, SO: true },
    bindings: [{ id: bindingId, chainId: '01990000-0000-7000-8000-000000000003',
      providerCoinId: 1, blockchainReference: 'Bitcoin', isToken: false,
      blockchainPrecision: 18, desiredState: 'OFF',
      hotWalletAddresses: ['0xAbC'], coldWalletAddresses: [], stakingWalletAddresses: [] }],
  }] } satisfies WalletCoreConfigurationPatch;
  await repository.applyConfiguration(client as never, config, 7, { chains: [], currencies: [{
    providerChainId: 1, providerCoinId: 1, revision: 1, currencyName: 'Bitcoin',
    blockchainPrecision: 18, tokenAddress: null, isBaseCurrency: true, isStake: true,
    providerState: 'ACTIVATED',
  }] });
  return { calls, bindingId };
}

test('currency replacement leaves Price view ownership alone', async () => {
  const { calls } = await runCurrencyReplacement();
  const priceWrite = calls.find((call) => /INSERT INTO price_conversion_test\.currencies/.test(call.sql));
  assert.ok(priceWrite); assert.doesNotMatch(priceWrite.sql, /viewable/i);
});

test('currency replacement retires prior custody membership at the applied revision', async () => {
  const { calls, bindingId } = await runCurrencyReplacement();
  const retirement = calls.find((call) => /UPDATE wallet_core_test\.custody_addresses/.test(call.sql));
  const addressInsert = calls.find((call) => /INSERT INTO wallet_core_test\.custody_addresses/.test(call.sql));
  assert.ok(retirement); assert.deepEqual(retirement.values, [bindingId, 7]);
  assert.doesNotMatch(calls.map((call) => call.sql).join('\n'),
    /DELETE FROM wallet_core_test\.custody_addresses/);
  assert.ok(addressInsert); assert.match(addressInsert.sql, /created_revision/);
  assert.equal(addressInsert.values.at(-1), 7);
});
