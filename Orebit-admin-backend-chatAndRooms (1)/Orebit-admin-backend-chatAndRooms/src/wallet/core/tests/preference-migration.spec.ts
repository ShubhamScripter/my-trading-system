import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';

const load = async () => await import(pathToFileURL(resolve(__dirname, '../provision-test-database.cjs')).href) as {
  assertSafeWalletCoreTestDatabase(): Promise<pg.Pool>;
  applyWalletCoreTestPreferenceMigration(env: NodeJS.ProcessEnv, open?: () => Promise<unknown>, inspect?: () => Promise<unknown>): Promise<void>;
};
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const live = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;

it('maps only the forward preference migration on one connection without resetting or rewriting data', async () => {
  const calls: string[] = []; let released = 0; let closed = 0;
  const client = { async query(sql: string) { calls.push(sql); return { rows: [] }; }, release() { released++; } };
  const pool = { async query() { return { rows: [{ database: 'orebit_wallet_core_test',
    cluster: 'orebit_wallet_core_test', address: '172.18.0.2', port: 5432 }] }; },
    async connect() { return client; }, async end() { closed++; } };
  const env = { NODE_ENV: 'test', WALLET_CORE_TEST_ALLOW_RESET: 'true', WALLET_CORE_TEST_DATABASE_URL: TEST_URL,
    WALLET_CORE_DATABASE_URL: 'postgresql://validation:validation@127.0.0.1:1/validation?schema=wallet_core',
    WALLET_CORE_DATABASE_DIRECT_URL: 'postgresql://validation:validation@127.0.0.1:1/validation?schema=wallet_core' };
  const docker = [{ Name: '/orebit-wallet-core-postgres-test', State: { Running: true },
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55435' }] } } }];
  await (await load()).applyWalletCoreTestPreferenceMigration(env, async () => pool, async () => docker);
  const sql = calls.join('\n');
  assert.match(sql, /ALTER TABLE wallet_core_test\.user_preferences/);
  assert.match(sql, /DROP NOT NULL/);
  assert.doesNotMatch(sql, /DROP SCHEMA|TRUNCATE|DELETE FROM|UPDATE\s|wallet_core\./);
  assert.equal(calls[0], 'BEGIN'); assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(released, 1); assert.equal(closed, 1);
});

it('preserves the immutable expand migration while Prisma describes nullable preference slots', async () => {
  const root = resolve(__dirname, '..');
  const expand = await readFile(resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql'));
  assert.equal(createHash('sha256').update(expand).digest('hex'), '68fd95f25ce870266b6fcdff52dd93a55479ca73f53a09fd257f01a4f289342c');
  const schema = await readFile(resolve(root, 'schema.prisma'), 'utf8');
  const preference = /model WalletUserPreference \{([^}]+)\}/.exec(schema)![1]!;
  assert.match(preference, /preferredViewCurrencyId\s+String\?/);
  assert.match(preference, /preferredCryptocurrencyId\s+String\?/);
});

it('allows exactly one initialized preference while preserving both FKs and the distinct/nonempty checks', { skip: !live }, async () => {
  const pool = await (await load()).assertSafeWalletCoreTestDatabase();
  const client = await pool.connect();
  try {
    const columns = (await client.query(`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema='wallet_core_test' AND table_name='user_preferences'
      AND column_name IN ('preferred_view_currency_id','preferred_cryptocurrency_id') ORDER BY column_name`)).rows;
    assert.deepEqual(columns.map(row => row.is_nullable), ['YES', 'YES']);
    const currencyId = (await client.query('SELECT id FROM price_conversion_test.currencies ORDER BY symbol LIMIT 1')).rows[0].id;
    await client.query('BEGIN');
    await client.query('INSERT INTO wallet_core_test.user_preferences (user_id,preferred_view_currency_id) VALUES ($1,$2)', [randomUUID(), currencyId]);
    await client.query('INSERT INTO wallet_core_test.user_preferences (user_id,preferred_cryptocurrency_id) VALUES ($1,$2)', [randomUUID(), currencyId]);
    for (const [view, crypto] of [[null, null], [currencyId, currencyId], [randomUUID(), null], [null, randomUUID()]]) {
      await client.query('SAVEPOINT invalid');
      await assert.rejects(() => client.query(`INSERT INTO wallet_core_test.user_preferences
        (user_id,preferred_view_currency_id,preferred_cryptocurrency_id) VALUES ($1,$2,$3)`, [randomUUID(), view, crypto]));
      await client.query('ROLLBACK TO SAVEPOINT invalid');
    }
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});
