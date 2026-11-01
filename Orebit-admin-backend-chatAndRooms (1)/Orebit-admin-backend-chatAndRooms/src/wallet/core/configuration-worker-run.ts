import { AdminAuditRepository } from '../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../admin-audits/admin-audit.writer.service.js';
import { WalletConfigurationWorker } from './configuration-worker.js';
import { WalletCronjobRepository } from './cronjob.repository.js';
import { WalletLogoAssetRepository } from './logo-asset.repository.js';
import { WalletCoreConfigurationWriter } from './wallet-core.configuration-writer.js';
import { createWalletCoreProductionDatabase } from './wallet-core.database.js';
import { WalletCoreRepository } from './wallet-core.repository.js';
import { walletWorkerInvocationId } from './worker-invocation-id.js';

/** Aligns scheduling to PostgreSQL time so hosts with clock drift claim the same minute. */
async function currentMinute(database: ReturnType<typeof createWalletCoreProductionDatabase>) {
  return database.transaction(async (client) => {
    const result = await client.query<{ readonly scheduled_for: unknown }>(`SELECT
      to_timestamp(floor(extract(epoch FROM clock_timestamp())/60)*60) scheduled_for`);
    const raw = result.rows[0]?.scheduled_for;
    const scheduledFor = raw instanceof Date ? raw : new Date(String(raw));
    if (!Number.isFinite(scheduledFor.valueOf()) || scheduledFor.valueOf() % 60_000 !== 0) {
      throw new Error('WALLET_CONFIGURATION_SCHEDULE_INVALID');
    }
    return scheduledFor;
  });
}

/** Builds production dependencies, applies one due bucket, and always closes the pool. */
async function main(): Promise<void> {
  const workerInstanceId = walletWorkerInvocationId(
    process.env.WALLET_WORKER_INSTANCE_ID ?? '',
  );
  const databaseUrl = process.env.WALLET_CORE_DATABASE_URL;
  if (!databaseUrl) throw new Error('WALLET_CORE_DATABASE_URL is required');

  const database = createWalletCoreProductionDatabase(databaseUrl);
  try {
    const audit = new AdminAuditWriterService(new AdminAuditRepository());
    const scheduledFor = await currentMinute(database);
    await new WalletConfigurationWorker({
      database,
      cronjobs: new WalletCronjobRepository(database),
      writer: new WalletCoreConfigurationWriter(new WalletCoreRepository(database), audit,
        new WalletLogoAssetRepository(database)),
    }).runOnce({
      scheduledFor,
      workerInstanceId,
    });
  } finally {
    await database.close();
  }
}

void main();
