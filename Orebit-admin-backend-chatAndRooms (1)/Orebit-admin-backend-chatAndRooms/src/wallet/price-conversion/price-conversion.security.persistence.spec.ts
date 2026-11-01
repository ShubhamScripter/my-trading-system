import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import type { PriceConversionAuditContext } from './price-conversion.types.js';

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

function provisioningModule(): { provisionPriceTestDatabase(): Promise<void> } {
  return createRequire(resolve(process.cwd(), 'price-conversion.security.persistence.spec.js'))(
    resolve(process.cwd(), 'provision-test-database.cjs'),
  ) as { provisionPriceTestDatabase(): Promise<void> };
}

class PriceTestPool extends pg.Pool {
  readonly priceConversionSchema = 'price_conversion_test' as const;
}

const AUDIT: PriceConversionAuditContext = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: 'security-review-test',
};
const GLOBAL_AUDIT = { appendWithTransaction: async () => ({
  id: '01920000-0000-7000-8000-000000000701', replayed: false,
}) };

describe('admin price live-security persistence', {
  skip: process.env.PRICE_TEST_ALLOW_RESET !== 'true' && 'destructive test opt-in not supplied',
}, () => {
  let database: PriceTestPool;

  before(async () => {
    await provisioningModule().provisionPriceTestDatabase();
    database = new PriceTestPool({ connectionString: testDatabaseUrl() });
  });
  beforeEach(async () => provisioningModule().provisionPriceTestDatabase());
  after(async () => database.end());

  it('degrades atomically on live PUSH but not on SAVE_DRAFT or SCHEDULE', async () => {
    const { PriceConversionDbOperation } = await import('./price-conversion.dboperation.js');
    const store = new PriceConversionDbOperation(database, GLOBAL_AUDIT);
    const state = async () => String((await database.query(`SELECT security_state::text
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.security_state);
    assert.equal(await state(), 'DEGRADED');
    await database.query(`UPDATE price_conversion_test.price_settings
      SET security_state = 'HEALTHY' WHERE id`);

    await store.updateAtomically({
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Review draft.', changelog: 'Draft.',
      divergenceThresholdBps: 125,
    }, AUDIT);
    assert.equal(await state(), 'HEALTHY');
    assert.equal(Number((await database.query(`SELECT revision::int
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.revision), 0);
    await store.updateAtomically({
      action: 'SCHEDULE', expectedRevision: 1, reason: 'Schedule review.', changelog: 'Scheduled.',
      effectiveAt: '2099-09-01T00:00:00.000Z', divergenceThresholdBps: 250,
    }, AUDIT);
    assert.equal(await state(), 'HEALTHY');
    assert.equal((await store.bootstrap({})).settings.revision, 2);

    await store.updateAtomically({
      action: 'PUSH', expectedRevision: 2, reason: 'Push review.', changelog: 'Live.',
      divergenceThresholdBps: 375,
    }, AUDIT);
    assert.equal(await state(), 'DEGRADED');
    assert.equal(Number((await database.query(`SELECT revision::int
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.revision), 3);
  });

  it('returns a stable 400 through service and persistence for an invalid final provider set', async () => {
    const [{ PriceConversionDbOperation }, { PriceConversionService }] = await Promise.all([
      import('./price-conversion.dboperation.js'),
      import('./price-conversion.service.js'),
    ]);
    const service = new PriceConversionService(new PriceConversionDbOperation(database, GLOBAL_AUDIT));
    await assert.rejects(() => service.update({
      action: 'PUSH', expectedRevision: 0, reason: 'Activate invalid BTC.', changelog: 'Invalid.',
      providers: [{ code: 'COINGECKO', enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 60 }],
    }, AUDIT), (error: unknown) => error instanceof PriceConfigurationValidationError
      && error.status === 400 && error.code === 'price_configuration_invalid');
    assert.equal(Number((await database.query(`SELECT revision::int
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.revision), 0);
  });

  it('installs revision-bound ledger reads and degrades every committed settings revision', async () => {
    const definition = String((await database.query(`SELECT pg_get_functiondef(to_regprocedure(
      'price_conversion_test.resolve_money_batch_for_ledger(uuid[])')) AS definition`)
    ).rows[0]?.definition);
    assert.match(definition, /r\.config_revision = settings\.revision/);
    assert.match(definition, /r\.configured_primary_provider_id = primary_provider\.id/);
    assert.match(definition, /r\.configured_comparison_provider_id = comparison_provider\.id/);
    assert.match(definition, /r\.configured_fallback_provider_id = fallback_provider\.id/);
    assert.equal(String((await database.query(`SELECT to_regclass(
      'price_conversion_test.price_view_fetch_buckets')::text AS table_name`)
    ).rows[0]?.table_name), 'price_conversion_test.price_view_fetch_buckets');

    await database.query(`UPDATE price_conversion_test.price_settings
      SET security_state = 'HEALTHY' WHERE id`);
    await database.query(`UPDATE price_conversion_test.price_settings
      SET revision = revision + 1 WHERE id`);
    assert.equal(String((await database.query(`SELECT security_state::text
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.security_state), 'DEGRADED');
  });

  it('rejects the last active provider-reference mutation for active CRYPTO', async () => {
    const currencyId = '01920000-0000-7000-8000-000000000101';
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.currency_provider_refs
      (currency_id, provider_id, external_id, symbol)
      SELECT $1::uuid, id, 'bitcoin', 'BTC' FROM price_conversion_test.price_providers
      WHERE code = 'COINGECKO'`, [currencyId]);
    await database.query(`UPDATE price_conversion_test.currencies
      SET pricing_status = 'ACTIVE' WHERE id = $1::uuid`, [currencyId]);

    await assert.rejects(() => database.query(`UPDATE price_conversion_test.currency_provider_refs
      SET active = false WHERE currency_id = $1::uuid`, [currencyId]), /active provider reference/i);
    await assert.rejects(() => database.query(`DELETE FROM price_conversion_test.currency_provider_refs
      WHERE currency_id = $1::uuid`, [currencyId]), /active provider reference/i);
    const privilege = await database.query<{ public_execute: boolean }>(`SELECT has_function_privilege(
      'public', 'price_conversion_test.require_active_crypto_ref_after_mutation()', 'EXECUTE'
    ) AS public_execute`);
    assert.equal(privilege.rows[0]?.public_execute, false);
  });
});
