import { uuidv7 } from '../../utils/public.utils.js';
import {
  WalletCoreDatabase,
  type WalletCoreClient,
} from './wallet-core.database.js';
import { planWalletProviderCatchup } from './wallet-core.policy.js';
import {
  walletPositiveSkippedBucketCount,
  type WalletCronRunOutcome,
} from './wallet-core.types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIVE_MINUTES_MS = 300_000;

export interface WalletCronjobLease {
  readonly id: string;
  readonly jobName: string;
  readonly scheduledFor: string;
  readonly workerInstanceId: string;
  readonly attemptCount: number;
  readonly leaseExpiresAt: string;
  readonly startedAt: string;
}

export interface WalletCronjobClaimInput {
  readonly jobName: string;
  readonly scheduledFor: Date;
  readonly periodMs: 60_000 | 300_000;
  readonly workerInstanceId: string;
}

export type WalletCronjobCompletion = WalletCronRunOutcome & Readonly<{
  processedCount: number;
  failedCount: number;
}>;

export interface WalletProviderCatchupInput {
  readonly jobName: string;
  readonly currentScheduledFor: Date;
  readonly missedBucketCount: number;
  readonly workerInstanceId: string;
}

interface LeaseRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly job_name: unknown;
  readonly scheduled_for: unknown;
  readonly worker_instance_id: unknown;
  readonly attempt_count: unknown;
  readonly lease_expires_at: unknown;
  readonly started_at: unknown;
}

interface RunningRow extends LeaseRow {
  readonly lease_active: unknown;
}

export class WalletCronLeaseLost extends Error {
  constructor() {
    super('WALLET_CRON_LEASE_LOST');
    this.name = 'WalletCronLeaseLost';
  }
}

const normalizedText = (value: string, max: number, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max
    || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(code);
  return normalized;
};

const validDate = (value: Date, code: string): Date => {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) throw new Error(code);
  return new Date(value.valueOf());
};

const validPeriod = (value: 60_000 | 300_000): 60_000 | 300_000 => {
  if (value !== 60_000 && value !== 300_000) throw new Error('WALLET_CRON_PERIOD_INVALID');
  return value;
};

const alignedDate = (value: Date, periodMs: 60_000 | 300_000): Date => {
  const date = validDate(value, 'WALLET_CRON_SCHEDULE_INVALID');
  if (date.valueOf() % periodMs !== 0) throw new Error('WALLET_CRON_SCHEDULE_INVALID');
  return date;
};

const safeCount = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('WALLET_CRON_COUNT_INVALID');
  return value;
};

const textValue = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('WALLET_CRON_DATABASE_RESULT_INVALID');
  return value;
};

const integer = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('WALLET_CRON_DATABASE_RESULT_INVALID');
  }
  return parsed;
};

const leaseFromRow = (row: LeaseRow): WalletCronjobLease => {
  const id = textValue(row.id);
  if (!UUID_V7.test(id)) throw new Error('WALLET_CRON_DATABASE_RESULT_INVALID');
  const lease = {
    id,
    jobName: textValue(row.job_name),
    scheduledFor: textValue(row.scheduled_for),
    workerInstanceId: textValue(row.worker_instance_id),
    attemptCount: integer(row.attempt_count),
    leaseExpiresAt: textValue(row.lease_expires_at),
    startedAt: textValue(row.started_at),
  };
  validDate(new Date(lease.scheduledFor), 'WALLET_CRON_DATABASE_RESULT_INVALID');
  validDate(new Date(lease.leaseExpiresAt), 'WALLET_CRON_DATABASE_RESULT_INVALID');
  validDate(new Date(lease.startedAt), 'WALLET_CRON_DATABASE_RESULT_INVALID');
  return lease;
};

const returningLease = `id::text,job_name,scheduled_for::text,worker_instance_id,
  attempt_count,lease_expires_at::text,started_at::text`;

const validateLease = (lease: WalletCronjobLease): WalletCronjobLease => {
  if (!lease || !UUID_V7.test(lease.id)) throw new WalletCronLeaseLost();
  normalizedText(lease.jobName, 96, 'WALLET_CRON_JOB_NAME_INVALID');
  normalizedText(lease.workerInstanceId, 128, 'WALLET_CRON_WORKER_INSTANCE_ID_INVALID');
  if (!Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) {
    throw new WalletCronLeaseLost();
  }
  validDate(new Date(lease.scheduledFor), 'WALLET_CRON_LEASE_INVALID');
  validDate(new Date(lease.leaseExpiresAt), 'WALLET_CRON_LEASE_INVALID');
  validDate(new Date(lease.startedAt), 'WALLET_CRON_LEASE_INVALID');
  return lease;
};

const assertCompletion = (completion: WalletCronjobCompletion, jobName: string): void => {
  safeCount(completion.processedCount);
  safeCount(completion.failedCount);
  if (completion.safeErrorCode === 'CATCHUP_TRUNCATED') {
    walletPositiveSkippedBucketCount(completion.skippedBucketCount);
  } else if (completion.skippedBucketCount !== 0) {
    throw new Error('WALLET_CRON_OUTCOME_INVALID');
  }
  if (completion.safeErrorCode === 'LOGO_CLEANUP_PARTIAL') {
    // Logo counts record successes and failures separately, including all-failed batches.
    if (jobName !== 'wallet-logo-cleanup' || completion.status !== 'PARTIAL'
      || completion.failedCount === 0) throw new Error('WALLET_CRON_OUTCOME_INVALID');
    return;
  }
  const pair = `${completion.status}:${completion.safeErrorCode ?? ''}`;
  const allowed = new Set([
    'SUCCESS:',
    'PARTIAL:CONFIGURATION_REJECTED',
    'PARTIAL:PROVIDER_OBSERVATION_PARTIAL',
    'FAILED:PROVIDER_OBSERVATION_FAILED',
    'FAILED:DEPENDENCY_UNAVAILABLE',
    'FAILED:UNEXPECTED_ERROR',
    'SKIPPED:MISSED_SCHEDULE',
    'SKIPPED:CATCHUP_TRUNCATED',
  ]);
  if (!allowed.has(pair)) {
    throw new Error('WALLET_CRON_OUTCOME_INVALID');
  }
  const coherent = completion.status === 'SUCCESS'
    ? completion.failedCount === 0
    : completion.status === 'PARTIAL'
      ? completion.processedCount > 0 && completion.failedCount > 0
        && completion.failedCount <= completion.processedCount
      : completion.status === 'FAILED'
        ? completion.processedCount === 0 && completion.failedCount > 0
        : completion.processedCount === 0 && completion.failedCount === 0;
  if (!coherent) throw new Error('WALLET_CRON_OUTCOME_INVALID');
};

/** Implements aligned, fenced cron leases plus explicit missed-bucket evidence. */
export class WalletCronjobRepository {
  private readonly wallet: string;

  constructor(private readonly database: WalletCoreDatabase) {
    this.wallet = database.schemas.wallet;
  }

  async claim(input: WalletCronjobClaimInput): Promise<WalletCronjobLease | null> {
    const jobName = normalizedText(input.jobName, 96, 'WALLET_CRON_JOB_NAME_INVALID');
    const worker = normalizedText(
      input.workerInstanceId, 128, 'WALLET_CRON_WORKER_INSTANCE_ID_INVALID',
    );
    const scheduledFor = alignedDate(input.scheduledFor, validPeriod(input.periodMs));
    return this.database.transaction(async (client) => {
      await this.lockJob(client, jobName);
      const running = await client.query<RunningRow>(`SELECT ${returningLease},
        lease_expires_at>clock_timestamp() AS lease_active
        FROM ${this.wallet}.cronjob_runs WHERE job_name=$1 AND status='RUNNING'
        ORDER BY scheduled_for,id LIMIT 1 FOR UPDATE`, [jobName]);
      const active = running.rows[0];
      if (active) {
        if (active.lease_active === true || active.worker_instance_id === worker) return null;
        return this.reclaim(client, active, worker);
      }

      const existing = await client.query<LeaseRow & { readonly status: unknown }>(`SELECT
        ${returningLease},status::text FROM ${this.wallet}.cronjob_runs
        WHERE job_name=$1 AND scheduled_for=$2 FOR UPDATE`, [jobName, scheduledFor]);
      const row = existing.rows[0];
      if (row) {
        if (row.status !== 'FAILED' || row.worker_instance_id === worker) return null;
        return this.reclaim(client, row, worker);
      }

      const inserted = await client.query<LeaseRow>(`INSERT INTO ${this.wallet}.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status)
        VALUES ($1,$2,$3,$4,'RUNNING') RETURNING ${returningLease}`,
      [uuidv7(), jobName, scheduledFor, worker]);
      const created = inserted.rows[0];
      if (!created) throw new Error('WALLET_CRON_DATABASE_RESULT_INVALID');
      return leaseFromRow(created);
    });
  }

  async renew(leaseValue: WalletCronjobLease): Promise<WalletCronjobLease> {
    const lease = validateLease(leaseValue);
    return this.database.transaction(async (client) => {
      await this.lockJob(client, lease.jobName);
      return this.renewWithClient(client, lease);
    });
  }

  async renewWithClient(
    client: WalletCoreClient,
    leaseValue: WalletCronjobLease,
  ): Promise<WalletCronjobLease> {
    const lease = validateLease(leaseValue);
    const updated = await client.query<LeaseRow>(`UPDATE ${this.wallet}.cronjob_runs
      SET lease_expires_at=clock_timestamp()+interval '5 minutes'
      WHERE id=$1 AND job_name=$2 AND scheduled_for=$3 AND status='RUNNING'
        AND worker_instance_id=$4 AND attempt_count=$5
        AND lease_expires_at>clock_timestamp()
      RETURNING ${returningLease}`,
    [lease.id, lease.jobName, lease.scheduledFor, lease.workerInstanceId,
      lease.attemptCount]);
    const row = updated.rows[0];
    if (!row) throw new WalletCronLeaseLost();
    return leaseFromRow(row);
  }

  async withFencedTransaction<T>(
    leaseValue: WalletCronjobLease,
    work: (client: WalletCoreClient) => Promise<T>,
  ): Promise<T> {
    const lease = validateLease(leaseValue);
    return this.database.transaction(async (client) => {
      await this.lockJob(client, lease.jobName);
      await this.assertFence(client, lease);
      const result = await work(client);
      await this.assertFence(client, lease);
      return result;
    });
  }

  async complete(
    leaseValue: WalletCronjobLease,
    completion: WalletCronjobCompletion,
  ): Promise<void> {
    const lease = validateLease(leaseValue);
    assertCompletion(completion, lease.jobName);
    await this.database.transaction(async (client) => {
      await this.lockJob(client, lease.jobName);
      const result = await client.query(`UPDATE ${this.wallet}.cronjob_runs SET
        status=$6,safe_error_code=$7,skipped_bucket_count=$8,
        processed_count=processed_count+$9,failed_count=failed_count+$10,
        finished_at=GREATEST(clock_timestamp(),started_at),
        lease_expires_at=NULL
        WHERE id=$1 AND job_name=$2 AND scheduled_for=$3 AND status='RUNNING'
          AND worker_instance_id=$4 AND attempt_count=$5
          AND lease_expires_at>clock_timestamp()`,
      [lease.id, lease.jobName, lease.scheduledFor, lease.workerInstanceId,
        lease.attemptCount, completion.status,
        completion.safeErrorCode, completion.skippedBucketCount,
        completion.processedCount, completion.failedCount]);
      if (result.rowCount !== 1) throw new WalletCronLeaseLost();
    });
  }

  async recordProviderCatchup(input: WalletProviderCatchupInput): Promise<void> {
    const jobName = normalizedText(input.jobName, 96, 'WALLET_CRON_JOB_NAME_INVALID');
    const worker = normalizedText(
      input.workerInstanceId, 128, 'WALLET_CRON_WORKER_INSTANCE_ID_INVALID',
    );
    const current = alignedDate(input.currentScheduledFor, 300_000);
    const plan = planWalletProviderCatchup(input.missedBucketCount);
    const oldest = new Date(current.valueOf() - input.missedBucketCount * FIVE_MINUTES_MS);
    if (input.missedBucketCount > 0) validDate(oldest, 'WALLET_CRON_SCHEDULE_INVALID');

    await this.database.transaction(async (client) => {
      await this.lockJob(client, jobName);
      const running = await client.query(`SELECT 1 FROM ${this.wallet}.cronjob_runs
        WHERE job_name=$1 AND status='RUNNING' LIMIT 1 FOR UPDATE`, [jobName]);
      if (running.rows.length > 0) return;
      if (plan.truncatedSummary) {
        await this.insertSkipped(client, jobName, oldest, worker,
          'CATCHUP_TRUNCATED', plan.truncatedSummary.skippedBucketCount);
      }
      for (let offset = plan.materializedMissedBucketCount; offset >= 1; offset -= 1) {
        await this.insertSkipped(client, jobName,
          new Date(current.valueOf() - offset * FIVE_MINUTES_MS), worker,
          'MISSED_SCHEDULE', 0);
      }
    });
  }

  private async lockJob(client: WalletCoreClient, jobName: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10000))', [jobName]);
  }

  private async reclaim(
    client: WalletCoreClient,
    row: LeaseRow,
    worker: string,
  ): Promise<WalletCronjobLease> {
    const updated = await client.query<LeaseRow>(`UPDATE ${this.wallet}.cronjob_runs SET
      status='RUNNING',worker_instance_id=$2,attempt_count=attempt_count+1,
      safe_error_code=NULL,finished_at=NULL
      WHERE id=$1 RETURNING ${returningLease}`, [textValue(row.id), worker]);
    const reclaimed = updated.rows[0];
    if (!reclaimed) throw new WalletCronLeaseLost();
    return leaseFromRow(reclaimed);
  }

  /** Proves ownership and lease freshness before a worker may publish completion. */
  private async assertFence(client: WalletCoreClient, lease: WalletCronjobLease): Promise<void> {
    const result = await client.query(`SELECT 1 FROM ${this.wallet}.cronjob_runs
      WHERE id=$1 AND job_name=$2 AND scheduled_for=$3 AND status='RUNNING'
        AND worker_instance_id=$4 AND attempt_count=$5
        AND lease_expires_at>clock_timestamp()
      FOR UPDATE`, [lease.id, lease.jobName, lease.scheduledFor, lease.workerInstanceId,
      lease.attemptCount]);
    if (result.rows.length !== 1) throw new WalletCronLeaseLost();
  }

  private async insertSkipped(
    client: WalletCoreClient,
    jobName: string,
    scheduledFor: Date,
    worker: string,
    reason: 'MISSED_SCHEDULE' | 'CATCHUP_TRUNCATED',
    skippedBucketCount: number,
  ): Promise<void> {
    const storedSkippedBucketCount = reason === 'CATCHUP_TRUNCATED'
      ? walletPositiveSkippedBucketCount(skippedBucketCount)
      : skippedBucketCount;
    if (reason === 'MISSED_SCHEDULE' && storedSkippedBucketCount !== 0) {
      throw new Error('WALLET_CRON_OUTCOME_INVALID');
    }
    const inserted = await client.query<{ readonly id: unknown }>(`INSERT INTO
      ${this.wallet}.cronjob_runs (id,job_name,scheduled_for,worker_instance_id,status)
      VALUES ($1,$2,$3,$4,'RUNNING') ON CONFLICT DO NOTHING RETURNING id::text`,
    [uuidv7(), jobName, scheduledFor, worker]);
    const id = inserted.rows[0]?.id;
    if (typeof id !== 'string') return;
    await client.query(`UPDATE ${this.wallet}.cronjob_runs SET status='SKIPPED',
      safe_error_code=$2,skipped_bucket_count=$3,
      finished_at=GREATEST(clock_timestamp(),started_at),lease_expires_at=NULL WHERE id=$1`,
    [id, reason, storedSkippedBucketCount]);
  }
}
