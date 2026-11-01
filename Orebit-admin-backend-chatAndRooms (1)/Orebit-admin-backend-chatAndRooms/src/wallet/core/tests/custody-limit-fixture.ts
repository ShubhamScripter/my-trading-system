import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const mapped = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const canonical = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_reconciliation_test?schema=wallet_core';
export const custodyTarget = process.env.WALLET_CUSTODY_SCHEMA_TEST_DATABASE_URL
  ?? (process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true' && process.env.WALLET_CORE_TEST_DATABASE_URL === mapped ? mapped : undefined);
export const custodyLive = process.env.NODE_ENV === 'test' && Boolean(custodyTarget);
export const wallet = custodyTarget === canonical ? 'wallet_core' : 'wallet_core_test';
const price = custodyTarget === canonical ? 'price_conversion' : 'price_conversion_test';
export const id = () => { const chars = randomUUID().split(''); chars[14] = '7'; chars[19] = '8'; return chars.join(''); };

export async function custodyPool(): Promise<pg.Pool> {
  assert.ok(custodyTarget === mapped || custodyTarget === canonical, 'exact approved custody target required');
  const pool = new pg.Pool({ connectionString: custodyTarget, max: 4 });
  try {
  const identity = (await pool.query(`SELECT current_database() name,current_user owner,inet_server_port() port,
    (SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
  assert.deepEqual(identity, { name: custodyTarget === canonical ? 'orebit_wallet_reconciliation_test' : 'orebit_wallet_core_test',
    owner: 'orebit_wallet_core_test_owner', port: 5432, system_id: '7681719399426031650' });
  return pool;
  } catch (error) { await pool.end(); throw error; }
}

export type CustodyFixture = { currency: string; bindings: string[] };
export async function custodyFixture(pool: pg.Pool, seed = 0, bindings = 1): Promise<CustodyFixture> {
  const client = await pool.connect(); const currency = id(); const result: CustodyFixture = { currency, bindings: [] };
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${price}.currencies(id,symbol,name,decimals,kind,pricing_status)
      VALUES($1,$2,'Custody concurrency fixture',18,'CRYPTO','DISABLED')`, [currency, 'Q' + currency.replaceAll('-', '').slice(-20).toUpperCase()]);
    // Keep retained fixture addresses outside current reconciliation capture revisions.
    await client.query(`INSERT INTO ${wallet}.currency_settings(currency_id,policy_revision) VALUES($1,9000000000000)`, [currency]);
    for (let ordinal = 0; ordinal < bindings; ordinal++) {
      const chain = id(), binding = id(); const provider = Number.parseInt(chain.replaceAll('-', '').slice(-12), 16) + 1;
      assert.ok(Number.isSafeInteger(provider) && provider > 0 && provider <= 2 ** 48);
      await client.query(`INSERT INTO ${wallet}.chains(id,provider_chain_id,short_name,name,is_evm)
        VALUES($1,$2,$3,'Custody concurrency chain',true)`, [chain, provider, 'Q' + chain.replaceAll('-', '').slice(-20).toUpperCase()]);
      await client.query(`INSERT INTO ${wallet}.currencies(id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
        VALUES($1,$2,$3,$4,false,true,18)`, [binding, currency, chain, provider]);
      result.bindings.push(binding);
      if (seed) await insertAddresses(client, binding, 'HOT', seed, 'seed');
    }
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function retireCustodyFixture(pool: pg.Pool, fixture: CustodyFixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revision = (await client.query(`UPDATE ${wallet}.currency_settings SET policy_revision=policy_revision+1
      WHERE currency_id=$1 RETURNING policy_revision`, [fixture.currency])).rows[0].policy_revision;
    await client.query(`UPDATE ${wallet}.custody_addresses SET retired_at=clock_timestamp(),retired_revision=$2
      WHERE currency_chain_id=ANY($1::uuid[]) AND retired_at IS NULL`, [fixture.bindings, revision]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export function insertAddresses(client: pg.PoolClient, binding: string, kind: string, count: number, prefix: string) {
  return client.query(`INSERT INTO ${wallet}.custody_addresses(currency_chain_id,kind,wallet_address,address_identity)
    SELECT $1,$2,$3||'-'||n,lower($3||'-'||n) FROM generate_series(1,$4::int) n`, [binding, kind, prefix, count]);
}

export async function lockWait(pool: pg.Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected database lock wait did not occur');
}
