import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { AdminAuditRepository } from '../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../admin-audits/admin-audit.writer.service.js';
import { PriceConversionDbOperation } from './price-conversion.dboperation.js';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { encodeHistoryCursor, scheduledCursorContext } from './price-conversion.cursor.js';
import type { ProviderPatch } from './price-conversion.types.js';

const DATABASE = 'orebit_wallet_pricing_fixes_20260910';
const URL_ENV = 'ADMIN_PRICE_WP11_DATABASE_URL';
const connectionString = process.env[URL_ENV];

function guardedUrl(value: string): string {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.port !== '55441'
    || decodeURIComponent(url.pathname) !== `/${DATABASE}`) {
    throw new Error(`${URL_ENV} must target the isolated 127.0.0.1:55441/${DATABASE} database`);
  }
  return value;
}

test('WP-MVP1.1 AdminPricing persists configuration, audit, and bounded reads atomically', {
  skip: connectionString === undefined && `${URL_ENV} not supplied; isolated PostgreSQL test skipped`,
}, async () => {
  const pool = new pg.Pool({ connectionString: guardedUrl(connectionString ?? '') });
  const client = await pool.connect();
  let initialLocalAudit = 0;
  let initialGlobalAudit = 0;
  try {
    const identity = (await client.query(`SELECT current_database() AS database,
      current_user AS username, current_setting('cluster_name') AS cluster,
      inet_server_port()::int AS port`)).rows[0];
    assert.deepEqual(identity, {
      database: DATABASE,
      username: 'orebit_wallet_pricing_fixes_owner',
      cluster: DATABASE,
      port: 5432,
    });
    initialLocalAudit = Number((await client.query(`SELECT count(*)
      FROM price_conversion.price_admin_audit`)).rows[0]?.count);
    initialGlobalAudit = Number((await client.query(`SELECT count(*)
      FROM admin.admin_audit_events WHERE domain='PRICE_CONVERSION'`)).rows[0]?.count);
    await client.query('BEGIN');
    const savepointClient = {
      query: (sql: string, values?: unknown[]) => {
        if (sql.startsWith('BEGIN')) return client.query('SAVEPOINT admin_price_wp11');
        if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT admin_price_wp11');
        if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT admin_price_wp11');
        return client.query(sql, values);
      },
      release() {},
    };
    const database = {
      priceConversionSchema: 'price_conversion' as const,
      connect: async () => savepointClient,
      query: (sql: string, values?: unknown[]) => client.query(sql, values),
    };
    const store = new PriceConversionDbOperation(
      database as never,
      new AdminAuditWriterService(new AdminAuditRepository()),
    );
    const before = await store.bootstrap({ scheduledLimit: 10 });
    assert.equal(before.fiatOptions.length, 45);
    assert.equal('latestEffectivePrices' in before, false);
    assert.ok(['HEALTHY', 'DEGRADED'].includes(before.roleConfigurationStatus));
    assert.ok(['HEALTHY', 'DEGRADED'].includes(before.securityState));
    const primary = before.providers.find((provider) => provider.role === 'PRIMARY');
    const comparison = before.providers.find((provider) => provider.role === 'COMPARISON');
    assert.ok(primary && comparison);
    const currentCadence = Math.max(primary.refreshIntervalSeconds, comparison.refreshIntervalSeconds);
    const nextCadence = currentCadence === 2_147_483_647 ? currentCadence - 1 : currentCadence + 1;
    const providers: ProviderPatch[] = before.providers.map((provider) => ({
      code: provider.code,
      enabled: provider.enabled,
      role: provider.role,
      viewEnabled: provider.viewEnabled,
      refreshIntervalSeconds: provider.role === 'PRIMARY' || provider.role === 'COMPARISON'
        ? nextCadence
        : provider.refreshIntervalSeconds,
    }));
    const visible = before.fiatOptions.filter((option) => option.visible).map((option) => option.code);
    const visibleFiatCodes = visible.includes('USD')
      ? visible.filter((code) => code !== 'USD')
      : [...visible, 'USD' as const];
    const threshold = before.settings.divergenceThresholdBps === 10_000
      ? 9_999 : before.settings.divergenceThresholdBps + 1;
    const actorId = randomUUID();
    const result = await store.updateAtomically({
      action: 'PUSH', expectedRevision: before.settings.revision,
      reason: 'Verify WP-MVP1.1 AdminPricing atomic persistence.',
      changelog: 'WP-MVP1.1 isolated integration.',
      divergenceThresholdBps: threshold, visibleFiatCodes, providers,
    }, {
      actorId, sessionId: randomUUID(), requestId: randomUUID(),
      ipAddress: '127.0.0.1', deviceId: 'wp11-admin-price-test',
    });
    assert.equal(result.kind, 'updated');
    const after = await store.bootstrap({ scheduledLimit: 10 });
    assert.equal(after.settings.divergenceThresholdBps, threshold);
    assert.equal(after.securityState, 'DEGRADED');
    assert.equal(after.providers.find((provider) => provider.role === 'PRIMARY')?.refreshIntervalSeconds,
      nextCadence);
    assert.equal(after.providers.find((provider) => provider.role === 'COMPARISON')?.refreshIntervalSeconds,
      nextCadence);
    assert.deepEqual(after.fiatOptions.filter((option) => option.visible).map((option) => option.code),
      [...visibleFiatCodes].sort());
    const localAfterPush = Number((await client.query(`SELECT count(*)
      FROM price_conversion.price_admin_audit`)).rows[0]?.count);
    const globalAfterPush = Number((await client.query(`SELECT count(*)
      FROM admin.admin_audit_events WHERE domain='PRICE_CONVERSION'`)).rows[0]?.count);
    assert.equal(localAfterPush, initialLocalAudit + 1);
    assert.equal(globalAfterPush, initialGlobalAudit + 1);
    await assert.rejects(() => store.updateAtomically({
      action: 'PUSH', expectedRevision: result.kind === 'updated' ? result.revision : -1,
      reason: 'Reject unchanged WP-MVP1.1 configuration.', changelog: 'No-op.',
      divergenceThresholdBps: threshold, visibleFiatCodes, providers,
    }, {
      actorId, sessionId: randomUUID(), requestId: randomUUID(),
      ipAddress: '127.0.0.1', deviceId: 'wp11-admin-price-test',
    }), (error: unknown) => error instanceof PriceConfigurationValidationError
      && error.message === 'Price configuration is unchanged');
    assert.equal(Number((await client.query(`SELECT count(*)
      FROM price_conversion.price_admin_audit`)).rows[0]?.count), localAfterPush);
    assert.equal(Number((await client.query(`SELECT count(*)
      FROM admin.admin_audit_events WHERE domain='PRICE_CONVERSION'`)).rows[0]?.count), globalAfterPush);
    const scheduledCadence = nextCadence === 2_147_483_647 ? nextCadence - 1 : nextCadence + 1;
    const scheduledProviders = providers.map((provider) => ({
      ...provider,
      refreshIntervalSeconds: provider.role === 'PRIMARY' || provider.role === 'COMPARISON'
        ? scheduledCadence
        : provider.refreshIntervalSeconds,
    }));
    const scheduledVisibleFiatCodes = visibleFiatCodes.includes('EUR')
      ? visibleFiatCodes.filter((code) => code !== 'EUR')
      : [...visibleFiatCodes, 'EUR' as const];
    const scheduledThreshold = threshold === 10_000 ? 9_998 : threshold + 1;
    const effectiveAt = new Date(Date.now() + 5_000);
    const scheduled = await store.updateAtomically({
      action: 'SCHEDULE', expectedRevision: result.kind === 'updated' ? result.revision : -1,
      reason: 'Verify real scheduled configuration handoff.',
      changelog: 'WP-MVP1.1 cross-owner schedule.', effectiveAt: effectiveAt.toISOString(),
      divergenceThresholdBps: scheduledThreshold,
      visibleFiatCodes: scheduledVisibleFiatCodes,
      providers: scheduledProviders,
    }, {
      actorId, sessionId: randomUUID(), requestId: randomUUID(),
      ipAddress: '127.0.0.1', deviceId: 'wp11-admin-price-test',
    });
    assert.equal(scheduled.kind, 'updated');
    const workerModulePath = '../../../../orebit-backend/src/wallet/price-conversion/worker-governance.js';
    const { applyDueConfiguration } = await import(workerModulePath) as {
      applyDueConfiguration(context: unknown, now: Date): Promise<void>;
    };
    await applyDueConfiguration({
      db: database as never,
      adapters: {} as never,
      workerInstanceId: 'wp11-admin-price-schedule',
    }, new Date(effectiveAt.getTime() + 1));
    const applied = await store.bootstrap({ scheduledLimit: 10 });
    const scheduledRevision = scheduled.kind === 'updated' ? scheduled.revision : -1;
    assert.equal(applied.settings.revision, scheduledRevision);
    assert.equal(applied.settings.divergenceThresholdBps, scheduledThreshold);
    assert.equal(applied.providers.find((provider) => provider.role === 'PRIMARY')?.refreshIntervalSeconds,
      scheduledCadence);
    assert.equal(applied.providers.find((provider) => provider.role === 'COMPARISON')?.refreshIntervalSeconds,
      scheduledCadence);
    assert.deepEqual(applied.fiatOptions.filter((option) => option.visible).map((option) => option.code),
      [...scheduledVisibleFiatCodes].sort());
    assert.deepEqual((await client.query(`SELECT action FROM admin.admin_audit_events
      WHERE domain='PRICE_CONVERSION' AND subject_id=$1 ORDER BY created_at`,
    [String(scheduledRevision)])).rows.map((row) => row.action), [
      'SETTINGS.SCHEDULED', 'SETTINGS.SCHEDULE_APPLIED',
    ]);
    const history = await store.history({ eventType: 'CONFIG_CHANGE', status: 'LIVE', limit: 10 });
    assert.equal(history.items.some((item) => item.kind === 'CONFIG_CHANGE'
      && item.revision === scheduledRevision), true);
    const precisionRows = [
      { currencyId: randomUUID(), resolutionId: randomUUID(), symbol: `P0${randomUUID().slice(0, 6)}`.toUpperCase(),
        createdAt: '1900-01-01T00:00:00.123456Z' },
      { currencyId: randomUUID(), resolutionId: randomUUID(), symbol: `P1${randomUUID().slice(0, 6)}`.toUpperCase(),
        createdAt: '1900-01-01T00:00:00.123789Z' },
      { currencyId: randomUUID(), resolutionId: randomUUID(), symbol: `P2${randomUUID().slice(0, 6)}`.toUpperCase(),
        createdAt: '2040-01-01T00:00:00.123456Z' },
      { currencyId: randomUUID(), resolutionId: randomUUID(), symbol: `P3${randomUUID().slice(0, 6)}`.toUpperCase(),
        createdAt: '2040-01-01T00:00:00.123789Z' },
    ];
    for (const row of precisionRows) {
      await client.query(`INSERT INTO price_conversion.currencies
        (id,symbol,name,decimals,kind,pricing_status)
        VALUES ($1,$2,$2,18,'CRYPTO','DISABLED')`, [row.currencyId, row.symbol]);
      await client.query(`INSERT INTO price_conversion.price_resolutions
        (id,currency_id,reason,stale,created_at)
        VALUES ($1,$2,'PRICE_UNAVAILABLE',false,$3::timestamptz)`,
      [row.resolutionId, row.currencyId, row.createdAt]);
    }
    for (const [direction, expected] of [
      ['asc', precisionRows.slice(0, 2)],
      ['desc', precisionRows.slice(2).reverse()],
    ] as const) {
      const priceIds: string[] = [];
      const seenCursors = new Set<string>();
      let priceCursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
        const page = await store.prices({ limit: 1, status: 'DISABLED',
          sortBy: 'updatedAt', sortDirection: direction, cursor: priceCursor });
        priceIds.push(...page.items.map((item) => item.currencyId));
        if (page.nextCursor === null) { priceCursor = undefined; break; }
        assert.equal(seenCursors.has(page.nextCursor), false);
        seenCursors.add(page.nextCursor);
        priceCursor = page.nextCursor;
      }
      assert.equal(priceCursor, undefined, 'latest-price traversal did not terminate');
      assert.deepEqual(priceIds.filter((id) => expected.some((row) => row.currencyId === id)),
        expected.map((row) => row.currencyId));
      const year = direction === 'asc' ? '1900' : '2040';
      const firstHistory = await store.history({ limit: 1, eventType: 'RESOLUTION',
        from: `${year}-01-01T00:00:00.123000Z`, to: `${year}-01-01T00:00:00.124000Z`,
        sortDirection: direction });
      const secondHistory = await store.history({ limit: 1, eventType: 'RESOLUTION',
        from: `${year}-01-01T00:00:00.123000Z`, to: `${year}-01-01T00:00:00.124000Z`,
        sortDirection: direction, cursor: firstHistory.nextCursor ?? undefined });
      assert.deepEqual([...firstHistory.items, ...secondHistory.items].map((item) => item.id),
        expected.map((row) => row.resolutionId));
      assert.equal(secondHistory.nextCursor, null);
    }
    const maxRevision = Number((await client.query(`SELECT max(revision)::int AS revision
      FROM price_conversion.price_config_changes`)).rows[0]?.revision);
    const scheduleIds = [randomUUID(), randomUUID()];
    await client.query(`INSERT INTO price_conversion.price_config_changes
      (id,revision,status,effective_at,changelog,config) VALUES
      ($1,$2,'SCHEDULED','9000-01-01T00:00:00.123456Z','Cursor precision','{}'),
      ($3,$4,'SCHEDULED','9000-01-01T00:00:00.123789Z','Cursor precision','{}')`,
    [scheduleIds[0], maxRevision + 1, scheduleIds[1], maxRevision + 2]);
    const scheduledStart = encodeHistoryCursor([
      '9000-01-01T00:00:00.123000Z',
      '00000000-0000-1000-8000-000000000000',
      scheduledCursorContext,
    ]);
    const firstSchedule = await store.bootstrap({ scheduledLimit: 1, scheduledCursor: scheduledStart });
    const secondSchedule = await store.bootstrap({ scheduledLimit: 1,
      scheduledCursor: firstSchedule.configuration.scheduledNextCursor ?? undefined });
    assert.deepEqual([
      ...firstSchedule.configuration.scheduled,
      ...secondSchedule.configuration.scheduled,
    ].map((item) => item.id), scheduleIds);
    assert.equal(secondSchedule.configuration.scheduledNextCursor, null);
    await client.query('ROLLBACK');
    assert.equal(Number((await client.query(`SELECT count(*)
      FROM price_conversion.price_admin_audit`)).rows[0]?.count), initialLocalAudit);
    assert.equal(Number((await client.query(`SELECT count(*)
      FROM admin.admin_audit_events WHERE domain='PRICE_CONVERSION'`)).rows[0]?.count), initialGlobalAudit);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
});
