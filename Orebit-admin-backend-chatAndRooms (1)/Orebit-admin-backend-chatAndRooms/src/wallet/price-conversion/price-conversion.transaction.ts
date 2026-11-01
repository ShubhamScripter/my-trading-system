import type { PoolClient } from 'pg';
import type { PriceConversionPool } from './price-conversion.database.js';

/** Runs one transaction; failed cleanup must preserve its original failure. */
export async function priceConversionTransaction<T>(
  pool: PriceConversionPool,
  work: (client: PoolClient) => Promise<T>,
  begin: 'BEGIN' | 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  let discard: true | undefined;
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => { discard = true; });
    throw error;
  } finally {
    // Failed rollback leaves session state uncertain; destroy that client.
    try { client.release(discard); } catch (error) { if (!failed) throw error; }
  }
}
