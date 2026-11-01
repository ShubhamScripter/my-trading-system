import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WalletCronjobRepository, type WalletCronjobCompletion, type WalletCronjobLease } from '../cronjob.repository.js';
import { WalletCoreDatabase, WALLET_CORE_TEST_SCHEMAS, type WalletCoreClient } from '../wallet-core.database.js';

const lease: WalletCronjobLease = {
  id: '01990000-0000-7000-8000-000000000001', jobName: 'wallet-logo-cleanup',
  scheduledFor: '2026-09-08T00:00:00.000Z', workerInstanceId: 'logo-completion-test',
  attemptCount: 1, leaseExpiresAt: '2026-09-08T00:05:00.000Z', startedAt: '2026-09-08T00:00:00.000Z',
};
function fixture() {
  let connections = 0;
  const updates: unknown[][] = [];
  const client: WalletCoreClient = {
    async query(sql, values) {
      if (sql.startsWith('UPDATE ')) updates.push([...(values ?? [])]);
      else assert.ok(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock'));
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const database = WalletCoreDatabase.validatedTest({
    async connect() { connections++; return client; }, async end() {},
  }, WALLET_CORE_TEST_SCHEMAS);
  return { repository: new WalletCronjobRepository(database), updates, connections: () => connections };
}
const partial = (processedCount: number, failedCount: number) => ({
  status: 'PARTIAL', safeErrorCode: 'LOGO_CLEANUP_PARTIAL', skippedBucketCount: 0,
  processedCount, failedCount,
} as const satisfies WalletCronjobCompletion);

for (const [processed, failed] of [[0, 3], [1, 3], [4, 2]] as const) {
  test(`logo completion preserves ${processed} successes and ${failed} failures`, async () => {
    const { repository, updates } = fixture();
    await repository.complete(lease, partial(processed, failed));
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]!.slice(5), ['PARTIAL', 'LOGO_CLEANUP_PARTIAL', 0, processed, failed]);
  });
}

test('logo reason rejects zero failures, other statuses/jobs and skipped buckets before SQL', async () => {
  const cases = [
    [lease, partial(1, 0)],
    [{ ...lease, jobName: 'wallet-provider-status' }, partial(1, 1)],
    [lease, { ...partial(1, 1), status: 'FAILED' }],
    [lease, { ...partial(1, 1), status: 'SUCCESS' }],
    [lease, { ...partial(1, 1), skippedBucketCount: 1 }],
    [lease, partial(-1, 1)],
  ] as const;
  for (const [job, completion] of cases) {
    const f = fixture();
    await assert.rejects(f.repository.complete(job, completion as WalletCronjobCompletion), /WALLET_CRON_(OUTCOME|COUNT)_INVALID/);
    assert.equal(f.connections(), 0);
  }
});

test('other PARTIAL reasons retain their existing processed/failed invariants', async () => {
  for (const safeErrorCode of ['CONFIGURATION_REJECTED', 'PROVIDER_OBSERVATION_PARTIAL'] as const) {
    const f = fixture();
    await assert.rejects(f.repository.complete(lease, { ...partial(0, 2), safeErrorCode }), /WALLET_CRON_OUTCOME_INVALID/);
    await assert.rejects(f.repository.complete(lease, { ...partial(1, 2), safeErrorCode }), /WALLET_CRON_OUTCOME_INVALID/);
    await f.repository.complete(lease, { ...partial(2, 1), safeErrorCode });
    assert.equal(f.updates.length, 1);
  }
});
