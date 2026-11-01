import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type pg from 'pg';

export interface ReconciliationPriceFixture {
  readonly valuationAt: Date;
  readonly resolutionId: string;
  readonly snapshotId: string;
  readonly provider: string;
  readonly priceUsd: string;
  readonly observedAt: Date;
  readonly resolutionReason: 'PRIMARY_CONFIRMED';
  readonly usedFallback: false;
}

export async function createReconciliationPriceFixture(
  client: pg.PoolClient,
  currencyId: string,
): Promise<ReconciliationPriceFixture> {
  const selected = (await client.query(`SELECT id,code::text code FROM
    price_conversion_test.price_providers WHERE code='COINGECKO'`)).rows[0];
  const snapshotId = randomUUID();
  const resolutionId = randomUUID();
  const priceUsd = '123.456789012345678901';
  const observedAt = new Date(Date.now() - 1_000);
  const valuationAt = new Date(Date.now() + 1_000);
  await client.query(`INSERT INTO price_conversion_test.price_snapshots
    (id,provider_id,currency_id,price_usd,observed_at,response_hash)
    VALUES ($1,$2,$3,$4,$5,repeat('b',64))`,
  [snapshotId, selected.id, currencyId, priceUsd, observedAt]);
  await client.query(`INSERT INTO price_conversion_test.price_resolutions
    (id,currency_id,effective_provider_id,effective_snapshot_id,effective_price_usd,
     observed_at,reason,stale) VALUES ($1,$2,$3,$4,$5,$6,'PRIMARY_CONFIRMED',false)`,
  [resolutionId, currencyId, selected.id, snapshotId, priceUsd, observedAt]);
  return { valuationAt, resolutionId, snapshotId, provider: selected.code, priceUsd,
    observedAt, resolutionReason: 'PRIMARY_CONFIRMED', usedFallback: false };
}

export async function createReconciliationCurrencyFixture(client:pg.PoolClient):Promise<string> {
  const id=randomUUID();
  await client.query(`INSERT INTO price_conversion_test.currencies(id,symbol,name,decimals,kind,pricing_status)
    VALUES ($1,$2,'Reconciliation fixture',18,'CRYPTO','DISABLED')`,[id,'R'+id.replaceAll('-','').slice(-20).toUpperCase()]);
  await client.query(`INSERT INTO wallet_core_test.currency_settings(currency_id) VALUES ($1)`,[id]);
  return id;
}

/** Narrow the real configured catalogue only in an existing owner rollback fixture; never commit. */
export async function isolateReconciliationConfiguration(client:pg.PoolClient,currencyIds:readonly string[]):Promise<void> {
  const identity=(await client.query(`SELECT current_database() name,current_user owner,
    current_setting('cluster_name') cluster,inet_server_port() port,
    pg_current_xact_id_if_assigned()::text transaction_id`)).rows[0];
  assert.ok(identity.transaction_id,'configuration isolation requires an already-written rollback transaction');
  assert.deepEqual({...identity,transaction_id:undefined},{name:'orebit_wallet_core_test',
    owner:'orebit_wallet_core_test_owner',cluster:'orebit_wallet_core_test',port:5432,transaction_id:undefined});
  // SAVEPOINT additionally refuses autocommit before any DELETE can execute.
  await client.query('SAVEPOINT reconciliation_configuration_fixture');
  try {
    assert.equal((await client.query('SELECT system_identifier::text id FROM pg_control_system()')).rows[0].id,'7681719399426031650');
    await client.query(`DELETE FROM wallet_core_test.currency_settings WHERE NOT(currency_id=ANY($1::uuid[]))`,[currencyIds]);
  } catch(error) {await client.query('ROLLBACK TO SAVEPOINT reconciliation_configuration_fixture');throw error;}
  finally {await client.query('RELEASE SAVEPOINT reconciliation_configuration_fixture');}
}

/** Called inside the caller's rollback transaction, after its currency/bindings/Price facts exist. */
export async function captureReconciliationFixture(client:pg.PoolClient,runId:string,
  currencyId:string|null,price:ReconciliationPriceFixture|null,
  liability:{readonly signed:string;readonly positive:string}={signed:'0',positive:'0'}):Promise<void> {
  await client.query(`UPDATE wallet_core_test.wallet_settings SET reconciliation_alert_percent=5,
    include_treasury=true,include_collection=false,reconciliation_alert_basis='SIGNED' WHERE id`);
  await client.query(`UPDATE wallet_core_test.configuration_changes SET status='ARCHIVED' WHERE status='LIVE'`);
  const at=price?.valuationAt??new Date();
  await client.query(`INSERT INTO wallet_core_test.cronjob_runs(id,job_name,scheduled_for,worker_instance_id,status)
    VALUES ($1,'wallet-reconciliation',$2,'reconciliation-fixture','RUNNING')`,[runId,at]);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_runs
    (id,status,scheduled_for,valuation_at,applied_reconciliation_alert_percent,applied_configuration_revision,
    comparison_rule,expected_currency_count,include_treasury,include_collection,applied_reconciliation_alert_basis)
    VALUES ($1,NULL,$2,$2,5,0,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$3,true,false,'SIGNED')`,
  [runId,at,currencyId===null?0:1]);
  if(currencyId===null)return;
  const reference=(await client.query(`SELECT binance_reference FROM wallet_core_test.currency_settings WHERE currency_id=$1`,[currencyId])).rows[0].binance_reference;
  const evidence=price?{resolutionId:price.resolutionId,snapshotId:price.snapshotId,provider:price.provider,
    priceUsd:price.priceUsd,observedAt:price.observedAt.toISOString(),resolutionReason:price.resolutionReason,usedFallback:price.usedFallback}:null;
  await client.query(`INSERT INTO wallet_core_test.state_events(id,event_type,subject_type,subject_id,run_id,payload)
    VALUES (gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',$1,$2,$3)`,[currencyId,runId,
    {binanceReference:reference,userMerchant:liability.signed,userMerchantPositive:liability.positive,treasury:'0',collection:'0',price:evidence}]);
  await client.query(`INSERT INTO wallet_core_test.state_events(id,event_type,subject_type,subject_id,run_id,payload)
    SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',binding.id,$2,
    jsonb_build_object('currencyId',currency.id,'chainShortName',chain.short_name,'currencyName',currency.name,
      'blockchainPrecision',binding.blockchain_precision,'isToken',binding.is_token,'isNative',binding.is_native)
    FROM wallet_core_test.currencies binding JOIN wallet_core_test.chains chain ON chain.id=binding.chain_id
    JOIN price_conversion_test.currencies currency ON currency.id=binding.currency_id WHERE currency.id=$1`,[currencyId,runId]);
}

export async function insertZeroReconciliation(client: pg.PoolClient, input: {
  runId: string; currencyId: string; runStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  itemStatus: 'COMPLETE' | 'PARTIAL'; reasons: readonly string[];
}): Promise<void> {
  const price = input.itemStatus === 'COMPLETE'
    ? await createReconciliationPriceFixture(client, input.currencyId) : null;
  await captureReconciliationFixture(client,input.runId,input.currencyId,price);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
    (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
     total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
     collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
     applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
     price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
     price_resolution_reason,price_used_fallback,ledger_signed_total,ledger_positive_total,applied_reconciliation_alert_basis)
    VALUES (gen_random_uuid(),$1,$2,$3,0,0,0,0,0,0,0,0,$4,$5,$6,5,0,
      'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$7,$8,$9,$10,$11,$12,$13,0,0,'SIGNED')`,
  [input.runId, input.currencyId, input.itemStatus, input.reasons,
    false, null,
    price?.resolutionId ?? null, price?.snapshotId ?? null, price?.provider ?? null,
    price?.priceUsd ?? null, price?.observedAt ?? null, price?.resolutionReason ?? null,
    price?.usedFallback ?? null]);
  await client.query(`UPDATE wallet_core_test.wallet_reconciliation_runs SET status=$2::text::wallet_core_test."WalletReconciliationRunStatus",currency_count=1,
    completed_at=clock_timestamp(),safe_error_code=CASE WHEN $2='FAILED' THEN 'LEDGER_UNAVAILABLE' ELSE NULL END WHERE id=$1`,[input.runId,input.runStatus]);
}
