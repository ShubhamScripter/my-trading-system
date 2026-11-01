import type { WalletCoreClient } from './wallet-core.database.js';

export type ProviderRequestCheckpoint = () => Promise<void>;

export class ProviderRequestCheckpointError {
  constructor(readonly reason: unknown) {}
}

/** Coordinates provider calls so the worker can renew its lease after each bounded request wave. */
export class ProviderRequestWave {
  private admitted = 0;
  private checkpointing: Promise<void> | null = null;

  constructor(private readonly checkpoint?: ProviderRequestCheckpoint) {}

  async beforeRequest(): Promise<void> {
    if (!this.checkpoint) return;
    for (;;) {
      if (this.checkpointing) {
        await this.checkpointing;
        continue;
      }
      if (this.admitted < 50) {
        this.admitted += 1;
        return;
      }
      const pending = Promise.resolve().then(this.checkpoint)
        .then(() => { this.admitted = 0; })
        .catch((error: unknown) => { throw new ProviderRequestCheckpointError(error); });
      this.checkpointing = pending;
      try {
        await pending;
      } finally {
        if (this.checkpointing === pending) this.checkpointing = null;
      }
    }
  }
}

export interface ProviderPersistenceWaveResult {
  readonly processedCount: number;
  readonly failedCount: number;
  readonly persistenceFailedCount: number;
  readonly stopped: boolean;
}

/** Persists status observations in isolated waves and stops after a wholly failed wave. */
export async function persistProviderWaves<T>(
  client: WalletCoreClient,
  items: readonly T[],
  persist: (item: T) => Promise<boolean>,
  checkpoint: () => Promise<void>,
): Promise<ProviderPersistenceWaveResult> {
  let processedCount = 0;
  let failedCount = 0;
  let persistenceFailedCount = 0;
  for (let offset = 0; offset < items.length; offset += 50) {
    const wave = items.slice(offset, offset + 50);
    let wavePersistenceFailures = 0;
    for (const item of wave) {
      await client.query('SAVEPOINT wallet_provider_status_item');
      try {
        if (await persist(item)) failedCount += 1;
        await client.query('RELEASE SAVEPOINT wallet_provider_status_item');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT wallet_provider_status_item');
        await client.query('RELEASE SAVEPOINT wallet_provider_status_item');
        failedCount += 1;
        persistenceFailedCount += 1;
        wavePersistenceFailures += 1;
      }
      processedCount += 1;
    }
    // Continuing after an entirely failed wave would amplify a likely database outage.
    if (wavePersistenceFailures === wave.length) {
      return { processedCount, failedCount, persistenceFailedCount, stopped: true };
    }
    if (processedCount < items.length) await checkpoint();
  }
  return { processedCount, failedCount, persistenceFailedCount, stopped: false };
}
