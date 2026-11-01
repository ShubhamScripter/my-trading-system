import { uuidv7 } from '../../utils/public.utils.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';

const KEY = /^[0-9a-f]{64}\.webp$/;
const BATCH_SIZE = 100;
export interface WalletLogoAssetAttachmentPort {
  attachReferencedWithTransaction(client: WalletCoreClient, input: {
    readonly configurationChangeId: string; readonly objectKeys: readonly string[];
  }): Promise<void>;
}

/** Tracks logo lifecycle so uploads are either referenced by configuration or safely collectible. */
export class WalletLogoAssetRepository implements WalletLogoAssetAttachmentPort {
  private readonly wallet: string;
  constructor(private readonly database: WalletCoreDatabase) { this.wallet = database.schemas.wallet; }

  async reserve(objectKey: string): Promise<void> {
    if (!KEY.test(objectKey)) throw new WalletConfigurationInvalid('Invalid Wallet logo object key.');
    await this.database.transaction(async client => {
      const result = await client.query(`WITH captured AS (SELECT clock_timestamp() created_at)
        INSERT INTO ${this.wallet}.wallet_logo_assets (object_key,created_at,expires_at)
        SELECT $1,created_at,created_at+interval '24 hours' FROM captured`, [objectKey]);
      if (result.rowCount !== 1) throw new Error('WALLET_LOGO_RESERVATION_FAILED');
    });
  }

  async markUploadedWithTransaction(client: WalletCoreClient, objectKey: string): Promise<void> {
    const result = await client.query(`UPDATE ${this.wallet}.wallet_logo_assets SET
      state='PENDING',uploaded_at=clock_timestamp() WHERE object_key=$1 AND state='STAGING'`, [objectKey]);
    if (result.rowCount !== 1) throw new Error('WALLET_LOGO_UPLOAD_STATE_CONFLICT');
  }

  async requestDeletion(objectKey: string): Promise<void> {
    await this.database.transaction(async client => { await client.query(`UPDATE
      ${this.wallet}.wallet_logo_assets SET state='DELETE_PENDING',cleanup_token=NULL,
      cleanup_lease_expires_at=NULL WHERE object_key=$1 AND state IN ('STAGING','PENDING')`, [objectKey]); });
  }

  async attachReferencedWithTransaction(client: WalletCoreClient, input: {
    readonly configurationChangeId: string; readonly objectKeys: readonly string[];
  }): Promise<void> {
    const keys = [...new Set(input.objectKeys)];
    for (const objectKey of keys) {
      if (!KEY.test(objectKey)) throw new WalletConfigurationInvalid('Invalid Wallet logo object key.');
      const row = (await client.query<{ state: unknown; expired: unknown }>(`SELECT state::text,
        expires_at<=clock_timestamp() expired FROM ${this.wallet}.wallet_logo_assets
        WHERE object_key=$1 FOR UPDATE`, [objectKey])).rows[0];
      if (!row) continue; // Pre-registry legacy assets are accepted and are never cleanup candidates.
      if ((row.state !== 'PENDING' && row.state !== 'ATTACHED') || row.expired === true && row.state === 'PENDING') {
        throw new WalletConfigurationInvalid('Wallet logo upload is unavailable or expired.');
      }
      await client.query(`INSERT INTO ${this.wallet}.wallet_logo_asset_references
        (configuration_change_id,object_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [input.configurationChangeId, objectKey]);
      const updated = await client.query(`UPDATE ${this.wallet}.wallet_logo_assets SET
        state='ATTACHED',attached_at=COALESCE(attached_at,clock_timestamp()),cleanup_token=NULL,
        cleanup_lease_expires_at=NULL WHERE object_key=$1 AND state IN ('PENDING','ATTACHED')`, [objectKey]);
      if (updated.rowCount !== 1) throw new Error('WALLET_LOGO_ATTACHMENT_CONFLICT');
    }
  }

  async claimExpired(): Promise<{ readonly token: string; readonly objectKeys: readonly string[] }> {
    // The cleanup token fences concurrent workers from finalizing each other's claims.
    const token = uuidv7();
    const objectKeys = await this.database.transaction(async client => (await client.query<{ object_key: string }>(`WITH candidates AS (
      SELECT asset.object_key FROM ${this.wallet}.wallet_logo_assets asset
      WHERE asset.state IN ('STAGING','PENDING','DELETE_PENDING')
        AND asset.expires_at<=clock_timestamp()
        AND (asset.cleanup_lease_expires_at IS NULL OR asset.cleanup_lease_expires_at<=clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM ${this.wallet}.wallet_logo_asset_references reference
          WHERE reference.object_key=asset.object_key)
      ORDER BY asset.delete_attempt_count,asset.expires_at,asset.object_key
      LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE ${this.wallet}.wallet_logo_assets asset SET state='DELETE_PENDING',cleanup_token=$2,
        cleanup_lease_expires_at=clock_timestamp()+interval '5 minutes',
        delete_attempt_count=delete_attempt_count+1 FROM candidates
      WHERE asset.object_key=candidates.object_key RETURNING asset.object_key`, [BATCH_SIZE, token])).rows.map(row => row.object_key));
    return { token, objectKeys };
  }

  async renewDeletion(objectKey: string, token: string): Promise<void> {
    await this.database.transaction(async client => {
      const result = await client.query(`UPDATE ${this.wallet}.wallet_logo_assets SET
        cleanup_lease_expires_at=clock_timestamp()+interval '5 minutes'
        WHERE object_key=$1 AND state='DELETE_PENDING' AND cleanup_token=$2
          AND cleanup_lease_expires_at>clock_timestamp()`, [objectKey, token]);
      if (result.rowCount !== 1) throw new Error('WALLET_LOGO_CLEANUP_FENCE_LOST');
    });
  }

  completeDeletion(objectKey: string, token: string): Promise<void> { return this.finish(objectKey, token, true); }
  releaseDeletion(objectKey: string, token: string): Promise<void> { return this.finish(objectKey, token, false); }
  private async finish(objectKey: string, token: string, deleted: boolean): Promise<void> {
    await this.database.transaction(async client => {
      const result = await client.query(`UPDATE ${this.wallet}.wallet_logo_assets SET
        state=CASE WHEN $3 THEN 'DELETED'::${this.wallet}."WalletLogoAssetState" ELSE state END,
        deleted_at=CASE WHEN $3 THEN clock_timestamp() ELSE deleted_at END,
        cleanup_token=NULL,cleanup_lease_expires_at=NULL
        WHERE object_key=$1 AND state='DELETE_PENDING' AND cleanup_token=$2`, [objectKey, token, deleted]);
      if (result.rowCount !== 1) throw new Error('WALLET_LOGO_CLEANUP_FENCE_LOST');
    });
  }
}
