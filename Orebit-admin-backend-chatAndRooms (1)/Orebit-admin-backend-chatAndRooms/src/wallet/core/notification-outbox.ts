import { uuidv7 } from '../../utils/public.utils.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import type { WalletProviderMaintenanceOutboxEvent } from './wallet-core.types.js';

/** Describes a durable, idempotent operator-notification request. */
export interface WalletNotificationOutboxInput {
  readonly eventType: WalletProviderMaintenanceOutboxEvent;
  readonly dedupeKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Persists maintenance notifications in the caller's transaction for reliable later delivery. */
export class WalletNotificationOutbox {
  private readonly wallet: string;

  constructor(database: WalletCoreDatabase) {
    this.wallet = database.schemas.wallet;
  }

  async enqueueWithClient(
    client: WalletCoreClient,
    input: WalletNotificationOutboxInput,
  ): Promise<void> {
    const payload = JSON.stringify(input.payload);
    const inserted = await client.query<{ readonly id: unknown }>(
      `INSERT INTO ${this.wallet}.wallet_notification_outbox
      (id,event_type,dedupe_key,payload,status)
      VALUES ($1,$2,$3,$4::jsonb,'PENDING') ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id::text`, [uuidv7(), input.eventType, input.dedupeKey, payload]);
    if (inserted.rowCount === 1 && inserted.rows.length === 1
      && typeof inserted.rows[0]?.id === 'string') return;
    if (inserted.rowCount !== 0 || inserted.rows.length !== 0) {
      throw new Error('WALLET_NOTIFICATION_OUTBOX_RESULT_INVALID');
    }
    // A reused dedupe key is safe only when it represents the identical event.
    const existing = await client.query<{
      readonly event_type: unknown; readonly same_payload: unknown;
    }>(`SELECT event_type,payload=$2::jsonb same_payload FROM
      ${this.wallet}.wallet_notification_outbox WHERE dedupe_key=$1 FOR SHARE`,
    [input.dedupeKey, payload]);
    if (existing.rows.length === 1
      && existing.rows[0]?.event_type === input.eventType
      && existing.rows[0]?.same_payload === true) return;
    throw new Error('WALLET_NOTIFICATION_OUTBOX_CONFLICT');
  }
}
