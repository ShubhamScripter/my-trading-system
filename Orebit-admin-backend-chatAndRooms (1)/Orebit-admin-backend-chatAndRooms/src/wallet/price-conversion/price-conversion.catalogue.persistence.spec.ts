import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { PriceConversionDbOperation } from './price-conversion.dboperation.js';

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

const provision = createRequire(resolve(process.cwd(), 'price-conversion.catalogue.persistence.spec.js'))(
  resolve(process.cwd(), 'provision-test-database.cjs'),
) as { provisionPriceTestDatabase(): Promise<void> };

class PriceTestPool extends pg.Pool {
  readonly priceConversionSchema = 'price_conversion_test' as const;
}

const database = new PriceTestPool({ connectionString: testDatabaseUrl() });
const GLOBAL_AUDIT = { appendWithTransaction: async () => ({
  id: '01920000-0000-7000-8000-000000000701', replayed: false,
}) };
const audit = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: 'session-catalogue',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: 'device-catalogue',
} as const;

describe('admin price ownership PostgreSQL validation', {
  skip: process.env.PRICE_TEST_ALLOW_RESET !== 'true' && 'destructive test opt-in not supplied',
}, () => {
  beforeEach(async () => provision.provisionPriceTestDatabase());
  after(async () => database.end());

  it('rejects a malformed stored draft as a stable local 400 before applying it', async () => {
    const draftId = randomUUID();
    await database.query(`INSERT INTO price_conversion_test.price_config_changes
      (id, revision, status, changelog, actor_id, config)
      VALUES ($1, 1, 'DRAFT', 'Malformed stored draft.', $2, $3::jsonb)`, [
      draftId,
      audit.actorId,
      JSON.stringify({
        settings: { divergenceThresholdBps: 125 },
        providers: {
          COINGECKO: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: true },
          ALCHEMY: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false },
          COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: false },
        },
        currencyUpserts: [{ id: 'not-a-uuid', symbol: 'btc', decimals: 19 }],
      }),
    ]);

    await assert.rejects(() => new PriceConversionDbOperation(database, GLOBAL_AUDIT).updateAtomically({
      action: 'PUSH', expectedRevision: 1, draftId,
      reason: 'Attempt malformed draft.', changelog: 'Malformed.',
    }, audit), (error: unknown) => error instanceof PriceConfigurationValidationError && error.status === 400);
    assert.equal((await database.query(`SELECT revision::int FROM price_conversion_test.price_settings WHERE id`))
      .rows[0]?.revision, 0);
    assert.equal((await database.query(`SELECT status::text FROM price_conversion_test.price_config_changes WHERE id = $1`, [draftId]))
      .rows[0]?.status, 'DRAFT');
  });

  it('leaves Wallet-owned identity and provider references unchanged on a price PUSH', async () => {
    const existingId = randomUUID();
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [existingId]);
    await database.query(`INSERT INTO price_conversion_test.currency_provider_refs
      (currency_id, provider_id, external_id, symbol)
      SELECT $1, id, 'bitcoin', 'BTC' FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`,
    [existingId]);

    const before = (await database.query(`SELECT c.id,c.symbol,c.name,c.decimals,c.kind::text,
      c.pricing_status::text,r.external_id,r.symbol AS ref_symbol,r.active
      FROM price_conversion_test.currencies c
      JOIN price_conversion_test.currency_provider_refs r ON r.currency_id=c.id
      WHERE c.id=$1`, [existingId])).rows[0];
    await new PriceConversionDbOperation(database, GLOBAL_AUDIT).updateAtomically({
      action: 'PUSH', expectedRevision: 0,
      reason: 'Change price threshold.', changelog: 'Price providers only.',
      divergenceThresholdBps: 125,
    }, audit);
    const after = (await database.query(`SELECT c.id,c.symbol,c.name,c.decimals,c.kind::text,
      c.pricing_status::text,r.external_id,r.symbol AS ref_symbol,r.active
      FROM price_conversion_test.currencies c
      JOIN price_conversion_test.currency_provider_refs r ON r.currency_id=c.id
      WHERE c.id=$1`, [existingId])).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await database.query(`SELECT revision::int FROM price_conversion_test.price_settings WHERE id`))
      .rows[0]?.revision, 1);
    const audited = (await database.query(`SELECT before_json,after_json
      FROM price_conversion_test.price_admin_audit`)).rows[0];
    assert.equal('catalogue' in audited.before_json, false);
    assert.equal('catalogue' in audited.after_json, false);
  });
});
