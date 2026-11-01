import { AdminAuditRepository } from '../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../admin-audits/admin-audit.writer.service.js';
import { BlockchainAdminCatalogueClient } from './blockchain-admin.client.js';
import { WalletCronjobRepository } from './cronjob.repository.js';
import { WalletNotificationOutbox } from './notification-outbox.js';
import {
  WALLET_PROVIDER_STATUS_JOB_NAME,
  WalletProviderStatusWorker,
} from './provider-status-worker.js';
import {
  createWalletCoreProductionDatabase,
  type WalletCoreDatabase,
} from './wallet-core.database.js';
import { walletWorkerInvocationId } from './worker-invocation-id.js';

const FIVE_MINUTES_MS = 300_000;

interface ScheduleRow extends Record<string, unknown> {
  readonly scheduled_for: unknown;
  readonly previous_scheduled_for: unknown;
}

const date = (value: unknown): Date | null => {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.valueOf())) throw new Error('WALLET_PROVIDER_SCHEDULE_INVALID');
  return parsed;
};

/** Derives the current provider bucket and outage gap from authoritative database time. */
async function schedule(database: WalletCoreDatabase): Promise<Readonly<{
  current: Date;
  missedBucketCount: number;
}>> {
  return database.transaction(async (client) => {
    const result = await client.query<ScheduleRow>(`SELECT
      to_timestamp(floor(extract(epoch FROM clock_timestamp())/300)*300) scheduled_for,
      (SELECT max(scheduled_for) FROM ${database.schemas.wallet}.cronjob_runs
        WHERE job_name=$1) previous_scheduled_for`, [WALLET_PROVIDER_STATUS_JOB_NAME]);
    const current = date(result.rows[0]?.scheduled_for);
    if (current === null) throw new Error('WALLET_PROVIDER_SCHEDULE_INVALID');
    const previous = date(result.rows[0]?.previous_scheduled_for);
    const missedBucketCount = previous === null ? 0
      : Math.max(0, Math.floor((current.valueOf() - previous.valueOf()) / FIVE_MINUTES_MS) - 1);
    return { current, missedBucketCount };
  });
}

/** Records catch-up evidence, runs one status sync, and always closes the pool. */
async function main(): Promise<void> {
  const workerInstanceId = walletWorkerInvocationId(
    process.env.WALLET_WORKER_INSTANCE_ID ?? '',
  );
  const databaseUrl = process.env.WALLET_CORE_DATABASE_URL;
  if (!databaseUrl) throw new Error('WALLET_CORE_DATABASE_URL is required');

  const database = createWalletCoreProductionDatabase(databaseUrl);
  try {
    const cronjobs = new WalletCronjobRepository(database);
    const due = await schedule(database);
    await cronjobs.recordProviderCatchup({
      jobName: WALLET_PROVIDER_STATUS_JOB_NAME,
      currentScheduledFor: due.current,
      missedBucketCount: due.missedBucketCount,
      workerInstanceId,
    });
    await new WalletProviderStatusWorker({
      database,
      cronjobs,
      providerClient: BlockchainAdminCatalogueClient.production(),
      audit: new AdminAuditWriterService(new AdminAuditRepository()),
      outbox: new WalletNotificationOutbox(database),
    }).runOnce({ scheduledFor: due.current, workerInstanceId });
  } finally {
    await database.close();
  }
}

void main();
