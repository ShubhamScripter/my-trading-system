import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  PersistedPriceConfiguration,
  PriceConversionAuditContext,
  PriceConversionBootstrap,
  PriceConversionHistoryPage,
  PriceConversionPatch,
  PriceConversionUpdateResult,
} from './price-conversion.types.js';

type QueryCall = { readonly sql: string; readonly values: readonly unknown[] };

async function moduleOrEmpty(path: string): Promise<Record<string, unknown>> {
  return import(path).catch(() => ({})) as Promise<Record<string, unknown>>;
}

describe('price-conversion extracted repositories', () => {
  it('shares strict timestamp and nullable row conversions across repositories', async () => {
    const values = await moduleOrEmpty('./price-conversion.row-values.js');
    assert.ok(values.requiredIso);
    assert.ok(values.isoOrNull);
    assert.ok(values.stringOrNull);
    const requiredIso = values.requiredIso as (value: unknown) => string;
    const isoOrNull = values.isoOrNull as (value: unknown) => string | null;
    const stringOrNull = values.stringOrNull as (value: unknown) => string | null;

    assert.equal(requiredIso('2026-09-10T00:00:00Z'), '2026-09-10T00:00:00.000Z');
    assert.equal(isoOrNull(null), null);
    assert.equal(isoOrNull(undefined), null);
    assert.equal(isoOrNull('2026-09-10T00:00:00Z'), '2026-09-10T00:00:00.000Z');
    assert.equal(stringOrNull(null), null);
    assert.equal(stringOrNull(undefined), null);
    assert.equal(stringOrNull(42), '42');
    assert.throws(() => requiredIso(null), /Expected timestamp/);
    assert.throws(() => requiredIso('not-a-date'), /Invalid time value/);
    assert.throws(() => isoOrNull('not-a-date'), /Invalid time value/);
  });

  it('builds the provider/settings bootstrap without a second currency catalogue', async () => {
    const module = await moduleOrEmpty('./price-conversion.bootstrap-repository.js');
    assert.ok(module.PriceConversionBootstrapRepository);
    const calls: QueryCall[] = [];
    const client = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'COMMIT') return { rows: [] };
        calls.push({ sql, values });
        if (sql.includes('FROM price_conversion_test.price_settings')) {
          return { rows: [{
            revision: 7,
            divergenceThresholdBps: 125,
            securityState: 'DEGRADED',
            updatedAt: '2026-08-31T08:00:00Z',
          }] };
        }
        if (sql.includes('FROM price_conversion_test.price_providers p')) {
          return { rows: [
            provider('ALCHEMY', 'COMPARISON', false),
            provider('COINGECKO', 'PRIMARY', true),
            provider('COINMARKETCAP', 'FALLBACK', false),
          ] };
        }
        if (sql.includes('FROM price_conversion_test.price_config_changes')) {
          return { rows: [
            change('DRAFT', 7, null),
            change('LIVE', 6, null),
            change('SCHEDULED', 9, '2026-09-20T00:00:00Z'),
            change('SCHEDULED', 8, '2026-09-10T00:00:00Z'),
          ] };
        }
        return { rows: [{ code: 'EUR', enabled: false }, { code: 'USD', enabled: true }] };
      },
      release() {},
    };
    const database = {
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
    };
    const Repository = module.PriceConversionBootstrapRepository as new (database: unknown) => {
      bootstrap(input: { readonly scheduledLimit?: number }): Promise<PriceConversionBootstrap>;
    };

    const result = await new Repository(database).bootstrap({ scheduledLimit: 1 });

    assert.equal(calls.length, 4);
    assert.deepEqual(result.settings, {
      revision: 7,
      divergenceThresholdBps: 125,
      updatedAt: '2026-08-31T08:00:00.000Z',
    });
    assert.equal(result.roleConfigurationStatus, 'HEALTHY');
    assert.equal(result.securityState, 'DEGRADED');
    assert.equal('latestEffectivePrices' in result, false);
    assert.equal('currencies' in result, false);
    assert.deepEqual(result.configuration.scheduled.map((entry) => entry.revision), [8]);
    assert.ok(result.configuration.scheduledNextCursor);
    assert.deepEqual(result.fiatOptions, [
      { code: 'EUR', visible: false },
      { code: 'USD', visible: true },
    ]);
  });

  it('maps every history payload and paginates by the last returned tuple', async () => {
    const module = await moduleOrEmpty('./price-conversion.history-repository.js');
    assert.ok(module.PriceConversionHistoryRepository);
    const calls: QueryCall[] = [];
    const database = {
      priceConversionSchema: 'price_conversion_test',
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [
          historyRow('RESOLUTION', '201', '2026-08-31T08:04:00Z', {
            currencyId: '01920000-0000-7000-8000-000000000101',
            reason: 'PRICE_UNAVAILABLE', priceUsd: '1.25', observedAt: null,
            provider: null, snapshotId: null, stale: false,
          }),
          historyRow('FETCH_RUN', '202', '2026-08-31T08:03:00Z', {
            provider: 'COINGECKO', scheduledFor: '2026-08-31T08:03:00Z', status: 'FAILED',
            requestedCount: 2, observedCount: 0, latencyMs: null, safeErrorCode: 'UPSTREAM_TIMEOUT',
            workerInstanceId: 'worker-test', startedAt: null, finishedAt: '2026-08-31T08:03:01Z',
          }),
          historyRow('AUDIT', '203', '2026-08-31T08:02:00Z', {}),
        ] };
      },
    };
    const Repository = module.PriceConversionHistoryRepository as new (database: unknown) => {
      history(input: { readonly limit: number }): Promise<PriceConversionHistoryPage>;
    };

    const result = await new Repository(database).history({ limit: 2 });

    assert.equal(calls.length, 1);
    assert.match(calls[0]?.sql ?? '', /price_resolutions[\s\S]+price_fetch_runs[\s\S]+price_config_changes[\s\S]+price_admin_audit/);
    assert.deepEqual(calls[0]?.values, [3]);
    assert.deepEqual(result.items, [
      {
        id: '01920000-0000-7000-8000-000000000201', createdAt: '2026-08-31T08:04:00.000Z',
        kind: 'RESOLUTION', currencyId: '01920000-0000-7000-8000-000000000101',
        reason: 'PRICE_UNAVAILABLE', priceUsd: '1.25', observedAt: null, provider: null,
        snapshotId: null, stale: false,
      },
      {
        id: '01920000-0000-7000-8000-000000000202', createdAt: '2026-08-31T08:03:00.000Z',
        kind: 'FETCH_RUN', provider: 'COINGECKO', scheduledFor: '2026-08-31T08:03:00.000Z',
        status: 'FAILED', requestedCount: 2, observedCount: 0, latencyMs: null,
        safeErrorCode: 'UPSTREAM_TIMEOUT', workerInstanceId: 'worker-test', startedAt: null,
        finishedAt: '2026-08-31T08:03:01.000Z',
      },
    ]);
    assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor ?? '', 'base64url').toString('utf8')), [
      '2026-08-31T08:03:00.000000Z',
      '01920000-0000-7000-8000-000000000202',
      '["history",null,null,null,null,null,null,"timestamp","desc"]',
    ]);
  });

  it('applies allowlisted history filters and rejects a cursor reused with different filters', async () => {
    const module = await moduleOrEmpty('./price-conversion.history-repository.js');
    const calls: QueryCall[] = [];
    const database = {
      priceConversionSchema: 'price_conversion_test',
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [
          historyRow('RESOLUTION', '211', '2026-09-10T08:00:00Z', {
            currencyId: '01920000-0000-7000-8000-000000000101',
            reason: 'PRIMARY_CONFIRMED', priceUsd: '1.25', observedAt: '2026-09-10T07:59:00Z',
            provider: 'COINGECKO', snapshotId: '01920000-0000-7000-8000-000000000311', stale: false,
          }),
          historyRow('RESOLUTION', '212', '2026-09-10T08:01:00Z', {
            currencyId: '01920000-0000-7000-8000-000000000101',
            reason: 'PRIMARY_CONFIRMED', priceUsd: '1.30', observedAt: '2026-09-10T08:00:00Z',
            provider: 'COINGECKO', snapshotId: '01920000-0000-7000-8000-000000000312', stale: false,
          }),
        ] };
      },
    };
    const Repository = module.PriceConversionHistoryRepository as new (database: unknown) => {
      history(input: Record<string, unknown>): Promise<PriceConversionHistoryPage>;
    };
    const repository = new Repository(database);
    const query = {
      eventType: 'RESOLUTION',
      currencyId: '01920000-0000-7000-8000-000000000101',
      providerCode: 'COINGECKO',
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
      sortBy: 'timestamp',
      sortDirection: 'asc',
      limit: 1,
    };

    const first = await repository.history(query);

    assert.match(calls[0]?.sql ?? '', /WHERE \$1 = 'RESOLUTION'/);
    assert.match(calls[0]?.sql ?? '', /r\.currency_id = \$2::uuid/);
    assert.match(calls[0]?.sql ?? '', /\$3 = p\.code::text/);
    assert.equal((calls[0]?.sql.match(/LIMIT \$6/g) ?? []).length, 6);
    assert.match(calls[0]?.sql ?? '', /ORDER BY created_at ASC, id ASC/);
    assert.deepEqual(calls[0]?.values, [
      'RESOLUTION', query.currencyId, 'COINGECKO', query.from, query.to, 2,
    ]);
    assert.ok(first.nextCursor);
    await repository.history({ ...query, cursor: first.nextCursor });
    await assert.rejects(
      () => repository.history({ ...query, providerCode: 'ALCHEMY', cursor: first.nextCursor }),
      /cursor does not match query/i,
    );
  });

  it('maps per-currency view reason and status through the existing history contract', async () => {
    const module = await moduleOrEmpty('./price-conversion.history-repository.js');
    assert.ok(module.PriceConversionHistoryRepository);
    const database = {
      priceConversionSchema: 'price_conversion_test',
      query: async () => ({ rows: [{
        id: '01920000-0000-7000-8000-000000000205',
        createdAt: '2026-08-31T08:05:00Z',
        kind: 'VIEW_RESOLUTION',
        payload: {
          currencyId: '01920000-0000-7000-8000-000000000101',
          selectedProvider: null,
          configuredProvider: 'COINGECKO',
          secondaryProvider: 'COINMARKETCAP',
          sensitiveResolutionId: '01920000-0000-7000-8000-000000000201',
          reason: 'SECONDARY_UNAVAILABLE',
          status: 'UNAVAILABLE',
          safeErrorCode: 'UPSTREAM_TIMEOUT',
        },
      }] }),
    };
    const Repository = module.PriceConversionHistoryRepository as new (database: unknown) => {
      history(input: { readonly limit: number }): Promise<PriceConversionHistoryPage>;
    };

    const result = await new Repository(database).history({ limit: 10 });

    assert.deepEqual(result, {
      items: [{
        id: '01920000-0000-7000-8000-000000000205',
        createdAt: '2026-08-31T08:05:00.000Z',
        kind: 'VIEW_RESOLUTION',
        currencyId: '01920000-0000-7000-8000-000000000101',
        selectedProvider: null,
        configuredProvider: 'COINGECKO',
        secondaryProvider: 'COINMARKETCAP',
        sensitiveResolutionId: '01920000-0000-7000-8000-000000000201',
        reason: 'SECONDARY_UNAVAILABLE',
        status: 'UNAVAILABLE',
        safeErrorCode: 'UPSTREAM_TIMEOUT',
      }],
      nextCursor: null,
    });
  });

  it('consumes stored draft state and writes the audit in the same transaction', async () => {
    const module = await moduleOrEmpty('./price-conversion.configuration-writer.js');
    assert.ok(module.PriceConversionConfigurationWriter);
    const storedDraft = draftConfiguration();
    const client = new DraftClient(storedDraft);
    const globalAudits: Record<string, unknown>[] = [];
    const database = {
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
    };
    const Writer = module.PriceConversionConfigurationWriter as new (database: unknown, audit: unknown) => {
      updateAtomically(
        input: PriceConversionPatch,
        audit: PriceConversionAuditContext,
      ): Promise<PriceConversionUpdateResult>;
    };
    const audit = {
      actorId: '01920000-0000-7000-8000-000000000010',
      sessionId: 'session-11',
      requestId: '01920000-0000-7000-8000-000000000012',
      ipAddress: '203.0.113.8',
      deviceId: 'device-13',
    };

    const result = await new Writer(database, {
      appendWithTransaction: async (tx: unknown, input: Record<string, unknown>) => {
        assert.equal(tx, client);
        globalAudits.push(input);
        return { id: '01920000-0000-7000-8000-000000000701', replayed: false };
      },
    }).updateAtomically({
      action: 'PUSH',
      expectedRevision: 5,
      draftId: '01920000-0000-7000-8000-000000000301',
      reason: 'Consume the reviewed draft.',
      changelog: 'Publish reviewed configuration.',
    }, audit);

    assert.deepEqual(result, { kind: 'updated', revision: 6 });
    assert.equal(client.released, true);
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    const settings = client.callContaining('UPDATE price_conversion_test.price_settings SET revision');
    assert.deepEqual(settings.values, [6, 125]);
    const config = client.callContaining('INSERT INTO price_conversion_test.price_config_changes');
    const normalizedDraft = {
      settings: { divergenceThresholdBps: 125, visibleFiatCodes: [] },
      providers: {
        COINGECKO: { ...storedDraft.providers.COINGECKO, refreshIntervalSeconds: 60 },
        ALCHEMY: { ...storedDraft.providers.ALCHEMY, refreshIntervalSeconds: 60 },
        COINMARKETCAP: { ...storedDraft.providers.COINMARKETCAP, refreshIntervalSeconds: 300 },
      },
    };
    assert.deepEqual(config.values, [
      6, 'LIVE', null, 'Publish reviewed configuration.', audit.actorId, JSON.stringify(normalizedDraft),
    ]);
    const draftRead = client.callContaining("WHERE id = $1::uuid AND status = 'DRAFT' FOR UPDATE");
    assert.deepEqual(draftRead.values, ['01920000-0000-7000-8000-000000000301']);
    const draftArchive = client.calls.find(({ sql }) =>
      sql.includes("SET status = 'ARCHIVED'") && sql.includes("WHERE id = $1::uuid AND status = 'DRAFT'"));
    assert.ok(draftArchive);
    assert.deepEqual(draftArchive.values, ['01920000-0000-7000-8000-000000000301']);
    const auditWrite = client.callContaining('INSERT INTO price_conversion_test.price_admin_audit');
    assert.deepEqual(auditWrite.values.slice(0, 7), [
      audit.actorId, audit.sessionId, audit.requestId, audit.ipAddress, audit.deviceId,
      'PRICE_CONFIG_PUSH', 'Consume the reviewed draft.',
    ]);
    const after = JSON.parse(String(auditWrite.values[8])) as Record<string, unknown>;
    assert.deepEqual(after.change, {
      id: '01920000-0000-7000-8000-000000000601',
      revision: 6,
      status: 'LIVE',
      effectiveAt: null,
      changelog: 'Publish reviewed configuration.',
      consumedDraftId: '01920000-0000-7000-8000-000000000301',
    });
    assert.equal(globalAudits.length, 1);
    assert.deepEqual(globalAudits[0], {
      domain: 'PRICE_CONVERSION',
      action: 'SETTINGS.PUSHED',
      eventKey: 'price-conversion:settings.pushed:01920000-0000-7000-8000-000000000601',
      actor: { kind: 'ADMIN', ...audit },
      subject: { type: 'SETTINGS_REVISION', id: '6' },
      reason: 'Consume the reviewed draft.',
      before: {
        revision: 5, status: 'LIVE', effectiveAt: null,
        config: {
          divergenceThresholdBps: 500,
          visibleFiatCodes: [],
          providers: {
            COINGECKO: { enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
            ALCHEMY: { enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
            COINMARKETCAP: { enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
          },
        },
      },
      after: {
        revision: 6, status: 'LIVE', effectiveAt: null,
        config: {
          divergenceThresholdBps: 125,
          visibleFiatCodes: [],
          providers: {
            COINGECKO: { enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
            ALCHEMY: { enabled: true, role: 'PRIMARY', viewEnabled: false, refreshIntervalSeconds: 60 },
            COINMARKETCAP: { enabled: true, role: 'FALLBACK', viewEnabled: true, refreshIntervalSeconds: 300 },
          },
        },
      },
      metadata: {
        configurationRevision: 6,
        configChangeId: '01920000-0000-7000-8000-000000000601',
        changelog: 'Publish reviewed configuration.',
      },
    });
  });

  it('applies a provider-only PUSH and preserves an unrelated draft', async () => {
    const module = await moduleOrEmpty('./price-conversion.configuration-writer.js');
    assert.ok(module.PriceConversionConfigurationWriter);
    const client = new DraftClient(draftConfiguration());
    const Writer = module.PriceConversionConfigurationWriter as new (database: unknown, audit: unknown) => {
      updateAtomically(
        input: PriceConversionPatch,
        audit: PriceConversionAuditContext,
      ): Promise<PriceConversionUpdateResult>;
    };
    const result = await new Writer({
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
    }, { appendWithTransaction: async () => ({
      id: '01920000-0000-7000-8000-000000000701', replayed: false,
    }) }).updateAtomically({
      action: 'PUSH',
      expectedRevision: 5,
      reason: 'Update provider settings.',
      changelog: 'Provider configuration.',
      divergenceThresholdBps: 333,
    }, {
      actorId: '01920000-0000-7000-8000-000000000010',
      sessionId: 'session-11',
      requestId: '01920000-0000-7000-8000-000000000012',
      ipAddress: '203.0.113.8',
      deviceId: 'device-13',
    });

    assert.deepEqual(result, { kind: 'updated', revision: 6 });
    assert.equal(client.calls.some(({ sql }) => sql.includes("status = 'DRAFT' FOR UPDATE")), false);
    assert.equal(client.calls.some(({ sql }) =>
      sql.includes("SET status = 'ARCHIVED'") && sql.includes("status = 'DRAFT'")), false);
    assert.equal(client.calls.some(({ sql }) =>
      /(?:INSERT INTO|UPDATE) price_conversion_test\.(?:currencies|currency_provider_refs)/.test(sql)),
    false);
    const config = client.callContaining('INSERT INTO price_conversion_test.price_config_changes');
    const persisted = JSON.parse(String(config.values[5])) as PersistedPriceConfiguration;
    assert.equal(persisted.settings.divergenceThresholdBps, 333);
    assert.equal('currencyUpserts' in persisted, false);
  });
});

function provider(code: string, role: string, viewEnabled: boolean): Record<string, unknown> {
  return {
    code, enabled: true, role, viewEnabled, revision: 2, refreshIntervalSeconds: 30,
    referenceCount: 1, trackedCurrencies: 1, healthyCurrencies: 1,
    lastSuccessAt: '2026-08-31T08:00:00Z', lastErrorAt: null,
    healthUpdatedAt: '2026-08-31T08:00:01Z', dailyRequests: 7, monthlyRequests: 70,
  };
}

function change(status: string, revision: number, effectiveAt: string | null): Record<string, unknown> {
  return {
    id: `01920000-0000-7000-8000-00000000040${revision}`,
    revision, status, effectiveAt,
    effectiveAtCursor: effectiveAt === null ? null : exactTestTimestamp(effectiveAt),
    changelog: status, actorId: null, config: {},
    createdAt: '2026-08-31T08:00:00Z', appliedAt: status === 'LIVE' ? '2026-08-31T08:00:00Z' : null,
  };
}

function historyRow(kind: string, suffix: string, createdAt: string, payload: Record<string, unknown>) {
  return {
    id: `01920000-0000-7000-8000-000000000${suffix}`,
    createdAt,
    cursorCreatedAt: exactTestTimestamp(createdAt),
    kind,
    payload,
  };
}

function exactTestTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

function draftConfiguration(): PersistedPriceConfiguration {
  return {
    settings: { divergenceThresholdBps: 125 },
    providers: {
      COINGECKO: { enabled: true, sensitiveRole: 'COMPARISON', viewEnabled: false },
      ALCHEMY: { enabled: true, sensitiveRole: 'PRIMARY', viewEnabled: false },
      COINMARKETCAP: { enabled: true, sensitiveRole: 'FALLBACK', viewEnabled: true },
    },
  };
}

/** Minimal transactional double; only PostgreSQL itself remains covered by the deferred integration suite. */
class DraftClient {
  readonly calls: QueryCall[] = [];
  released = false;

  constructor(private readonly storedDraft: PersistedPriceConfiguration) {}

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql.includes('FROM price_conversion_test.price_settings')) {
      return { rows: [{ liveRevision: 5, divergenceThresholdBps: 500 }] };
    }
    if (sql.includes('FROM price_conversion_test.price_config_changes')
      && sql.includes('MAX(revision)')) return { rows: [{ revision: 5 }] };
    if (sql.includes('FROM price_conversion_test.price_providers ORDER BY')) {
      return { rows: [
        { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
        { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
        { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
      ] };
    }
    if (sql.includes("status = 'DRAFT' FOR UPDATE")) {
      return { rows: [{ id: '01920000-0000-7000-8000-000000000301', config: this.storedDraft }] };
    }
    if (sql.includes('INSERT INTO price_conversion_test.price_config_changes')) {
      return { rows: [{ id: '01920000-0000-7000-8000-000000000601' }] };
    }
    return { rows: [] };
  }

  callContaining(fragment: string): QueryCall {
    const call = this.calls.find(({ sql }) => sql.includes(fragment));
    assert.ok(call, `missing query: ${fragment}`);
    return call;
  }

  release(): void {
    this.released = true;
  }
}
