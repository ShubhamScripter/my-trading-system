import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';

import { WALLET_CORE_TEST_SCHEMAS, WalletCoreDatabase,
  type WalletCoreClient, type WalletCorePool } from '../wallet-core.database.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';

type Row = Record<string, unknown>;
type Counts = { filter: number; find: number };
const viewer = { adminId: '550e8400-e29b-41d4-a716-446655440400' };
const instant = '2026-09-07T00:00:00.000000Z';
const uuid = (value: number) => `019f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;

function observed(rows: Row[], counts: Counts): Row[] {
  return new Proxy(rows, { get(target, property, receiver) {
    if (property === 'filter') return (predicate: (row: Row, index: number, array: Row[]) => boolean) =>
      Array.prototype.filter.call(target, (row: Row, index: number, array: Row[]) => {
        counts.filter += 1; return predicate(row, index, array);
      });
    if (property === 'find') return (predicate: (row: Row, index: number, array: Row[]) => boolean) =>
      Array.prototype.find.call(target, (row: Row, index: number, array: Row[]) => {
        counts.find += 1; return predicate(row, index, array);
      });
    return Reflect.get(target, property, receiver);
  } });
}

function fixture(bindingCount: number, addressCount: number) {
  const queryCount = { value: 0 };
  const counts = { addresses: { filter: 0, find: 0 }, bindings: { filter: 0, find: 0 },
    chains: { filter: 0, find: 0 }, addressReads: { bindingId: 0, kind: 0 } };
  const currencyId = uuid(1);
  const chains = observed(Array.from({ length: bindingCount }, (_, index) => ({ id: uuid(100 + index),
    provider_chain_id: String(index), blockchain_reference: `chain-${index}`,
    short_name: `C${index}`, name: `Chain ${index}`, is_evm: true,
    logo_object_key: null, available_for: 'BOTH', desired_state: 'ON', maintenance_pinned: false,
    provider_state: 'ACTIVATED', consecutive_failed_checks: 0, last_success_at: null,
    last_error_at: null, provider_updated_at: null })), counts.chains);
  const bindings = observed(Array.from({ length: bindingCount }, (_, index) => ({ id: uuid(1_000 + index),
    currency_id: currencyId, chain_id: uuid(100 + index), short_name: `C${index}`,
    provider_coin_id: String(index), blockchain_reference: `coin-${index}`,
    is_token: false, token_contract_address: null,
    blockchain_precision: 18, desired_state: 'ON', maintenance_pinned: false,
    provider_state: 'ACTIVATED', consecutive_failed_checks: 0, last_success_at: null,
    last_error_at: null, provider_updated_at: null })), counts.bindings);
  const addresses = observed(Array.from({ length: addressCount }, (_, index) => new Proxy({
    currency_chain_id: uuid(1_000 + index % bindingCount), kind: ['HOT', 'COLD', 'STAKING'][index % 3],
    wallet_address: `address-${index}` }, { get(target, property, receiver) {
    if (property === 'currency_chain_id') counts.addressReads.bindingId += 1;
    if (property === 'kind') counts.addressReads.kind += 1;
    return Reflect.get(target, property, receiver);
  } })), counts.addresses);
  const currency = { id: currencyId, symbol: 'BTC', name: 'Bitcoin', decimals: 18, kind: 'CRYPTO',
    pricing_status: 'ACTIVE', auto_disabled: false, desired_state: 'ON', price_readiness: 'HEALTHY',
    listing_state: 'LISTED', completed_delist: false, logo_object_key: null, view_currency_enabled: false,
    geo_countries: [], geo_continents: [], access_level: 'ALL', available_for: 'BOTH',
    listing_kind: 'PERMANENT', listing_start_at: null, show_before_listing: false,
    premium_early_access_at: null, premium_early_access_ops: [], so_early_access_at: null,
    so_early_access_ops: [], delist_at: null, after_delist_mode: null,
    auto_exchange_to_currency_id: null, auto_exchange_fee_bps: null, leave_days: null,
    after_leave_action: null, after_leave_to_currency_id: null, after_leave_fee_bps: null,
    post_delist_ops: [], maintain_users: false, maintain_so: false, show_balance_users: true,
    show_balance_so: true, price_readiness_changed_at: null, binance_reference: null };
  const client: WalletCoreClient = { release() {}, async query<RowType extends Row>(sql: string) {
    queryCount.value += 1;
    let rows: Row[] = [];
    if (sql.includes('.wallet_settings WHERE')) rows = [{ revision: '1', global_desired_state: 'ON',
      catalogue_mode: 'ALL', include_treasury: true, include_collection: true,
      reconciliation_alert_percent: '5.000', reconciliation_alert_basis: 'SIGNED',
      default_currency_ids: [], updated_at: instant }];
    else if (sql.includes('.chains ORDER BY')) rows = chains;
    else if (sql.includes('master.decimals')) rows = [currency];
    else if (sql.includes('currency_provider_refs')) rows = [];
    else if (sql.includes('.currencies binding JOIN')) rows = bindings;
    else if (sql.includes('.custody_addresses WHERE')) rows = addresses;
    return { rows: rows as RowType[], rowCount: rows.length };
  } };
  const pool: WalletCorePool = { async connect() { return client; }, async end() {} };
  const repository = new WalletCoreBootstrapRepository(
    WalletCoreDatabase.validatedTest(pool, WALLET_CORE_TEST_SCHEMAS),
    { publicUrl(objectKey: string) { return `https://assets.invalid/${objectKey}`; } });
  return { repository, counts, queryCount };
}

it('maps bootstrap children with work linear in bindings plus addresses', async (context) => {
  const representative = fixture(1, 3);
  const representativeResult = await representative.repository.bootstrap({ limit: 1 }, viewer);
  assert.deepEqual(representativeResult.currencies.items[0]?.bindings[0], {
    id: uuid(1_000), chainId: uuid(100), chainShortName: 'C0', providerCoinId: '0',
    blockchainReference: 'coin-0',
    isToken: false, tokenContractAddress: null, blockchainPrecision: 18, desiredState: 'ON',
    effectiveState: 'ON', maintenancePinned: false, provider: { state: 'ACTIVATED',
      consecutiveFailedChecks: 0, lastSuccessAt: null, lastErrorAt: null, updatedAt: null },
    hotWalletAddresses: ['address-0'], coldWalletAddresses: ['address-1'],
    stakingWalletAddresses: ['address-2'],
  });
  assert.equal(representative.queryCount.value, 14);

  const samples: Array<{ bindingCount: number; totalAddresses: number; addressRowReads: number }> = [];
  for (const [bindingCount, totalAddresses] of [[10, 1_000], [100, 10_000], [1_000, 100_000]] as const) {
    const { repository, counts, queryCount } = fixture(bindingCount, totalAddresses);
    const started = performance.now();
    const result = await repository.bootstrap({ limit: 1 }, viewer);
    const elapsedMs = performance.now() - started;
    assert.equal(result.currencies.items[0]?.bindings.length, bindingCount);
    const addressRowReads = counts.addressReads.bindingId + counts.addressReads.kind;
    context.diagnostic(JSON.stringify({ bindingCount, totalAddresses, elapsedMs,
      addressesPerBinding: totalAddresses / bindingCount, sqlCalls: queryCount.value,
      addressBindingIdReads: counts.addressReads.bindingId, addressKindReads: counts.addressReads.kind,
      addressRowReads }));
    assert.equal(queryCount.value, 14);
    samples.push({ bindingCount, totalAddresses, addressRowReads });
  }
  for (const sample of samples) {
    assert.ok(sample.addressRowReads > 0);
    assert.ok(sample.addressRowReads <= sample.totalAddresses * 4,
      `address mapping read ${sample.addressRowReads} row keys for ${sample.bindingCount} bindings and ${sample.totalAddresses} total addresses`);
  }
});
