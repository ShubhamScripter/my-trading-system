import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PriceConversionBootstrapRepository } from './price-conversion.bootstrap-repository.js';
import { PriceConversionConfigurationWriter } from './price-conversion.configuration-writer.js';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import type { PriceConversionPool } from './price-conversion.database.js';

const PATCH = { action: 'PUSH' as const, expectedRevision: 5, reason: 'Transaction cleanup regression', changelog: 'Cleanup regression', divergenceThresholdBps: 126 };
const AUDIT = {
  actorId: '01920000-0000-7000-8000-000000000010', sessionId: 'session-11',
  requestId: '01920000-0000-7000-8000-000000000012', ipAddress: '203.0.113.8', deviceId: 'device-13',
};
const GLOBAL_AUDIT = { appendWithTransaction: async () => ({
  id: '01920000-0000-7000-8000-000000000701', replayed: false,
}) };

class SqlClient {
  readonly calls: string[] = [];
  readonly releases: (boolean | undefined)[] = [];
  revision = 5;
  failureAt?: 'BEGIN' | 'body' | 'COMMIT';
  originalError = new Error('original transaction failure');
  rollbackError?: Error;
  releaseError?: Error;

  async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push(sql);
    if ((this.failureAt === 'BEGIN' && sql.startsWith('BEGIN'))
      || (this.failureAt === 'COMMIT' && sql === 'COMMIT')
      || (this.failureAt === 'body' && sql.includes('price_settings'))) throw this.originalError;
    if (sql === 'ROLLBACK' && this.rollbackError) throw this.rollbackError;
    if (sql.includes('FROM price_conversion_test.price_settings')) return { rows: [{
      liveRevision: 5, revision: 5, divergenceThresholdBps: 125, updatedAt: '2026-09-01T00:00:00Z',
    }] };
    if (sql.includes('SELECT GREATEST(') && sql.includes('price_config_changes')) {
      return { rows: [{ revision: this.revision }] };
    }
    if (sql.includes('FROM price_conversion_test.price_providers ORDER BY')) return { rows: [
      { code: 'COINGECKO', enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
      { code: 'ALCHEMY', enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 60 },
      { code: 'COINMARKETCAP', enabled: true, role: 'FALLBACK', viewEnabled: false, refreshIntervalSeconds: 300 },
    ] };
    if (sql.includes('INSERT INTO price_conversion_test.price_config_changes')) {
      return { rows: [{ id: '01920000-0000-7000-8000-000000000601' }] };
    }
    return { rows: [] };
  }

  release(discard?: boolean): void {
    this.releases.push(discard);
    if (this.releaseError) throw this.releaseError;
  }
}

function pool(client: SqlClient): PriceConversionPool {
  return { priceConversionSchema: 'price_conversion_test', connect: async () => client } as unknown as PriceConversionPool;
}

const callers = [
  { name: 'writer', begin: 'BEGIN', run: (client: SqlClient) => new PriceConversionConfigurationWriter(pool(client), GLOBAL_AUDIT).updateAtomically(PATCH, AUDIT) },
  { name: 'bootstrap', begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', run: (client: SqlClient) => new PriceConversionBootstrapRepository(pool(client)).bootstrap({}) },
];

for (const caller of callers) {
  for (const phase of ['BEGIN', 'body', 'COMMIT'] as const) {
    for (const cleanup of ['rollback', 'release', 'both'] as const) {
      test(`${caller.name}: ${phase} preserves original error through ${cleanup} failure`, async () => {
        const client = new SqlClient();
        client.failureAt = phase;
        if (cleanup !== 'release') client.rollbackError = new Error('rollback failed');
        if (cleanup !== 'rollback') client.releaseError = new Error('release failed');
        await assert.rejects(() => caller.run(client), (caught: unknown) => {
          assert.strictEqual(caught, client.originalError);
          return true;
        });
        assert.equal(client.calls[0], caller.begin);
        assert.equal(client.calls.filter(sql => sql === 'ROLLBACK').length, 1);
        assert.deepEqual(client.releases, [cleanup === 'release' ? undefined : true]);
        assert.equal(client.calls.includes('COMMIT'), phase === 'COMMIT');
        if (phase === 'BEGIN') assert.equal(client.calls.length, 2);
      });
    }
  }

  test(`${caller.name}: success commits and releases once`, async () => {
    const client = new SqlClient();
    const result = await caller.run(client);
    if ('kind' in result) assert.deepEqual(result, { kind: 'updated', revision: 6 });
    else assert.equal(result.settings.revision, 5);
    assert.equal(client.calls[0], caller.begin);
    assert.equal(client.calls.at(-1), 'COMMIT');
    assert.equal(client.calls.filter(sql => sql === 'COMMIT').length, 1);
    assert.equal(client.calls.includes('ROLLBACK'), false);
    assert.deepEqual(client.releases, [undefined]);
  });

  test(`${caller.name}: successful transaction surfaces release failure without rollback`, async () => {
    const client = new SqlClient();
    client.releaseError = new Error('release failed');
    await assert.rejects(() => caller.run(client), (caught: unknown) => caught === client.releaseError);
    assert.equal(client.calls.at(-1), 'COMMIT');
    assert.equal(client.calls.includes('ROLLBACK'), false);
    assert.deepEqual(client.releases, [undefined]);
  });
}

for (const failedCleanup of [false, true]) {
  test(`writer: revision conflict rolls back once without writes or commit (cleanup fails: ${failedCleanup})`, async () => {
    const client = new SqlClient();
    client.revision = 8;
    if (failedCleanup) {
      client.rollbackError = new Error('rollback failed');
      client.releaseError = new Error('release failed');
    }
    assert.deepEqual(await callers[0]!.run(client), { kind: 'revision_conflict', actualRevision: 8 });
    assert.equal(client.calls.filter(sql => sql === 'ROLLBACK').length, 1);
    assert.equal(client.calls.some(sql => /^(COMMIT|UPDATE|INSERT|DELETE)/.test(sql)), false);
    assert.deepEqual(client.releases, [failedCleanup ? true : undefined]);
  });
}

for (const code of ['23503', '23505', '23514']) {
  test(`writer: ${code} keeps safe validation mapping after rollback and release fail`, async () => {
    const client = new SqlClient();
    client.failureAt = 'body';
    client.originalError = Object.assign(new Error('sensitive database detail'), { code });
    client.rollbackError = new Error('rollback failed');
    client.releaseError = new Error('release failed');
    await assert.rejects(() => callers[0]!.run(client), (caught: unknown) =>
      caught instanceof PriceConfigurationValidationError && caught.status === 400
      && !caught.message.includes('sensitive database detail'));
    assert.deepEqual(client.releases, [true]);
  });
}
