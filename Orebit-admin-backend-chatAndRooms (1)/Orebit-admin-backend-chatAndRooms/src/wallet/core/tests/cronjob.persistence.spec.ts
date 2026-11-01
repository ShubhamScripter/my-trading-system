import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import {
  WalletCronLeaseLost,
  WalletCronjobRepository,
  type WalletCronjobLease,
} from '../cronjob.repository.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import {
  walletPositiveSkippedBucketCount,
  type WalletCronRunOutcome,
} from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;

class Client implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void { this.client.release(); }
}

class Pool implements WalletCorePool {
  constructor(readonly pool: pg.Pool) {}
  async connect(): Promise<WalletCoreClient> { return new Client(await this.pool.connect()); }
  async end(): Promise<void> { await this.pool.end(); }
}

const job = (prefix: string): string => `${prefix}-${randomUUID()}`;
const bucket = (periodMs: 60_000 | 300_000, offset = 1): Date =>
  new Date(Math.floor(Date.now() / periodMs) * periodMs - offset * periodMs);
type Completion = Parameters<WalletCronjobRepository['complete']>[1];

describe('Wallet Cron runtime persistence', { skip: !LIVE }, () => {
  let raw: pg.Pool;
  let repository: WalletCronjobRepository;

  before(() => {
    raw = new pg.Pool({ connectionString: TEST_URL, max: 6 });
    const database = createValidatedWalletCoreTestDatabase(
      new Pool(raw), WALLET_CORE_TEST_SCHEMAS,
    );
    repository = new WalletCronjobRepository(database);
  });
  after(async () => { await raw?.end(); });

  it('excludes replica claims and uses a renewable DB-clock five-minute fenced lease', async () => {
    const scheduledFor = bucket(60_000);
    const jobName = job('task7-lease');
    const claims: (WalletCronjobLease | null)[] = await Promise.all([
      repository.claim({ jobName, scheduledFor, periodMs: 60_000,
        workerInstanceId: 'task7-worker-a' }),
      repository.claim({ jobName, scheduledFor, periodMs: 60_000,
        workerInstanceId: 'task7-worker-b' }),
    ]);
    const lease = claims.find((entry): entry is WalletCronjobLease => entry !== null);
    assert.ok(lease);
    assert.equal(claims.filter((entry) => entry !== null).length, 1);
    assert.equal(lease.attemptCount, 1);

    const initial = (await raw.query(`SELECT started_at,lease_expires_at,
      extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS seconds
      FROM wallet_core_test.cronjob_runs WHERE id=$1`, [lease.id])).rows[0];
    assert.ok(initial.seconds > 295 && initial.seconds <= 300, String(initial.seconds));
    const startedAt = initial.started_at as Date;
    const firstExpiry = initial.lease_expires_at as Date;

    await repository.withFencedTransaction(lease, async (client: WalletCoreClient) => {
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET processed_count=1
        WHERE id=$1`, [lease.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const renewed = await repository.renew(lease);
    assert.equal(renewed.id, lease.id);
    assert.equal(renewed.workerInstanceId, lease.workerInstanceId);
    assert.equal(renewed.attemptCount, 1);
    assert.ok(new Date(renewed.leaseExpiresAt).getTime() > firstExpiry.getTime());

    const rolledBackEventId = randomUUID();
    await assert.rejects(() => repository.withFencedTransaction(
      renewed, async (client: WalletCoreClient) => {
        await client.query(`INSERT INTO wallet_core_test.state_events
          (id,event_type,subject_type,subject_id,run_id,payload)
          VALUES ($1,'TASK7.FENCE_PROBE','CHAIN',$2,$3,'{}'::jsonb)`,
        [rolledBackEventId, randomUUID(), lease.id]);
        await client.query(`ALTER TABLE wallet_core_test.cronjob_runs
          DISABLE TRIGGER cronjob_runs_lease_guard`);
        await client.query(`UPDATE wallet_core_test.cronjob_runs
          SET lease_expires_at=clock_timestamp() WHERE id=$1`, [lease.id]);
        await client.query(`ALTER TABLE wallet_core_test.cronjob_runs
          ENABLE TRIGGER cronjob_runs_lease_guard`);
      },
    ), (error) => error instanceof WalletCronLeaseLost);
    assert.deepEqual((await raw.query(`SELECT status::text,
      lease_expires_at>clock_timestamp() AS leased,
      (SELECT count(*)::int FROM wallet_core_test.state_events WHERE id=$2) AS event_count
      FROM wallet_core_test.cronjob_runs WHERE id=$1`,
    [lease.id, rolledBackEventId])).rows[0], {
      status: 'RUNNING', leased: true, event_count: 0,
    });

    await raw.query(`ALTER TABLE wallet_core_test.cronjob_runs
      DISABLE TRIGGER cronjob_runs_lease_guard`);
    try {
      await raw.query(`UPDATE wallet_core_test.cronjob_runs
        SET lease_expires_at=clock_timestamp() WHERE id=$1`, [lease.id]);
    } finally {
      await raw.query(`ALTER TABLE wallet_core_test.cronjob_runs
        ENABLE TRIGGER cronjob_runs_lease_guard`);
    }
    await assert.rejects(
      () => repository.withFencedTransaction(renewed, async () => undefined),
      (error) => error instanceof WalletCronLeaseLost,
    );
    assert.equal((await raw.query(`SELECT status::text FROM wallet_core_test.cronjob_runs
      WHERE id=$1`, [lease.id])).rows[0].status, 'RUNNING');

    const reclaimed = await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'task7-worker-c',
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, lease.id);
    assert.equal(reclaimed.attemptCount, 2);
    const reclaimedRow = (await raw.query(`SELECT started_at,worker_instance_id,attempt_count,
      lease_expires_at>clock_timestamp() AS leased FROM wallet_core_test.cronjob_runs
      WHERE id=$1`, [lease.id])).rows[0];
    assert.deepEqual(reclaimedRow, {
      started_at: startedAt, worker_instance_id: 'task7-worker-c', attempt_count: 2, leased: true,
    });
    await repository.complete(reclaimed, {
      status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
      processedCount: 1, failedCount: 0,
    });
    assert.deepEqual((await raw.query(`SELECT status::text,lease_expires_at,safe_error_code
      FROM wallet_core_test.cronjob_runs WHERE id=$1`, [lease.id])).rows[0], {
      status: 'SUCCESS', lease_expires_at: null, safe_error_code: null,
    });
  });

  it('renews on the caller transaction and rolls it back for a stale owner', async () => {
    const jobName = job('task7-client-renew');
    const scheduledFor = bucket(300_000);
    const first = await repository.claim({
      jobName, scheduledFor, periodMs: 300_000, workerInstanceId: 'client-renew-worker-a',
    });
    assert.ok(first);
    const initialExpiry = new Date(first.leaseExpiresAt);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const renewed = await repository.withFencedTransaction(first, (client) =>
      repository.renewWithClient(client, first));
    assert.ok(new Date(renewed.leaseExpiresAt) > initialExpiry);

    await raw.query(`ALTER TABLE wallet_core_test.cronjob_runs
      DISABLE TRIGGER cronjob_runs_lease_guard`);
    try {
      await raw.query(`UPDATE wallet_core_test.cronjob_runs
        SET lease_expires_at=clock_timestamp() WHERE id=$1`, [first.id]);
    } finally {
      await raw.query(`ALTER TABLE wallet_core_test.cronjob_runs
        ENABLE TRIGGER cronjob_runs_lease_guard`);
    }
    const reclaimed = await repository.claim({
      jobName, scheduledFor, periodMs: 300_000, workerInstanceId: 'client-renew-worker-b',
    });
    assert.ok(reclaimed);
    assert.equal(reclaimed.attemptCount, 2);

    const eventId = randomUUID();
    await assert.rejects(() => repository.withFencedTransaction(reclaimed, async (client) => {
      await client.query(`INSERT INTO wallet_core_test.state_events
        (id,event_type,subject_type,subject_id,run_id,payload)
        VALUES ($1,'TASK7.CLIENT_RENEW_ROLLBACK','CHAIN',$2,$3,'{}'::jsonb)`,
      [eventId, randomUUID(), reclaimed.id]);
      await repository.renewWithClient(client, renewed);
    }), (error) => error instanceof WalletCronLeaseLost);
    assert.equal((await raw.query(`SELECT count(*)::int AS count
      FROM wallet_core_test.state_events WHERE id=$1`, [eventId])).rows[0].count, 0);
    await repository.complete(reclaimed, {
      status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
      processedCount: 0, failedCount: 0,
    });
  });

  it('persists the exact terminal outcome, reason, and count combinations', async () => {
    const cases = [
      { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
        processedCount: 0, failedCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'CONFIGURATION_REJECTED', skippedBucketCount: 0,
        processedCount: 4, failedCount: 1 },
      { status: 'PARTIAL', safeErrorCode: 'PROVIDER_OBSERVATION_PARTIAL', skippedBucketCount: 0,
        processedCount: 3, failedCount: 1 },
      { status: 'FAILED', safeErrorCode: 'PROVIDER_OBSERVATION_FAILED', skippedBucketCount: 0,
        processedCount: 0, failedCount: 1 },
      { status: 'FAILED', safeErrorCode: 'DEPENDENCY_UNAVAILABLE', skippedBucketCount: 0,
        processedCount: 0, failedCount: 1 },
      { status: 'FAILED', safeErrorCode: 'UNEXPECTED_ERROR', skippedBucketCount: 0,
        processedCount: 0, failedCount: 1 },
      { status: 'SKIPPED', safeErrorCode: 'MISSED_SCHEDULE', skippedBucketCount: 0,
        processedCount: 0, failedCount: 0 },
      { status: 'SKIPPED', safeErrorCode: 'CATCHUP_TRUNCATED',
        skippedBucketCount: walletPositiveSkippedBucketCount(12),
        processedCount: 0, failedCount: 0 },
    ] as const satisfies readonly (WalletCronRunOutcome & {
      readonly processedCount: number; readonly failedCount: number;
    })[];

    for (const [index, outcome] of cases.entries()) {
      const lease = await repository.claim({
        jobName: job(`task7-terminal-${index}`),
        scheduledFor: bucket(60_000, index + 1),
        periodMs: 60_000,
        workerInstanceId: 'task7-terminal-worker',
      });
      assert.ok(lease);
      await repository.complete(lease, outcome);
      const row = (await raw.query(`SELECT status::text,safe_error_code::text,
        skipped_bucket_count,processed_count,failed_count,lease_expires_at,
        finished_at>=started_at AS ordered FROM wallet_core_test.cronjob_runs WHERE id=$1`,
      [lease.id])).rows[0];
      assert.deepEqual(row, {
        status: outcome.status, safe_error_code: outcome.safeErrorCode,
        skipped_bucket_count: outcome.skippedBucketCount,
        processed_count: outcome.processedCount, failed_count: outcome.failedCount,
        lease_expires_at: null, ordered: true,
      });
    }
  });

  it('rejects incoherent terminal reason and per-attempt count combinations', async () => {
    const invalid = [
      { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
        processedCount: 0, failedCount: 1 },
      { status: 'SUCCESS', safeErrorCode: 'UNEXPECTED_ERROR', skippedBucketCount: 0,
        processedCount: 0, failedCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'CONFIGURATION_REJECTED', skippedBucketCount: 0,
        processedCount: 0, failedCount: 1 },
      { status: 'PARTIAL', safeErrorCode: 'PROVIDER_OBSERVATION_PARTIAL', skippedBucketCount: 0,
        processedCount: 1, failedCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'PROVIDER_OBSERVATION_PARTIAL', skippedBucketCount: 0,
        processedCount: 1, failedCount: 2 },
      { status: 'FAILED', safeErrorCode: 'DEPENDENCY_UNAVAILABLE', skippedBucketCount: 0,
        processedCount: 1, failedCount: 1 },
      { status: 'FAILED', safeErrorCode: 'UNEXPECTED_ERROR', skippedBucketCount: 0,
        processedCount: 0, failedCount: 0 },
      { status: 'SKIPPED', safeErrorCode: 'MISSED_SCHEDULE', skippedBucketCount: 0,
        processedCount: 1, failedCount: 0 },
      { status: 'SKIPPED', safeErrorCode: 'CATCHUP_TRUNCATED', skippedBucketCount: 0,
        processedCount: 0, failedCount: 0 },
    ] as const;
    for (const [index, completion] of invalid.entries()) {
      const lease = await repository.claim({
        jobName: job(`task7-invalid-outcome-${index}`), scheduledFor: bucket(60_000),
        periodMs: 60_000, workerInstanceId: 'task7-invalid-outcome-worker',
      });
      assert.ok(lease);
      await assert.rejects(
        () => repository.complete(lease, completion as unknown as Completion),
        /WALLET_CRON_OUTCOME_INVALID|Invalid skipped bucket count/,
      );
    }
  });

  it('reclaims FAILED with a new worker and keeps cumulative run counts and identity', async () => {
    const jobName = job('task7-failed-reclaim');
    const scheduledFor = bucket(60_000);
    const first = await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'failed-worker-a',
    });
    assert.ok(first);
    await repository.complete(first, {
      status: 'FAILED', safeErrorCode: 'UNEXPECTED_ERROR', skippedBucketCount: 0,
      processedCount: 0, failedCount: 1,
    });
    assert.equal(await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'failed-worker-a',
    }), null);
    const second = await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'failed-worker-b',
    });
    assert.ok(second);
    assert.equal(second.id, first.id);
    assert.equal(second.startedAt, first.startedAt);
    assert.equal(second.attemptCount, 2);
    await repository.complete(second, {
      status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
      processedCount: 1, failedCount: 0,
    });
    assert.deepEqual((await raw.query(`SELECT status::text,attempt_count,processed_count,
      failed_count FROM wallet_core_test.cronjob_runs WHERE id=$1`, [first.id])).rows[0], {
      status: 'SUCCESS', attempt_count: 2, processed_count: 1, failed_count: 1,
    });
  });

  it('returns null for duplicate active and already-terminal period claims', async () => {
    const jobName = job('task7-duplicate');
    const scheduledFor = bucket(60_000);
    const first = await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'duplicate-worker-a',
    });
    assert.ok(first);
    assert.equal(await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'duplicate-worker-b',
    }), null);
    await repository.complete(first, {
      status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
      processedCount: 0, failedCount: 0,
    });
    assert.equal(await repository.claim({
      jobName, scheduledFor, periodMs: 60_000, workerInstanceId: 'duplicate-worker-c',
    }), null);
  });

  it('rejects unsupported periods and schedules outside their UTC epoch bucket', async () => {
    const aligned = bucket(60_000);
    await assert.rejects(() => repository.claim({
      jobName: job('task7-off-boundary'), scheduledFor: new Date(aligned.getTime() + 1),
      periodMs: 60_000, workerInstanceId: 'boundary-worker',
    }), /WALLET_CRON_SCHEDULE_INVALID/);
    await assert.rejects(() => repository.claim({
      jobName: job('task7-period'), scheduledFor: aligned,
      periodMs: 120_000 as 60_000, workerInstanceId: 'boundary-worker',
    }), /WALLET_CRON_PERIOD_INVALID/);
    await assert.rejects(() => repository.recordProviderCatchup({
      jobName: job('task7-catchup-boundary'),
      currentScheduledFor: new Date(aligned.getTime() + 1), missedBucketCount: 1,
      workerInstanceId: 'boundary-worker',
    }), /WALLET_CRON_SCHEDULE_INVALID/);
  });

  it('materializes only the latest 288 missed buckets plus one truncation summary', async () => {
    const jobName = job('task7-catchup');
    const currentScheduledFor = new Date('2026-09-05T12:00:00.000Z');
    await repository.recordProviderCatchup({
      jobName,
      currentScheduledFor,
      missedBucketCount: 1_000,
      workerInstanceId: 'task7-catchup-worker',
    });
    await repository.recordProviderCatchup({
      jobName,
      currentScheduledFor,
      missedBucketCount: 1_000,
      workerInstanceId: 'task7-catchup-worker',
    });
    const rows = (await raw.query(`SELECT scheduled_for,status::text,safe_error_code::text,
      skipped_bucket_count FROM wallet_core_test.cronjob_runs
      WHERE job_name=$1 ORDER BY scheduled_for`, [jobName])).rows;
    assert.equal(rows.length, 289);
    const materialized = rows.filter((row) => row.status === 'SKIPPED'
      && row.safe_error_code === 'MISSED_SCHEDULE' && row.skipped_bucket_count === 0);
    assert.deepEqual(materialized.map((row) => (row.scheduled_for as Date).toISOString()),
      Array.from({ length: 288 }, (_, index) =>
        new Date(currentScheduledFor.getTime() - (288 - index) * 300_000).toISOString()));
    const summaries = rows.filter((row) => row.safe_error_code === 'CATCHUP_TRUNCATED');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].status, 'SKIPPED');
    assert.equal(summaries[0].skipped_bucket_count, 712);
    assert.ok((summaries[0].scheduled_for as Date) < (materialized[0].scheduled_for as Date));
  });
});
