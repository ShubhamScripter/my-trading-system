import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';

import { createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient, type WalletCorePool } from '../wallet-core.database.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import type { AdminBootstrapViewerInput, WalletLogoUrlResolver } from '../wallet-core.types.js';
import {
  createReconciliationPriceFixture,
  isolateReconciliationConfiguration,
} from './reconciliation-price-fixture.js';

const URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === URL;
const VIEWER: AdminBootstrapViewerInput = {
  adminId: '550e8400-e29b-41d4-a716-446655440400',
};
const ids = {
  chain: '019f0000-0000-7000-8000-000000000001',
  binding: '019f0000-0000-7000-8000-000000000002',
  hot: '019f0000-0000-7000-8000-000000000003',
  cold: '019f0000-0000-7000-8000-000000000004',
  stake: '019f0000-0000-7000-8000-000000000005',
  stakeReplacement: '019f0000-0000-7000-8000-00000000000e',
  live: '019f0000-0000-7000-8000-000000000006',
  draft: '019f0000-0000-7000-8000-000000000007',
  run: '019f0000-0000-7000-8000-000000000008',
  item: '019f0000-0000-7000-8000-000000000009',
  hotComponent: '019f0000-0000-7000-8000-00000000000a',
  coldComponent: '019f0000-0000-7000-8000-000000000010',
  stakeComponent: '019f0000-0000-7000-8000-00000000000b',
  binanceComponent: '019f0000-0000-7000-8000-00000000000c',
  alert: '019f0000-0000-7000-8000-00000000000d',
  pendingRun: '019f0000-0000-7000-8000-00000000000f',
} as const;
const scheduledId = (index: number) =>
  `019f0001-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

async function seed(client: pg.PoolClient) {
  const currencies = await client.query(`SELECT symbol,id::text FROM price_conversion_test.currencies
    WHERE symbol IN ('BTC','USD')`);
  const btc = currencies.rows.find((row) => row.symbol === 'BTC')!.id as string;
  await client.query(`UPDATE wallet_core_test.wallet_settings SET revision=500,
    global_desired_state='ON',catalogue_mode='ALL',include_treasury=true,
    include_collection=false,reconciliation_alert_percent=5.000,
    reconciliation_alert_basis='POSITIVE_ONLY',
    updated_at='2026-09-05T00:00:00.123456Z' WHERE id`);
  await isolateReconciliationConfiguration(client, currencies.rows.map((row) => row.id));
  await client.query(`INSERT INTO wallet_core_test.admin_preferences(admin_id,timezone)
    VALUES ($1,'Europe/London')`, [VIEWER.adminId]);
  await client.query(`UPDATE wallet_core_test.currency_settings SET binance_reference='BTCBIN',
    logo_object_key='currency/btc.webp',view_currency_enabled=true,desired_state='ON',
    price_readiness='HEALTHY',price_readiness_changed_at='2026-09-05T00:00:01.123456Z',
    policy_revision=40
    WHERE currency_id=$1`, [btc]);
  await client.query(`UPDATE wallet_core_test.custody_addresses SET retired_revision=40,
    retired_at=clock_timestamp() WHERE retired_at IS NULL AND currency_chain_id IN
    (SELECT id FROM wallet_core_test.currencies WHERE currency_id=$1)`, [btc]);
  await client.query(`INSERT INTO wallet_core_test.chains
    (id,provider_chain_id,short_name,name,is_evm,logo_object_key,desired_state,provider_state)
    VALUES ($1,99001,'BTCMAIN','Bitcoin Mainnet',false,'chain/btc.webp','ON','ACTIVATED')`,
  [ids.chain]);
  await client.query(`INSERT INTO wallet_core_test.currencies
    (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision,
     desired_state,provider_state) VALUES ($1,$2,$3,99002,false,true,18,'ON','ACTIVATED')`,
  [ids.binding, btc, ids.chain]);
  for (const [id, kind, address] of [[ids.hot, 'HOT', 'hot-wallet'],
    [ids.cold, 'COLD', 'cold-wallet'], [ids.stake, 'STAKING', 'stake-wallet']] as const) {
    await client.query(`INSERT INTO wallet_core_test.custody_addresses
      (id,currency_chain_id,kind,wallet_address,address_identity) VALUES ($1,$2,$3,$4,$4)`,
    [id, ids.binding, kind, address]);
  }
  await client.query(`INSERT INTO price_conversion_test.currency_provider_refs
    (currency_id,provider_id,external_id,symbol)
    SELECT $1,id,'bootstrap-'||lower(code::text),'BTC' FROM price_conversion_test.price_providers
    ON CONFLICT (currency_id,provider_id) DO NOTHING`,
  [btc]);
  const config = async (id: string, revision: number, status: 'LIVE' | 'SCHEDULED') => {
    await client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,reason,changelog,actor_id,snapshot)
      VALUES ($1,$2,'DRAFT','bootstrap configuration','safe changelog',$3,'{}')`,
    [id, revision, VIEWER.adminId]);
    await client.query(`UPDATE wallet_core_test.configuration_changes
      SET status=$2::wallet_core_test."WalletConfigurationStatus",
      effective_at=CASE WHEN $2::text='SCHEDULED' THEN $3::timestamptz END,
      applied_at=CASE WHEN $2::text='LIVE' THEN $3::timestamptz END WHERE id=$1`,
    [id, status, `2027-01-01T00:${String(revision % 60).padStart(2, '0')}:00.123456Z`]);
  };
  await config(ids.live, 40, 'LIVE');
  for (let index = 1; index <= 101; index += 1) await config(
    scheduledId(index), 100 + index, 'SCHEDULED');
  await client.query(`INSERT INTO wallet_core_test.configuration_changes
    (id,revision,status,reason,changelog,actor_id,snapshot)
    VALUES ($1,500,'DRAFT','saved draft',NULL,$2,'{}')`, [ids.draft, VIEWER.adminId]);
  const price = await createReconciliationPriceFixture(client, btc);
  await client.query(`INSERT INTO wallet_core_test.cronjob_runs
    (id,job_name,scheduled_for,worker_instance_id,status)
    VALUES ($1,'wallet-reconciliation','2026-09-05T03:30:00.123456Z','bootstrap-worker','RUNNING')`,
  [ids.run]);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_runs
    (id,status,scheduled_for,valuation_at,applied_reconciliation_alert_percent,
     applied_configuration_revision,comparison_rule,currency_count,warning_count,completed_at,created_at,
     expected_currency_count,include_treasury,include_collection,applied_reconciliation_alert_basis)
    VALUES ($1,NULL,'2026-09-05T03:30:00.123456Z',$2,5,40,
      'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',0,0,NULL,
      GREATEST(clock_timestamp(),(SELECT max(created_at)+interval '1 microsecond'
        FROM wallet_core_test.wallet_reconciliation_runs)),1,true,false,'POSITIVE_ONLY')`,
  [ids.run, price.valuationAt]);
  await client.query(`INSERT INTO wallet_core_test.state_events
    (id,event_type,subject_type,subject_id,run_id,payload) VALUES
    (gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',$1,$2,$3)`,
  [btc, ids.run, { binanceReference: 'BTCBIN', userMerchant: '-2', userMerchantPositive: '3',
    treasury: '0', collection: '0', price: { resolutionId: price.resolutionId,
      snapshotId: price.snapshotId, provider: price.provider, priceUsd: price.priceUsd,
      observedAt: price.observedAt, resolutionReason: price.resolutionReason,
      usedFallback: price.usedFallback } }]);
  await client.query(`INSERT INTO wallet_core_test.state_events
    (id,event_type,subject_type,subject_id,run_id,payload)
    SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',binding.id,$2,
      jsonb_build_object('currencyId',master.id,'chainShortName',chain.short_name,
        'currencyName',master.name,'blockchainPrecision',binding.blockchain_precision,
        'isToken',binding.is_token,'isNative',binding.is_native)
    FROM wallet_core_test.currencies binding JOIN wallet_core_test.chains chain ON chain.id=binding.chain_id
    JOIN price_conversion_test.currencies master ON master.id=binding.currency_id
    WHERE binding.currency_id=$1`, [btc, ids.run]);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
    (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
     total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
     collection_balance,ledger_signed_total,ledger_positive_total,
     applied_reconciliation_alert_basis,partial_reasons,shortfall_suppressed,shortfall_percent,
     applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
     price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
     price_resolution_reason,price_used_fallback)
    VALUES ($1,$2,$3,'PARTIAL',1.123456789123456789,5,3.333333333333333333,
      9.456790122456790122,3,-2,0,0,-2,3,'POSITIVE_ONLY',
      ARRAY['STAKING_TOTAL_MISMATCH'],false,0,5,40,
      'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$4,$5,$6,$7,$8,$9,$10)`,
  [ids.item, ids.run, btc, price.resolutionId, price.snapshotId, price.provider,
    price.priceUsd, price.observedAt, price.resolutionReason, price.usedFallback]);
  const component = async (id: string, kind: string, address: string | null, amount: string) => {
    if (kind === 'BINANCE') await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
      (id,run_item_id,kind,binance_reference,attempts_used,accepted_raw_decimal,selected_balance)
      VALUES ($1,$2,'BINANCE','BTCBIN',1,$3::text,$3::numeric)`, [id, ids.item, amount]);
    else if (kind === 'STAKING') await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
      (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
       accepted_raw_decimal,selected_balance,total_admin_stake_balance,
       total_admin_manual_stake_balance,total_balance,stake_selected_source,stake_total_mismatch)
      VALUES ($1,$2,'STAKING',$3,$4,1,'99',$5::numeric,2,3,99,'COMPONENT_SUM',true)`,
    [id, ids.item, ids.binding, address, amount]);
    else await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_components
      (id,run_item_id,kind,currency_chain_id,custody_address_id,attempts_used,
       accepted_raw_decimal,selected_balance) VALUES ($1,$2,$3,$4,$5,1,$6::text,$6::numeric)`,
    [id, ids.item, kind, ids.binding, address, amount]);
    await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_attempts
      (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome)
      VALUES (gen_random_uuid(),$1,1,0,'BALANCE','SUCCESS')`, [id]);
  };
  await component(ids.hotComponent, 'HOT', ids.hot, '1.123456789123456789');
  await component(ids.coldComponent, 'COLD', ids.cold, '0');
  await component(ids.stakeComponent, 'STAKING', ids.stake, '5');
  await component(ids.binanceComponent, 'BINANCE', null, '3.333333333333333333');
  await client.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=41 WHERE currency_id=$1`, [btc]);
  await client.query(`UPDATE wallet_core_test.custody_addresses
    SET retired_revision=41,retired_at=clock_timestamp() WHERE id=$1`, [ids.stake]);
  await client.query(`INSERT INTO wallet_core_test.custody_addresses
    (id,currency_chain_id,kind,wallet_address,address_identity)
    VALUES ($1,$2,'STAKING','rotated-stake-wallet','rotated-stake-wallet')`,
  [ids.stakeReplacement, ids.binding]);
  await client.query(`UPDATE wallet_core_test.wallet_reconciliation_runs SET status='PARTIAL',
    currency_count=1,warning_count=0,completed_at=created_at WHERE id=$1`,
  [ids.run]);
  await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='PARTIAL',
    safe_error_code='RECONCILIATION_PARTIAL',lease_expires_at=NULL,finished_at=clock_timestamp()
    WHERE id=$1`, [ids.run]);
  const alertPayload = { runId: ids.run, itemId: ids.item, currencyId: btc,
    partialReasons: ['STAKING_TOTAL_MISMATCH'], shortfallSuppressed: false };
  await client.query(`INSERT INTO wallet_core_test.wallet_alerts
    (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
    VALUES ($1,'bootstrap-alert','PARTIAL_DATA','ACTIVE',$2,$3,
      '2026-09-05T03:31:00.123456Z','2026-09-05T03:31:01.123456Z')`,
  [ids.alert, btc, alertPayload]);
  await client.query(`INSERT INTO wallet_core_test.cronjob_runs
    (id,job_name,scheduled_for,worker_instance_id,status)
    VALUES ($1,'wallet-reconciliation','2026-09-06T03:30:00.123456Z','pending-worker','RUNNING')`,
  [ids.pendingRun]);
  await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_runs
    (id,status,scheduled_for,applied_reconciliation_alert_percent,applied_configuration_revision,
     comparison_rule,expected_currency_count,include_treasury,include_collection,
     applied_reconciliation_alert_basis)
    VALUES ($1,NULL,'2026-09-06T03:30:00.123456Z',5,40,
      'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',1,true,false,'POSITIVE_ONLY')`,
  [ids.pendingRun]);
  await client.query(`INSERT INTO wallet_core_test.state_events
    (id,event_type,subject_type,subject_id,run_id,payload) VALUES
    (gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',$1,$2,$3)`,
  [btc, ids.pendingRun, { binanceReference: 'BTCBIN', userMerchant: '0',
    userMerchantPositive: '0', treasury: '0', collection: '0', price: null }]);
  await client.query(`INSERT INTO wallet_core_test.state_events
    (id,event_type,subject_type,subject_id,run_id,payload)
    SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',binding.id,$2,
      jsonb_build_object('currencyId',master.id,'chainShortName',chain.short_name,
        'currencyName',master.name,'blockchainPrecision',binding.blockchain_precision,
        'isToken',binding.is_token,'isNative',binding.is_native)
    FROM wallet_core_test.currencies binding JOIN wallet_core_test.chains chain ON chain.id=binding.chain_id
    JOIN price_conversion_test.currencies master ON master.id=binding.currency_id
    WHERE binding.currency_id=$1`, [btc, ids.pendingRun]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
}

const READ_ONLY = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
class SeededClient implements WalletCoreClient {
  private count = 0;
  constructor(private readonly client: pg.PoolClient, private readonly released: () => void,
    readonly calls: string[], private readonly failAt: number | null,
    private readonly corruptAlert: 'CURRENCY_ID' | 'PARTIAL_REASON' | false) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) {
    this.calls.push(sql); this.count += 1;
    if (this.count === this.failAt) throw new Error(`BOOTSTRAP_DB_FAIL_${this.count}`);
    if (sql === READ_ONLY) { const result = await this.client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await seed(this.client);
      if (this.corruptAlert === 'CURRENCY_ID') await this.client.query(`UPDATE wallet_core_test.wallet_alerts
        SET payload=jsonb_set(payload,'{currencyId}',to_jsonb($1::text)),
        updated_at=updated_at+interval '1 microsecond' WHERE id=$2`, [ids.chain, ids.alert]);
      return { rows: result.rows as Row[], rowCount: result.rowCount }; }
    if (sql === 'COMMIT') { const result = await this.client.query('ROLLBACK');
      return { rows: result.rows as Row[], rowCount: result.rowCount }; }
    const result = await this.client.query(sql, values as unknown[]);
    if (this.corruptAlert === 'PARTIAL_REASON'
      && /FROM\s+wallet_core_test\.wallet_alerts WHERE status='ACTIVE'/.test(sql)) {
      const rows = result.rows.map((row) => ({ ...row,
        payload: { ...row.payload, partialReasons: ['UNKNOWN_PARTIAL_REASON'] } }));
      return { rows: rows as Row[], rowCount: result.rowCount };
    }
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release() { this.released(); this.client.release(); }
}
class SeededPool implements WalletCorePool {
  releases = 0; readonly calls: string[] = [];
  constructor(readonly pool: pg.Pool, private readonly failAt: number | null = null,
    private readonly corruptAlert: 'CURRENCY_ID' | 'PARTIAL_REASON' | false = false) {}
  async connect() { return new SeededClient(await this.pool.connect(),
    () => { this.releases += 1; }, this.calls, this.failAt, this.corruptAlert); }
  async end() { await this.pool.end(); }
}
const logo: WalletLogoUrlResolver = {
  publicUrl: (key) => `https://assets.test.invalid/wallet/${encodeURIComponent(key)}`,
};

describe('Wallet Core Task 4 bootstrap repository', { skip: !LIVE }, () => {
  it('keeps reconciliation address evidence unchanged after a custody address rotates', async () => {
    const pool = new SeededPool(new pg.Pool({ connectionString: URL, max: 1 }));
    try {
      const repository = new WalletCoreBootstrapRepository(createValidatedWalletCoreTestDatabase(
        pool, WALLET_CORE_TEST_SCHEMAS), logo);
      const result = await repository.bootstrap({limit:100},VIEWER);
      const evidence = result.lastReconciliation?.items.flatMap(item => item.anomalousComponents)
        .find(component => component.id===ids.stakeComponent);
      assert.equal(evidence?.walletAddress,'stake-wallet');
    } finally { await pool.end(); }
  });
  it('returns one safe repeatable snapshot with pagination, evidence, and distribution', async () => {
    const pool = new SeededPool(new pg.Pool({ connectionString: URL, max: 2 }));
    const repository = new WalletCoreBootstrapRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS), logo);
    try {
      const first = await repository.bootstrap({ limit: 100 }, VIEWER);
      assert.deepEqual(Object.keys(first), ['currentRevision', 'settings', 'configuration',
        'chains', 'currencies', 'activeAlerts', 'lastReconciliation', 'viewer']);
      assert.equal(pool.calls[0], 'BEGIN'); assert.equal(pool.calls[1], READ_ONLY);
      assert.equal(first.currentRevision, '500');
      assert.equal(first.settings.reconciliationAlertBasis, 'POSITIVE_ONLY');
      assert.deepEqual(first.viewer, { displayTimezone: 'Europe/London' });
      assert.equal(first.configuration.live?.id, ids.live);
      assert.equal('draft' in first.configuration, false);
      assert.equal(first.configuration.scheduled.items.length, 50);
      assert.equal(first.configuration.scheduled.total, 101);
      assert.ok(first.configuration.scheduled.nextCursor);
      assert.ok(first.configuration.scheduled.items[0]!.effectiveAt!
        <= first.configuration.scheduled.items.at(-1)!.effectiveAt!);
      const chain = first.chains.find(({ id }) => id === ids.chain);
      assert.equal(chain?.logo?.url,
        'https://assets.test.invalid/wallet/chain%2Fbtc.webp');
      const btcView = first.currencies.items.find(({ symbol }) => symbol === 'BTC');
      assert.equal(btcView?.effectiveState, 'ON');
      const binding = btcView?.bindings.find(({ id }) => id === ids.binding);
      assert.equal(binding?.effectiveState, 'ON');
      assert.deepEqual(binding?.hotWalletAddresses, ['hot-wallet']);
      assert.deepEqual(binding?.coldWalletAddresses, ['cold-wallet']);
      assert.deepEqual(binding?.stakingWalletAddresses, ['rotated-stake-wallet']);
      assert.equal(btcView?.providerReferences.length, 3);
      assert.deepEqual(btcView?.providerReferences.map((entry) => entry.provider),
        ['ALCHEMY', 'COINGECKO', 'COINMARKETCAP']);
      const alert = first.activeAlerts.items.find(({ id }) => id === ids.alert);
      assert.equal(alert?.category, 'PARTIAL_DATA');
      assert.deepEqual(alert?.payload, {
        runId: ids.run, itemId: ids.item,
        currencyId: btcView?.id,
        partialReasons: ['STAKING_TOTAL_MISMATCH'], shortfallSuppressed: false,
      });
      assert.equal(first.lastReconciliation?.items[0]?.anomalousComponents[0]?.id,
        ids.stakeComponent);
      assert.equal(first.lastReconciliation?.items[0]?.anomalousComponents[0]?.walletAddress, 'stake-wallet');
      assert.equal(first.lastReconciliation?.run.id, ids.run);
      assert.equal(first.lastReconciliation?.run.appliedConfigurationRevision, '40');
      assert.equal(first.lastReconciliation?.run.appliedAlertBasis, 'POSITIVE_ONLY');
      assert.deepEqual(first.lastReconciliation?.items[0] && {
        ledgerSignedTotal: first.lastReconciliation.items[0].ledgerSignedTotal,
        ledgerSignedTotalUsd: first.lastReconciliation.items[0].ledgerSignedTotalUsd,
        ledgerPositiveTotal: first.lastReconciliation.items[0].ledgerPositiveTotal,
        ledgerPositiveTotalUsd: first.lastReconciliation.items[0].ledgerPositiveTotalUsd,
        alertBasis: first.lastReconciliation.items[0].alertBasis,
      }, { ledgerSignedTotal: '-2', ledgerSignedTotalUsd: '-246.91',
        ledgerPositiveTotal: '3', ledgerPositiveTotalUsd: '370.37',
        alertBasis: 'POSITIVE_ONLY' });
      assert.deepEqual(first.lastReconciliation?.items[0]?.evidenceSummary.componentCounts, {
        HOT: { total: 1, succeeded: 1, failed: 0 },
        COLD: { total: 1, succeeded: 1, failed: 0 },
        STAKING: { total: 1, succeeded: 1, failed: 0 },
        BINANCE: { total: 1, succeeded: 1, failed: 0 },
      });
      assert.equal(first.lastReconciliation?.distribution.currencies[0]?.price?.provider,
        'COINGECKO');
      assert.equal(first.lastReconciliation?.distribution.currencies[0]?.price?.priceUsd, '123.45');
      assert.equal(first.lastReconciliation?.distribution.currencies[0]
        ?.blockchainWallets.cryptoAmount, '1.12345678');
      assert.equal(first.lastReconciliation?.distribution.overall.status, 'PARTIAL');
      assert.equal(first.lastReconciliation?.distribution.overall.totalUsd, null);
      const page = await repository.bootstrap({ limit: 1 }, VIEWER);
      assert.ok(page.currencies.nextCursor);
      assert.deepEqual(page.lastReconciliation?.items.map(({ id }) => id), [ids.item]);
      const second = await repository.bootstrap({ limit: 1,
        cursor: page.currencies.nextCursor }, { ...VIEWER, adminId: crypto.randomUUID() });
      assert.notEqual(second.currencies.items[0]?.id, page.currencies.items[0]?.id);
      assert.deepEqual(second.lastReconciliation?.items, []);
      assert.equal(second.viewer.displayTimezone, 'Asia/Kolkata');
      const defaulted = await repository.bootstrap({} as never, VIEWER);
      assert.ok(defaulted.currencies.items.length > 0 && defaulted.currencies.items.length <= 50);
      assert.equal(pool.releases, 4);
      assert.equal(JSON.stringify(first).includes('bootstrap-alert'), false);
      assert.equal(JSON.stringify(first).includes('address_identity'), false);
    } finally { await pool.end(); }
  });

  it('aggregates component counts in SQL and materializes only anomalies', async () => {
    const pool = new SeededPool(new pg.Pool({ connectionString: URL, max: 1 }));
    try {
      const repository = new WalletCoreBootstrapRepository(createValidatedWalletCoreTestDatabase(
        pool, WALLET_CORE_TEST_SCHEMAS), logo);
      await repository.bootstrap({ limit: 100 }, VIEWER);
      const queries = pool.calls.filter((sql) =>
        /FROM wallet_core_test\.wallet_reconciliation_components component/.test(sql)
        && /run_item_id=ANY\(\$1::uuid\[\]\)/.test(sql));
      assert.equal(queries.length, 2);
      assert.ok(queries.some((sql) => /GROUP BY component\.run_item_id,component\.kind/.test(sql)));
      assert.ok(queries.some((sql) =>
        /component\.selected_balance IS NULL\s+OR\s+component\.stake_total_mismatch/.test(sql)));
    } finally { await pool.end(); }
  });

  it('rejects invalid input before connect and rolls back mapping failures', async () => {
    const raw = new SeededPool(new pg.Pool({ connectionString: URL, max: 1 }));
    const database = createValidatedWalletCoreTestDatabase(raw, WALLET_CORE_TEST_SCHEMAS);
    try {
      const repository = new WalletCoreBootstrapRepository(database, logo);
      await assert.rejects(() => repository.bootstrap({ limit: 0 }, VIEWER),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.bootstrap({ limit: 1, extra: true } as never, VIEWER),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.bootstrap({ limit: 1 },
        { ...VIEWER, extra: true } as never), WalletConfigurationInvalid);
      assert.equal(raw.calls.length, 0);
      await assert.rejects(() => new WalletCoreBootstrapRepository(database, {
        publicUrl() { throw new Error('LOGO_MAP_FAILED'); },
      }).bootstrap({ limit: 1 }, VIEWER), /LOGO_MAP_FAILED/);
      assert.equal(raw.calls.at(-1), 'ROLLBACK');
      assert.equal(raw.releases, 1);
      const corrupt = new SeededPool(raw.pool, null, 'CURRENCY_ID');
      await assert.rejects(() => new WalletCoreBootstrapRepository(
        createValidatedWalletCoreTestDatabase(corrupt, WALLET_CORE_TEST_SCHEMAS), logo)
        .bootstrap({ limit: 1 }, VIEWER), /WALLET_ALERT_ROW_INVALID/);
      assert.equal(corrupt.calls.at(-1), 'ROLLBACK');
      assert.equal(corrupt.releases, 1);
      const unknownReason = new SeededPool(raw.pool, null, 'PARTIAL_REASON');
      await assert.rejects(() => new WalletCoreBootstrapRepository(
        createValidatedWalletCoreTestDatabase(unknownReason, WALLET_CORE_TEST_SCHEMAS), logo)
        .bootstrap({ limit: 1 }, VIEWER), /WALLET_ALERT_ROW_INVALID/);
      assert.equal(unknownReason.calls.at(-1), 'ROLLBACK');
      assert.equal(unknownReason.releases, 1);
    } finally { await raw.end(); }
  });

  it('rolls back and releases at every repository query failure position', async () => {
    const raw = new pg.Pool({ connectionString: URL, max: 2 });
    try {
      const baseline = new SeededPool(raw);
      await new WalletCoreBootstrapRepository(createValidatedWalletCoreTestDatabase(
        baseline, WALLET_CORE_TEST_SCHEMAS), logo).bootstrap({ limit: 1 }, VIEWER);
      const positions = baseline.calls.length;
      assert.ok(positions >= 14);
      for (let at = 1; at <= positions; at += 1) {
        const failing = new SeededPool(raw, at);
        await assert.rejects(() => new WalletCoreBootstrapRepository(
          createValidatedWalletCoreTestDatabase(failing, WALLET_CORE_TEST_SCHEMAS), logo)
          .bootstrap({ limit: 1 }, VIEWER), new RegExp(`BOOTSTRAP_DB_FAIL_${at}`));
        assert.equal(failing.releases, 1, `release at query ${at}`);
        if (at > 1) assert.equal(failing.calls.at(-1), 'ROLLBACK', `rollback at query ${at}`);
      }
    } finally { await raw.end(); }
  });
});
