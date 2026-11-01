import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

function testDatabaseUrl(): string {
  const value = process.env.PRICE_TEST_DATABASE_URL;
  if (value === undefined) throw new Error('PRICE_TEST_DATABASE_URL is required');
  return value;
}

describe('canonical 00008-00011 lifecycle, freshness, timestamp, and storage guards', () => {
  it('protects immutable payloads while permitting only legal lifecycle transitions', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const configId = randomUUID();
    const fetchId = randomUUID();
    const notificationId = randomUUID();
    const actorId = randomUUID();
    const revision = String(BigInt(Date.now()) * 100_000n + BigInt(process.pid));
    try {
      const providerId = (await client.query<{ id: string }>(`
        SELECT id FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`)).rows[0]?.id;
      assert.ok(providerId);
      await client.query('BEGIN');
      await client.query(`INSERT INTO price_conversion_test.price_config_changes
        (id, revision, status, changelog, actor_id, config, scope_key)
        VALUES ($1, $2, 'DRAFT', 'immutable config', $3, '{"value":1}', $4)`,
      [configId, revision, actorId, `guard-${configId}`]);
      await client.query(`INSERT INTO price_conversion_test.price_fetch_runs
        (id, provider_id, scheduled_for, status, worker_instance_id, started_at, attempt_count)
        VALUES ($1, $2, '1750-01-01', 'RUNNING', 'guard-worker', '1750-01-01', 1)`, [fetchId, providerId]);
      await client.query(`INSERT INTO price_conversion_test.price_admin_notifications
        (id, type, dedupe_key, payload, delivery_status)
        VALUES ($1, 'PROVIDER_FAILURE', $2, '{"value":1}', 'PENDING')`,
      [notificationId, `guard-${notificationId}`]);

      for (const [sql, values] of [
        [`UPDATE price_conversion_test.price_config_changes SET config = '{"value":2}' WHERE id = $1`, [configId]],
        [`UPDATE price_conversion_test.price_fetch_runs SET scheduled_for = '1750-01-02' WHERE id = $1`, [fetchId]],
        [`UPDATE price_conversion_test.price_admin_notifications SET payload = '{"value":2}' WHERE id = $1`, [notificationId]],
      ] as Array<[string, unknown[]]>) {
        await client.query('SAVEPOINT lifecycle_negative');
        await assert.rejects(() => client.query(sql, values), /immutable|lifecycle/i);
        await client.query('ROLLBACK TO SAVEPOINT lifecycle_negative');
      }

      await client.query(`UPDATE price_conversion_test.price_config_changes
        SET status = 'SCHEDULED', effective_at = now() WHERE id = $1`, [configId]);
      await client.query(`UPDATE price_conversion_test.price_config_changes
        SET status = 'REJECTED' WHERE id = $1`, [configId]);
      await client.query(`UPDATE price_conversion_test.price_fetch_runs
        SET status = 'FAILED', finished_at = now(), safe_error_code = 'PROVIDER_FAILURE' WHERE id = $1`, [fetchId]);
      await client.query(`UPDATE price_conversion_test.price_fetch_runs
        SET status = 'RUNNING', attempt_count = 2, started_at = now(), finished_at = NULL,
          safe_error_code = NULL, next_retry_at = NULL WHERE id = $1`, [fetchId]);
      await client.query(`UPDATE price_conversion_test.price_fetch_runs
        SET status = 'SUCCESS', finished_at = now() WHERE id = $1`, [fetchId]);
      await client.query(`UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'PROCESSING', attempt_count = 1, claimed_at = now(),
          claimed_by = 'guard-worker', claim_token = gen_random_uuid() WHERE id = $1`, [notificationId]);
      await client.query(`UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'SENT', delivered_at = now(), claimed_at = NULL,
          claimed_by = NULL, claim_token = NULL WHERE id = $1`, [notificationId]);

      for (const [sql, values] of [
        [`UPDATE price_conversion_test.price_config_changes SET status = 'LIVE' WHERE id = $1`, [configId]],
        [`UPDATE price_conversion_test.price_fetch_runs SET status = 'RUNNING' WHERE id = $1`, [fetchId]],
        [`UPDATE price_conversion_test.price_admin_notifications SET delivery_status = 'PROCESSING' WHERE id = $1`, [notificationId]],
      ] as Array<[string, unknown[]]>) {
        await client.query('SAVEPOINT lifecycle_transition');
        await assert.rejects(() => client.query(sql, values), /immutable|lifecycle|terminal|transition/i);
        await client.query('ROLLBACK TO SAVEPOINT lifecycle_transition');
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('keeps ledger valuation fail-closed on wall-clock freshness and security state', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const result = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef(to_regprocedure(
          'price_conversion_test.resolve_money_batch_for_ledger(uuid[])'
        )) AS definition`);
      const definition = result.rows[0]?.definition ?? '';
      assert.match(definition, /statement_timestamp\(\)/);
      assert.match(definition, /freshness_seconds/);
      assert.match(definition, /snapshot\.observed_at >= statement_timestamp\(\)/);
      assert.match(definition, /snapshot\.observed_at <= statement_timestamp\(\) \+ interval '60 seconds'/);
      assert.match(definition, /security_state = 'HEALTHY'/);
      assert.match(definition, /c\.pricing_status = 'ACTIVE'/);
      assert.match(definition, /NOT c\.auto_disabled/);
      assert.match(definition, /NOT r\.stale/);
    } finally {
      await client.end();
    }
  });

  it('couples retry and delivery claims to their complete lifecycle fields', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const fetchId = randomUUID();
    const notificationId = randomUUID();
    try {
      const providerId = (await client.query<{ id: string }>(`SELECT id
        FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`)).rows[0]?.id;
      assert.ok(providerId);
      await client.query('BEGIN');
      await client.query(`INSERT INTO price_conversion_test.price_fetch_runs
        (id, provider_id, scheduled_for, status, worker_instance_id, started_at, finished_at,
          attempt_count, next_retry_at, safe_error_code)
        VALUES ($1, $2, '1740-01-01', 'FAILED', 'failed-worker', '1740-01-01',
          '1740-01-01', 1, '1740-01-01', 'PROVIDER_FAILURE')`, [fetchId, providerId]);
      await assertSavepointReject(client, 'fetch_missing_attempt', `UPDATE price_conversion_test.price_fetch_runs
        SET status = 'RUNNING', worker_instance_id = 'retry-worker', started_at = now(),
          finished_at = NULL, next_retry_at = NULL, safe_error_code = NULL WHERE id = $1`, [fetchId]);
      await assertSavepointReject(client, 'fetch_missing_claim', `UPDATE price_conversion_test.price_fetch_runs
        SET status = 'RUNNING', attempt_count = 2 WHERE id = $1`, [fetchId]);
      await client.query(`UPDATE price_conversion_test.price_fetch_runs
        SET status = 'RUNNING', attempt_count = 2, worker_instance_id = 'retry-worker',
          started_at = now(), finished_at = NULL, next_retry_at = NULL, safe_error_code = NULL
        WHERE id = $1`, [fetchId]);
      await assertSavepointReject(client, 'fetch_missing_finish', `UPDATE price_conversion_test.price_fetch_runs
        SET status = 'SUCCESS' WHERE id = $1`, [fetchId]);
      await client.query(`UPDATE price_conversion_test.price_fetch_runs
        SET status = 'SUCCESS', finished_at = now() WHERE id = $1`, [fetchId]);

      await client.query(`INSERT INTO price_conversion_test.price_admin_notifications
        (id, type, dedupe_key, payload, delivery_status)
        VALUES ($1, 'PROVIDER_FAILURE', $2, '{}', 'PENDING')`,
      [notificationId, `strict-claim-${notificationId}`]);
      await assertSavepointReject(client, 'notification_missing_claim', `UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'PROCESSING' WHERE id = $1`, [notificationId]);
      await client.query(`UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'PROCESSING', attempt_count = 1, claimed_at = now(),
          claimed_by = 'strict-worker', claim_token = gen_random_uuid() WHERE id = $1`, [notificationId]);
      await assertSavepointReject(client, 'notification_still_claimed', `UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'SENT', delivered_at = now() WHERE id = $1`, [notificationId]);
      await client.query(`UPDATE price_conversion_test.price_admin_notifications
        SET delivery_status = 'SENT', delivered_at = now(), claimed_at = NULL,
          claimed_by = NULL, claim_token = NULL WHERE id = $1`, [notificationId]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('rejects FIAT rows from both sensitive storage tables at the database boundary', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const currencyId = randomUUID();
    try {
      const providerId = (await client.query<{ id: string }>(`SELECT id
        FROM price_conversion_test.price_providers WHERE code = 'COINGECKO'`)).rows[0]?.id;
      assert.ok(providerId);
      await client.query('BEGIN');
      await client.query(`INSERT INTO price_conversion_test.currencies
        (id, symbol, name, decimals, kind) VALUES ($1, 'INR', 'Indian Rupee', 2, 'FIAT')`, [currencyId]);
      await client.query('SAVEPOINT fiat_snapshot');
      await assert.rejects(() => client.query(`INSERT INTO price_conversion_test.price_snapshots
        (provider_id, currency_id, price_usd, observed_at, response_hash)
        VALUES ($1, $2, 1, now(), repeat('a', 64))`, [providerId, currencyId]), /CRYPTO currency/i);
      await client.query('ROLLBACK TO SAVEPOINT fiat_snapshot');
      await client.query('SAVEPOINT fiat_resolution');
      await assert.rejects(() => client.query(`INSERT INTO price_conversion_test.price_resolutions
        (currency_id, reason) VALUES ($1, 'PRICE_UNAVAILABLE')`, [currencyId]), /CRYPTO currency/i);
      await client.query('ROLLBACK TO SAVEPOINT fiat_resolution');
      const privilege = await client.query<{ allowed: boolean }>(`SELECT has_function_privilege(
        'public', 'price_conversion_test.enforce_sensitive_crypto_currency()', 'EXECUTE'
      ) AS allowed`);
      assert.equal(privilege.rows[0]?.allowed, false);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});

async function assertSavepointReject(
  client: pg.Client,
  savepoint: string,
  sql: string,
  values: unknown[],
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  await assert.rejects(() => client.query(sql, values), /attempt|claim|finish|delivered|retry|terminal|lifecycle/i);
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
}
