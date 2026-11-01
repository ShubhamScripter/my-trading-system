const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const pg = require('pg');
const schemaTest = (name, run) => test(name, { skip: !process.env.WP11_SCHEMA_DATABASE_URL }, run);
const FIAT_CODES='AED ARS AUD BDT BHD BMD BRL CAD CHF CLP CNY CZK DKK EUR GBP GEL HKD HUF IDR ILS INR JPY KRW KWD LKR MMK MXN MYR NGN NOK NZD PHP PKR PLN RUB SAR SEK SGD THB TRY TWD UAH USD VND ZAR'.split(' ');

// The harness provisions this new cluster; this test never provisions or resets a database.
async function transaction(run) {
  const url = new URL(process.env.WP11_SCHEMA_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55441');
  assert.equal(url.pathname, '/orebit_wallet_pricing_fixes_20260910');
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_database() AS name,
      current_setting('cluster_name') AS cluster`)).rows[0];
    assert.equal(identity.name, url.pathname.slice(1));
    assert.equal(identity.cluster, 'orebit_wallet_pricing_fixes_20260910');
    await client.query('BEGIN');
    await run(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

async function rejects(client, sql, values, code = '23514') {
  await client.query('SAVEPOINT invalid_value');
  try { await assert.rejects(client.query(sql, values), error => error.code === code); }
  finally { await client.query('ROLLBACK TO SAVEPOINT invalid_value'); }
}

async function currency(client) {
  const id = randomUUID();
  await client.query(`INSERT INTO price_conversion.currencies
    (id,symbol,name,decimals,kind,pricing_status)
    VALUES ($1,$2,'Schema regression fixture',18,'CRYPTO','DISABLED')`,
  [id, 'S' + id.replaceAll('-', '').slice(0, 25).toUpperCase()]);
  return id;
}

schemaTest('pricing rejects numeric NaN in every durable monetary field', () => transaction(async client => {
  const id = await currency(client);
  const provider = (await client.query('SELECT id FROM price_conversion.price_providers LIMIT 1')).rows[0].id;
  await rejects(client, `INSERT INTO price_conversion.price_snapshots
    (provider_id,currency_id,price_usd,observed_at,response_hash)
    VALUES ($1,$2,'NaN',now(),repeat('a',64))`, [provider, id]);
  await rejects(client, `INSERT INTO price_conversion.price_view_snapshots
    (provider_id,currency_id,fiat_code,price,observed_at,response_hash)
    VALUES ($1,$2,'USD','NaN',now(),repeat('a',64))`, [provider, id]);
  for (const field of ['difference_bps', 'primary_price_usd', 'comparison_price_usd',
    'fallback_price_usd', 'absolute_difference_usd', 'difference_numerator', 'difference_denominator']) {
    await rejects(client, `INSERT INTO price_conversion.price_resolutions
      (currency_id,reason,stale,${field}) VALUES ($1,'PRICE_UNAVAILABLE',true,'NaN')`, [id]);
  }
  const snapshot = (await client.query(`INSERT INTO price_conversion.price_snapshots
    (provider_id,currency_id,price_usd,observed_at,response_hash)
    VALUES ($1,$2,'0.000000000000000001',now(),repeat('a',64)) RETURNING id`, [provider, id])).rows[0].id;
  await rejects(client, `INSERT INTO price_conversion.price_resolutions
    (currency_id,effective_snapshot_id,effective_price_usd,reason,stale)
    VALUES ($1,$2,'NaN','STALE_DISPLAY',true)`, [id,snapshot]);
}));

schemaTest('pricing keeps independent long provider intervals and fixed fiat visibility', () => transaction(async client => {
  assert.ok((await client.query('SELECT freshness_seconds FROM price_conversion.price_providers')).rows
    .every(row => row.freshness_seconds === 600),'every valuation provider uses the ten-minute freshness window');
  await client.query(`UPDATE price_conversion.price_providers
    SET refresh_interval_seconds=3600, freshness_seconds=600 WHERE code='COINMARKETCAP'`);
  await rejects(client, `UPDATE price_conversion.price_providers
    SET freshness_seconds=601 WHERE code='COINMARKETCAP'`);
  await rejects(client, `UPDATE price_conversion.price_providers
    SET freshness_seconds=599 WHERE code='COINMARKETCAP'`);
  await rejects(client, `UPDATE price_conversion.price_view_fiats SET enabled=true WHERE code='XDR'`);
  const rows = (await client.query(`SELECT code FROM price_conversion.price_view_fiats
    WHERE enabled ORDER BY code`)).rows;
  assert.equal(rows.length, 45);
  assert.ok(!rows.some(row => ['XDR', 'VEF'].includes(row.code)));
}));

schemaTest('restricted price writer supports explicit and default revision without extra authority', () => transaction(async client => {
  const id = await currency(client);
  await client.query('SET LOCAL ROLE orebit_price_conversion_writer');
  const revision = (await client.query('SELECT revision FROM price_conversion.price_settings WHERE id')).rows[0].revision;
  for (const explicit of [true, false]) {
    const row = (await client.query(`INSERT INTO price_conversion.price_resolutions
      (currency_id,reason,stale${explicit ? ',config_revision' : ''})
      VALUES ($1,'PRICE_UNAVAILABLE',true${explicit ? ',$2' : ''}) RETURNING config_revision`,
    explicit ? [id, revision] : [id])).rows[0];
    assert.equal(row.config_revision, revision);
  }
  await rejects(client, 'DELETE FROM price_conversion.price_resolutions WHERE currency_id=$1', [id], '42501');
  await client.query('RESET ROLE');
  const access = (await client.query(`SELECT
    has_function_privilege('orebit_wallet_core_user_writer',
      'price_conversion.current_price_config_revision()','EXECUTE') AS user_access`)).rows[0];
  assert.equal(access.user_access, false);
}));

schemaTest('provider reference replacement retains old identities and only one current mapping', () => transaction(async client => {
  assert.equal((await client.query(`SELECT count(*)::int count FROM information_schema.columns
    WHERE table_schema='price_conversion' AND table_name='currency_provider_refs' AND column_name='retired_at'`)).rows[0].count,
  1,'provider references need retained history');
  const id = await currency(client);
  const provider = (await client.query('SELECT id FROM price_conversion.price_providers LIMIT 1')).rows[0].id;
  const ref = randomUUID();
  await client.query(`INSERT INTO price_conversion.currency_provider_refs
    (id,currency_id,provider_id,external_id,symbol) VALUES ($1,$2,$3,$4,'OLD')`, [ref,id,provider,ref]);
  await client.query('UPDATE price_conversion.currency_provider_refs SET retired_at=clock_timestamp() WHERE id=$1', [ref]);
  await client.query(`INSERT INTO price_conversion.currency_provider_refs
    (currency_id,provider_id,external_id,symbol) VALUES ($1,$2,$3,'NEW')`, [id,provider,ref]);
  assert.equal((await client.query('SELECT count(*)::int count FROM price_conversion.currency_provider_refs WHERE currency_id=$1', [id])).rows[0].count,2);
  await rejects(client, `INSERT INTO price_conversion.currency_provider_refs
    (currency_id,provider_id,external_id,symbol) VALUES ($1,$2,$3,'DUP')`, [id,provider,ref], '23505');
  await rejects(client, 'DELETE FROM price_conversion.currency_provider_refs WHERE id=$1', [ref]);
  await rejects(client, "UPDATE price_conversion.currency_provider_refs SET symbol='CHANGED' WHERE id=$1", [ref]);
  await client.query("UPDATE price_conversion.currencies SET pricing_status='ACTIVE' WHERE id=$1", [id]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await rejects(client, `UPDATE price_conversion.currency_provider_refs SET retired_at=clock_timestamp()
    WHERE currency_id=$1 AND retired_at IS NULL`, [id], 'P0001');
}));

schemaTest('ordered Wallet defaults reject duplicate, missing, fiat and oversized choices', () => transaction(async client => {
  assert.equal((await client.query(`SELECT count(*)::int count FROM information_schema.columns
    WHERE table_schema='wallet_core' AND table_name='wallet_settings' AND column_name='default_currency_ids'`)).rows[0].count,
  1,'Wallet needs an ordered default catalogue');
  const id = await currency(client);
  await client.query('UPDATE wallet_core.wallet_settings SET default_currency_ids=$1 WHERE id', [[id]]);
  await rejects(client, 'UPDATE wallet_core.wallet_settings SET default_currency_ids=$1 WHERE id', [[id,id]]);
  await rejects(client, 'UPDATE wallet_core.wallet_settings SET default_currency_ids=$1 WHERE id', [[randomUUID()]]);
  await rejects(client, 'UPDATE wallet_core.wallet_settings SET default_currency_ids=$1 WHERE id', [Array.from({length:11},randomUUID)]);
  const fiat = await currency(client);
  await client.query("UPDATE price_conversion.currencies SET kind='FIAT' WHERE id=$1",[fiat]);
  await rejects(client, 'UPDATE wallet_core.wallet_settings SET default_currency_ids=$1 WHERE id', [[fiat]]);
}));

schemaTest('all persisted deviation representations stop at 1000 percent', () => transaction(async client => {
  const id = await currency(client);
  for (const [fields,values] of [
    ['difference_bps','100001'],
    ['difference_numerator,difference_denominator','11,1'],
    ['absolute_difference_usd,primary_price_usd','11,1'],
  ]) await rejects(client, `INSERT INTO price_conversion.price_resolutions
    (currency_id,reason,stale,${fields}) VALUES ($1,'PRICE_UNAVAILABLE',true,${values})`, [id]);
  await client.query(`INSERT INTO price_conversion.price_resolutions
    (currency_id,reason,stale,difference_bps,difference_numerator,difference_denominator,
    absolute_difference_usd,primary_price_usd)
    VALUES ($1,'PRICE_UNAVAILABLE',true,100000,10000000000000000000,1000000000000000000,10,1)`, [id]);
}));

async function capture(client, id, amount='0') {
  await client.query('INSERT INTO wallet_core.currency_settings(currency_id) VALUES ($1)', [id]);
  const run = randomUUID();
  const settings = (await client.query('SELECT * FROM wallet_core.wallet_settings WHERE id')).rows[0];
  const revision = (await client.query("SELECT revision FROM wallet_core.configuration_changes WHERE status='LIVE'")).rows[0]?.revision ?? '0';
  await client.query(`INSERT INTO wallet_core.cronjob_runs
    (id,job_name,scheduled_for,worker_instance_id,status)
    VALUES ($1,'wallet-reconciliation',clock_timestamp(),'schema-regression','RUNNING')`, [run]);
  await client.query(`INSERT INTO wallet_core.wallet_reconciliation_runs
    (id,scheduled_for,applied_reconciliation_alert_percent,applied_configuration_revision,
    comparison_rule,expected_currency_count,include_treasury,include_collection,applied_reconciliation_alert_basis)
    SELECT $1,scheduled_for,$2,$3,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',
    (SELECT count(*) FROM wallet_core.currency_settings s JOIN price_conversion.currencies c ON c.id=s.currency_id WHERE c.kind='CRYPTO'),
    $4,$5,$6 FROM wallet_core.cronjob_runs WHERE id=$1`,
  [run,settings.reconciliation_alert_percent,revision,settings.include_treasury,settings.include_collection,settings.reconciliation_alert_basis]);
  await client.query(`INSERT INTO wallet_core.state_events(id,event_type,subject_type,subject_id,run_id,payload)
    SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',c.id,$1,
    jsonb_build_object('binanceReference',s.binance_reference,'userMerchant',CASE WHEN c.id=$2 THEN $3 ELSE '0' END,
      'userMerchantPositive',CASE WHEN c.id=$2 THEN $3 ELSE '0' END,'treasury','0','collection','0','price',NULL)
    FROM wallet_core.currency_settings s JOIN price_conversion.currencies c ON c.id=s.currency_id WHERE c.kind='CRYPTO'`, [run,id,amount]);
  await client.query(`INSERT INTO wallet_core.state_events(id,event_type,subject_type,subject_id,run_id,payload)
    SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',b.id,$1,
    jsonb_build_object('currencyId',b.currency_id,'chainShortName',COALESCE(to_jsonb(c)->>'blockchain_reference',c.short_name),
      'currencyName',COALESCE(to_jsonb(b)->>'blockchain_reference',master.name),
      'blockchainPrecision',b.blockchain_precision,'isToken',b.is_token,'isNative',b.is_native)
    FROM wallet_core.currencies b JOIN wallet_core.chains c ON c.id=b.chain_id
    JOIN price_conversion.currencies master ON master.id=b.currency_id`, [run]);
  return { run, settings, revision };
}

async function zeroItem(client, id, fixture, amount='0') {
  const { run, settings, revision } = fixture;
  const item=(await client.query(`INSERT INTO wallet_core.wallet_reconciliation_items
    (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,total_custody_balance,
    required_backing,user_merchant_balance,treasury_balance,collection_balance,partial_reasons,shortfall_suppressed,
    applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,ledger_signed_total,
    ledger_positive_total,applied_reconciliation_alert_basis)
    VALUES(gen_random_uuid(),$1,$2,'PARTIAL',0,0,0,0,$3,$3,0,0,$4,$5,$6,$7,
    'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$3,$3,$8) RETURNING id`,
  [run,id,amount,amount==='0'?['PRICE_UNAVAILABLE']:['PRICE_UNAVAILABLE','CUSTODY_NOT_CONFIGURED'],
    amount!=='0',settings.reconciliation_alert_percent,revision,settings.reconciliation_alert_basis])).rows[0].id;
  const reference=(await client.query('SELECT binance_reference FROM wallet_core.currency_settings WHERE currency_id=$1',[id])).rows[0].binance_reference;
  if (reference!==null) {
    const component=randomUUID();
    await client.query(`INSERT INTO wallet_core.wallet_reconciliation_components
      (id,run_item_id,kind,binance_reference,attempts_used,accepted_raw_decimal,selected_balance)
      VALUES($1,$2,'BINANCE',$3,1,'0',0)`,[component,item,reference]);
    await client.query(`INSERT INTO wallet_core.wallet_reconciliation_attempts
      (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome)
      VALUES(gen_random_uuid(),$1,1,0,'BALANCE','SUCCESS')`,[component]);
  }
}

schemaTest('pending reconciliation keeps unique captured members and final counter verification', () => transaction(async client => {
  const id = await currency(client);
  const fixture = await capture(client,id);
  await zeroItem(client,id,fixture);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await rejects(client, `UPDATE wallet_core.wallet_reconciliation_runs
    SET status='PARTIAL',currency_count=99,completed_at=clock_timestamp() WHERE id=$1`, [fixture.run]);
  await rejects(client, `INSERT INTO wallet_core.wallet_reconciliation_items
    SELECT (jsonb_populate_record(NULL::wallet_core.wallet_reconciliation_items,
      to_jsonb(item)||jsonb_build_object('id',gen_random_uuid()))).*
    FROM wallet_core.wallet_reconciliation_items item WHERE run_id=$1`, [fixture.run], '23505');
}));

schemaTest('positive liability without configured custody persists partial evidence without shortfall', () => transaction(async client => {
  const id = await currency(client);
  const fixture = await capture(client,id,'1');
  await zeroItem(client,id,fixture,'1');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const row = (await client.query(`SELECT shortfall_suppressed,shortfall_percent,partial_reasons
    FROM wallet_core.wallet_reconciliation_items WHERE run_id=$1`, [fixture.run])).rows[0];
  assert.equal(row.shortfall_suppressed,true);
  assert.equal(row.shortfall_percent,null);
  assert.ok(row.partial_reasons.includes('CUSTODY_NOT_CONFIGURED'));
  const remaining=(await client.query(`SELECT subject_id FROM wallet_core.state_events
    WHERE run_id=$1 AND event_type='RECONCILIATION.CONFIG_SNAPSHOT' AND subject_type='CURRENCY'
      AND subject_id<>$2`,[fixture.run,id])).rows;
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  for (const other of remaining) await zeroItem(client,other.subject_id,fixture);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query(`UPDATE wallet_core.wallet_reconciliation_runs SET status='PARTIAL',
    currency_count=expected_currency_count,warning_count=0,completed_at=clock_timestamp() WHERE id=$1`,[fixture.run]);
  const header=(await client.query('SELECT status,warning_count FROM wallet_core.wallet_reconciliation_runs WHERE id=$1',[fixture.run])).rows[0];
  assert.deepEqual(header,{status:'PARTIAL',warning_count:0});
  await rejects(client,`UPDATE wallet_core.wallet_reconciliation_runs
    SET warning_count=1 WHERE id=$1`,[fixture.run]);
}));

schemaTest('reconciliation attempt identity keeps unique protection without its duplicate index', () => transaction(async client => {
  const indexes=(await client.query(`SELECT i.indisunique,pg_get_indexdef(i.indexrelid) definition
    FROM pg_index i WHERE i.indrelid='wallet_core.wallet_reconciliation_attempts'::regclass`)).rows;
  const identity=indexes.filter(row=>row.definition.includes('(component_id, attempt_ordinal)'));
  assert.equal(identity.length,1,'one unique index should protect the attempt identity');
  assert.equal(identity[0].indisunique,true);
}));

schemaTest('source timestamps preserve unknown historical receipt and accept explicit new metadata', () => transaction(async client => {
  for (const table of ['price_snapshots','price_view_snapshots']) {
    const columns=(await client.query(`SELECT column_name,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='price_conversion' AND table_name=$1
      AND column_name IN ('received_at','asset_updated_at')`,[table])).rows;
    assert.equal(columns.length,2,'source and receipt metadata need separate storage');
    for (const column of columns) {assert.equal(column.is_nullable,'YES');assert.equal(column.column_default,null);}
  }
}));

schemaTest('all supported fiat display choices have stable masters without Wallet holdings', () => transaction(async client => {
  const rows=(await client.query(`SELECT f.code,c.id,c.decimals
    FROM price_conversion.price_view_fiats f LEFT JOIN price_conversion.currencies c
    ON c.symbol=f.code AND c.kind='FIAT'
    WHERE f.code=ANY($1::text[])`,[FIAT_CODES])).rows;
  assert.equal(rows.length,45);
  assert.ok(rows.every(row=>row.id && row.decimals===18),'all45 fiat choices need display-only master UUIDs');
}));

schemaTest('Pricing receives only the narrow global Audit append capability', () => transaction(async client => {
  const signature='admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)';
  const rights=(await client.query(`SELECT
    has_schema_privilege('orebit_price_conversion_writer','admin','USAGE') AS schema_usage,
    has_function_privilege('orebit_price_conversion_writer',$1,'EXECUTE') AS append,
    has_table_privilege('orebit_price_conversion_writer','admin.admin_audit_events','INSERT') AS table_insert,
    has_function_privilege('orebit_wallet_core_user_writer',$1,'EXECUTE') AS user_append,
    EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_append`,[signature])).rows[0];
  assert.deepEqual(rights,{schema_usage:true,append:true,table_insert:false,user_append:false,public_append:false});
  await client.query('SET LOCAL ROLE orebit_wallet_core_user_writer');
  await rejects(client,`SELECT admin.append_admin_audit_event_v1(NULL::uuid,NULL::text,NULL::text,
    NULL::text,NULL::text,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::inet,
    NULL::text,NULL::text,NULL::text,NULL::text,NULL::jsonb,NULL::jsonb,NULL::jsonb)`,[], '42501');
}));
