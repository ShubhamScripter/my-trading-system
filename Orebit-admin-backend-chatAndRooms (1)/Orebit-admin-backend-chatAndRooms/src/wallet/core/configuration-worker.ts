import {
  WalletCronLeaseLost,
  WalletCronjobRepository,
  type WalletCronjobLease,
} from './cronjob.repository.js';
import { WalletCoreConfigurationWriter } from './wallet-core.configuration-writer.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import type { WalletCronRunOutcome } from './wallet-core.types.js';

const JOB_NAME = 'wallet-configuration-apply';
const BATCH_SIZE = 50;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface WalletConfigurationWorkerInput {
  readonly scheduledFor: Date;
  readonly workerInstanceId: string;
}

export type WalletConfigurationWorkerResult = WalletCronRunOutcome & Readonly<{
  runId: string;
  processedCount: number;
  failedCount: number;
}>;

/** Claims one minute bucket and applies due configuration changes independently under savepoints. */
export class WalletConfigurationWorker {
  constructor(private readonly dependencies: Readonly<{
    database: WalletCoreDatabase;
    cronjobs: WalletCronjobRepository;
    writer: WalletCoreConfigurationWriter;
  }>) {}

  async runOnce(
    input: WalletConfigurationWorkerInput,
  ): Promise<WalletConfigurationWorkerResult | null> {
    let lease = await this.dependencies.cronjobs.claim({
      jobName: JOB_NAME,
      scheduledFor: input.scheduledFor,
      workerInstanceId: input.workerInstanceId,
      periodMs: 60_000,
    });
    if (!lease) return null;

    try {
      const claimed = lease;
      const applied = await this.dependencies.cronjobs.withFencedTransaction(
        claimed,
        (client) => this.applyDue(client, claimed),
      );
      lease = applied.lease;
      const counts = { processedCount: applied.processedCount,
        failedCount: applied.failedCount };
      const outcome = counts.failedCount === 0
        ? { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0 } as const
        : { status: 'PARTIAL', safeErrorCode: 'CONFIGURATION_REJECTED',
          skippedBucketCount: 0 } as const;
      await this.dependencies.cronjobs.complete(lease, { ...outcome, ...counts });
      return { runId: lease.id, ...outcome, ...counts };
    } catch (error) {
      if (error instanceof WalletCronLeaseLost) throw error;
      const outcome = { status: 'FAILED', safeErrorCode: 'DEPENDENCY_UNAVAILABLE',
        skippedBucketCount: 0, processedCount: 0, failedCount: 1 } as const;
      await this.dependencies.cronjobs.complete(lease, outcome);
      return { runId: lease.id, ...outcome };
    }
  }
  /** Applies up to 50 due revisions under savepoints while renewing the active lease. */
  private async applyDue(
    client: WalletCoreClient,
    lease: WalletCronjobLease,
  ): Promise<Readonly<{ lease: WalletCronjobLease;
    processedCount: number; failedCount: number }>> {
    // One database timestamp defines the whole batch's due boundary.
    const due = await client.query<{
      readonly id: unknown;
      readonly decision_at: unknown;
    }>(`WITH decision AS MATERIALIZED (SELECT clock_timestamp() decision_at),
      due AS MATERIALIZED (SELECT change.id,change.effective_at,decision.decision_at FROM
        ${this.dependencies.database.schemas.wallet}.configuration_changes change
        CROSS JOIN decision WHERE change.status='SCHEDULED'
          AND change.effective_at<=decision.decision_at
        ORDER BY change.effective_at,change.id LIMIT $1 FOR UPDATE OF change)
      SELECT id::text,decision_at FROM due ORDER BY effective_at,id`, [BATCH_SIZE]);
    const decisionAt = due.rows[0]?.decision_at;
    if (due.rows.length > 0 && (!(decisionAt instanceof Date)
      || Number.isNaN(decisionAt.valueOf())
      || due.rows.some((row) => !(row.decision_at instanceof Date)
        || row.decision_at.valueOf() !== decisionAt.valueOf()))) {
      throw new Error('WALLET_CONFIGURATION_DATABASE_RESULT_INVALID');
    }
    const ids = due.rows.map((row) => {
      if (typeof row.id !== 'string' || !UUID_V7.test(row.id)) {
        throw new Error('WALLET_CONFIGURATION_DATABASE_RESULT_INVALID');
      }
      return row.id;
    });
    let failedCount = 0;
    let currentLease = lease;
    for (const id of ids) {
      // A malformed change must not roll back other due changes in the same lease.
      await client.query('SAVEPOINT wallet_configuration_item');
      try {
        const result = await this.dependencies.writer.applyScheduledChangeWithClient(
          client,
          id,
          decisionAt as Date,
          { actor: { kind: 'SYSTEM', runId: currentLease.id } },
        );
        if (result.outcome === 'SCHEDULE_REJECTED') failedCount += 1;
        await client.query('RELEASE SAVEPOINT wallet_configuration_item');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT wallet_configuration_item');
        await client.query('RELEASE SAVEPOINT wallet_configuration_item');
        failedCount += 1;
      }
      currentLease = await this.dependencies.cronjobs.renewWithClient(client, currentLease);
    }
    return { lease: currentLease, processedCount: ids.length, failedCount };
  }
}
