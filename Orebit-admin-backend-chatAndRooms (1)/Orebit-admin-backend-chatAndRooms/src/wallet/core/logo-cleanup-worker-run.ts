import { LocalWalletLogoStorage } from './logo-storage.js';
import { WalletLogoAssetRepository } from './logo-asset.repository.js';
import { walletLogoCleanupScheduledFor } from './logo-cleanup-schedule.js';
import { WalletLogoCleanupWorker } from './logo-cleanup-worker.js';
import { WalletCronjobRepository } from './cronjob.repository.js';
import { createWalletCoreProductionDatabase } from './wallet-core.database.js';
import { walletWorkerInvocationId } from './worker-invocation-id.js';

/** Composes local development/test storage, runs one cleanup bucket, and closes its pool. */
async function main() {
  const workerInstanceId = walletWorkerInvocationId(
    process.env.WALLET_WORKER_INSTANCE_ID ?? '',
  );
  const database = createWalletCoreProductionDatabase();
  try {
    const storage = await LocalWalletLogoStorage.create({ root: process.env.WALLET_LOGO_STORAGE_ROOT ?? '',
      publicBaseUrl: process.env.WALLET_LOGO_PUBLIC_BASE_URL ?? '' });
    const scheduledFor = await walletLogoCleanupScheduledFor(database);
    await new WalletLogoCleanupWorker(new WalletLogoAssetRepository(database), storage,
      new WalletCronjobRepository(database)).runOnce({ scheduledFor, workerInstanceId });
  } finally { await database.close(); }
}
void main();
