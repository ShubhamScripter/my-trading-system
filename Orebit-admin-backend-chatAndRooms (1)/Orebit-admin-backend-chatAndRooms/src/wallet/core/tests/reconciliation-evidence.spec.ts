import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import {
  captureReconciliationFixture,
  createReconciliationCurrencyFixture,
  createReconciliationPriceFixture,
  isolateReconciliationConfiguration,
  type ReconciliationPriceFixture,
} from './reconciliation-price-fixture.js';

const root = resolve(__dirname, '..');
const schemaPath = resolve(root, 'schema.prisma');
const migrationPath = resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const INDEXES: ReadonlyArray<readonly [string, string, string]> = [
  ['chains_provider_state_idx', 'provider_state, id', 'providerState, id'],
  ['currency_settings_state_idx', 'desired_state, price_readiness, currency_id', 'desiredState, priceReadiness, currencyId'],
  ['currency_settings_listing_due_idx', 'listing_start_at, currency_id', 'listingStartAt, currencyId'],
  ['currency_settings_delist_due_idx', 'delist_at, currency_id', 'delistAt, currencyId'],
  ['currencies_binding_read_idx', 'currency_id, chain_id, id', 'currencyId, chainId, id'],
  ['custody_addresses_binding_kind_idx', 'currency_chain_id, kind, address_identity, id', 'currencyChainId, kind, addressIdentity, id'],
  ['wallet_reconciliation_runs_cursor_idx', 'created_at DESC, id DESC', 'createdAt(sort: Desc), id(sort: Desc)'],
  ['wallet_reconciliation_items_currency_cursor_idx', 'currency_id, created_at DESC, id DESC', 'currencyId, createdAt(sort: Desc), id(sort: Desc)'],
  ['wallet_reconciliation_components_item_idx', 'run_item_id, kind, id', 'runItemId, kind, id'],
  ['wallet_reconciliation_attempts_component_idx', 'component_id, attempt_ordinal', 'componentId, attemptOrdinal'],
  ['wallet_alerts_status_idx', 'status, category, currency_id', 'status, category, currencyId'],
  ['wallet_notification_outbox_pending_idx', 'status, next_attempt_at, created_at, id', 'status, nextAttemptAt, createdAt, id'],
  ['cronjob_runs_status_idx', 'job_name, status, scheduled_for', 'jobName, status, scheduledFor'],
  ['delisting_executions_status_idx', 'status, deadline, id', 'status, deadline, id'],
  ['configuration_changes_schedule_idx', 'status, effective_at', 'status, effectiveAt'],
];

it('keeps reconciliation identity and every required query index in SQL-Prisma parity', async () => {
  const [sql, schema] = await Promise.all([
    readFile(migrationPath, 'utf8'), readFile(schemaPath, 'utf8'),
  ]);
  const compactSql = sql.replace(/\s+/g, ' ');
  assert.match(schema, /model WalletCurrencyChain \{[\s\S]*?@@unique\(\[id, currencyId\]\)/);
  assert.match(schema, /mappedBinding\s+WalletCurrencyChain\?\s+@relation\("LegacyCurrencyMappedBinding", fields: \[mappedBindingId, currencyId\], references: \[id, currencyId\]/);
  assert.match(sql, /IF TG_TABLE_NAME = 'wallet_reconciliation_components' THEN\s+v_component_id := NEW\.id;[\s\S]*?ELSE\s+v_component_id := NEW\.component_id;/);
  assert.doesNotMatch(sql, /currency_settings_listing_idx/);
  for (const name of ['currency_settings_listing_due_idx', 'currency_settings_delist_due_idx']) {
    assert.match(compactSql, new RegExp(`${name}[^;]+WHERE [^;]+ IS NOT NULL`, 'i'));
  }
  for (const [name, columns, fields] of INDEXES) {
    const escaped = columns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(compactSql, new RegExp(`${name}[^;]+\\(${escaped}\\)`, 'i'), name);
    assert.ok(schema.includes(`@@index([${fields}], map: "${name}")`), name);
  }
});

interface Fixture {
  currencyA: string; currencyB: string; bindingA: string; bindingB: string;
  hotA: string; coldA: string; stakeA: string; hotB: string; run: string; item: string;
  price: ReconciliationPriceFixture;
}

const alertTarget = process.env.WALLET_ALERT_SCHEMA_TEST_DATABASE_URL ?? (LIVE ? TEST_URL : undefined);
it('requires JSON strings for financial alert evidence while preserving producer payloads',
  { skip: process.env.NODE_ENV !== 'test' || !alertTarget }, async () => {
    const canonical = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_reconciliation_test?schema=wallet_core';
    assert.ok(alertTarget === TEST_URL || alertTarget === canonical, 'exact approved alert test target required');
    const schema = alertTarget === canonical ? 'wallet_core' : 'wallet_core_test';
    const database = alertTarget === canonical ? 'orebit_wallet_reconciliation_test' : 'orebit_wallet_core_test';
    const client = new pg.Client({ connectionString: alertTarget }); await client.connect();
    try {
      const identity = (await client.query(`SELECT current_database() name,current_user owner,
        inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
      assert.deepEqual(identity, { name: database, owner: 'orebit_wallet_core_test_owner', port: 5432,
        system_id: '7681719399426031650' });
      await client.query('BEGIN');
      const currencyId = (await client.query(`SELECT currency_id FROM ${schema}.currency_settings LIMIT 1`)).rows[0].currency_id;
      const common = { runId: randomUUID(), itemId: randomUUID(), currencyId };
      const cases = [
        { category: 'SHORTFALL', payload: { ...common, custodyBalance: '0.000000000000000001',
          requiredBacking: '1.000000000000000000', shortfallPercent: '99.999999999999999900', thresholdPercent: '5.000' } },
        { category: 'STAKING_TOTAL_MISMATCH', payload: { ...common, componentId: randomUUID(),
          reportedTotal: '0.000000000000000001', componentSum: '1.000000000000000000', selectedSource: 'COMPONENT_SUM' } },
        { category: 'PARTIAL_DATA', payload: { ...common, partialReasons: ['TIMEOUT'], shortfallSuppressed: true } },
      ];
      for (const { category, payload } of cases) {
        const parent = randomUUID();
        await client.query(`INSERT INTO ${schema}.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at)
          VALUES ($1,$2,$3,'ACTIVE',$4,$5::jsonb,now())`, [parent, parent, category, currencyId, JSON.stringify(payload)]);
        await client.query(`INSERT INTO ${schema}.wallet_alert_events(id,alert_id,category,status,payload)
          VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3::jsonb)`, [parent, category, JSON.stringify(payload)]);
        // Preserve the literal fractional number and its decimal scale through PostgreSQL JSONB parsing.
        for (const [key, value] of Object.entries(payload).filter(([, value]) => typeof value === 'string')) {
          const numeric = key === 'thresholdPercent' ? '5.000' : '0.000000000000000001';
          const raw = JSON.stringify(payload).replace(JSON.stringify(key) + ':' + JSON.stringify(value),
            JSON.stringify(key) + ':' + numeric);
          await rejectsInSavepoint(client, () => client.query(`INSERT INTO ${schema}.wallet_alerts
            (id,dedupe_key,category,status,currency_id,payload,opened_at)
            VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3,$4::jsonb,now())`,
          [randomUUID(), category, currencyId, raw]), /invalid wallet alert payload/);
          await rejectsInSavepoint(client, () => client.query(`INSERT INTO ${schema}.wallet_alert_events
            (id,alert_id,category,status,payload) VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3::jsonb)`,
          [parent, category, raw]), /invalid wallet alert payload/);
        }
      }
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });

it('rejects nonfinite durable staking evidence while retaining signed, high-range and nullable amounts',
  { skip: process.env.NODE_ENV !== 'test' || !alertTarget }, async () => {
    const canonical = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_reconciliation_test?schema=wallet_core';
    assert.ok(alertTarget === TEST_URL || alertTarget === canonical, 'exact approved evidence test target required');
    const schema = alertTarget === canonical ? 'wallet_core' : 'wallet_core_test';
    const database = alertTarget === canonical ? 'orebit_wallet_reconciliation_test' : 'orebit_wallet_core_test';
    const price = schema === 'wallet_core' ? 'price_conversion' : 'price_conversion_test';
    const client = new pg.Client({ connectionString: alertTarget }); await client.connect();
    try {
      const identity = (await client.query(`SELECT current_database() name,current_user owner,
        inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
      assert.deepEqual(identity, { name: database, owner: 'orebit_wallet_core_test_owner', port: 5432,
        system_id: '7681719399426031650' });
      for (const mode of ['NaN', 'Infinity', '-Infinity', 'high', 'negative', 'missing']) {
        await client.query('BEGIN');
        try {
          const special = ['NaN', 'Infinity', '-Infinity'].includes(mode);
          const currency = randomUUID(), chain = randomUUID(), binding = randomUUID(), address = randomUUID();
          const run = randomUUID(), item = randomUUID(), component = randomUUID();
          const provider = String(BigInt(Date.now()) * 1000n + BigInt(process.pid));
          await client.query(`INSERT INTO ${price}.currencies(id,symbol,name,decimals,kind,pricing_status)
            VALUES($1,$2,'Finite evidence fixture',18,'CRYPTO','DISABLED')`,
          [currency, 'N' + currency.replaceAll('-', '').slice(-20).toUpperCase()]);
          await client.query(`INSERT INTO ${schema}.currency_settings(currency_id) VALUES($1)`, [currency]);
          await client.query(`INSERT INTO ${schema}.chains(id,provider_chain_id,short_name,name,is_evm)
            VALUES($1,$2,$3,'Finite evidence chain',false)`,
          [chain, provider, 'N' + chain.replaceAll('-', '').slice(-20).toUpperCase()]);
          await client.query(`INSERT INTO ${schema}.currencies
            (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
            VALUES($1,$2,$3,$4,false,true,18)`, [binding, currency, chain, provider]);
          await client.query(`INSERT INTO ${schema}.custody_addresses(id,currency_chain_id,kind,wallet_address,address_identity)
            VALUES($1,$2,'STAKING','Finite-Evidence-Address','Finite-Evidence-Address')`, [address, binding]);
          const settings = (await client.query(`SELECT *,COALESCE((SELECT revision FROM ${schema}.configuration_changes
            WHERE status='LIVE'),0)::text live_revision FROM ${schema}.wallet_settings WHERE id`)).rows[0];
          const at = new Date();
          await client.query(`INSERT INTO ${schema}.cronjob_runs(id,job_name,scheduled_for,worker_instance_id,status)
            VALUES($1,'wallet-reconciliation',$2,'finite-evidence-fixture','RUNNING')`, [run, at]);
          await client.query(`INSERT INTO ${schema}.wallet_reconciliation_runs
            (id,status,scheduled_for,applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
             expected_currency_count,include_treasury,include_collection,applied_reconciliation_alert_basis)
            SELECT $1,NULL,$2,reconciliation_alert_percent,$3,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',
              (SELECT count(*) FROM ${price}.currencies c JOIN ${schema}.currency_settings s ON s.currency_id=c.id
                WHERE c.kind='CRYPTO'),include_treasury,include_collection,reconciliation_alert_basis
            FROM ${schema}.wallet_settings WHERE id`, [run, at, settings.live_revision]);
          const user = mode === 'high' ? '9'.repeat(60) : '-10';
          const positive = mode === 'high' ? user : '0';
          await client.query(`INSERT INTO ${schema}.state_events(id,event_type,subject_type,subject_id,run_id,payload)
            SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',c.id,$1,
              jsonb_build_object('binanceReference',s.binance_reference,'userMerchant',CASE WHEN c.id=$2 THEN $3::text ELSE '0' END,
                'userMerchantPositive',CASE WHEN c.id=$2 THEN $4::text ELSE '0' END,
                'treasury',CASE WHEN c.id=$2 THEN '-1' ELSE '0' END,'collection',CASE WHEN c.id=$2 THEN '-2' ELSE '0' END,'price',NULL)
            FROM ${price}.currencies c JOIN ${schema}.currency_settings s ON s.currency_id=c.id WHERE c.kind='CRYPTO'`,
          [run, currency, user, positive]);
          await client.query(`INSERT INTO ${schema}.state_events(id,event_type,subject_type,subject_id,run_id,payload)
            SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',b.id,$1,
              jsonb_build_object('currencyId',c.id,'chainShortName',ch.short_name,'currencyName',c.name,
                'blockchainPrecision',b.blockchain_precision,'isToken',b.is_token,'isNative',b.is_native)
            FROM ${schema}.currencies b JOIN ${schema}.chains ch ON ch.id=b.chain_id
            JOIN ${price}.currencies c ON c.id=b.currency_id JOIN ${schema}.currency_settings s ON s.currency_id=c.id
            WHERE c.kind='CRYPTO'`, [run]);
          const signed = (BigInt(user) - (settings.include_treasury ? 1n : 0n) - (settings.include_collection ? 2n : 0n)).toString();
          const chosen = settings.reconciliation_alert_basis === 'SIGNED' ? signed : positive;
          const backing = BigInt(chosen) > 0n ? chosen : '0';
          const selected = special ? mode : mode === 'high' ? '199999999999999999998' : '0';
          const mismatch = special || mode === 'high';
          const reasons = ['PRICE_UNAVAILABLE', ...(mode === 'missing' ? ['TIMEOUT'] : mismatch ? ['STAKING_TOTAL_MISMATCH'] : [])];
          const persist = async () => {
            await client.query(`INSERT INTO ${schema}.wallet_reconciliation_items
              (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,total_custody_balance,
               required_backing,user_merchant_balance,treasury_balance,collection_balance,partial_reasons,shortfall_suppressed,
               shortfall_percent,applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
               ledger_signed_total,ledger_positive_total,applied_reconciliation_alert_basis)
              SELECT $1,id,$3,'PARTIAL',0,$4,0,$4,$5,$6,-1,-2,$7,$8,
                CASE WHEN $8 OR $5::numeric=0 THEN NULL ELSE trunc(GREATEST($5::numeric-$4::numeric,0)*100/$5::numeric,18) END,
                applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,$9,$10,applied_reconciliation_alert_basis
              FROM ${schema}.wallet_reconciliation_runs WHERE id=$2`,
            [item, run, currency, selected, backing, user, reasons, mode === 'missing', signed, positive]);
            await client.query(`INSERT INTO ${schema}.wallet_reconciliation_components
              (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,accepted_raw_decimal,selected_balance,
               total_admin_stake_balance,total_admin_manual_stake_balance,total_balance,stake_selected_source,stake_total_mismatch,safe_error_code)
              VALUES($1,$2,'STAKING',$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [component, item, binding, address, mode === 'missing' ? null : '0', mode === 'missing' ? null : selected,
              mode === 'missing' ? null : special ? mode : mode === 'high' ? '99999999999999999999' : '0',
              mode === 'missing' ? null : mode === 'high' ? '99999999999999999999' : '0', mode === 'missing' ? null : '0',
              mode === 'missing' ? null : mismatch ? 'COMPONENT_SUM' : 'REPORTED_TOTAL', mismatch, mode === 'missing' ? 'TIMEOUT' : null]);
            await client.query(`INSERT INTO ${schema}.wallet_reconciliation_attempts
              (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome,safe_error_code)
              VALUES(gen_random_uuid(),$1,1,0,$2,$3,$4)`,
            [component, mode === 'missing' ? 'ENCRYPT' : 'BALANCE', mode === 'missing' ? 'FAILED' : 'SUCCESS', mode === 'missing' ? 'TIMEOUT' : null]);
            await client.query('SET CONSTRAINTS ALL IMMEDIATE');
          };
          if (special) await assert.rejects(persist, /finite_amounts|numeric field overflow|cannot hold an infinite value/);
          else {
            await persist();
            const saved = (await client.query(`SELECT user_merchant_balance::text liability,treasury_balance::text treasury,
              collection_balance::text collection FROM ${schema}.wallet_reconciliation_items WHERE id=$1`, [item])).rows[0];
            assert.equal(saved.liability, user + '.000000000000000000');
            assert.equal(saved.treasury, '-1.000000000000000000');
            assert.equal(saved.collection, '-2.000000000000000000');
          }
        } finally { await client.query('ROLLBACK'); }
      }
    } finally { await client.end(); }
  });
async function fixture(client: pg.PoolClient): Promise<Fixture> {
  const currencyA = await createReconciliationCurrencyFixture(client);
  const currencyB = await createReconciliationCurrencyFixture(client);
  const price = await createReconciliationPriceFixture(client, currencyA);
  const [chainA, chainB, bindingA, bindingB, hotA, coldA, stakeA, hotB, run] =
    Array.from({ length: 9 }, () => randomUUID()) as
    [string, string, string, string, string, string, string, string, string];
  const item = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const provider = BigInt(Date.now()) * 100000n + BigInt(Math.floor(Math.random() * 10000));
  await client.query(`UPDATE wallet_core_test.currency_settings SET binance_reference =
    CASE currency_id WHEN $1 THEN 'BINANCE_A'::varchar ELSE 'BINANCE_B'::varchar END
    WHERE currency_id IN ($1,$2)`, [currencyA, currencyB]);
  await client.query(`INSERT INTO wallet_core_test.chains
    (id,provider_chain_id,short_name,name,is_evm) VALUES
    ($1,$3,$5,$5,false),($2,$4,$6,$6,false)`,
  [chainA, chainB, provider.toString(), (provider + 1n).toString(), `CA${suffix}`, `CB${suffix}`]);
  await client.query(`INSERT INTO wallet_core_test.currencies
    (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
    VALUES ($1,$3,$5,$7,false,true,18),($2,$4,$6,$8,false,true,18)`,
  [bindingA, bindingB, currencyA, currencyB, chainA, chainB,
    (provider + 2n).toString(), (provider + 3n).toString()]);
  await client.query(`INSERT INTO wallet_core_test.custody_addresses
    (id,currency_chain_id,kind,wallet_address,address_identity) VALUES
    ($1,$5,'HOT','hot-a','hot-a'),($2,$5,'COLD','cold-a','cold-a'),
    ($3,$5,'STAKING','stake-a','stake-a'),($4,$6,'HOT','hot-b','hot-b')`,
  [hotA, coldA, stakeA, hotB, bindingA, bindingB]);
  await isolateReconciliationConfiguration(client, [currencyA]);
  await captureReconciliationFixture(client, run, currencyA, price);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
    (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
     total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
     collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
     applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
     price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
     price_resolution_reason,price_used_fallback,ledger_signed_total,ledger_positive_total,
     applied_reconciliation_alert_basis)
    VALUES ($1,$2,$3,'PARTIAL',0,0,0,0,0,0,0,0,ARRAY['TIMEOUT'],true,NULL,
      5,0,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$4,$5,$6,$7,$8,$9,$10,0,0,'SIGNED')`,
  [item, run, currencyA, price.resolutionId, price.snapshotId, price.provider,
    price.priceUsd, price.observedAt, price.resolutionReason, price.usedFallback]);
  return { currencyA, currencyB, bindingA, bindingB, hotA, coldA, stakeA, hotB, run, item, price };
}

let savepoint = 0;
async function rejectsInSavepoint(
  client: pg.Client | pg.PoolClient, action: () => Promise<unknown>, pattern: RegExp,
) {
  const name = `evidence_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    await assert.rejects(action, pattern);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

describe('Wallet Core reconciliation evidence database boundaries', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(() => { pool = new pg.Pool({ connectionString: TEST_URL, max: 1 }); });
  after(async () => { await pool?.end(); });

  it('rejects JSON nulls in otherwise complete financial alert evidence', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currency = await createReconciliationCurrencyFixture(client);
      const payload = { currencyId: currency, custodyBalance: '0.000000000000000000',
        itemId: randomUUID(), requiredBacking: '1.000000000000000000', runId: randomUUID(),
        shortfallPercent: '100.000000000000000000', thresholdPercent: '5.000' };
      for (const key of Object.keys(payload)) {
        await rejectsInSavepoint(client, () => client.query(`INSERT INTO wallet_core_test.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at)
          VALUES (gen_random_uuid(),$1,'SHORTFALL','ACTIVE',$2,$3,now())`,
        [randomUUID(), currency, { ...payload, [key]: null }]), /invalid wallet alert payload/);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('rejects incoherent component, item, and legacy evidence', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const f = await fixture(client);
      const failed = `INSERT INTO wallet_core_test.wallet_reconciliation_components
        (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,safe_error_code)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5)`;
      const componentCases: ReadonlyArray<readonly [string, unknown[], RegExp]> = [
        ['bad safe code', [f.item, 'HOT', f.bindingA, f.hotA, 'RAW_PROVIDER_ERROR'], /invalid input value for enum/i],
        ['wrong binding', [f.item, 'HOT', f.bindingB, f.hotB, 'TIMEOUT'], /reconciliation address capture membership mismatch/i],
        ['wrong address', [f.item, 'HOT', f.bindingA, f.hotB, 'TIMEOUT'], /reconciliation address capture membership mismatch/i],
        ['wrong kind', [f.item, 'HOT', f.bindingA, f.coldA, 'TIMEOUT'], /reconciliation address capture membership mismatch/i],
      ];
      for (const [, params, pattern] of componentCases) {
        await rejectsInSavepoint(client, () => client.query(failed, params), pattern);
      }
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_reconciliation_components
        (id,run_item_id,kind,binance_reference,attempts_used,safe_error_code)
        VALUES (gen_random_uuid(),$1,'BINANCE','WRONG',1,'TIMEOUT')`, [f.item]), /reconciliation Binance capture mismatch/i);
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_reconciliation_components
        (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
         accepted_raw_decimal,selected_balance,total_admin_stake_balance,
         total_admin_manual_stake_balance,total_balance,stake_selected_source,stake_total_mismatch)
        VALUES (gen_random_uuid(),$1,'STAKING',$2,$3,1,'3',3,1,2,3,'COMPONENT_SUM',false)`,
      [f.item, f.bindingA, f.stakeA]), /reconciliation staking evidence mismatch/i);
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_reconciliation_items
        (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
         total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
         collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
         applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
         price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
         price_resolution_reason,price_used_fallback,ledger_signed_total,ledger_positive_total,
         applied_reconciliation_alert_basis)
        VALUES (gen_random_uuid(),$1,$2,'PARTIAL',1,1,1,4,0,0,0,0,ARRAY['TIMEOUT'],
          true,NULL,5,0,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',
          $3,$4,$5,$6,$7,$8,$9,0,0,'SIGNED')`,
      [f.run, f.currencyA, f.price.resolutionId, f.price.snapshotId, f.price.provider,
        f.price.priceUsd, f.price.observedAt, f.price.resolutionReason, f.price.usedFallback]),
      /check constraint/i);
      await rejectsInSavepoint(client, () => client.query(`INSERT INTO
        wallet_core_test.legacy_currency_chain_codes
        (currency_id,chain_code,blockchain_precision,mapped_binding_id)
        VALUES ($1,'WRONG_BINDING',18,$2)`, [f.currencyA, f.bindingB]), /foreign key constraint/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects missing, gapped, and nonterminal-success attempt evidence', async () => {
    const failedComponent = `INSERT INTO wallet_core_test.wallet_reconciliation_components
      (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,safe_error_code)
      VALUES ($1,$2,'HOT',$3,$4,$5,'TIMEOUT')`;
    const attempt = `INSERT INTO wallet_core_test.wallet_reconciliation_attempts
      (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome,safe_error_code)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`;
    const attemptCase = async (
      action: (client: pg.PoolClient, f: Fixture) => Promise<void>, pattern: RegExp,
    ) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const f = await fixture(client);
        await assert.rejects(() => action(client, f), pattern);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await attemptCase(async (client, f) => {
        await client.query(failedComponent, [randomUUID(), f.item, f.bindingA, f.hotA, 1]);
        await client.query(`SET CONSTRAINTS
          wallet_core_test.wallet_reconciliation_components_attempt_set_guard IMMEDIATE`);
    }, /attempt count mismatch/i);
    await attemptCase(async (client, f) => {
        const id = randomUUID();
        await client.query(failedComponent, [id, f.item, f.bindingA, f.hotA, 3]);
        await client.query(attempt, [id, 1, 0, 'ENCRYPT', 'FAILED', 'TIMEOUT']);
        await client.query(attempt, [id, 3, 3000, 'ENCRYPT', 'FAILED', 'TIMEOUT']);
        await client.query(`SET CONSTRAINTS
          wallet_core_test.wallet_reconciliation_components_attempt_set_guard IMMEDIATE`);
    }, /attempt count mismatch/i);
    await attemptCase(async (client, f) => {
        const id = randomUUID();
        await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
          (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
           accepted_raw_decimal,selected_balance) VALUES ($1,$2,'HOT',$3,$4,2,'0',0)`,
        [id, f.item, f.bindingA, f.hotA]);
        await client.query(attempt, [id, 1, 0, 'BALANCE', 'SUCCESS', null]);
        await client.query(attempt, [id, 2, 1000, 'ENCRYPT', 'FAILED', 'TIMEOUT']);
        await client.query(`SET CONSTRAINTS
          wallet_core_test.wallet_reconciliation_components_attempt_set_guard IMMEDIATE`);
    }, /attempt outcome mismatch/i);
  });
});
