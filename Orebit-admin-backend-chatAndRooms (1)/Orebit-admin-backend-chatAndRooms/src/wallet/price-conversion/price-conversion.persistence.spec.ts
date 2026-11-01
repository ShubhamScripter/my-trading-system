import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import type { PriceConversionHistoryItem } from './price-conversion.types.js';

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

class PriceTestPool extends pg.Pool {
  readonly priceConversionSchema = 'price_conversion_test' as const;
}

const featureDirectory = process.cwd();

async function provisioningModule(): Promise<{
  provisionPriceTestDatabase(
    env?: NodeJS.ProcessEnv,
    options?: { readonly through?: string },
  ): Promise<void>;
}> {
  return createRequire(resolve(featureDirectory, 'price-conversion.persistence.spec.js'))(
    resolve(featureDirectory, 'provision-test-database.cjs'),
  ) as { provisionPriceTestDatabase(): Promise<void> };
}

const AUDIT_CONTEXT = {
  actorId: '01920000-0000-7000-8000-000000000010',
  sessionId: '01920000-0000-7000-8000-000000000011',
  requestId: '01920000-0000-7000-8000-000000000012',
  ipAddress: '203.0.113.8',
  deviceId: '262a22871b5e894643e6833ceb144fbe',
} as const;
const GLOBAL_AUDIT = { appendWithTransaction: async () => ({
  id: '01920000-0000-7000-8000-000000000701', replayed: false,
}) };

describe('admin price-conversion PostgreSQL operations', {
  skip: process.env.PRICE_TEST_ALLOW_RESET !== 'true' && 'destructive test opt-in not supplied',
}, () => {
  let database: PriceTestPool;

  before(async () => {
    await (await provisioningModule()).provisionPriceTestDatabase();
    database = new PriceTestPool({ connectionString: testDatabaseUrl() });
  });

  beforeEach(async () => {
    await (await provisioningModule()).provisionPriceTestDatabase();
  });

  after(async () => database.end());

  it('keeps provider-reference metrics without returning a second currency catalogue', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const currencyId = '01920000-0000-7000-8000-000000000101';
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.currency_provider_refs
      (currency_id, provider_id, external_id, symbol)
      SELECT $1::uuid, id, 'bitcoin', 'BTC'
      FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`, [currencyId]);
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    const bootstrap = await store.bootstrap({});

    assert.equal('currencies' in bootstrap, false);
    assert.equal(bootstrap.providers.find((provider) => provider.code === 'COINGECKO')
      ?.referenceCount, 1);
  });

  it('returns concrete provider health and read-only usage in bootstrap', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const currencyId = '01920000-0000-7000-8000-000000000101';
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_provider_health
      (provider_id, currency_id, healthy, last_success_at, last_observed_at, updated_at)
      SELECT id, $1::uuid, true, '2026-08-31T08:00:00Z', '2026-08-31T08:00:00Z', '2026-08-31T08:00:01Z'
      FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_provider_call_stats
      (provider_id, period_type, period_start, request_count)
      SELECT id, 'DAILY', CURRENT_DATE, 7 FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`);
    const bootstrap = await new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT).bootstrap({});
    const coingecko = bootstrap.providers.find((provider) => provider.code === 'COINGECKO');

    assert.deepEqual(coingecko?.health, {
      trackedCurrencies: 1, healthyCurrencies: 1, lastSuccessAt: '2026-08-31T08:00:00.000Z',
      lastErrorAt: null, updatedAt: '2026-08-31T08:00:01.000Z',
    });
    assert.deepEqual(coingecko?.usage, { dailyRequests: 7, monthlyRequests: 0 });
    assert.deepEqual(bootstrap.fiatOptions.map((option) => option.code), [
      'AED','ARS','AUD','BDT','BHD','BMD','BRL','CAD','CHF','CLP','CNY','CZK','DKK','EUR','GBP',
      'GEL','HKD','HUF','IDR','ILS','INR','JPY','KRW','KWD','LKR','MMK','MXN','MYR','NGN','NOK',
      'NZD','PHP','PKR','PLN','RUB','SAR','SEK','SGD','THB','TRY','TWD','UAH','USD','VND','ZAR',
    ]);
    assert.equal(bootstrap.fiatOptions.every((option) => option.visible), true);
  });

  it('rejects TRUNCATE and DELETE on canonical append-only/history tables', async () => {
    const guards = await database.query<{ trigger_name: string }>(`
      SELECT t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'price_conversion_test' AND NOT t.tgisinternal
        AND (t.tgtype & 32) = 32`);
    assert.ok(guards.rows.length >= 7);
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(() => client.query(
        `TRUNCATE price_conversion_test.price_snapshots CASCADE`,
      ), /append-only|truncate/i);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await assert.rejects(() => client.query(
        `DELETE FROM price_conversion_test.price_config_changes WHERE status = 'LIVE'`,
      ), /cannot be deleted|append-only/i);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await assert.rejects(() => client.query(
        `TRUNCATE price_conversion_test.price_view_resolutions`,
      ), /append-only|truncate/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('archives legacy duplicate drafts before creating the one-draft unique index', async () => {
    await (await provisioningModule()).provisionPriceTestDatabase(process.env, {
      through: '20260831000004_complete_price_hardening',
    });
    await database.query(`INSERT INTO price_conversion_test.price_config_changes
      (revision, status, changelog, config, created_at)
      VALUES
        (1, 'DRAFT', 'older', '{}'::jsonb, '2026-01-01T00:00:00Z'),
        (2, 'DRAFT', 'newer', '{}'::jsonb, '2026-01-02T00:00:00Z')`);
    const migration = await readFile(resolve(
      featureDirectory,
      'migrations/20260901000005_final_review_hardening/migration.sql',
    ), 'utf8');

    await database.query(migration.replaceAll('price_conversion', 'price_conversion_test'));

    assert.deepEqual((await database.query(`SELECT revision::int, status::text
      FROM price_conversion_test.price_config_changes WHERE revision IN (1, 2)
      ORDER BY revision`)).rows, [
      { revision: 1, status: 'ARCHIVED' },
      { revision: 2, status: 'DRAFT' },
    ]);
    await assert.rejects(() => database.query(`INSERT INTO price_conversion_test.price_config_changes
      (revision, status, changelog, config) VALUES (3, 'DRAFT', 'duplicate', '{}'::jsonb)`));
  });

  it('returns nullable fields instead of empty strings for PRICE_UNAVAILABLE', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const currencyId = '01920000-0000-7000-8000-000000000101';
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_resolutions
      (currency_id, reason, stale, created_at) VALUES ($1::uuid, 'PRICE_UNAVAILABLE', false, '2026-08-31T08:00:00Z')`, [currencyId]);

    const prices = await new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT).prices({ limit: 50 });

    assert.deepEqual(prices.items, [{
      currencyId, priceUsd: null, observedAt: null,
      updatedAt: '2026-08-31T08:00:00.000Z', provider: null, snapshotId: null,
      stale: false, disabled: true, reason: 'PRICE_UNAVAILABLE',
    }]);
    assert.equal(prices.nextCursor, null);
  });

  it('swaps sensitive and view roles atomically without unique-index collisions', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    const result = await store.updateAtomically({
      action: 'PUSH', expectedRevision: 0, reason: 'Rotate all provider roles.', changelog: 'Role rotation.',
      providers: [
        { code: 'COINGECKO', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'ALCHEMY', enabled: true, role: 'PRIMARY', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: true, refreshIntervalSeconds: 300 },
      ],
    }, AUDIT_CONTEXT);

    assert.deepEqual(result, { kind: 'updated', revision: 1 });
    const rows = await database.query(`SELECT code::text AS code, sensitive_role::text AS role, view_enabled AS "viewEnabled"
      FROM price_conversion_test.price_providers ORDER BY code`);
    assert.deepEqual(rows.rows, [
      { code: 'ALCHEMY', role: 'PRIMARY', viewEnabled: false },
      { code: 'COINGECKO', role: 'COMPARISON', viewEnabled: false },
      { code: 'COINMARKETCAP', role: 'FALLBACK', viewEnabled: true },
    ]);
  });

  it('validates the complete final enabled role and view set before writing', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);

    await assert.rejects(() => store.updateAtomically({
      action: 'PUSH', expectedRevision: 0, reason: 'Invalid provider removal.', changelog: 'Invalid.',
      providers: [{ code: 'COINGECKO', enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 60 }],
    }, AUDIT_CONTEXT), /PRIMARY|role|view/i);
    const state = await database.query(`SELECT revision::int AS revision FROM price_conversion_test.price_settings WHERE id`);
    assert.equal(state.rows[0]?.revision, 0);
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_admin_audit`)).rows[0]?.count), 0);
  });

  it('allows disabled comparison and fallback providers and reports DEGRADED', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    assert.deepEqual(await store.updateAtomically({
      action: 'PUSH', expectedRevision: 0, reason: 'Run with the primary only.', changelog: 'Degraded.',
      providers: [
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        { code: 'ALCHEMY', enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 300 },
      ],
    }, AUDIT_CONTEXT), { kind: 'updated', revision: 1 });

    const bootstrap = await store.bootstrap({});
    assert.equal(bootstrap.roleConfigurationStatus, 'DEGRADED');
    assert.deepEqual(bootstrap.providers.map((provider) => ({
      code: provider.code, enabled: provider.enabled, role: provider.role,
    })), [
      { code: 'ALCHEMY', enabled: false, role: null },
      { code: 'COINGECKO', enabled: true, role: 'PRIMARY' },
      { code: 'COINMARKETCAP', enabled: false, role: null },
    ]);
  });

  it('returns stable 400 domain errors for past schedules and invalid final providers', async () => {
    const [operation, errors] = await Promise.all([
      import('./price-conversion.dboperation.js'),
      import('./price-conversion.errors.js'),
    ]);
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    for (const input of [
      {
        action: 'SCHEDULE' as const, expectedRevision: 0, reason: 'Past schedule.', changelog: 'Past.',
        effectiveAt: '2020-01-01T00:00:00.000Z',
      },
      {
        action: 'PUSH' as const, expectedRevision: 0, reason: 'Invalid providers.', changelog: 'Invalid.',
        providers: [{ code: 'COINGECKO' as const, enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 60 }],
      },
    ]) {
      await assert.rejects(() => store.updateAtomically(input, AUDIT_CONTEXT), (error: unknown) =>
        error instanceof errors.PriceConfigurationValidationError && error.status === 400,
      );
    }
  });

  it('records before, after, reason, actor, session, request, IP, and device in the same transaction', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    await new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT).updateAtomically({
      action: 'PUSH', expectedRevision: 0, reason: 'Change the divergence threshold.', changelog: 'Threshold changed.',
      divergenceThresholdBps: 125,
    }, AUDIT_CONTEXT);

    const audit = (await database.query(`SELECT actor_id AS "actorId", session_id AS "sessionId",
      request_id AS "requestId", host(ip_address) AS "ipAddress", device_id AS "deviceId", action, reason,
      before_json AS "beforeJson", after_json AS "afterJson" FROM price_conversion_test.price_admin_audit`)).rows[0];
    assert.ok(audit);
    assert.deepEqual({
      actorId: audit.actorId, sessionId: audit.sessionId, requestId: audit.requestId,
      ipAddress: audit.ipAddress, deviceId: audit.deviceId, action: audit.action, reason: audit.reason,
    }, { ...AUDIT_CONTEXT, action: 'PRICE_CONFIG_PUSH', reason: 'Change the divergence threshold.' });
    assert.equal(audit.beforeJson.settings.divergenceThresholdBps, 500);
    assert.equal(audit.afterJson.settings.divergenceThresholdBps, 125);
    assert.equal('catalogue' in audit.beforeJson, false);
    assert.equal('catalogue' in audit.afterJson, false);
  });

  it('rolls back settings, config change, and audit when a database write fails', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    await assert.rejects(() => new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT).updateAtomically({
      action: 'PUSH', expectedRevision: 0, reason: 'Exercise rollback.',
      changelog: 'x'.repeat(1_001),
      divergenceThresholdBps: 125,
    }, AUDIT_CONTEXT));

    assert.deepEqual((await database.query(`SELECT revision::int AS revision, divergence_threshold_bps AS threshold FROM price_conversion_test.price_settings WHERE id`)).rows[0], { revision: 0, threshold: 500 });
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_admin_audit`)).rows[0]?.count), 0);
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_config_changes`)).rows[0]?.count), 1);
  });

  it('returns the actual revision from real PostgreSQL without side effects on conflict', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const result = await new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT).updateAtomically({
      action: 'PUSH', expectedRevision: 99, reason: 'Stale request.', changelog: 'Stale.',
    }, AUDIT_CONTEXT);

    assert.deepEqual(result, { kind: 'revision_conflict', actualRevision: 0 });
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_admin_audit`)).rows[0]?.count), 0);
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_config_changes`)).rows[0]?.count), 1);
  });

  it('keeps SAVE_DRAFT and SCHEDULE out of live state and exposes all lifecycle states', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    assert.deepEqual(await store.updateAtomically({
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Save a draft.', changelog: 'Draft.', divergenceThresholdBps: 111,
    }, AUDIT_CONTEXT), { kind: 'updated', revision: 1 });
    assert.deepEqual(await store.updateAtomically({
      action: 'SAVE_DRAFT', expectedRevision: 1, reason: 'Supersede the draft.', changelog: 'Draft 2.', divergenceThresholdBps: 112,
    }, AUDIT_CONTEXT), { kind: 'updated', revision: 2 });
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_config_changes WHERE status = 'DRAFT'`)).rows[0]?.count), 1);
    assert.deepEqual(await store.updateAtomically({
      action: 'SCHEDULE', expectedRevision: 2, reason: 'Schedule a change.', changelog: 'Scheduled.',
      effectiveAt: '2026-09-30T00:00:00.000Z', divergenceThresholdBps: 222,
    }, AUDIT_CONTEXT), { kind: 'updated', revision: 3 });
    assert.deepEqual((await database.query(`SELECT divergence_threshold_bps AS threshold FROM price_conversion_test.price_settings WHERE id`)).rows[0], { threshold: 500 });
    const draftId = String((await database.query(`SELECT id FROM price_conversion_test.price_config_changes
      WHERE status = 'DRAFT'`)).rows[0]?.id);
    assert.deepEqual(await store.updateAtomically({
      action: 'PUSH', expectedRevision: 3, reason: 'Push the saved draft.', changelog: 'Live.', draftId,
    }, AUDIT_CONTEXT), { kind: 'updated', revision: 4 });

    const bootstrap = await store.bootstrap({});
    assert.equal(bootstrap.settings.divergenceThresholdBps, 112);
    assert.equal(bootstrap.configuration.draft, null);
    assert.equal(bootstrap.configuration.live?.revision, 4);
    assert.deepEqual(bootstrap.configuration.scheduled.map((change) => change.revision), [3]);
    assert.ok(bootstrap.settings.updatedAt > '2026-01-01T00:00:00.000Z');
  });

  it('applies the stored draft payload by draftId and cannot discard it with a mismatched body', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    await store.updateAtomically({
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Save threshold.', changelog: 'Draft.',
      divergenceThresholdBps: 111,
    }, AUDIT_CONTEXT);
    const draft = (await database.query(`SELECT id, config FROM price_conversion_test.price_config_changes
      WHERE status = 'DRAFT'`)).rows[0];
    assert.ok(draft);

    await store.updateAtomically({
      action: 'PUSH', expectedRevision: 1, draftId: String(draft.id), reason: 'Consume draft.',
      changelog: 'Live draft.', divergenceThresholdBps: 999,
    }, AUDIT_CONTEXT);

    assert.equal(Number((await database.query(`SELECT divergence_threshold_bps
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.divergence_threshold_bps), 111);
    const live = (await database.query(`SELECT config FROM price_conversion_test.price_config_changes
      WHERE status = 'LIVE'`)).rows[0];
    assert.deepEqual(live?.config, draft.config);
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_config_changes
      WHERE status = 'DRAFT'`)).rows[0]?.count), 0);
    assert.equal(String((await database.query(`SELECT after_json->'change'->>'consumedDraftId' AS id
      FROM price_conversion_test.price_admin_audit WHERE action = 'PRICE_CONFIG_PUSH'`)).rows[0]?.id), String(draft.id));
  });

  it('keeps an active draft when an explicit instant PUSH has no draftId', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    await store.updateAtomically({
      action: 'SAVE_DRAFT', expectedRevision: 0, reason: 'Keep draft.', changelog: 'Draft.',
      divergenceThresholdBps: 111,
    }, AUDIT_CONTEXT);
    await store.updateAtomically({
      action: 'PUSH', expectedRevision: 1, reason: 'Independent instant push.', changelog: 'Instant.',
      divergenceThresholdBps: 333,
    }, AUDIT_CONTEXT);

    assert.equal(Number((await database.query(`SELECT divergence_threshold_bps
      FROM price_conversion_test.price_settings WHERE id`)).rows[0]?.divergence_threshold_bps), 333);
    assert.equal(Number((await database.query(`SELECT count(*) FROM price_conversion_test.price_config_changes
      WHERE status = 'DRAFT'`)).rows[0]?.count), 1);
  });

  it('persists the identical canonical payload for immediate PUSH and SCHEDULE', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    const providers = [
      { code: 'COINGECKO' as const, enabled: true, role: 'COMPARISON' as const, viewEnabled: false, refreshIntervalSeconds: 60 },
      { code: 'ALCHEMY' as const, enabled: true, role: 'PRIMARY' as const, viewEnabled: false, refreshIntervalSeconds: 60 },
      { code: 'COINMARKETCAP' as const, enabled: true, role: 'FALLBACK' as const, viewEnabled: true, refreshIntervalSeconds: 300 },
    ];
    await store.updateAtomically({
      action: 'SCHEDULE', expectedRevision: 0, reason: 'Schedule canonical.', changelog: 'Scheduled.',
      effectiveAt: '2026-09-30T00:00:00.000Z', divergenceThresholdBps: 125, providers,
    }, AUDIT_CONTEXT);
    await store.updateAtomically({
      action: 'PUSH', expectedRevision: 1, reason: 'Push canonical.', changelog: 'Pushed.',
      divergenceThresholdBps: 125, providers,
    }, AUDIT_CONTEXT);

    const rows = await database.query(`SELECT revision::int, config
      FROM price_conversion_test.price_config_changes WHERE revision IN (1, 2) ORDER BY revision`);
    assert.deepEqual(rows.rows[0]?.config, rows.rows[1]?.config);
    assert.deepEqual(rows.rows[0]?.config, operation.serializePriceConfiguration(125, providers, []));
  });

  it('paginates sensitive/view resolutions, fetch, config, and audit history with an opaque tuple cursor', async () => {
    const operation = await import('./price-conversion.dboperation.js');
    const currencyId = '01920000-0000-7000-8000-000000000101';
    await database.query(`INSERT INTO price_conversion_test.currencies
      (id, symbol, name, decimals, kind, pricing_status)
      VALUES ($1::uuid, 'BTC', 'Bitcoin', 18, 'CRYPTO', 'DISABLED')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_resolutions (id, currency_id, reason, created_at)
      VALUES ('01920000-0000-7000-8000-000000000201', $1::uuid, 'PRICE_UNAVAILABLE', '2026-08-31T08:04:00Z')`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_view_resolutions
      (id, currency_id, configured_provider_id, secondary_provider_id, sensitive_resolution_id,
        reason, status, safe_error_code, created_at)
      SELECT '01920000-0000-7000-8000-000000000205', $1::uuid, configured.id, secondary.id,
        '01920000-0000-7000-8000-000000000201', 'SECONDARY_UNAVAILABLE', 'UNAVAILABLE',
        'UPSTREAM_TIMEOUT', '2026-08-31T08:05:00Z'
      FROM price_conversion_test.price_providers configured
      CROSS JOIN price_conversion_test.price_providers secondary
      WHERE configured.code = 'COINGECKO' AND secondary.code = 'COINMARKETCAP'`, [currencyId]);
    await database.query(`INSERT INTO price_conversion_test.price_fetch_runs
      (id, provider_id, scheduled_for, status, worker_instance_id, created_at)
      SELECT '01920000-0000-7000-8000-000000000202', id, '2026-08-31T08:03:00Z', 'FAILED', 'worker-test', '2026-08-31T08:03:00Z'
      FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`);
    await database.query(`INSERT INTO price_conversion_test.price_config_changes
      (id, revision, status, changelog, actor_id, config, created_at)
      VALUES ('01920000-0000-7000-8000-000000000203', 1, 'DRAFT', 'Draft history', $1::uuid, '{}'::jsonb, '2026-08-31T08:02:00Z')`, [AUDIT_CONTEXT.actorId]);
    await database.query(`INSERT INTO price_conversion_test.price_admin_audit
      (id, actor_id, session_id, request_id, ip_address, device_id, action, reason, created_at)
      VALUES ('01920000-0000-7000-8000-000000000204', $1::uuid, $2, $3::uuid, $4::inet, $5, 'PRICE_CONFIG_SAVE_DRAFT', 'History audit', '2026-08-31T08:01:00Z')`,
    [AUDIT_CONTEXT.actorId, AUDIT_CONTEXT.sessionId, AUDIT_CONTEXT.requestId, AUDIT_CONTEXT.ipAddress, AUDIT_CONTEXT.deviceId]);
    const store = new operation.PriceConversionDbOperation(database, GLOBAL_AUDIT);
    const items: PriceConversionHistoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.history({ limit: 2, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    assert.deepEqual([...new Set(items.map((item) => item.kind))].sort(), [
      'AUDIT', 'CONFIG_CHANGE', 'FETCH_RUN', 'RESOLUTION', 'VIEW_RESOLUTION',
    ]);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.ok(items.length >= 5);
  });
});
