import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import pg from 'pg';
import adminOperation from './price-conversion.dboperation.ts';
import { applyDueConfiguration } from '../../../../orebit-backend/src/wallet/price-conversion/worker-governance.ts';

const { PriceConversionDbOperation } = adminOperation;

const require = createRequire(import.meta.url);
const { provisionPriceTestDatabase, validatePriceTestDatabaseEnvironment } = require('./provision-test-database.cjs');
const testConfig = validatePriceTestDatabaseEnvironment(process.env);
class PriceTestPool extends pg.Pool {
  priceConversionSchema = 'price_conversion_test';
}
const database = new PriceTestPool({ connectionString: testConfig.connectionString });
const isolatedWorkerDatabase = {
  query(sql, params = []) {
    return database.query(sql.replaceAll('price_conversion.', 'price_conversion_test.'), params);
  },
  async connect() {
    const client = await database.connect();
    return {
      query(sql, params = []) {
        return client.query(sql.replaceAll('price_conversion.', 'price_conversion_test.'), params);
      },
      release() { client.release(); },
    };
  },
};
const audit = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: 'scheduled-cross-test',
};

before(async () => provisionPriceTestDatabase());
after(async () => database.end());

test('admin SCHEDULE payload is applied end to end by the canonical user worker', async () => {
  const scheduledAt = new Date(Date.now() + 60_000);
  const workerAt = new Date(scheduledAt.getTime() + 60_000);
  const store = new PriceConversionDbOperation(database);
  const currencyId = '01920000-0000-7000-8000-000000000101';
  await database.query(`UPDATE price_conversion_test.price_settings
    SET security_state = 'HEALTHY' WHERE id`);
  await database.query(`INSERT INTO price_conversion_test.currencies
    (id, symbol, name, decimals, kind, pricing_status)
    VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
  await database.query(`INSERT INTO price_conversion_test.currency_provider_refs
    (currency_id, provider_id, external_id, symbol)
    SELECT $1::uuid, id, code::text || '-old', 'BTC'
    FROM price_conversion_test.price_providers`, [currencyId]);
  const walletRowsBefore = (await database.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) - 'updated_at') FROM price_conversion_test.currencies c
      WHERE c.id=$1) AS currencies,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.provider_id)
      FROM price_conversion_test.currency_provider_refs r WHERE r.currency_id=$1) AS refs`,
  [currencyId])).rows[0];
  await store.updateAtomically({
    action: 'SCHEDULE', expectedRevision: 0, reason: 'Cross-service schedule.',
    changelog: 'Apply threshold and provider roles.',
    effectiveAt: scheduledAt.toISOString(), divergenceThresholdBps: 125,
    providers: [
      { code: 'COINGECKO', enabled: true, role: 'COMPARISON', viewEnabled: false },
      { code: 'ALCHEMY', enabled: true, role: 'PRIMARY', viewEnabled: false },
      { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: true },
    ],
  }, audit);
  assert.equal(String((await database.query(`SELECT security_state::text
    FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.security_state), 'HEALTHY');

  await applyDueConfiguration({
    db: isolatedWorkerDatabase, adapters: {}, workerInstanceId: 'admin-cross-apply-test',
  }, workerAt);
  assert.equal(String((await database.query(`SELECT security_state::text
    FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.security_state), 'DEGRADED');

  assert.equal(Number((await database.query(`SELECT divergence_threshold_bps
    FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.divergence_threshold_bps), 125);
  assert.deepEqual((await database.query(`SELECT code::text AS code, sensitive_role::text AS role,
    view_enabled AS "viewEnabled" FROM price_conversion_test.price_providers ORDER BY code`)).rows, [
    { code: 'ALCHEMY', role: 'PRIMARY', viewEnabled: false },
    { code: 'COINGECKO', role: 'COMPARISON', viewEnabled: false },
    { code: 'COINMARKETCAP', role: 'FALLBACK', viewEnabled: true },
  ]);
  const walletRowsAfter = (await database.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) - 'updated_at') FROM price_conversion_test.currencies c
      WHERE c.id=$1) AS currencies,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.provider_id)
      FROM price_conversion_test.currency_provider_refs r WHERE r.currency_id=$1) AS refs`,
  [currencyId])).rows[0];
  assert.deepEqual(walletRowsAfter, walletRowsBefore);
  assert.equal(String((await database.query(`SELECT status::text FROM price_conversion_test.price_config_changes
    WHERE revision = 1`)).rows[0]?.status), 'LIVE');
  const auditRow = (await database.query(`SELECT before_json AS "beforeJson", after_json AS "afterJson"
    FROM price_conversion_test.price_admin_audit WHERE action = 'PRICE_CONFIG_APPLIED'`)).rows[0];
  assert.ok(auditRow);
  assert.equal('catalogue' in auditRow.beforeJson, false);
  assert.equal('catalogue' in auditRow.afterJson, false);
});
