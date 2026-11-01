import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

const root = resolve(__dirname, '..');
const URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === URL;
const ALERTS = ['SHORTFALL', 'PARTIAL_DATA', 'STAKING_TOTAL_MISMATCH',
  'CATALOGUE_REFRESH_FAILED', 'PROVIDER_MAINTENANCE'];
const CRON_REASONS = ['CONFIGURATION_REJECTED', 'PROVIDER_OBSERVATION_PARTIAL',
  'PROVIDER_OBSERVATION_FAILED', 'DEPENDENCY_UNAVAILABLE', 'MISSED_SCHEDULE',
  'CATCHUP_TRUNCATED', 'UNEXPECTED_ERROR'];
const ids = {
  chain: '019f2000-0000-7000-8000-000000000001',
  binding: '550e8400-e29b-41d4-a716-446655440002',
  chainAlert: '019f2000-0000-7000-8000-000000000003',
  bindingAlert: '019f2000-0000-7000-8000-000000000004',
  event: '019f2000-0000-7000-8000-000000000005',
} as const;

async function rejects(client: pg.PoolClient, work: () => Promise<unknown>): Promise<void> {
  await client.query('SAVEPOINT task7_reject');
  await assert.rejects(work);
  await client.query('ROLLBACK TO SAVEPOINT task7_reject');
  await client.query('RELEASE SAVEPOINT task7_reject');
}

it('pins provider-maintenance alert and cron safe-reason schema contracts', async () => {
  const [sql, schema, env] = await Promise.all([
    readFile(resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql'), 'utf8'),
    readFile(resolve(root, 'schema.prisma'), 'utf8'), readFile(resolve(root, '.env.example'), 'utf8'),
  ]);
  const sqlAlert = /WalletAlertCategory" AS ENUM \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  const sqlCron = /WalletCronSafeReasonCode" AS ENUM \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  const members = (value: string) => [...value.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(members(sqlAlert), ALERTS); assert.deepEqual(members(sqlCron), CRON_REASONS);
  assert.match(schema, /enum WalletCronSafeReasonCode \{[\s\S]*?@@schema\("wallet_core"\)/);
  assert.match(schema, /safeErrorCode\s+WalletCronSafeReasonCode\?\s+@map\("safe_error_code"\)/);
  assert.match(schema, /skippedBucketCount\s+Int\s+@default\(0\)\s+@map\("skipped_bucket_count"\)/);
  assert.match(sql, /PROVIDER_MAINTENANCE[\s\S]*subjectType[\s\S]*providerReference[\s\S]*observedAt/);
  assert.equal(sql.match(/consecutive_failed_checks BETWEEN 0 AND 3/g)?.length, 2);
  assert.match(sql, /CATCHUP_TRUNCATED[\s\S]*skipped_bucket_count > 0/);
  assert.match(sql, /status = 'PARTIAL'[\s\S]*CONFIGURATION_REJECTED[\s\S]*PROVIDER_OBSERVATION_PARTIAL/);
  assert.match(sql, /status = 'FAILED'[\s\S]*PROVIDER_OBSERVATION_FAILED[\s\S]*DEPENDENCY_UNAVAILABLE[\s\S]*UNEXPECTED_ERROR/);
  assert.match(sql, /status = 'SKIPPED'[\s\S]*MISSED_SCHEDULE[\s\S]*CATCHUP_TRUNCATED/);
  assert.equal(env.split(/\r?\n/).filter((line) => line === 'WALLET_WORKER_INSTANCE_ID=').length, 1);
});

describe('Wallet Task 7 schema boundaries', { skip: !LIVE }, () => {
  it('accepts only coherent closed provider-maintenance alerts and immutable events', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 1 }); const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currencyId = (await client.query(`SELECT id::text FROM price_conversion_test.currencies
        ORDER BY id LIMIT 1`)).rows[0].id as string;
      await client.query(`INSERT INTO wallet_core_test.chains
        (id,provider_chain_id,short_name,name,is_evm,provider_state)
        VALUES ($1,42,'T7','Task Seven Chain',true,'MAINTENANCE')`, [ids.chain]);
      await client.query(`INSERT INTO wallet_core_test.currencies
        (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision,provider_state)
        VALUES ($1,$2,$3,99,false,true,18,'DISABLED')`, [ids.binding, currencyId, ids.chain]);
      await client.query(`UPDATE wallet_core_test.chains SET consecutive_failed_checks=3
        WHERE id=$1`, [ids.chain]);
      await client.query(`UPDATE wallet_core_test.currencies SET consecutive_failed_checks=3
        WHERE id=$1`, [ids.binding]);
      await rejects(client, () => client.query(`UPDATE wallet_core_test.chains
        SET consecutive_failed_checks=4 WHERE id=$1`, [ids.chain]));
      await rejects(client, () => client.query(`UPDATE wallet_core_test.currencies
        SET consecutive_failed_checks=4 WHERE id=$1`, [ids.binding]));
      const chainPayload = { subjectType: 'CHAIN', subjectId: ids.chain,
        providerReference: 'CHAIN:42', providerState: 'MAINTENANCE', failureStreak: 3,
        maintenancePinned: false, effectiveState: 'MAINTAIN',
        observedAt: '2026-09-05T09:00:00.123456Z' };
      const bindingPayload = { ...chainPayload, subjectType: 'CURRENCY_CHAIN',
        subjectId: ids.binding, providerReference: 'CURRENCY_CHAIN:42:99',
        providerState: 'DISABLED', effectiveState: 'OFF' };
      await client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES ($1,'task7-chain','PROVIDER_MAINTENANCE','ACTIVE',NULL,$2,now(),now())`,
      [ids.chainAlert, chainPayload]);
      await client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES ($1,'task7-binding','PROVIDER_MAINTENANCE','ACTIVE',$2,$3,now(),now())`,
      [ids.bindingAlert, currencyId, bindingPayload]);
      await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
        (id,alert_id,category,status,payload) VALUES
        ($1,$2,'PROVIDER_MAINTENANCE','ACTIVE',$3)`, [ids.event, ids.bindingAlert, bindingPayload]);
      const invalid: Array<[string | null, Record<string, unknown>]> = [
        [currencyId, chainPayload], [null, bindingPayload],
        [currencyId, { ...bindingPayload, subjectId: ids.chain }],
        [currencyId, { ...bindingPayload, providerReference: 'CURRENCY_CHAIN:42:100' }],
        [null, { ...chainPayload, providerReference: 'CHAIN:042' }],
        [currencyId, { ...bindingPayload, subjectId: ids.binding.toUpperCase() }],
        [null, { ...chainPayload, failureStreak: 4 }],
        [null, { ...chainPayload, providerState: 'BROKEN' }],
        [null, { ...chainPayload, effectiveState: 'UPCOMING' }],
        [null, { ...chainPayload, observedAt: '2026-09-05T09:00:00+00:00' }],
        [null, { ...chainPayload, raw: 'provider-body' }],
      ];
      for (const [index, [rowCurrency, payload]] of invalid.entries()) await rejects(client,
        () => client.query(`INSERT INTO wallet_core_test.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
          VALUES (gen_random_uuid(),$1,'PROVIDER_MAINTENANCE','ACTIVE',$2,$3,now(),now())`,
        [`task7-bad-${index}`, rowCurrency, payload]));
    } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
  });

  it('enforces the closed cron reason enum and catch-up skipped-bucket summary', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 1 }); const client = await pool.connect();
    const running = async (id: string, job: string) => client.query(`INSERT INTO
      wallet_core_test.cronjob_runs(id,job_name,scheduled_for,worker_instance_id,status)
      VALUES ($1,$2,clock_timestamp()+($3::int*interval '1 second'),'task7-worker','RUNNING')`,
    [id, job, Number(id.slice(-2))]);
    try {
      await client.query('BEGIN');
      const partial = '019f2000-0000-7000-8000-000000000010'; await running(partial, 'task7-partial');
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='PARTIAL',
        lease_expires_at=NULL,safe_error_code='PROVIDER_OBSERVATION_PARTIAL',
        finished_at=clock_timestamp() WHERE id=$1`, [partial]);
      const catchup = '019f2000-0000-7000-8000-000000000011'; await running(catchup, 'task7-catchup');
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='SKIPPED',
        lease_expires_at=NULL,safe_error_code='CATCHUP_TRUNCATED',skipped_bucket_count=288,
        finished_at=clock_timestamp() WHERE id=$1`, [catchup]);
      const missed = '019f2000-0000-7000-8000-000000000012'; await running(missed, 'task7-missed');
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='SKIPPED',
        lease_expires_at=NULL,safe_error_code='MISSED_SCHEDULE',finished_at=clock_timestamp()
        WHERE id=$1`, [missed]);
      assert.deepEqual((await client.query(`SELECT safe_error_code::text,skipped_bucket_count
        FROM wallet_core_test.cronjob_runs WHERE id IN ($1,$2,$3) ORDER BY id`,
      [partial, catchup, missed])).rows, [
        { safe_error_code: 'PROVIDER_OBSERVATION_PARTIAL', skipped_bucket_count: 0 },
        { safe_error_code: 'CATCHUP_TRUNCATED', skipped_bucket_count: 288 },
        { safe_error_code: 'MISSED_SCHEDULE', skipped_bucket_count: 0 },
      ]);
      for (const [suffix, status, reason, skipped] of [
        ['13', 'SKIPPED', 'CATCHUP_TRUNCATED', 0],
        ['14', 'SKIPPED', 'MISSED_SCHEDULE', 1],
        ['15', 'PARTIAL', 'CATCHUP_TRUNCATED', 1],
        ['16', 'FAILED', 'TIMEOUT', 0],
        ['17', 'PARTIAL', 'PROVIDER_OBSERVATION_FAILED', 0],
        ['18', 'FAILED', 'PROVIDER_OBSERVATION_PARTIAL', 0],
        ['19', 'SKIPPED', 'CONFIGURATION_REJECTED', 0],
      ] as const) {
        const id = `019f2000-0000-7000-8000-0000000000${suffix}`; await running(id, `task7-${suffix}`);
        await rejects(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs SET
          status=$2,lease_expires_at=NULL,safe_error_code=$3,skipped_bucket_count=$4,
          finished_at=clock_timestamp() WHERE id=$1`, [id, status, reason, skipped]));
      }
    } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
  });
});
