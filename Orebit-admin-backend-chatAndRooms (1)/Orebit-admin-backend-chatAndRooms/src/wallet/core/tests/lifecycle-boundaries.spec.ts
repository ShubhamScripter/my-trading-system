import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const root = resolve(__dirname, '..');
const migrationPath = resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql');
const schemaPath = resolve(root, 'schema.prisma');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const CRON_FENCE_SQL = `UPDATE wallet_core_test.cronjob_runs
  SET processed_count=processed_count+1
  WHERE id=$1 AND worker_instance_id=$2 AND attempt_count=$3
    AND status='RUNNING' AND lease_expires_at>clock_timestamp() RETURNING id`;

it('stores the four-level desired hierarchy and lifecycle database guards', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'), readFile(schemaPath, 'utf8'),
  ]);
  assert.match(sql, /global_desired_state wallet_core\."WalletDesiredState" NOT NULL DEFAULT 'ON'/);
  assert.match(schema, /globalDesiredState\s+WalletDesiredState\s+@default\(ON\)\s+@map\("global_desired_state"\)/);
  assert.match(sql, /cursor_ordinal BIGINT NOT NULL DEFAULT 0 CHECK \(cursor_ordinal >= 0\)/);
  assert.match(schema, /cursorOrdinal\s+BigInt\s+@default\(0\)\s+@map\("cursor_ordinal"\)/);
  for (const name of [
    'guard_wallet_notification_outbox_update', 'guard_wallet_alert_update',
    'wallet_notification_outbox_no_delete', 'wallet_notification_outbox_no_truncate',
    'wallet_alerts_no_delete', 'wallet_alerts_no_truncate',
    'guard_delisting_execution_update', 'delisting_executions_no_delete',
    'delisting_executions_no_truncate', 'guard_cronjob_run_lease',
    'cronjob_runs_no_delete', 'cronjob_runs_no_truncate',
  ]) assert.ok(sql.includes(name), name);
  assert.match(sql, /OLD\.status = 'PENDING' AND NEW\.status = 'PROCESSING'/);
  assert.match(sql, /OLD\.status = 'PROCESSING' AND NEW\.status IN \('SENT','FAILED','DEAD'\)/);
  assert.match(sql, /OLD\.status = 'FAILED' AND NEW\.status IN \('PROCESSING','DEAD'\)/);
  assert.match(sql, /OLD\.status = 'CLEARED' AND NEW\.status = 'ACTIVE'/);
  assert.match(sql, /status = 'PENDING' AND attempt_count = 0 AND next_attempt_at IS NULL/);
  assert.match(sql, /NEW\.opened_at IS DISTINCT FROM OLD\.opened_at/);
  for (const status of ['PARTIAL', 'FAILED', 'SKIPPED']) {
    assert.match(sql, new RegExp(`status = '${status}'[\\s\\S]*?safe_error_code IS NOT NULL`));
  }
  assert.match(sql, /status = 'RUNNING' AND finished_at IS NULL[\s\S]*finished_at >= started_at/);
  assert.match(sql, /NEW\.cursor IS DISTINCT FROM OLD\.cursor[\s\S]*NEW\.cursor_ordinal <= OLD\.cursor_ordinal/);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/);
  assert.match(schema, /leaseExpiresAt\s+DateTime\?\s+@map\("lease_expires_at"\)/);
  assert.match(sql, /interval '5 minutes'/);
  assert.match(sql, /IF OLD\.lease_expires_at > v_now THEN[\s\S]*?ELSIF NEW\.worker_instance_id/);
  assert.match(sql, /CREATE UNIQUE INDEX cronjob_runs_one_running_per_job[\s\S]*WHERE status = 'RUNNING'/);
  assert.match(sql, /CREATE INDEX cronjob_runs_reclaim_idx[\s\S]*WHERE status IN \('RUNNING','FAILED'\)/);
  assert.ok(schema.includes('@@index([jobName, status, leaseExpiresAt, scheduledFor, id], map: "cronjob_runs_reclaim_idx")'));
  assert.match(CRON_FENCE_SQL, /id=\$1[\s\S]*worker_instance_id=\$2[\s\S]*attempt_count=\$3[\s\S]*status='RUNNING'[\s\S]*lease_expires_at>clock_timestamp\(\)/);
});

let savepoint = 0;
async function rejectsInSavepoint(
  client: pg.PoolClient, action: () => Promise<unknown>,
  pattern = /invalid|immutable|append-only|increment|progress|backward|duplicate|unique|start/i,
) {
  const name = `lifecycle_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    await assert.rejects(action, pattern);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

describe('Wallet Core mutable lifecycle database boundaries', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(() => { pool = new pg.Pool({ connectionString: TEST_URL, max: 1 }); });
  after(async () => { await pool?.end(); });

  it('defaults the global desired state to ON', async () => {
    const row = (await pool.query(`SELECT global_desired_state::text AS state
      FROM wallet_core_test.wallet_settings WHERE id`)).rows[0];
    assert.deepEqual(row, { state: 'ON' });
  });

  it('allows only the approved outbox claim, retry, delivery, and dead-letter progress', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_notification_outbox
        (id,event_type,dedupe_key,payload,next_attempt_at)
        VALUES (gen_random_uuid(),'TEST',$1,'{}',now())`, [randomUUID()]), /check constraint/i);
      await client.query(`INSERT INTO wallet_core_test.wallet_notification_outbox
        (id,event_type,dedupe_key,payload) VALUES ($1,'TEST',$2,'{"safe":true}')`, [id, randomUUID()]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='SENT',attempt_count=1,delivered_at=now() WHERE id=$1`, [id]));
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING' WHERE id=$1`, [id]));
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING',attempt_count=1,next_attempt_at=NULL WHERE id=$1`, [id]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET payload='{"changed":true}' WHERE id=$1`, [id]), /immutable/i);
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='FAILED',safe_error_code='TIMEOUT',next_attempt_at=now() WHERE id=$1`, [id]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING',safe_error_code=NULL,next_attempt_at=NULL WHERE id=$1`, [id]));
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING',attempt_count=2,safe_error_code=NULL,next_attempt_at=NULL WHERE id=$1`, [id]);
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='SENT',delivered_at=now() WHERE id=$1`, [id]);
      for (const action of [
        () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox SET status='PROCESSING' WHERE id=$1`, [id]),
        () => client.query(`DELETE FROM wallet_core_test.wallet_notification_outbox WHERE id=$1`, [id]),
        () => client.query('TRUNCATE wallet_core_test.wallet_notification_outbox'),
      ]) await rejectsInSavepoint(client, action);

      const dead = randomUUID();
      await client.query(`INSERT INTO wallet_core_test.wallet_notification_outbox
        (id,event_type,dedupe_key,payload) VALUES ($1,'TEST',$2,'{}')`, [dead, randomUUID()]);
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING',attempt_count=1 WHERE id=$1`, [dead]);
      await client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='DEAD',safe_error_code='INVALID_RESPONSE' WHERE id=$1`, [dead]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_notification_outbox
        SET status='PROCESSING',attempt_count=2,safe_error_code=NULL WHERE id=$1`, [dead]));
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('reuses one alert row across active, clear, and reopen with immutable identity', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currencies = await client.query(`SELECT symbol,id FROM price_conversion_test.currencies
        WHERE symbol IN ('BTC','USD')`);
      const btc = currencies.rows.find((row) => row.symbol === 'BTC')?.id as string;
      const usd = currencies.rows.find((row) => row.symbol === 'USD')?.id as string;
      assert.ok(btc && usd);
      const id = randomUUID();
      const opened = new Date(Date.now() - 4000);
      const payload = (custodyBalance: string) => ({ runId: randomUUID(), itemId: randomUUID(),
        currencyId: btc,
        custodyBalance, requiredBacking: '2.000000000000000000',
        shortfallPercent: '50.000000000000000000', thresholdPercent: '5.000' });
      const first = payload('1.000000000000000000');
      await client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES ($1,$2,'SHORTFALL','ACTIVE',$3,$4,$5,$5)`,
      [id, randomUUID(), btc, first, opened]);
      const eventIds = [randomUUID(), randomUUID(), randomUUID()];
      await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
        (id,alert_id,category,status,payload,created_at)
        VALUES ($1,$2,'SHORTFALL','ACTIVE',$3,$4)`, [eventIds[0], id, first, opened]);
      const second = { ...first, custodyBalance: '1.500000000000000000' };
      await client.query(`UPDATE wallet_core_test.wallet_alerts
        SET payload=$2,updated_at=$3 WHERE id=$1`,
      [id, second, new Date(opened.getTime() + 1000)]);
      for (const [column, value] of [['category', 'PARTIAL_DATA'], ['currency_id', usd], ['dedupe_key', randomUUID()]]) {
        await rejectsInSavepoint(client, () => client.query(
          `UPDATE wallet_core_test.wallet_alerts SET ${column}=$2,updated_at=$3 WHERE id=$1`,
          [id, value, new Date(opened.getTime() + 1500)],
        ), /immutable/i);
      }
      const cleared = new Date(opened.getTime() + 2000);
      await client.query(`UPDATE wallet_core_test.wallet_alerts
        SET status='CLEARED',cleared_at=$2,updated_at=$2 WHERE id=$1`, [id, cleared]);
      await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
        (id,alert_id,category,status,payload,created_at)
        VALUES ($1,$2,'SHORTFALL','CLEARED',$3,$4)`, [eventIds[1], id, second, cleared]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_alerts
        SET payload='{"invalid":true}',updated_at=$2 WHERE id=$1`,
      [id, new Date(cleared.getTime() + 100)]));
      const reopened = new Date(cleared.getTime() + 1000);
      const third = { ...second, custodyBalance: '1.750000000000000000' };
      await client.query(`UPDATE wallet_core_test.wallet_alerts SET status='ACTIVE',
        payload=$2,cleared_at=NULL,updated_at=$3 WHERE id=$1`, [id, third, reopened]);
      await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
        (id,alert_id,category,status,payload,created_at)
        VALUES ($1,$2,'SHORTFALL','ACTIVE',$3,$4)`, [eventIds[2], id, third, reopened]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.wallet_alert_events
        SET payload='{"changed":true}' WHERE id=$1`, [eventIds[2]]), /append-only/i);
      await rejectsInSavepoint(client, () => client.query(`DELETE FROM wallet_core_test.wallet_alert_events
        WHERE id=$1`, [eventIds[2]]), /append-only/i);
      await rejectsInSavepoint(client, () => client.query(
        'TRUNCATE wallet_core_test.wallet_alert_events',
      ), /append-only/i);
      for (const action of [
        () => client.query(`DELETE FROM wallet_core_test.wallet_alerts WHERE id=$1`, [id]),
        () => client.query('TRUNCATE wallet_core_test.wallet_alerts CASCADE'),
      ]) await rejectsInSavepoint(client, action);
      const row = (await client.query(`SELECT status::text,payload,opened_at,cleared_at
        FROM wallet_core_test.wallet_alerts WHERE id=$1`, [id])).rows[0];
      assert.deepEqual(row, { status: 'ACTIVE', payload: third, opened_at: opened, cleared_at: null });
      const history = await client.query(`SELECT status::text,created_at FROM
        wallet_core_test.wallet_alert_events WHERE alert_id=$1 ORDER BY created_at`, [id]);
      assert.deepEqual(history.rows, [
        { status: 'ACTIVE', created_at: opened }, { status: 'CLEARED', created_at: cleared },
        { status: 'ACTIVE', created_at: reopened },
      ]);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('enforces Cron safe-reason shapes independently of lease transitions', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const started = new Date(now.getTime() - 1000);
      const start = async () => {
        const id = randomUUID();
        await client.query(`INSERT INTO wallet_core_test.cronjob_runs
          (id,job_name,scheduled_for,worker_instance_id,started_at,status)
          VALUES ($1,$2,$3,'worker',$4,'RUNNING')`,
        [id, `cron-${randomUUID()}`, now, started]);
        return id;
      };
      for (const [status, error, finished] of [
        ['SUCCESS', 'DEPENDENCY_UNAVAILABLE', now], ['PARTIAL', null, now],
        ['FAILED', null, now], ['SKIPPED', null, now], ['SUCCESS', null, null],
        ['FAILED', 'UNEXPECTED_ERROR', new Date(started.getTime() - 1)],
      ] as const) {
        const id = await start();
        await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
          SET status=$2,lease_expires_at=NULL,safe_error_code=$3,finished_at=$4 WHERE id=$1`,
        [id, status, error, finished]), /check constraint/i);
      }
      for (const [error, finished] of [['DEPENDENCY_UNAVAILABLE', null], [null, now]] as const) {
        await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.cronjob_runs
          (id,job_name,scheduled_for,worker_instance_id,started_at,status,safe_error_code,finished_at)
          VALUES (gen_random_uuid(),$1,$2,'worker',$3,'RUNNING',$4,$5)`,
        [`cron-${randomUUID()}`, now, started, error, finished]), /check constraint/i);
      }
      await start();
      for (const [status, error, finished] of [
        ['SUCCESS', null, now], ['PARTIAL', 'PROVIDER_OBSERVATION_PARTIAL', now],
        ['FAILED', 'PROVIDER_OBSERVATION_FAILED', now], ['SKIPPED', 'MISSED_SCHEDULE', now],
      ] as const) {
        const id = await start();
        await client.query(`UPDATE wallet_core_test.cronjob_runs
          SET status=$2,lease_expires_at=NULL,safe_error_code=$3,finished_at=$4 WHERE id=$1`,
        [id, status, error, finished]);
      }
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('enforces the renewable five-minute Cron lease and later-service fence', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const job = `lease-${randomUUID()}`;
      const scheduled = new Date();
      await client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status)
        VALUES ($1,$2,$3,'worker-a','RUNNING')`, [id, job, scheduled]);
      const initial = (await client.query(`SELECT attempt_count,status::text,
        extract(epoch FROM lease_expires_at-clock_timestamp())::float8 AS seconds
        FROM wallet_core_test.cronjob_runs WHERE id=$1`, [id])).rows[0];
      assert.equal(initial.attempt_count, 1);
      assert.equal(initial.status, 'RUNNING');
      assert.ok(initial.seconds > 295 && initial.seconds <= 300);
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status)
        VALUES (gen_random_uuid(),$1,$2,'worker-b','RUNNING')`, [job, new Date(scheduled.getTime() + 1)]));
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,attempt_count,status)
        VALUES (gen_random_uuid(),$1,$2,'worker-a',0,'RUNNING')`,
      [`invalid-${job}`, scheduled]), /check constraint/i);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET worker_instance_id='worker-b',attempt_count=2 WHERE id=$1`, [id]), /unexpired|lease/i);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET scheduled_for=$2 WHERE id=$1`, [id, new Date(scheduled.getTime() + 1)]), /immutable/i);
      const firstLease = (await client.query(`SELECT lease_expires_at FROM
        wallet_core_test.cronjob_runs WHERE id=$1`, [id])).rows[0].lease_expires_at as Date;
      await client.query('SELECT pg_sleep(0.01)');
      assert.equal((await client.query(CRON_FENCE_SQL, [id, 'worker-a', 1])).rowCount, 1);
      const renewed = (await client.query(`SELECT worker_instance_id,attempt_count,lease_expires_at
        FROM wallet_core_test.cronjob_runs WHERE id=$1`, [id])).rows[0];
      assert.equal(renewed.worker_instance_id, 'worker-a');
      assert.equal(renewed.attempt_count, 1);
      assert.ok(renewed.lease_expires_at > firstLease);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET processed_count=0 WHERE id=$1`, [id]), /decrease/i);

      await client.query('ALTER TABLE wallet_core_test.cronjob_runs DISABLE TRIGGER cronjob_runs_lease_guard');
      await client.query(`UPDATE wallet_core_test.cronjob_runs
        SET lease_expires_at=clock_timestamp() WHERE id=$1`, [id]);
      await client.query('ALTER TABLE wallet_core_test.cronjob_runs ENABLE TRIGGER cronjob_runs_lease_guard');
      const expired = (await client.query(`SELECT status::text,count(*)::int AS count,
        bool_and(clock_timestamp()>=lease_expires_at) AS at_or_past_boundary
        FROM wallet_core_test.cronjob_runs WHERE id=$1 GROUP BY status`, [id])).rows[0];
      assert.deepEqual(expired, { status: 'RUNNING', count: 1, at_or_past_boundary: true });
      const oldFence = await client.query(CRON_FENCE_SQL, [id, 'worker-a', 1]);
      assert.equal(oldFence.rowCount === 0 ? 'LEASE_LOST' : 'OK', 'LEASE_LOST');
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET attempt_count=2 WHERE id=$1`, [id]), /change worker/i);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET worker_instance_id='worker-b',attempt_count=3 WHERE id=$1`, [id]), /increment attempt/i);
      await client.query(`UPDATE wallet_core_test.cronjob_runs
        SET worker_instance_id='worker-b',attempt_count=2 WHERE id=$1`, [id]);
      assert.equal((await client.query(CRON_FENCE_SQL, [id, 'worker-a', 1])).rowCount, 0);
      assert.equal((await client.query(CRON_FENCE_SQL, [id, 'worker-b', 2])).rowCount, 1);
      await client.query(`UPDATE wallet_core_test.cronjob_runs
        SET status='SUCCESS',lease_expires_at=NULL,finished_at=clock_timestamp() WHERE id=$1`, [id]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET status='RUNNING',worker_instance_id='worker-c',attempt_count=3,
          finished_at=NULL WHERE id=$1`, [id]));

      const failed = randomUUID();
      await client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status)
        VALUES ($1,$2,$3,'worker-a','RUNNING')`, [failed, `failed-${job}`, scheduled]);
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='FAILED',
        lease_expires_at=NULL,safe_error_code='PROVIDER_OBSERVATION_FAILED',
        finished_at=clock_timestamp() WHERE id=$1`, [failed]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
        SET status='RUNNING',attempt_count=2,finished_at=NULL,safe_error_code=NULL WHERE id=$1`,
      [failed]), /change worker/i);
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='RUNNING',
        worker_instance_id='worker-b',attempt_count=2,finished_at=NULL,
        safe_error_code=NULL WHERE id=$1`, [failed]);
      const retried = (await client.query(`SELECT status::text,worker_instance_id,attempt_count,
        lease_expires_at>clock_timestamp() AS leased FROM wallet_core_test.cronjob_runs
        WHERE id=$1`, [failed])).rows[0];
      assert.deepEqual(retried, {
        status: 'RUNNING', worker_instance_id: 'worker-b', attempt_count: 2, leased: true,
      });
      for (const [status, error] of [['PARTIAL', 'PROVIDER_OBSERVATION_PARTIAL'],
        ['SKIPPED', 'MISSED_SCHEDULE']] as const) {
        const terminal = randomUUID();
        await client.query(`INSERT INTO wallet_core_test.cronjob_runs
          (id,job_name,scheduled_for,worker_instance_id,status)
          VALUES ($1,$2,$3,'worker-a','RUNNING')`,
        [terminal, `${status.toLowerCase()}-${job}`, scheduled]);
        await client.query(`UPDATE wallet_core_test.cronjob_runs SET status=$2,
          lease_expires_at=NULL,safe_error_code=$3,finished_at=clock_timestamp() WHERE id=$1`,
        [terminal, status, error]);
        await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.cronjob_runs
          SET status='RUNNING',worker_instance_id='worker-b',attempt_count=2,
            finished_at=NULL,safe_error_code=NULL WHERE id=$1`, [terminal]));
      }
      for (const action of [
        () => client.query(`DELETE FROM wallet_core_test.cronjob_runs WHERE id=$1`, [id]),
        () => client.query('TRUNCATE wallet_core_test.cronjob_runs'),
      ]) await rejectsInSavepoint(client, action);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('allows only forward, restartable delisting progress and terminal completion', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currency = (await client.query(`SELECT id FROM price_conversion_test.currencies
        WHERE symbol='BTC'`)).rows[0].id;
      const id = randomUUID();
      const started = new Date(Date.now() - 5000);
      await client.query(`INSERT INTO wallet_core_test.delisting_executions
        (id,currency_id,policy_revision,deadline,status,created_at,updated_at)
        VALUES ($1,$2,1,$3,'RUNNING',$4,$4)`, [id, currency, started, started]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.delisting_executions
        SET cursor='cursor-a',updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 500)]));
      await client.query(`UPDATE wallet_core_test.delisting_executions
        SET cursor='cursor-a',cursor_ordinal=1,processed_count=1,updated_at=$2 WHERE id=$1`,
      [id, new Date(started.getTime() + 1000)]);
      for (const statement of [
        `UPDATE wallet_core_test.delisting_executions SET cursor_ordinal=0,updated_at=$2 WHERE id=$1`,
        `UPDATE wallet_core_test.delisting_executions SET processed_count=0,updated_at=$2 WHERE id=$1`,
        `UPDATE wallet_core_test.delisting_executions SET currency_id=gen_random_uuid(),updated_at=$2 WHERE id=$1`,
      ]) await rejectsInSavepoint(client, () => client.query(statement,
        [id, new Date(started.getTime() + 1500)]));
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='PARTIAL',
        safe_error_code='TIMEOUT',updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 2000)]);
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='RUNNING',
        safe_error_code=NULL,updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 3000)]);
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='FAILED',
        safe_error_code='TIMEOUT',updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 4000)]);
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='RUNNING',
        safe_error_code=NULL,updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 5000)]);
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='COMPLETED',
        updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 6000)]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE wallet_core_test.delisting_executions
        SET status='RUNNING',updated_at=$2 WHERE id=$1`, [id, new Date(started.getTime() + 7000)]));
      for (const action of [
        () => client.query(`DELETE FROM wallet_core_test.delisting_executions WHERE id=$1`, [id]),
        () => client.query('TRUNCATE wallet_core_test.delisting_executions'),
      ]) await rejectsInSavepoint(client, action);
      for (const status of ['PARTIAL', 'FAILED'] as const) {
        await rejectsInSavepoint(client, () => client.query(`INSERT INTO
          wallet_core_test.delisting_executions
          (id,currency_id,policy_revision,deadline,status)
          VALUES (gen_random_uuid(),$1,$2,$3,$4)`,
        [currency, Math.floor(Math.random() * 1000000) + 2,
          new Date(Date.now() + Math.floor(Math.random() * 1000000)), status]));
      }
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
