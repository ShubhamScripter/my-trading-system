import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PriceConversionBootstrapRepository } from './price-conversion.bootstrap-repository.js';
import { PriceConversionHistoryRepository } from './price-conversion.history-repository.js';
import { PriceConversionPriceRepository } from './price-conversion.price-repository.js';

const EARLIER = '2026-09-10T08:00:00.123456Z';
const LATER = '2026-09-10T08:00:00.123789Z';
const EARLIER_ID = '01940000-0000-7000-8000-000000000999';
const LATER_ID = '01940000-0000-7000-8000-000000000001';

function cursorTuple(cursor: string | null): readonly [string, string, string] {
  assert.ok(cursor);
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string, string];
}

function timestampKey(value: string): string {
  const matched = /^(.*\.)(\d{3})(\d{0,3})Z$/.exec(value);
  assert.ok(matched);
  return `${matched[1] ?? ''}${matched[2] ?? ''}${(matched[3] ?? '').padEnd(3, '0')}Z`;
}

function afterCursor(
  rows: readonly { exact: string; id: string }[],
  cursor: readonly [string, string] | null,
  direction: 'asc' | 'desc',
) {
  const ordered = [...rows].sort((left, right) => {
    const compared = left.exact.localeCompare(right.exact) || left.id.localeCompare(right.id);
    return direction === 'asc' ? compared : -compared;
  });
  if (cursor === null) return ordered;
  const cursorKey = `${timestampKey(cursor[0])}:${cursor[1]}`;
  return ordered.filter((row) => {
    const rowKey = `${row.exact}:${row.id}`;
    return direction === 'asc' ? rowKey > cursorKey : rowKey < cursorKey;
  });
}

describe('microsecond cursor precision', () => {
  for (const direction of ['asc', 'desc'] as const) {
    it(`traverses same-millisecond history exactly once in ${direction} order`, async () => {
      const source = [
        { exact: EARLIER, id: EARLIER_ID },
        { exact: LATER, id: LATER_ID },
      ];
      const database = {
        priceConversionSchema: 'price_conversion_test',
        query: async (sql: string, values: readonly unknown[]) => {
          const cursor = values.length === 3
            ? [String(values[0]), String(values[1])] as const
            : null;
          const rows = afterCursor(source, cursor, direction).slice(0, Number(values.at(-1))).map((row) => ({
            id: row.id,
            createdAt: new Date(row.exact),
            cursorCreatedAt: row.exact,
            kind: 'RESOLUTION',
            payload: {
              currencyId: '01940000-0000-7000-8000-000000000010',
              reason: 'PRIMARY_CONFIRMED', priceUsd: '1.25', observedAt: row.exact,
              provider: 'COINGECKO', snapshotId: row.id, stale: false,
            },
          }));
          assert.match(sql, new RegExp(`ORDER BY created_at ${direction.toUpperCase()}`));
          return { rows };
        },
      };
      const repository = new PriceConversionHistoryRepository(database as never);
      const first = await repository.history({ limit: 1, sortDirection: direction });
      const firstCursor = cursorTuple(first.nextCursor);
      const second = await repository.history({ limit: 1, sortDirection: direction,
        cursor: first.nextCursor ?? undefined });

      assert.equal(firstCursor[0], direction === 'asc' ? EARLIER : LATER);
      assert.deepEqual([...first.items, ...second.items].map((item) => item.id),
        direction === 'asc' ? [EARLIER_ID, LATER_ID] : [LATER_ID, EARLIER_ID]);
      assert.equal(second.nextCursor, null);
      assert.equal(first.items[0]?.createdAt, '2026-09-10T08:00:00.123Z');
    });

    it(`traverses same-millisecond latest prices exactly once in ${direction} order`, async () => {
      const source = [
        { exact: EARLIER, id: EARLIER_ID },
        { exact: LATER, id: LATER_ID },
      ];
      const database = {
        priceConversionSchema: 'price_conversion_test',
        query: async (_sql: string, values: readonly unknown[]) => {
          const cursor = values.length === 3
            ? [String(values[0]), String(values[1])] as const
            : null;
          return { rows: afterCursor(source, cursor, direction)
            .slice(0, Number(values.at(-1))).map((row, index) => ({
              id: row.id,
              currencyId: `01940000-0000-7000-8000-00000000001${index}`,
              priceUsd: '1.25', observedAt: row.exact,
              updatedAt: new Date(row.exact), cursorUpdatedAt: row.exact,
              provider: 'COINGECKO', snapshotId: row.id, stale: false,
              disabled: false, reason: 'PRIMARY_CONFIRMED',
            })) };
        },
      };
      const repository = new PriceConversionPriceRepository(database as never);
      const first = await repository.prices({ limit: 1, sortBy: 'updatedAt', sortDirection: direction });
      const firstCursor = cursorTuple(first.nextCursor);
      const second = await repository.prices({ limit: 1, sortBy: 'updatedAt', sortDirection: direction,
        cursor: first.nextCursor ?? undefined });

      assert.equal(firstCursor[0], direction === 'asc' ? EARLIER : LATER);
      assert.deepEqual([...first.items, ...second.items].map((item) => item.snapshotId),
        direction === 'asc' ? [EARLIER_ID, LATER_ID] : [LATER_ID, EARLIER_ID]);
      assert.equal(second.nextCursor, null);
      assert.equal(first.items[0]?.updatedAt, '2026-09-10T08:00:00.123Z');
    });
  }

  it('orders and cursors scheduled changes by exact effectiveAt before display mapping', async () => {
    const client = {
      async query(sql: string) {
        if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('price_settings')) return { rows: [{
          revision: 7, divergenceThresholdBps: 125, securityState: 'HEALTHY',
          updatedAt: '2026-09-10T08:00:00Z',
        }] };
        if (sql.includes('price_providers p')) return { rows: [] };
        if (sql.includes('price_config_changes')) return { rows: [
          scheduledRow(LATER_ID, LATER, 9), scheduledRow(EARLIER_ID, EARLIER, 8),
        ] };
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PriceConversionBootstrapRepository({
      priceConversionSchema: 'price_conversion_test', connect: async () => client,
    } as never);
    const page = await repository.bootstrap({ scheduledLimit: 1 });

    assert.equal(page.configuration.scheduled[0]?.id, EARLIER_ID);
    assert.equal(page.configuration.scheduled[0]?.effectiveAt, '2026-09-10T08:00:00.123Z');
    assert.equal(cursorTuple(page.configuration.scheduledNextCursor)[0], EARLIER);
  });
});

function scheduledRow(id: string, exact: string, revision: number) {
  return {
    id, revision, status: 'SCHEDULED', effectiveAt: new Date(exact), effectiveAtCursor: exact,
    changelog: 'Microsecond schedule.', actorId: null, config: {},
    createdAt: '2026-09-10T07:00:00Z', appliedAt: null,
  };
}
