import assert from 'node:assert/strict';
import pg from 'pg';
import { test } from 'node:test';

import { WalletLogoAssetRepository } from '../logo-asset.repository.js';

const EXPECTED_DATABASE_URL =
  'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const key = (value: number) => `${value.toString(16).padStart(64, '0')}.webp`;

test('database claim gives a never-attempted logo one slot ahead of 100 poison rows', async () => {
  const databaseUrl = process.env.WALLET_CORE_TEST_DATABASE_URL;
  assert.equal(databaseUrl, EXPECTED_DATABASE_URL,
    'WALLET_CORE_TEST_DATABASE_URL must target the approved mapped Wallet test database');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  try {
    const poison = Array.from({ length: 100 }, (_, index) => ({
      objectKey: key(20_000 + index), expiresOffsetSeconds: 200 - index,
    }));
    const good = key(30_000);
    await client.query(`WITH captured AS (SELECT clock_timestamp() observed_at), input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
        "objectKey" text,"expiresOffsetSeconds" integer)
    ) INSERT INTO wallet_core_test.wallet_logo_assets
      (object_key,state,created_at,expires_at,delete_attempt_count)
      SELECT "objectKey",'DELETE_PENDING',
        captured.observed_at-interval '3 days'+"expiresOffsetSeconds"*interval '1 second',
        captured.observed_at-interval '2 days'+"expiresOffsetSeconds"*interval '1 second',1
      FROM input CROSS JOIN captured`, [JSON.stringify(poison)]);
    await client.query(`WITH captured AS (SELECT clock_timestamp() observed_at)
      INSERT INTO wallet_core_test.wallet_logo_assets
      (object_key,state,created_at,expires_at,delete_attempt_count)
      SELECT $1,'DELETE_PENDING',captured.observed_at-interval '2 days',
        captured.observed_at-interval '1 day',0 FROM captured`, [good]);

    const database = {
      schemas: { wallet: 'wallet_core_test' },
      async transaction<T>(work: (nested: typeof client) => Promise<T>) {
        await client.query('SAVEPOINT logo_cleanup_fairness');
        try {
          const result = await work(client);
          await client.query('RELEASE SAVEPOINT logo_cleanup_fairness');
          return result;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT logo_cleanup_fairness');
          await client.query('RELEASE SAVEPOINT logo_cleanup_fairness');
          throw error;
        }
      },
    };
    const claimed = await new WalletLogoAssetRepository(database as never).claimExpired();

    assert.equal(claimed.objectKeys.length, 100);
    assert.equal(claimed.objectKeys.includes(good), true);
    assert.equal(poison.filter((row) => claimed.objectKeys.includes(row.objectKey)).length, 99);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
});
