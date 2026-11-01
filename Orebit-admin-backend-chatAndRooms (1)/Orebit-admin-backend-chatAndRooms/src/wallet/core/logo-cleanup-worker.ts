import type { WalletLogoStorage } from './logo-storage.js';
import type { WalletLogoAssetRepository } from './logo-asset.repository.js';
import type { WalletCronjobRepository } from './cronjob.repository.js';

const JOB_NAME = 'wallet-logo-cleanup';
/** Claims a cron bucket, deletes claimed expired logo objects, and releases failures for retry. */
export class WalletLogoCleanupWorker {
  constructor(private readonly assets: WalletLogoAssetRepository,
    private readonly storage: WalletLogoStorage, private readonly cronjobs: WalletCronjobRepository,
    private readonly storageTimeoutMs = 30_000) {
    if (!Number.isSafeInteger(storageTimeoutMs) || storageTimeoutMs < 1 || storageTimeoutMs > 60_000) {
      throw new TypeError('WALLET_LOGO_STORAGE_TIMEOUT_INVALID');
    }
  }

  async runOnce(input: { readonly scheduledFor: Date; readonly workerInstanceId: string }) {
    let lease = await this.cronjobs.claim({ jobName: JOB_NAME, scheduledFor: input.scheduledFor,
      periodMs: 300_000, workerInstanceId: input.workerInstanceId });
    if (!lease) return null;
    const claimed = await this.assets.claimExpired(); let processed = 0; let failed = 0;
    for (const objectKey of claimed.objectKeys) {
      lease = await this.cronjobs.renew(lease);
      try {
        await this.assets.renewDeletion(objectKey, claimed.token);
        await this.boundedDelete(objectKey);
        await this.assets.renewDeletion(objectKey, claimed.token);
        await this.assets.completeDeletion(objectKey, claimed.token); processed += 1;
      } catch (error) {
        // Keep metadata retryable when either object deletion or finalization fails.
        failed += 1;
        if (!(error instanceof LogoStorageTimeout)) {
          await this.assets.releaseDeletion(objectKey, claimed.token).catch(() => undefined);
        }
      }
    }
    const completion = failed === 0
      ? { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0,
        processedCount: processed, failedCount: 0 } as const
      : { status: 'PARTIAL', safeErrorCode: 'LOGO_CLEANUP_PARTIAL', skippedBucketCount: 0,
        processedCount: processed, failedCount: failed } as const;
    lease = await this.cronjobs.renew(lease);
    await this.cronjobs.complete(lease, completion);
    return { processedCount: processed, failedCount: failed };
  }

  private async boundedDelete(objectKey: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const operation = this.storage.delete(objectKey);
    operation.catch(() => undefined);
    try {
      await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LogoStorageTimeout()), this.storageTimeoutMs);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class LogoStorageTimeout extends Error {}
