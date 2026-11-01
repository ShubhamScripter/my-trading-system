import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

import { PriceConversionBootstrapRepository } from './price-conversion.bootstrap-repository.js';
import {
  persistedPriceConfigurationSchema,
  priceConversionPatchSchema,
} from './price-conversion.dto.js';

const TEST_URL = process.env.PRICE_TEST_DATABASE_URL ?? '';
const SOURCE_ROOT = process.cwd();
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.PRICE_TEST_ALLOW_RESET === 'true'
  && (() => {
    try {
      const url = new URL(TEST_URL);
      return url.hostname === '127.0.0.1' && url.port === '55433'
        && decodeURIComponent(url.pathname.slice(1)) === 'orebit_price_test'
        && url.searchParams.get('schema') === 'price_conversion_test';
    } catch { return false; }
  })();

const PROVIDERS = {
  COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
  ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
  COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
} as const;
const PATCH = {
  action: 'SAVE_DRAFT', expectedRevision: 0,
  reason: 'Change provider configuration.', changelog: 'Provider settings only.',
  divergenceThresholdBps: 125,
  providers: [
    { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
    { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
    { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
  ],
} as const;
const CURRENCY = {
  id: '01920000-0000-7000-8000-000000000501', symbol: 'OWN', name: 'Ownership Coin',
  decimals: 18, kind: 'CRYPTO', active: false, providerRefs: [],
} as const;

describe('Admin Price Conversion ownership contract', () => {
  it('accepts provider configuration but rejects every Wallet-owned PATCH field', () => {
    assert.equal(priceConversionPatchSchema.safeParse(PATCH).success, true);
    for (const [name, value] of [
      ['currencies', [CURRENCY]],
      ['currencyUpserts', []],
      ['providerRefs', []],
      ['walletPolicy', { desiredState: 'ON', availableFor: 'BOTH' }],
      ['binanceReference', 'OWNUSDT'],
    ] as const) {
      assert.equal(priceConversionPatchSchema.safeParse({ ...PATCH, [name]: value }).success,
        false, name);
    }
  });

  it('stores exactly settings and providers, never currency upserts or references', () => {
    const clean = { settings: { divergenceThresholdBps: 125, visibleFiatCodes: ['USD'] },
      providers: PROVIDERS };
    assert.equal(persistedPriceConfigurationSchema.safeParse(clean).success, true);
    for (const [name, value] of [
      ['currencyUpserts', []], ['currencies', []], ['providerRefs', []],
      ['walletPolicy', { desiredState: 'ON' }], ['binanceReference', 'OWNUSDT'],
    ] as const) {
      assert.equal(persistedPriceConfigurationSchema.safeParse({ ...clean, [name]: value }).success,
        false, name);
    }
  });

  it('exports no currency mutation contract and contains no currency writer or audit path', async () => {
    const [types, dto, writer, policy, schema] = await Promise.all([
      readFile(resolve(SOURCE_ROOT, 'price-conversion.types.ts'), 'utf8'),
      readFile(resolve(SOURCE_ROOT, 'price-conversion.dto.ts'), 'utf8'),
      readFile(resolve(SOURCE_ROOT, 'price-conversion.configuration-writer.ts'), 'utf8'),
      readFile(resolve(SOURCE_ROOT, 'price-conversion.policy.ts'), 'utf8'),
      readFile(resolve(SOURCE_ROOT, 'schema.prisma'), 'utf8'),
    ]);
    for (const symbol of [
      'CurrencyPatch', 'PersistedCurrencyUpsert', 'ProviderReferencePatch',
      'CurrencyCatalogueItem',
    ]) assert.doesNotMatch(types, new RegExp(`export (?:interface|type) ${symbol}\\b`), symbol);
    for (const symbol of [
      'currencyPatchSchema', 'persistedCurrencyUpsertSchema', 'validateCurrencyIdentities',
    ]) assert.doesNotMatch(dto, new RegExp(`\\b${symbol}\\b`), symbol);
    for (const symbol of ['validateCatalogue', 'upsertCurrency', 'catalogueState']) {
      assert.doesNotMatch(writer, new RegExp(`\\b${symbol}\\b`), symbol);
    }
    assert.doesNotMatch(writer, /\bcatalogue\s*:/);
    assert.doesNotMatch(policy, /\bcurrencyUpserts\b|readonly CurrencyPatch\[\]/);
    assert.match(schema, /pricingStatus\s+CurrencyStatus\s+@map\("pricing_status"\)/);
    assert.doesNotMatch(schema, /^\s+status\s+CurrencyStatus\b/m);
  });

  it('keeps provider, health, usage and configuration without unbounded catalogue or prices', async () => {
    const client = new BootstrapClient();
    const repository = new PriceConversionBootstrapRepository({
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
    } as never);
    const result = await repository.bootstrap({});
    assert.equal('currencies' in result, false);
    assert.deepEqual(result.providers[0]?.health, {
      trackedCurrencies: 2, healthyCurrencies: 1,
      lastSuccessAt: '2026-09-05T00:00:00.000Z', lastErrorAt: null,
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    assert.deepEqual(result.providers[0]?.usage, { dailyRequests: 7, monthlyRequests: 11 });
    assert.equal('freshnessSeconds' in (result.providers[0] ?? {}), false);
    assert.equal('latestEffectivePrices' in result, false);
    assert.equal(result.configuration.live?.revision, 7);
    assert.equal(client.calls.some((sql) => /FROM price_conversion_test\.currencies c\b/.test(sql)
      && !/price_resolutions/.test(sql)), false);
    assert.equal(client.released, true);

    const [routes, store] = await Promise.all([
      readFile(resolve(SOURCE_ROOT, 'price-conversion.routes.ts'), 'utf8'),
      readFile(resolve(SOURCE_ROOT, 'price-conversion.types.ts'), 'utf8'),
    ]);
    assert.match(routes, /@Patch\(\)[\s\S]*@UseGuards\(SuperAdminGuard\)/);
    assert.doesNotMatch(routes, /RequiresElevation|ElevationGuard/);
    assert.match(store, /expectedRevision: number/);
    assert.match(store, /history\(input: PriceConversionHistoryQuery\)/);
  });
});

class BootstrapClient {
  readonly calls: string[] = [];
  released = false;

  async query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(sql);
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM price_conversion_test.price_settings')) return { rows: [{
      revision: 7, divergenceThresholdBps: 125, securityState: 'DEGRADED',
      updatedAt: '2026-09-05T00:00:00Z',
    }] };
    if (sql.includes('FROM price_conversion_test.price_providers p')) return { rows: [{
      code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, revision: 2,
      referenceCount: 2, refreshIntervalSeconds: 60,
      trackedCurrencies: 2, healthyCurrencies: 1,
      lastSuccessAt: '2026-09-05T00:00:00Z', lastErrorAt: null,
      healthUpdatedAt: '2026-09-05T00:00:00Z', dailyRequests: 7, monthlyRequests: 11,
    }] };
    if (sql.includes('FROM price_conversion_test.currencies c')) return { rows: [CURRENCY] };
    if (sql.includes('FROM price_conversion_test.price_config_changes')) return { rows: [{
      id: '01920000-0000-7000-8000-000000000503', revision: 7, status: 'LIVE',
      effectiveAt: null, changelog: 'Provider settings.', actorId: null,
      config: { settings: { divergenceThresholdBps: 125 }, providers: PROVIDERS },
      createdAt: '2026-09-05T00:00:00Z', appliedAt: '2026-09-05T00:00:00Z',
    }] };
    if (sql.includes('price_view_fiats')) return { rows: [{ code: 'USD', enabled: true }] };
    throw new Error(`OWNERSHIP_BOOTSTRAP_QUERY_UNEXPECTED:${sql}`);
  }

  release(): void { this.released = true; }
}

describe('Price runtime database ownership', { skip: !LIVE }, () => {
  it('cannot mutate Wallet identity/status/references but owns price append and health state',
    async () => {
      const pool = new pg.Pool({ connectionString: TEST_URL, max: 1 });
      const client = await pool.connect();
      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      const role = `price_runtime_ownership_${suffix}`;
      const currencyId = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE orebit_price_test_owner');
        const statusColumns = (await client.query<{ column_name: string }>(`SELECT column_name
          FROM information_schema.columns WHERE table_schema='price_conversion_test'
            AND table_name='currencies' AND column_name IN ('status','pricing_status')`)).rows;
        assert.deepEqual(statusColumns, [{ column_name: 'pricing_status' }]);
        const statusColumn = 'pricing_status';
        const providerId = String((await client.query(`SELECT id FROM
          price_conversion_test.price_providers WHERE code='COINGECKO'`)).rows[0]?.id);
        await client.query(`INSERT INTO price_conversion_test.currencies
          (id,symbol,name,decimals,kind,${statusColumn})
          VALUES ($1,$2,'Ownership runtime coin',18,'CRYPTO','DISABLED')`,
        [currencyId, `O${suffix.slice(0, 10).toUpperCase()}`]);
        await client.query(`CREATE ROLE "${role}" NOLOGIN`);
        await client.query(`GRANT USAGE ON SCHEMA price_conversion_test TO "${role}"`);
        await client.query(`GRANT SELECT ON price_conversion_test.currencies,
          price_conversion_test.currency_provider_refs,price_conversion_test.price_providers
          TO "${role}"`);
        await client.query(`GRANT UPDATE(auto_disabled) ON
          price_conversion_test.currencies TO "${role}"`);
        await client.query(`GRANT SELECT,INSERT ON price_conversion_test.price_snapshots TO "${role}"`);
        await client.query(`GRANT SELECT,INSERT,UPDATE ON
          price_conversion_test.price_provider_health TO "${role}"`);
        await client.query(`GRANT "${role}" TO orebit`);
        await client.query('RESET ROLE');
        await client.query(`SET LOCAL ROLE "${role}"`);

        for (const sql of [
          `UPDATE price_conversion_test.currencies SET symbol=symbol,name=name,
            decimals=decimals,kind=kind WHERE id=$1`,
          `UPDATE price_conversion_test.currencies SET ${statusColumn}=${statusColumn} WHERE id=$1`,
          `UPDATE price_conversion_test.currency_provider_refs SET active=active WHERE currency_id=$1`,
        ]) await denied(client, sql, [currencyId]);

        assert.equal((await client.query(`UPDATE price_conversion_test.currencies
          SET auto_disabled=true WHERE id=$1`, [currencyId])).rowCount, 1);
        assert.equal((await client.query(`INSERT INTO price_conversion_test.price_snapshots
          (provider_id,currency_id,price_usd,observed_at,response_hash)
          VALUES ($1,$2,1.25,clock_timestamp(),$3)`,
        [providerId, currencyId, 'a'.repeat(64)])).rowCount, 1);
        assert.equal((await client.query(`INSERT INTO price_conversion_test.price_provider_health
          (provider_id,currency_id,healthy,last_observed_at)
          VALUES ($1,$2,true,clock_timestamp())`, [providerId, currencyId])).rowCount, 1);
        assert.equal((await client.query(`UPDATE price_conversion_test.price_provider_health
          SET healthy=false,consecutive_failures=1,safe_error_code='TIMEOUT',
            last_error_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE provider_id=$1 AND currency_id=$2`, [providerId, currencyId])).rowCount, 1);
        await client.query('RESET ROLE');
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    });
});

async function denied(
  client: pg.PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  await client.query('SAVEPOINT ownership_denied');
  await assert.rejects(() => client.query(sql, [...values]), /permission denied/i);
  await client.query('ROLLBACK TO SAVEPOINT ownership_denied');
  await client.query('RELEASE SAVEPOINT ownership_denied');
}
