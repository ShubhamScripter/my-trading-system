import assert from 'node:assert/strict';
import { test } from 'node:test';

import { walletLogoCleanupScheduledFor } from '../logo-cleanup-schedule.js';

const database = (scheduledFor: unknown, queries: string[] = []) => ({
  async transaction<T>(work: (client: unknown) => Promise<T>) {
    return work({
      async query(sql: string) {
        queries.push(sql);
        return { rows: [{ scheduled_for: scheduledFor }] };
      },
    });
  },
});

test('logo cleanup derives its exact five-minute bucket from PostgreSQL time', async () => {
  const queries: string[] = [];
  const scheduledFor = await walletLogoCleanupScheduledFor(
    database(new Date('2026-09-08T12:35:00.000Z'), queries) as never,
  );

  assert.equal(scheduledFor.toISOString(), '2026-09-08T12:35:00.000Z');
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /clock_timestamp\(\)/);
  assert.match(queries[0]!, /\/300\)\*300/);
});

test('logo cleanup rejects invalid or unaligned database schedule values', async () => {
  for (const value of [null, 'invalid', new Date('2026-09-08T12:35:00.001Z')]) {
    await assert.rejects(
      () => walletLogoCleanupScheduledFor(database(value) as never),
      /WALLET_LOGO_CLEANUP_SCHEDULE_INVALID/,
    );
  }
});
