import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type QueryCall = { readonly sql: string; readonly values: readonly unknown[] };

describe('bootstrap snapshot transaction', () => {
  it('uses one repeatable-read client snapshot while a concurrent PUSH advances live state', async () => {
    const module = await import('./price-conversion.bootstrap-repository.js');
    const client = new SnapshotClient();
    const pool = {
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
      query: async () => { throw new Error('pool query escaped snapshot client'); },
    };

    const result = await new module.PriceConversionBootstrapRepository(pool as never).bootstrap({});

    assert.equal(client.liveRevision, 8);
    assert.equal(result.settings.revision, 7);
    assert.equal(result.configuration.live?.revision, 7);
    assert.equal(result.configuration.live?.config && (result.configuration.live.config as { revision: number }).revision, 7);
    assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
    assert.equal(client.calls.filter(({ sql }) => !['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT']
      .includes(sql)).length, 4);
    assert.equal(client.released, true);
  });

  it('rolls back and releases the checked-out client when a snapshot query fails', async () => {
    const module = await import('./price-conversion.bootstrap-repository.js');
    const client = new SnapshotClient(true);
    const pool = {
      priceConversionSchema: 'price_conversion_test',
      connect: async () => client,
      query: async () => { throw new Error('pool query escaped snapshot client'); },
    };

    await assert.rejects(
      () => new module.PriceConversionBootstrapRepository(pool as never).bootstrap({}),
      /snapshot read failed/,
    );
    assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(client.released, true);
  });
});

class SnapshotClient {
  readonly calls: QueryCall[] = [];
  liveRevision = 7;
  released = false;
  private snapshotRevision = 0;
  private queryActive = false;

  constructor(private readonly failReads = false) {}

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
      this.snapshotRevision = this.liveRevision;
      this.liveRevision = 8;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
    if (this.failReads) throw new Error('snapshot read failed');
    if (this.queryActive) throw new Error('snapshot client query overlap');
    this.queryActive = true;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    this.queryActive = false;
    if (sql.includes('FROM price_conversion_test.price_settings')) {
      return { rows: [{
        revision: this.snapshotRevision,
        divergenceThresholdBps: 125,
        updatedAt: '2026-09-01T00:00:00Z',
      }] };
    }
    if (sql.includes('FROM price_conversion_test.price_providers p')) return { rows: [] };
    if (sql.includes('FROM price_conversion_test.price_resolutions r')) return { rows: [] };
    if (sql.includes('FROM price_conversion_test.price_config_changes')) {
      return { rows: [{
        id: '01920000-0000-7000-8000-000000000301',
        revision: this.snapshotRevision,
        status: 'LIVE',
        effectiveAt: null,
        changelog: 'Concurrent snapshot.',
        actorId: null,
        config: { revision: this.snapshotRevision },
        createdAt: '2026-09-01T00:00:00Z',
        appliedAt: '2026-09-01T00:00:00Z',
      }] };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}
