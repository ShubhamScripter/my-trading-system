import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type pg from 'pg';

// Explicit root-reserved DB window only; the imported guard also checks exact URL and Docker identity.
const live = process.env.WALLET_CORE_LOGO_MIGRATION_TEST === 'true';
const loadModule = createRequire(__filename);

test('forward logo reason accepts truthful counts only for its PARTIAL job and preserves old reasons', { skip: !live }, async () => {
  const { assertSafeWalletCoreTestDatabase } = loadModule('../provision-test-database.cjs') as {
    assertSafeWalletCoreTestDatabase(): Promise<pg.Pool>;
  };
  const pool = await assertSafeWalletCoreTestDatabase();
  const client = await pool.connect();
  let ordinal = 0;
  const started = new Date();
  const transition = async (job: string, status: string, reason: string | null,
    processed = 1, failed = 1, skipped = 0) => {
    ordinal++;
    const id = randomUUID();
    await client.query(`INSERT INTO wallet_core_test.cronjob_runs
      (id,job_name,scheduled_for,worker_instance_id,status,started_at,lease_expires_at)
      VALUES ($1,$2,$3,'logo-migration-regression','RUNNING',$4,$5)`,
    [id, job, new Date(started.valueOf() + ordinal), started,
      new Date(started.valueOf() + 300_000)]);
    return client.query(`UPDATE wallet_core_test.cronjob_runs SET
      status=$2::text::wallet_core_test."WalletCronStatus",safe_error_code=$3,
      processed_count=$4,failed_count=$5,skipped_bucket_count=$6,
      finished_at=CASE WHEN $2::text='RUNNING' THEN NULL::timestamptz ELSE $7::timestamptz END,
      lease_expires_at=CASE WHEN $2::text='RUNNING' THEN lease_expires_at ELSE NULL::timestamptz END
      WHERE id=$1`, [id, status, reason, processed, failed, skipped, started]);
  };
  try {
    await client.query('BEGIN');
    for (const [processed, failed] of [[0, 3], [1, 3], [4, 2]] as const) {
      await transition('wallet-logo-cleanup', 'PARTIAL', 'LOGO_CLEANUP_PARTIAL', processed, failed);
    }
    const invalid: readonly (readonly [string, string, string | null, number, number, number,
      '23514' | '55000'])[] = [
      ['wrong-job', 'PARTIAL', 'LOGO_CLEANUP_PARTIAL', 1, 1, 0, '23514'],
      ...['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'].map(status =>
        ['wallet-logo-cleanup', status, 'LOGO_CLEANUP_PARTIAL', 1, 1, 0,
          '23514'] as const),
      ['wallet-logo-cleanup', 'PARTIAL', 'LOGO_CLEANUP_PARTIAL', 1, 0, 0, '23514'],
      ['wallet-logo-cleanup', 'PARTIAL', 'LOGO_CLEANUP_PARTIAL', 1, 1, 1, '23514'],
      ['wallet-logo-cleanup', 'PARTIAL', 'LOGO_CLEANUP_PARTIAL', -1, 1, 0, '55000'],
      ['old-job', 'PARTIAL', null, 1, 1, 0, '23514'],
      ['old-job', 'PARTIAL', 'UNEXPECTED_ERROR', 1, 1, 0, '23514'],
      ['old-job', 'FAILED', 'PROVIDER_OBSERVATION_PARTIAL', 0, 1, 0, '23514'],
      ['old-job', 'SKIPPED', 'CATCHUP_TRUNCATED', 0, 0, 0, '23514'],
    ];
    for (const row of invalid) {
      const expectedCode = row.at(-1)!;
      await client.query('SAVEPOINT invalid_logo_completion');
      await assert.rejects(transition(...row.slice(0, -1) as Parameters<typeof transition>),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error
          && error.code === expectedCode);
      await client.query('ROLLBACK TO SAVEPOINT invalid_logo_completion');
      await client.query('RELEASE SAVEPOINT invalid_logo_completion');
    }
    for (const reason of ['CONFIGURATION_REJECTED', 'PROVIDER_OBSERVATION_PARTIAL',
      'LIFECYCLE_PARTIAL', 'RECONCILIATION_PARTIAL']) await transition('old-job', 'PARTIAL', reason);
    for (const reason of ['PROVIDER_OBSERVATION_FAILED', 'DEPENDENCY_UNAVAILABLE', 'UNEXPECTED_ERROR']) {
      await transition('old-job', 'FAILED', reason, 0, 1);
    }
    await transition('old-job', 'SUCCESS', null, 1, 0);
    await transition('old-job', 'SKIPPED', 'MISSED_SCHEDULE', 0, 0);
    await transition('old-job', 'SKIPPED', 'CATCHUP_TRUNCATED', 0, 0, 2);
    const counts = await client.query(`SELECT processed_count,failed_count FROM wallet_core_test.cronjob_runs
      WHERE worker_instance_id='logo-migration-regression' AND safe_error_code::text='LOGO_CLEANUP_PARTIAL'
      ORDER BY scheduled_for`);
    assert.deepEqual(counts.rows, [
      { processed_count: 0, failed_count: 3 }, { processed_count: 1, failed_count: 3 },
      { processed_count: 4, failed_count: 2 },
    ]);
  } finally {
    try { await client.query('ROLLBACK'); }
    finally { client.release(); await pool.end(); }
  }
});
