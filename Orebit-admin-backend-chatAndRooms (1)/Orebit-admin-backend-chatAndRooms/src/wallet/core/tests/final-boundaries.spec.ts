import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { uuidv7 } from '../../../utils/public.utils.js';
import {
  captureReconciliationFixture,
  createReconciliationCurrencyFixture,
  createReconciliationPriceFixture,
  isolateReconciliationConfiguration,
} from './reconciliation-price-fixture.js';

const root = resolve(__dirname, '..');
const migrationPath = resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql');
const schemaPath = resolve(root, 'schema.prisma');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const ALERT_CATEGORIES = [
  'PRICE_MAINTENANCE', 'DELISTING_PENDING', 'DELISTING_ACCOUNT_REVIEW',
  'SHORTFALL', 'PARTIAL_DATA', 'STAKING_TOTAL_MISMATCH', 'CATALOGUE_REFRESH_FAILED',
  'PROVIDER_MAINTENANCE',
] as const;
const BASE_ALERT_CATEGORIES = ALERT_CATEGORIES.slice(3);

it('pins final alert, lifecycle, and reconciliation SQL contracts', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'), readFile(schemaPath, 'utf8'),
  ]);
  const sqlEnum = /WalletAlertCategory" AS ENUM \(([^)]*)\)/.exec(sql)?.[1];
  const prismaEnum = /enum WalletAlertCategory \{([\s\S]*?)@@schema/.exec(schema)?.[1];
  assert.deepEqual([...sqlEnum!.matchAll(/'([^']+)'/g)].map((match) => match[1]), BASE_ALERT_CATEGORIES);
  assert.deepEqual(prismaEnum!.trim().split(/\s+/), ALERT_CATEGORIES);
  for (const name of [
    'wallet_notification_outbox_insert_update_guard',
    'wallet_alerts_insert_update_guard', 'cronjob_runs_lease_guard',
    'delisting_executions_insert_update_guard', 'validate_reconciliation_buckets',
    'wallet_reconciliation_items_bucket_guard', 'wallet_reconciliation_components_bucket_guard',
  ]) assert.ok(sql.includes(name), name);
  assert.doesNotMatch(sql, /OLD\.status = NEW\.status/);
  assert.match(sql, /DRAFT' AND NEW\.status IN \('SCHEDULED','LIVE','ARCHIVED'\)/);
  assert.match(sql, /SCHEDULED' AND NEW\.status IN \('LIVE','ARCHIVED','REJECTED'\)/);
  assert.match(sql, /OLD\.status = 'LIVE' AND NEW\.status = 'ARCHIVED'/);
  assert.match(sql, /configuration_changes_guard\s+BEFORE INSERT OR UPDATE/);
  assert.match(sql, /NEW\.effective_at IS DISTINCT FROM OLD\.effective_at/);
  assert.match(sql, /NEW\.applied_at IS DISTINCT FROM OLD\.applied_at/);
  assert.match(sql, /sum\(selected_balance\) FILTER \(\s*WHERE kind IN \('HOT','COLD'\)/);
  assert.match(sql, /sum\(selected_balance\) FILTER \(\s*WHERE kind = 'STAKING'/);
  assert.match(sql, /sum\(selected_balance\) FILTER \(\s*WHERE kind = 'BINANCE'/);
  assert.match(sql, /draft_guard_key SMALLINT GENERATED ALWAYS AS\s*\(\s*CASE WHEN status='DRAFT' THEN 1 ELSE NULL END\s*\)\s*STORED/);
  assert.match(sql, /CONSTRAINT configuration_changes_one_draft UNIQUE \(draft_guard_key\)\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /live_guard_key SMALLINT GENERATED ALWAYS AS\s*\(\s*CASE WHEN status='LIVE' THEN 1 ELSE NULL END\s*\)\s*STORED/);
  assert.match(sql, /CONSTRAINT configuration_changes_one_live UNIQUE \(live_guard_key\)\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.match(schema, /draftGuardKey\s+Int\?\s+@default\(dbgenerated\(\)\)[^\n]*@ignore/);
  assert.match(schema, /liveGuardKey\s+Int\?\s+@default\(dbgenerated\(\)\)[^\n]*@ignore/);
  assert.doesNotMatch(sql, /validate_single_configuration_draft|single_configuration_draft/);
  const priceGuard = /CREATE OR REPLACE FUNCTION price_conversion\.require_active_crypto_provider_ref\(\)[\s\S]*?\$\$;/.exec(sql)?.[0];
  assert.ok(priceGuard);
  assert.match(priceGuard, /NEW\.pricing_status[\s\S]*OLD\.pricing_status/);
  assert.match(priceGuard, /SELECT kind, pricing_status INTO current_kind, current_status/);
  assert.doesNotMatch(priceGuard, /(?:NEW|OLD)\.status|SELECT kind, status/);
  const mutationGuard = /CREATE OR REPLACE FUNCTION price_conversion\.require_active_crypto_ref_after_mutation\(\)[\s\S]*?\$\$;/.exec(sql)?.[0];
  assert.ok(mutationGuard);
  assert.match(mutationGuard, /c\.pricing_status = 'ACTIVE'/);
  assert.doesNotMatch(mutationGuard, /c\.status|NEW\.status|OLD\.status/);
  assert.ok(schema.includes('@@index([status, id], map: "configuration_changes_draft_lookup_idx")'));
});

let savepoint = 0;
async function rejectsInSavepoint(client: pg.PoolClient, action: () => Promise<unknown>) {
  const name = `final_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    await assert.rejects(action);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

async function withRollback(pool: pg.Pool, body: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Wallet Core final Task 2 database boundaries', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(() => { pool = new pg.Pool({ connectionString: TEST_URL, max: 3 }); });
  after(async () => { await pool?.end(); });

  it('supports the exact global catalogue alert and rejects non-initial inserts', async () => {
    await withRollback(pool, async (client) => {
      const now = new Date();
      await client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES (gen_random_uuid(),$1,'CATALOGUE_REFRESH_FAILED','ACTIVE',NULL,
          '{"safeErrorCode":"TIMEOUT","failedAt":"2026-09-05T09:00:00.000000Z"}',$2,$2)`,
      [randomUUID(), now]);
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_notification_outbox
        (id,event_type,dedupe_key,payload,status,attempt_count,delivered_at)
        VALUES (gen_random_uuid(),'TEST',$1,'{}','SENT',1,$2)`, [randomUUID(), now]));
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,payload,opened_at,cleared_at,updated_at)
        VALUES (gen_random_uuid(),$1,'SHORTFALL','CLEARED','{}',$2,$3,$3)`,
      [randomUUID(), new Date(now.getTime() - 1), now]));
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status,finished_at)
        VALUES (gen_random_uuid(),$1,$2,'worker','SUCCESS',$2)`, [randomUUID(), now]));
      const currency = (await client.query(`SELECT id FROM price_conversion_test.currencies
        WHERE symbol='BTC'`)).rows[0].id;
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.delisting_executions
        (id,currency_id,policy_revision,deadline,status,safe_error_code)
        VALUES (gen_random_uuid(),$1,1,$2,'PARTIAL','TIMEOUT')`, [currency, now]));
      const cron = randomUUID();
      await client.query(`INSERT INTO wallet_core_test.cronjob_runs
        (id,job_name,scheduled_for,worker_instance_id,status)
        VALUES ($1,$2,$3,'worker','RUNNING')`, [cron, `missed-${randomUUID()}`, now]);
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='SKIPPED',
        lease_expires_at=NULL,safe_error_code='MISSED_SCHEDULE',
        finished_at=clock_timestamp() WHERE id=$1`, [cron]);
      assert.equal((await client.query(`SELECT status::text FROM wallet_core_test.cronjob_runs
        WHERE id=$1`, [cron])).rows[0].status, 'SKIPPED');
    });
  });

  it('enforces one-way configuration status and timestamp fields', async () => {
    await withRollback(pool, async (client) => {
      const id = randomUUID();
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.configuration_changes
        (id,revision,status,effective_at,reason,actor_id,snapshot)
        VALUES (gen_random_uuid(),99,'SCHEDULED',clock_timestamp(),'test',$1,'{}')`, [id]));
      await client.query(`INSERT INTO wallet_core_test.configuration_changes
        (id,revision,status,reason,actor_id,snapshot)
        VALUES ($1,100,'DRAFT','test',$1,'{}')`, [id]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET status='DRAFT' WHERE id=$1`, [id]));
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET status='REJECTED' WHERE id=$1`, [id]));
      const effective = new Date();
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='SCHEDULED',effective_at=$2 WHERE id=$1`, [id, effective]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET effective_at=$2 WHERE id=$1`,
      [id, new Date(effective.getTime() + 1)]));
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET status='LIVE',effective_at=$2,
          applied_at=clock_timestamp() WHERE id=$1`, [id, new Date(effective.getTime() + 1)]));
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='LIVE',applied_at=clock_timestamp() WHERE id=$1`, [id]);
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET status='LIVE' WHERE id=$1`, [id]));
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET applied_at=clock_timestamp() WHERE id=$1`, [id]));
      const live = (await client.query(`SELECT effective_at,applied_at FROM
        wallet_core_test.configuration_changes WHERE id=$1`, [id])).rows[0];
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='ARCHIVED' WHERE id=$1`, [id]);
      assert.deepEqual((await client.query(`SELECT effective_at,applied_at FROM
        wallet_core_test.configuration_changes WHERE id=$1`, [id])).rows[0], live);
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET status='LIVE' WHERE id=$1`, [id]));
      await rejectsInSavepoint(client, () => client.query(`UPDATE
        wallet_core_test.configuration_changes SET applied_at=clock_timestamp() WHERE id=$1`, [id]));
    });
  });

  it('defers one-DRAFT validation to final state and serializes concurrent commits', async () => {
    const insertDraft = (
      client: pg.PoolClient,
      id: string,
      revision: number,
    ) => client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,reason,actor_id,snapshot)
      VALUES ($1,$2,'DRAFT','deferred draft',$1,'{}')`, [id, revision]);
    for (const terminal of ['LIVE', 'SCHEDULED'] as const) {
      await withRollback(pool, async (client) => {
        const base = Date.now() + (terminal === 'LIVE' ? 1000 : 2000);
        await insertDraft(client, randomUUID(), base);
        const transient = randomUUID();
        await insertDraft(client, transient, base + 1);
        if (terminal === 'LIVE') {
          await client.query(`UPDATE wallet_core_test.configuration_changes
            SET status='ARCHIVED' WHERE status='LIVE'`);
          await client.query(`UPDATE wallet_core_test.configuration_changes
            SET status='LIVE',applied_at=clock_timestamp() WHERE id=$1`, [transient]);
        } else {
          await client.query(`UPDATE wallet_core_test.configuration_changes
            SET status='SCHEDULED',effective_at=clock_timestamp() WHERE id=$1`, [transient]);
        }
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
    }
    await withRollback(pool, async (client) => {
      const base = Date.now() + 3000;
      await insertDraft(client, randomUUID(), base);
      await insertDraft(client, randomUUID(), base + 1);
      await assert.rejects(() => client.query('SET CONSTRAINTS ALL IMMEDIATE'), /draft/i);
    });

    const first = await pool.connect();
    const second = await pool.connect();
    const ids = [uuidv7(), uuidv7()];
    const base = Date.now() + 4000;
    try {
      await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await first.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'");
      await second.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'");
      await insertDraft(first, ids[0]!, base);
      await insertDraft(second, ids[1]!, base + 1);
      const commits = await Promise.allSettled([
        first.query('COMMIT'), second.query('COMMIT'),
      ]);
      assert.equal(commits.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(commits.filter((result) => result.status === 'rejected').length, 1);
      const loser = commits.find((result) => result.status === 'rejected');
      assert.equal((loser as PromiseRejectedResult).reason.code, '23505');
      assert.ok(Number((await pool.query(`SELECT count(*) FROM
        wallet_core_test.configuration_changes WHERE status='DRAFT'`)).rows[0].count) <= 1);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
      await pool.query(`UPDATE wallet_core_test.configuration_changes SET status='ARCHIVED'
        WHERE id=ANY($1::uuid[]) AND status='DRAFT'`, [ids]);
    }
  });

  it('defers one-LIVE validation and permits one concurrent final LIVE row', async () => {
    const insertLive = async (client: pg.PoolClient, id: string, revision: number) => {
      await client.query(`INSERT INTO wallet_core_test.configuration_changes
        (id,revision,status,reason,actor_id,snapshot)
        VALUES ($1,$2,'DRAFT','live guard',$1,'{}')`, [id, revision]);
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='LIVE',applied_at=now() WHERE id=$1`, [id]);
    };
    await withRollback(pool, async (client) => {
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='ARCHIVED' WHERE status='LIVE'`);
      const oldLive = randomUUID(); const finalLive = randomUUID();
      await insertLive(client, oldLive, Date.now() + 920000);
      await insertLive(client, finalLive, Date.now() + 920001);
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='ARCHIVED' WHERE id=$1`, [oldLive]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    await pool.query(`UPDATE wallet_core_test.configuration_changes
      SET status='ARCHIVED' WHERE status='LIVE'`);
    const clients = [await pool.connect(), await pool.connect()];
    const ids = [uuidv7(), uuidv7()]; const revision = Date.now() + 930000;
    try {
      for (const [index, client] of clients.entries()) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'");
        await insertLive(client, ids[index]!, revision + index);
      }
      const commits = await Promise.allSettled(clients.map((client) => client.query('COMMIT')));
      assert.equal(commits.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(commits.filter((entry) => entry.status === 'rejected'
        && (entry.reason as { code?: string }).code === '23505').length, 1);
      assert.ok(Number((await pool.query(`SELECT count(*) FROM
        wallet_core_test.configuration_changes WHERE status='LIVE'`)).rows[0].count) <= 1);
    } finally {
      for (const client of clients) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      await pool.query(`UPDATE wallet_core_test.configuration_changes
        SET status='ARCHIVED' WHERE id=ANY($1::uuid[]) AND status='LIVE'`, [ids]);
    }
  });

  it('keeps future canonical crypto writes behind the deferred active-provider guard', async () => {
    const provider = (await pool.query(`SELECT id FROM price_conversion_test.price_providers
      WHERE code='COINGECKO'`)).rows[0].id;
    const write = async (activeReference: boolean | null, valid: boolean) => {
      await withRollback(pool, async (client) => {
        const id = randomUUID();
        const symbol = `P${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
        const action = async () => {
          await client.query(`INSERT INTO price_conversion_test.currencies
            (id,symbol,name,decimals,kind,pricing_status)
            VALUES ($1,$2,$2,18,'CRYPTO','DISABLED')`, [id, symbol]);
          if (activeReference !== null) await client.query(`INSERT INTO
            price_conversion_test.currency_provider_refs
            (currency_id,provider_id,external_id,symbol,active)
            VALUES ($1,$2,$3,$4,$5)`,
          [id, provider, randomUUID(), symbol, activeReference]);
          await client.query(`UPDATE price_conversion_test.currencies
            SET pricing_status='ACTIVE' WHERE id=$1`, [id]);
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        };
        if (valid) await action();
        else await assert.rejects(action, /active provider reference/i);
      });
    };
    await write(true, true);
    await write(null, false);
    await write(false, false);
    const replace = async (replacement: boolean | null, valid: boolean) => {
      await withRollback(pool, async (client) => {
        const id = randomUUID();
        const symbol = `R${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
        await client.query(`INSERT INTO price_conversion_test.currencies
          (id,symbol,name,decimals,kind,pricing_status)
          VALUES ($1,$2,$2,18,'CRYPTO','DISABLED')`, [id, symbol]);
        await client.query(`INSERT INTO price_conversion_test.currency_provider_refs
          (currency_id,provider_id,external_id,symbol,active)
          VALUES ($1,$2,$3,$4,true)`, [id, provider, randomUUID(), symbol]);
        await client.query(`UPDATE price_conversion_test.currencies
          SET pricing_status='ACTIVE' WHERE id=$1`, [id]);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        const action = async () => {
          await client.query(`DELETE FROM price_conversion_test.currency_provider_refs
            WHERE currency_id=$1`, [id]);
          if (replacement !== null) await client.query(`INSERT INTO
            price_conversion_test.currency_provider_refs
            (currency_id,provider_id,external_id,symbol,active)
            VALUES ($1,$2,$3,$4,$5)`, [id, provider, randomUUID(), symbol, replacement]);
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        };
        if (valid) await action();
        else await assert.rejects(action, /active provider reference/i);
      });
    };
    await replace(true, true);
    await replace(null, false);
    await replace(false, false);
  });

  async function reconciliationCase(
    itemStatus: 'COMPLETE' | 'PARTIAL',
    buckets: readonly [number, number, number],
    components: ReadonlyArray<readonly ['HOT' | 'COLD' | 'STAKING' | 'BINANCE', number | null]>,
    reject: boolean,
  ) {
    await withRollback(pool, async (client) => {
      const currency = await createReconciliationCurrencyFixture(client);
      const usesBinance = components.some(([kind]) => kind === 'BINANCE');
      if (usesBinance) await client.query(`UPDATE wallet_core_test.currency_settings
        SET binance_reference='BINANCE_TEST' WHERE currency_id=$1`, [currency]);
      const chain = randomUUID();
      const binding = randomUUID();
      const provider = String(BigInt(Date.now()) * 100000n + BigInt(Math.floor(Math.random() * 99999)));
      const shortName = `R${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
      await client.query(`INSERT INTO wallet_core_test.chains
        (id,provider_chain_id,short_name,name,is_evm) VALUES ($1,$2,$3,$3,false)`,
      [chain, provider, shortName]);
      await client.query(`INSERT INTO wallet_core_test.currencies
        (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
        VALUES ($1,$2,$3,$4,false,true,18)`, [binding, currency, chain, provider]);
      const addresses: Record<string, string> = {};
      const addressKinds = [...new Set(components.flatMap(([kind]) => kind === 'BINANCE' ? [] : [kind]))];
      for (const kind of addressKinds) {
        addresses[kind] = randomUUID();
        await client.query(`INSERT INTO wallet_core_test.custody_addresses
          (id,currency_chain_id,kind,wallet_address,address_identity)
          VALUES ($1,$2,$3,$4,$4)`, [addresses[kind], binding, kind, `${kind}-${randomUUID()}`]);
      }
      const run = randomUUID();
      const item = randomUUID();
      const runStatus = itemStatus === 'COMPLETE' ? 'SUCCESS' : 'PARTIAL';
      const reasons = itemStatus === 'COMPLETE' ? [] : ['TIMEOUT'];
      const total = buckets[0] + buckets[1] + buckets[2];
      const price = await createReconciliationPriceFixture(client, currency);
      await isolateReconciliationConfiguration(client, [currency]);
      await captureReconciliationFixture(client, run, currency, price);
      await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
        (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
         total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
         collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
         applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
         price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
         price_resolution_reason,price_used_fallback,ledger_signed_total,ledger_positive_total,
         applied_reconciliation_alert_basis)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,0,0,$9,$10,$11,5,0,
          'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$12,$13,$14,$15,$16,$17,$18,
          0,0,'SIGNED')`,
      [item, run, currency, itemStatus, ...buckets, total, reasons,
        itemStatus === 'PARTIAL', null,
        price.resolutionId, price.snapshotId, price.provider, price.priceUsd,
        price.observedAt, price.resolutionReason, price.usedFallback]);
      for (const [kind, amount] of components) {
        const component = randomUUID();
        if (kind === 'BINANCE') {
          await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
            (id,run_item_id,kind,binance_reference,attempts_used,accepted_raw_decimal,
             selected_balance,safe_error_code) VALUES ($1,$2,$3,'BINANCE_TEST',1,$4,$5,$6)`,
          [component, item, kind, amount === null ? null : String(amount), amount,
            amount === null ? 'TIMEOUT' : null]);
        } else if (kind === 'STAKING' && amount !== null) {
          await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
            (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
             accepted_raw_decimal,selected_balance,total_admin_stake_balance,
             total_admin_manual_stake_balance,total_balance,stake_selected_source)
            VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7,0,$7,'REPORTED_TOTAL')`,
          [component, item, kind, binding, addresses[kind], String(amount), amount]);
        } else {
          await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
            (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
             accepted_raw_decimal,selected_balance,safe_error_code)
            VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`,
          [component, item, kind, binding, addresses[kind],
            amount === null ? null : String(amount), amount, amount === null ? 'TIMEOUT' : null]);
        }
        await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_attempts
          (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome,safe_error_code)
          VALUES (gen_random_uuid(),$1,1,0,$2,$3,$4)`,
        [component, amount === null ? 'ENCRYPT' : 'BALANCE',
          amount === null ? 'FAILED' : 'SUCCESS', amount === null ? 'TIMEOUT' : null]);
      }
      await client.query(`UPDATE wallet_core_test.wallet_reconciliation_runs SET status=$2,
        currency_count=1,warning_count=0,completed_at=clock_timestamp() WHERE id=$1`,
      [run, runStatus]);
      if (reject) await assert.rejects(() => client.query(`SET CONSTRAINTS
        wallet_core_test.wallet_reconciliation_items_bucket_guard IMMEDIATE`),
      /reconciliation component\/address evidence mismatch/i);
      else await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  }

  it('ties complete and partial reconciliation buckets to successful components', async () => {
    await reconciliationCase('COMPLETE', [3, 3, 4],
      [['HOT', 1], ['COLD', 2], ['STAKING', 3], ['BINANCE', 4]], false);
    await reconciliationCase('PARTIAL', [1, 0, 0], [['HOT', 1], ['COLD', null]], false);
    await reconciliationCase('PARTIAL', [0, 0, 0], [['HOT', 1], ['COLD', null]], true);
  });
});
