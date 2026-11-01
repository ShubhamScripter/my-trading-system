import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderCatalogueRepository } from '../provider-catalogue.repository.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';
import { decodeWalletQueryCursor, encodeWalletQueryCursor,
  walletQueryFingerprint } from '../wallet-core.cursor.js';
import { walletAdminChainPageQuerySchema, walletAdminCurrencyPageQuerySchema,
  walletAdminHistoryPageQuerySchema, walletProviderCatalogueCoinsPageQuerySchema,
  walletProviderCataloguePageQuerySchema } from '../wallet-core.dto.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { WalletCoreHistoryRepository } from '../wallet-core.history-repository.js';

const UUID = '019f2000-0000-7000-8000-000000000001';
const VIEWER = { adminId: '019f2000-0000-7000-8000-000000000002' };
const SCHEMAS = { wallet: 'wallet_core_test', price: 'price_conversion_test' } as const;

class RecordingDatabase {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  readonly schemas = SCHEMAS;
  constructor(private readonly rows: (sql: string) => readonly Record<string, unknown>[] =
    () => []) {}
  async transaction<T>(work: (client: { query<Row extends Record<string, unknown>>(
    sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> }) => Promise<T>) {
    return work({ query: async <Row extends Record<string, unknown>>(
      sql: string, values?: readonly unknown[],
    ) => {
      this.calls.push({ sql, values });
      const rows = this.rows(sql) as Row[];
      return { rows: [...rows], rowCount: rows.length };
    } });
  }
}

const logo = { publicUrl: (key: string) => `https://assets.test.invalid/${key}` };
const audit = { appendWithTransaction: async () => ({ id: UUID, replayed: false }) };
const identity = { nextUuidV7: () => UUID };

function settingsRow() {
  return [{ revision: '1', global_desired_state: 'ON', catalogue_mode: 'ALL',
    include_treasury: true, include_collection: false, reconciliation_alert_percent: '5',
    reconciliation_alert_basis: 'SIGNED', default_currency_ids: [],
    updated_at: '2026-09-10T00:00:00.000000Z' }];
}

describe('WP1.1 Admin Wallet normalized query contracts', () => {
  it('normalizes bounded filters and rejects unsupported values before cursor decoding', () => {
    assert.deepEqual(walletAdminCurrencyPageQuerySchema.parse({
      search: '  %_Bitcoin  ', state: 'ON', chainId: UUID,
      sortBy: 'name', sortDirection: 'desc', limit: '100',
      scheduledLimit: '2', activeAlertLimit: '3',
    }), { search: '%_Bitcoin', state: 'ON', chainId: UUID,
      sortBy: 'name', sortDirection: 'desc', limit: 100,
      scheduledLimit: 2, activeAlertLimit: 3 });
    assert.deepEqual(walletAdminChainPageQuerySchema.parse({ isEvm: 'false' }), {
      isEvm: false, sortBy: 'shortName', sortDirection: 'asc', limit: 50,
    });
    assert.deepEqual(walletProviderCatalogueCoinsPageQuerySchema.parse({
      isBaseCurrency: 'true', isStake: 'false', blockchainCatalogueChainId: '12',
    }), { isBaseCurrency: true, isStake: false, providerChainId: '12',
      sortDirection: 'asc', limit: 50 });
    assert.deepEqual(walletAdminHistoryPageQuerySchema.parse({
      from: '2026-09-10T00:00:00Z', to: '2026-09-11T00:00:00Z',
    }), { from: '2026-09-10T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z',
      sortDirection: 'desc', limit: 50 });
    for (const value of ['1', '0', 'yes', 'TRUE', '']) {
      assert.equal(walletAdminChainPageQuerySchema.safeParse({ isEvm: value }).success, false);
    }
    for (const invalid of [
      { search: 'x'.repeat(101) }, { sortBy: 'rawSql' }, { sortDirection: 'sideways' },
      { from: '2026-09-11T00:00:00Z', to: '2026-09-10T00:00:00Z' },
      { from: '2026-09-10T00:00:00+05:30' }, { unknown: 'field' },
    ]) assert.equal(walletAdminHistoryPageQuerySchema.safeParse(invalid).success, false);
  });

  it('binds a canonical cursor to every normalized filter and order value', () => {
    const filter = { search: 'btc', state: 'ON', chainId: UUID,
      sortBy: 'name', sortDirection: 'desc' } as const;
    const fingerprint = walletQueryFingerprint(filter);
    const cursor = encodeWalletQueryCursor('CURRENCY', fingerprint, ['Bitcoin', UUID]);
    assert.deepEqual(decodeWalletQueryCursor(cursor, 'CURRENCY', fingerprint, 2),
      ['Bitcoin', UUID]);
    assert.equal(decodeWalletQueryCursor(cursor, 'CURRENCY',
      walletQueryFingerprint({ ...filter, state: 'OFF' }), 2), null);
    assert.equal(walletAdminCurrencyPageQuerySchema.safeParse({ ...filter, cursor }).success, true);
    assert.equal(walletAdminCurrencyPageQuerySchema.safeParse({ ...filter,
      search: 'eth', cursor }).success, false);
  });

  it('round-trips the largest escaped sort value and distinguishes omitted from explicit sort', () => {
    const escaped = '\u0001'.repeat(128);
    const parsedDefault = walletProviderCatalogueCoinsPageQuerySchema.parse({});
    const parsedExplicit = walletProviderCatalogueCoinsPageQuerySchema.parse({
      sortBy: 'blockchainCatalogueCoinId', sortDirection: 'asc',
    });
    const selected = (query: typeof parsedDefault) => ({ providerChainId: query.providerChainId,
      search: query.search, providerState: query.providerState,
      isBaseCurrency: query.isBaseCurrency, isStake: query.isStake,
      sortBy: query.sortBy ?? 'providerChainId', sortDirection: query.sortDirection });
    assert.notEqual(walletQueryFingerprint(selected(parsedDefault)),
      walletQueryFingerprint(selected(parsedExplicit)));
    const fingerprint = walletQueryFingerprint({ sortBy: 'currencyName', sortDirection: 'asc' });
    const cursor = encodeWalletQueryCursor('PROVIDER_COIN', fingerprint,
      ['7', escaped, '9100000001', '9100000201']);
    assert.ok(cursor.length > 512);
    assert.deepEqual(decodeWalletQueryCursor(cursor, 'PROVIDER_COIN', fingerprint, 4),
      ['7', escaped, '9100000001', '9100000201']);
    assert.equal(walletProviderCatalogueCoinsPageQuerySchema.safeParse({
      sortBy: 'currencyName', sortDirection: 'asc', cursor,
    }).success, true);
  });

  it('rejects NUL across every Admin collection while preserving literals, Unicode, and TAB', () => {
    const schemas = [
      [walletAdminCurrencyPageQuerySchema, {}],
      [walletAdminChainPageQuerySchema, {}],
      [walletProviderCataloguePageQuerySchema, {}],
      [walletProviderCataloguePageQuerySchema, { blockchainCatalogueChainId: '12' }],
      [walletProviderCatalogueCoinsPageQuerySchema, {}],
    ] as const;
    for (const [schema, base] of schemas) {
      assert.equal(schema.safeParse({ ...base, search: 'bad\0value' }).success, false);
      for (const search of ['価格_%', 'internal\tTAB']) {
        const valid = schema.safeParse({ ...base, search });
        assert.equal(valid.success, true);
        if (valid.success) assert.equal(valid.data.search, search);
      }
      assert.equal(schema.safeParse({ ...base, search: 'valid', unknown: true }).success, false);
    }
  });

  it('rejects NUL in every user-controlled list cursor sort position', () => {
    const cases = [
      [walletAdminCurrencyPageQuerySchema, { sortBy: 'name', sortDirection: 'asc' },
        { sortBy: 'name', sortDirection: 'asc' }, 'CURRENCY', ['bad\0name', UUID]],
      [walletAdminChainPageQuerySchema, { sortBy: 'name', sortDirection: 'asc' },
        { sortBy: 'name', sortDirection: 'asc' }, 'CHAIN', ['bad\0name', UUID]],
      [walletProviderCataloguePageQuerySchema,
        { sortBy: 'name', sortDirection: 'asc' }, { sortBy: 'name', sortDirection: 'asc' },
        'PROVIDER_CHAIN', ['7', 'bad\0name', '12']],
      [walletProviderCataloguePageQuerySchema,
        { blockchainCatalogueChainId: '12', sortBy: 'currencyName', sortDirection: 'asc' },
        { providerChainId: '12', sortBy: 'currencyName', sortDirection: 'asc' },
        'PROVIDER_COIN', ['7', 'bad\0name', '12', '2']],
      [walletProviderCatalogueCoinsPageQuerySchema,
        { sortBy: 'currencyName', sortDirection: 'asc' },
        { sortBy: 'currencyName', sortDirection: 'asc' },
        'PROVIDER_COIN', ['7', 'bad\0name', '12', '2']],
    ] as const;
    for (const [schema, query, fingerprintQuery, scope, values] of cases) {
      const cursor = encodeWalletQueryCursor(scope, walletQueryFingerprint(fingerprintQuery), values);
      assert.equal(schema.safeParse({ ...query, cursor }).success, false);
    }
  });
});

describe('WP1.1 Admin Wallet emitted query controls', () => {
  it('filters currencies before descending keyset paging with literal search parameters', async () => {
    const database = new RecordingDatabase((sql) => sql.includes('FROM wallet_core_test.wallet_settings WHERE id')
      ? settingsRow() : []);
    const repository = new WalletCoreBootstrapRepository(database as never, logo);
    const result = await repository.bootstrap({ search: '%_', state: 'ON', chainId: UUID,
      sortBy: 'name', sortDirection: 'desc', limit: 2,
      scheduledLimit: 2, activeAlertLimit: 2 }, VIEWER);
    assert.deepEqual(result.currencies, { items: [], nextCursor: null });
    const currency = database.calls.find(({ sql }) => sql.includes("master.kind='CRYPTO'"));
    assert.ok(currency);
    assert.match(currency.sql, /strpos\(lower\(name\),lower\(\$\d+::text\)\)>0/);
    assert.match(currency.sql, /EXISTS \(SELECT 1 FROM wallet_core_test\.currencies/);
    assert.match(currency.sql, /effective_state=\$2/);
    assert.ok(currency.values?.includes('ON'));
    assert.match(currency.sql, /ORDER BY name DESC,id DESC LIMIT/);
    assert.ok(currency.values?.includes('%_'));
    assert.ok(currency.values?.includes(UUID));
  });

  it('queries chains independently with effective state, boolean filter, and tied-name paging', async () => {
    const database = new RecordingDatabase((sql) => sql.includes('SELECT global_desired_state')
      ? [{ global_desired_state: 'ON' }] : []);
    const repository = new WalletCoreBootstrapRepository(database as never, logo);
    assert.deepEqual(await repository.chainPage({ search: '_%', state: 'MAINTAIN', isEvm: false,
      sortBy: 'name', sortDirection: 'asc', limit: 1 }), { items: [], nextCursor: null });
    const query = database.calls.find(({ sql }) => sql.includes('FROM wallet_core_test.chains'));
    assert.ok(query);
    assert.match(query.sql, /strpos\(lower\(name\),lower\(\$\d+::text\)\)>0/);
    assert.match(query.sql, /effective_state=\$2/);
    assert.ok(query.values?.includes('MAINTAIN'));
    assert.match(query.sql, /is_evm=\$3/);
    assert.ok(query.values?.includes(false));
    assert.match(query.sql, /ORDER BY name ASC,id ASC LIMIT/);
    assert.ok(query.values?.includes('_%'));
  });

  it('parameterizes provider chain and both coin variants with allowlisted ordering', async () => {
    const database = new RecordingDatabase((sql) => sql.includes('provider_catalogue_revision')
      ? [{ revision: '7' }] : []);
    const repository = new ProviderCatalogueRepository(database as never, audit as never, identity);
    await repository.chains({ search: '%_', providerState: 'DISABLED', sortBy: 'name',
      sortDirection: 'desc', limit: 2 });
    await repository.coins('12', { search: 'USD_', providerState: 'ACTIVATED',
      isBaseCurrency: false, isStake: false, sortBy: 'currencyName', sortDirection: 'asc', limit: 2 });
    await repository.allCoins({ search: 'ETH%', providerChainId: '12',
      providerState: 'MAINTENANCE', isBaseCurrency: true, isStake: true,
      sortBy: 'providerCoinId', sortDirection: 'desc', limit: 2 });
    const reads = database.calls.filter(({ sql }) => sql.includes('provider_catalogue_')
      && !sql.includes('provider_catalogue_revision'));
    assert.equal(reads.length, 3);
    assert.match(reads[0]!.sql,
      /ORDER BY chain\.name DESC,chain\.provider_chain_id DESC LIMIT/);
    assert.match(reads[1]!.sql,
      /ORDER BY coin\.currency_name ASC,coin\.provider_coin_id ASC LIMIT/);
    assert.match(reads[2]!.sql, /ORDER BY coin\.provider_coin_id DESC,coin\.provider_chain_id DESC,[\s\S]*coin\.provider_coin_id DESC LIMIT/);
    assert.ok(reads.every(({ sql }) => /strpos\(lower\(/.test(sql)));
    assert.ok(reads[0]!.values?.includes('%_'));
    assert.ok(reads[1]!.values?.includes('USD_'));
    assert.ok(reads[2]!.values?.includes('ETH%'));
  });

  it('pushes history filters, direction, cursor and limit into every compatible source branch', async () => {
    const database = new RecordingDatabase();
    const repository = new WalletCoreHistoryRepository(database as never);
    assert.deepEqual(await repository.history({ eventType: 'CURRENCY.STATUS_CHANGED',
      currencyId: UUID, actorId: VIEWER.adminId, status: 'ACTIVE',
      from: '2026-09-10T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z',
      sortDirection: 'asc', limit: 4 }), { items: [], nextCursor: null });
    const query = database.calls.find(({ sql }) => sql.includes('WITH history AS'));
    assert.ok(query);
    assert.match(query.sql, /ORDER BY created_at ASC,id ASC LIMIT \$3\) c/);
    assert.match(query.sql, /ORDER BY created_at ASC,id ASC LIMIT \$3\) e/);
    assert.match(query.sql, /ORDER BY history\.sort_at ASC,history\.id ASC LIMIT \$3/);
    assert.match(query.sql, /configuration_changes[\s\S]*\$4::text IS NULL/);
    assert.match(query.sql, /state_events[\s\S]*event_type=\$4/);
    assert.match(query.sql, /wallet_alert_events[\s\S]*ae\.status::text=\$7/);
    assert.deepEqual(query.values, [null, null, 5, 'CURRENCY.STATUS_CHANGED', UUID,
      VIEWER.adminId, 'ACTIVE', '2026-09-10T00:00:00.000Z',
      '2026-09-11T00:00:00.000Z']);
  });

  it('rejects cursor reuse after a filter changes at repository boundaries', async () => {
    const filter = { search: 'btc', sortBy: 'providerChainId', sortDirection: 'asc' } as const;
    const cursor = encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint(filter),
      ['7', '1', '1']);
    const database = new RecordingDatabase((sql) => sql.includes('provider_catalogue_revision')
      ? [{ revision: '7' }] : []);
    const repository = new ProviderCatalogueRepository(database as never, audit as never, identity);
    await assert.rejects(() => repository.chains({ ...filter, search: 'eth', cursor, limit: 1 }),
      WalletConfigurationInvalid);
    assert.equal(database.calls.length, 0);
  });

  it('accepts revision zero but rejects malformed numeric cursor positions before SQL', async () => {
    const filter = { sortBy: 'providerChainId', sortDirection: 'asc' } as const;
    const zero = new RecordingDatabase((sql) => sql.includes('provider_catalogue_revision')
      ? [{ revision: '0' }] : []);
    const zeroRepository = new ProviderCatalogueRepository(zero as never, audit as never, identity);
    const zeroCursor = encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint(filter),
      ['0', '1', '1']);
    assert.deepEqual(await zeroRepository.chains({ ...filter, cursor: zeroCursor, limit: 1 }),
      { revision: '0', items: [], nextCursor: null });

    const malformed = encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint(filter),
      ['7', 'not-a-number', '1']);
    const untouched = new RecordingDatabase();
    await assert.rejects(() => new ProviderCatalogueRepository(
      untouched as never, audit as never, identity,
    ).chains({ ...filter, cursor: malformed, limit: 1 }), WalletConfigurationInvalid);
    assert.equal(untouched.calls.length, 0);
  });

  it('preserves omitted all-coins chain/coin order through transport and distinguishes explicit coin sort', async () => {
    const parsedDefault = walletProviderCatalogueCoinsPageQuerySchema.parse({ limit: '1' });
    assert.deepEqual(parsedDefault, { sortDirection: 'asc', limit: 1 });
    const database = new RecordingDatabase((sql) => sql.includes('provider_catalogue_revision')
      ? [{ revision: '7' }] : []);
    const repository = new ProviderCatalogueRepository(database as never, audit as never, identity);
    await repository.allCoins(parsedDefault);
    await repository.allCoins(walletProviderCatalogueCoinsPageQuerySchema.parse({
      sortBy: 'blockchainCatalogueCoinId', sortDirection: 'asc', limit: '1',
    }));
    const reads = database.calls.filter(({ sql }) => sql.includes('provider_catalogue_currencies coin'));
    assert.equal(reads.length, 2);
    assert.match(reads[0]!.sql,
      /ORDER BY coin\.provider_chain_id ASC,coin\.provider_coin_id ASC LIMIT/);
    assert.match(reads[1]!.sql,
      /ORDER BY coin\.provider_coin_id ASC,coin\.provider_chain_id ASC,[\s\S]*coin\.provider_coin_id ASC LIMIT/);
  });

  it('rejects direct provider NUL and pre-existing newline searches before a transaction', async () => {
    const database = new RecordingDatabase();
    const repository = new ProviderCatalogueRepository(database as never, audit as never, identity);
    for (const search of ['bad\0value', 'bad\nvalue']) {
      await assert.rejects(() => repository.chains({ search, limit: 1 }), WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins('12', { search, limit: 1 }),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.allCoins({ search, limit: 1 }),
        WalletConfigurationInvalid);
    }
    const forgedCursor = encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint({
      sortBy: 'name', sortDirection: 'asc',
    }), ['7', 'bad\0name', '12']);
    await assert.rejects(() => repository.chains({ sortBy: 'name', sortDirection: 'asc',
      cursor: forgedCursor, limit: 1 }), WalletConfigurationInvalid);
    assert.equal(database.calls.length, 0);
    const acceptsTab = new RecordingDatabase((sql) => sql.includes('provider_catalogue_revision')
      ? [{ revision: '7' }] : []);
    const accepted = new ProviderCatalogueRepository(acceptsTab as never, audit as never, identity);
    await accepted.chains({ search: 'internal\tTAB', limit: 1 });
    await accepted.coins('12', { search: 'internal\tTAB', limit: 1 });
    await accepted.allCoins({ search: 'internal\tTAB', limit: 1 });
    assert.ok(acceptsTab.calls.length > 0);
  });
});
