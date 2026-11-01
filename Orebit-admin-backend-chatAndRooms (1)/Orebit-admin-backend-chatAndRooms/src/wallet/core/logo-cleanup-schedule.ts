import type { WalletCoreDatabase } from './wallet-core.database.js';

const FIVE_MINUTES_MS = 300_000;

/** Returns the current five-minute cleanup bucket from the authoritative PostgreSQL clock. */
export function walletLogoCleanupScheduledFor(database: WalletCoreDatabase): Promise<Date> {
  return database.transaction(async (client) => {
    const result = await client.query<{ readonly scheduled_for: unknown }>(`SELECT
      to_timestamp(floor(extract(epoch FROM clock_timestamp())/300)*300) scheduled_for`);
    const raw = result.rows[0]?.scheduled_for;
    const scheduledFor = raw instanceof Date ? new Date(raw.valueOf()) : new Date(String(raw));
    if (!Number.isFinite(scheduledFor.valueOf())
      || scheduledFor.valueOf() % FIVE_MINUTES_MS !== 0) {
      throw new Error('WALLET_LOGO_CLEANUP_SCHEDULE_INVALID');
    }
    return scheduledFor;
  });
}
