/**
 * Development-only rain balances and USD rates (`RAIN_DEV_WALLET=true`). There is no real ledger behind it, so a
 * live rain would credit a table that is not the wallet: it is refused whenever NODE_ENV is production, whatever
 * the variable says.
 *
 * Read here from the environment rather than from src/config.ts, which is not chat's to edit (decision D-02).
 */
export function rainDevWallet(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.RAIN_DEV_WALLET === 'true';
}
