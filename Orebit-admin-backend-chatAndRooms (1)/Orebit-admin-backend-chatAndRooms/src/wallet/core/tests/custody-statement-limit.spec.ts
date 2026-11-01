import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { custodyLive, custodyPool, custodyFixture, retireCustodyFixture, insertAddresses, lockWait, wallet } from './custody-limit-fixture.js';

describe('custody statement limits and snapshot concurrency', { skip: !custodyLive }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await custodyPool(); });
  after(async () => { await pool?.end(); });

  it('keeps repeatable-read near-cap transactions from committing 10001 addresses', async () => {
    const fixture = await custodyFixture(pool, 9999); const binding = fixture.bindings[0]!;
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await a.query(`SELECT count(*) FROM ${wallet}.custody_addresses WHERE currency_chain_id=$1`, [binding]);
      await b.query(`SELECT count(*) FROM ${wallet}.custody_addresses WHERE currency_chain_id=$1`, [binding]);
      await insertAddresses(a, binding, 'HOT', 1, 'rr-a'); await a.query('COMMIT');
      await assert.rejects(() => insertAddresses(b, binding, 'HOT', 1, 'rr-b'),
        (error: unknown) => ['40001', '23514'].includes((error as { code: string }).code));
      await b.query('ROLLBACK');
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${wallet}.custody_addresses
        WHERE currency_chain_id=$1 AND retired_at IS NULL`, [binding])).rows[0].n, 10000);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await retireCustodyFixture(pool, fixture); }
  });

  it('accepts 10000 per kind, rejects bulk and subsequent overflow, and preserves empty conflicts', async () => {
    const fixture = await custodyFixture(pool); const binding = fixture.bindings[0]!; const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE orebit_wallet_core_admin_writer');
      await client.query('SAVEPOINT overflow');
      await assert.rejects(() => insertAddresses(client, binding, 'HOT', 10001, 'bulk'), /limit exceeded/);
      await client.query('ROLLBACK TO SAVEPOINT overflow');
      await insertAddresses(client, binding, 'HOT', 10000, 'hot');
      await client.query('SAVEPOINT overflow');
      await assert.rejects(() => insertAddresses(client, binding, 'HOT', 1, 'extra'), /limit exceeded/);
      await client.query('ROLLBACK TO SAVEPOINT overflow');
      const before = (await client.query(`SELECT xmin::text version,ctid::text tuple,to_jsonb(binding) body FROM ${wallet}.currencies binding WHERE id=$1`, [binding])).rows[0];
      await client.query(`INSERT INTO ${wallet}.custody_addresses(currency_chain_id,kind,wallet_address,address_identity)
        VALUES($1,'HOT','hot-1','hot-1') ON CONFLICT DO NOTHING`, [binding]);
      const after = (await client.query(`SELECT xmin::text version,ctid::text tuple,to_jsonb(binding) body FROM ${wallet}.currencies binding WHERE id=$1`, [binding])).rows[0];
      assert.deepEqual(after, before, 'an empty transition must not write the binding');
      await insertAddresses(client, binding, 'STAKING', 10000, 'hot');
      await insertAddresses(client, binding, 'COLD', 10000, 'cold');
      assert.equal((await client.query(`SELECT count(*)::int n FROM ${wallet}.custody_addresses WHERE currency_chain_id=$1`, [binding])).rows[0].n, 30000);
    } finally { await client.query('ROLLBACK'); client.release(); await retireCustodyFixture(pool, fixture); }
  });

  it('serializes read-committed near-cap writes and EVM HOT/COLD overlap', async () => {
    for (const scenario of ['cap', 'liquid']) {
      const fixture = await custodyFixture(pool, scenario === 'cap' ? 9999 : 0); const binding = fixture.bindings[0]!;
      const a = await pool.connect(), b = await pool.connect();
      try {
        await a.query('BEGIN'); await b.query('BEGIN');
        const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await insertAddresses(a, binding, 'HOT', 1, 'MiXeD');
        const pending = insertAddresses(b, binding, scenario === 'cap' ? 'HOT' : 'COLD', 1,
          scenario === 'cap' ? 'other' : 'mixed').then(() => null, error => error as Error);
        await lockWait(pool, pid); await a.query('COMMIT');
        const error = await pending; assert.ok(error); assert.match(error.message, /limit exceeded|both HOT and COLD|unique constraint/);
        await b.query('ROLLBACK');
      } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await retireCustodyFixture(pool, fixture); }
    }
  });

  it('orders direct inserts behind Admin binding locks without an advisory-lock deadlock', async () => {
    const fixture = await custodyFixture(pool); const binding = fixture.bindings[0]!;
    const admin = await pool.connect(), direct = await pool.connect();
    try {
      await admin.query('BEGIN'); await direct.query('BEGIN');
      await admin.query("SET LOCAL statement_timeout='5s'"); await direct.query("SET LOCAL statement_timeout='5s'");
      await admin.query(`SELECT id FROM ${wallet}.currencies WHERE id=$1 FOR UPDATE`, [binding]);
      const pid = (await direct.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const pending = insertAddresses(direct, binding, 'HOT', 1, 'direct').then(() => null, error => error as Error);
      await lockWait(pool, pid);
      await insertAddresses(admin, binding, 'HOT', 1, 'admin'); await admin.query('COMMIT');
      assert.equal(await pending, null); await direct.query('COMMIT');
    } finally { await admin.query('ROLLBACK'); await direct.query('ROLLBACK'); admin.release(); direct.release(); await retireCustodyFixture(pool, fixture); }
  });

  it('counts distinct binding/kind groups, preserves visible binding state and permits retired identity reuse', async () => {
    const fixture = await custodyFixture(pool, 0, 2); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query(`SELECT id,to_jsonb(binding) body FROM ${wallet}.currencies binding WHERE id=ANY($1::uuid[]) ORDER BY id`, [fixture.bindings])).rows;
      const providerIds = (await client.query(`SELECT chain.provider_chain_id,binding.provider_coin_id
        FROM ${wallet}.currencies binding JOIN ${wallet}.chains chain ON chain.id=binding.chain_id
        WHERE binding.id=ANY($1::uuid[])`, [fixture.bindings])).rows;
      assert.ok(providerIds.every(row => [row.provider_chain_id, row.provider_coin_id]
        .every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2 ** 48)));
      const writes = async () => Number((await client.query(`SELECT pg_stat_get_xact_tuples_updated('${wallet}.currencies'::regclass) n`)).rows[0].n);
      const writesBefore = await writes();
      await client.query(`INSERT INTO ${wallet}.custody_addresses(currency_chain_id,kind,wallet_address,address_identity)
        SELECT binding,kind::${wallet}."WalletAddressKind",kind||'-'||n,lower(kind||'-'||n)
        FROM unnest($1::uuid[]) binding CROSS JOIN unnest(ARRAY['HOT','STAKING']) kind CROSS JOIN generate_series(1,3) n`, [fixture.bindings]);
      assert.deepEqual((await client.query(`SELECT id,to_jsonb(binding) body FROM ${wallet}.currencies binding WHERE id=ANY($1::uuid[]) ORDER BY id`, [fixture.bindings])).rows, before);
      assert.equal(await writes() - writesBefore, 2, 'one physical version per affected binding, not per row or kind');
      await client.query(`UPDATE ${wallet}.currency_settings SET policy_revision=policy_revision+1 WHERE currency_id=$1`, [fixture.currency]);
      await client.query(`UPDATE ${wallet}.custody_addresses SET retired_at=clock_timestamp(),retired_revision=9000000000001 WHERE currency_chain_id=ANY($1::uuid[])`, [fixture.bindings]);
      await insertAddresses(client, fixture.bindings[0]!, 'COLD', 1, 'HOT');
      assert.equal((await client.query(`SELECT count(*)::int n FROM ${wallet}.custody_addresses WHERE currency_chain_id=$1 AND retired_at IS NULL`, [fixture.bindings[0]])).rows[0].n, 1);
    } finally { await client.query('ROLLBACK'); client.release(); await retireCustodyFixture(pool, fixture); }
  });

  it('serializes HOT and STAKING on one binding without FK upgrade deadlock and preserves allowed overlap', async () => {
    const fixture = await custodyFixture(pool); const binding = fixture.bindings[0]!;
    const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await insertAddresses(a, binding, 'HOT', 1, 'overlap');
      const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const pending = insertAddresses(b, binding, 'STAKING', 1, 'overlap').then(() => null, error => error as Error);
      await lockWait(pool, pid); await a.query('COMMIT');
      assert.equal(await pending, null); await b.query('COMMIT');
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await retireCustodyFixture(pool, fixture); }
  });

  it('rolls back an opposite-binding lock cycle without leaking a partial winner or violating limits', async () => {
    const fixture = await custodyFixture(pool, 0, 2); const a = await pool.connect(), b = await pool.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await a.query("SET LOCAL statement_timeout='5s'"); await b.query("SET LOCAL statement_timeout='5s'");
      await insertAddresses(a, fixture.bindings[0]!, 'HOT', 1, 'left');
      await insertAddresses(b, fixture.bindings[1]!, 'HOT', 1, 'right');
      const finish = (client: pg.PoolClient, binding: string, prefix: string) => insertAddresses(client, binding, 'HOT', 1, prefix)
        .then(async () => { await client.query('COMMIT'); return null; },
          async (error: { code: string }) => { await client.query('ROLLBACK'); return error.code; });
      const outcomes = await Promise.all([finish(a, fixture.bindings[1]!, 'left-cross'), finish(b, fixture.bindings[0]!, 'right-cross')]);
      assert.deepEqual(outcomes.filter(Boolean), ['40P01']);
      const rows = (await pool.query(`SELECT currency_chain_id,count(*)::int n FROM ${wallet}.custody_addresses
        WHERE currency_chain_id=ANY($1::uuid[]) AND retired_at IS NULL GROUP BY currency_chain_id`, [fixture.bindings])).rows;
      assert.equal(rows.length, 2); assert.ok(rows.every(row => row.n === 1));
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await retireCustodyFixture(pool, fixture); }
  });
});
