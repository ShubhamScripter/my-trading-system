import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import {
  captureReconciliationFixture,
  createReconciliationPriceFixture,
  isolateReconciliationConfiguration,
} from './reconciliation-price-fixture.js';

const root = resolve(__dirname, '..');
const migrationPath = resolve(root, 'migrations/20260903000000_wallet_core_expand/migration.sql');
const schemaPath = resolve(root, 'schema.prisma');
const envPath = resolve(root, '.env.example');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const CATALOGUE_CODES = ['PROVIDER_REJECTED', 'TIMEOUT', 'TRANSPORT_ERROR',
  'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'CATALOGUE_LIMIT_EXCEEDED',
  'PAGINATION_INCONSISTENT', 'DUPLICATE_PROVIDER_ID', 'WRONG_CHAIN_ASSOCIATION',
  'DATABASE_ERROR', 'AUDIT_ERROR'] as const;

it('pins minimal reconciliation valuation and three closed safe alert shapes', async () => {
  const [sql, schema, env] = await Promise.all([
    readFile(migrationPath, 'utf8'), readFile(schemaPath, 'utf8'), readFile(envPath, 'utf8'),
  ]);
  assert.doesNotMatch(sql, /catalogue_visible/i);
  assert.doesNotMatch(schema, /catalogueVisible|catalogue_visible/);
  assert.match(sql, /catalogue_mode wallet_core\."WalletCatalogueMode" NOT NULL DEFAULT 'ALL'/);
  assert.match(schema, /catalogueMode\s+WalletCatalogueMode\s+@default\(ALL\)/);
  assert.match(sql, /'INVALID_DECIMAL'\s*,\s*'PRICE_UNAVAILABLE'/);
  assert.match(schema, /enum WalletReconciliationSafeErrorCode \{[\s\S]*PRICE_UNAVAILABLE/);
  assert.match(sql, /valuation_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(schema, /valuationAt\s+DateTime\s+@default\(now\(\)\)[^\n]*@db\.Timestamptz\(6\)/);
  for (const name of ['price_resolution_id', 'price_snapshot_id', 'price_provider',
    'price_usd', 'price_observed_at', 'price_resolution_reason', 'price_used_fallback']) {
    assert.match(sql, new RegExp(`\\b${name}\\b`), name);
  }
  assert.match(sql, /num_nonnulls\(price_resolution_id,price_snapshot_id,price_provider,\s*price_usd,price_observed_at,price_resolution_reason,price_used_fallback\) IN \(0,7\)/);
  assert.match(sql, /CREATE FUNCTION wallet_core\.validate_reconciliation_price_evidence/);
  assert.match(sql, /price_conversion\.price_resolutions/);
  assert.match(sql, /price_conversion\.price_snapshots/);
  assert.match(sql, /price_conversion\.price_providers/);
  assert.match(sql, /FALLBACK_PRIMARY_FAILED[\s\S]*FALLBACK_DIVERGENCE/);
  assert.doesNotMatch(sql, /(?:custody|required_backing|shortfall)_usd|usd_(?:total|value|balance)/i);
  const alertGuard = /CREATE FUNCTION wallet_core\.validate_wallet_alert_payload\(\)[\s\S]*?\$\$;/.exec(sql)?.[0];
  assert.ok(alertGuard);
  for (const category of ['SHORTFALL', 'PARTIAL_DATA', 'STAKING_TOTAL_MISMATCH']) {
    assert.match(alertGuard, new RegExp(`NEW\\.category = '${category}'`));
  }
  for (const rawKey of ['rawBody', 'stack', 'url', 'hmac', 'ciphertext', 'providerPayload']) {
    assert.doesNotMatch(alertGuard, new RegExp(`'${rawKey}'`, 'i'));
  }
  const sqlCodes = /WalletCatalogueRefreshErrorCode" AS ENUM \(([^)]*)\)/
    .exec(sql)?.[1]?.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1));
  const prismaCodes = /enum WalletCatalogueRefreshErrorCode \{([\s\S]*?)@@schema/
    .exec(schema)?.[1]?.trim().split(/\s+/);
  assert.deepEqual(sqlCodes, CATALOGUE_CODES);
  assert.deepEqual(prismaCodes, CATALOGUE_CODES);
  assert.match(alertGuard, /NEW\.category = 'CATALOGUE_REFRESH_FAILED'[\s\S]*?ARRAY\['failedAt','safeErrorCode'\]/);
  assert.match(alertGuard, /WalletCatalogueRefreshErrorCode/);
  for (const entry of [
    'WALLET_CATALOGUE_MAX_CHAINS=100', 'WALLET_CATALOGUE_MAX_COINS_PER_CHAIN=2000',
    'WALLET_CATALOGUE_MAX_COINS_PER_REFRESH=10000',
    'WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES=2097152',
    'WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES=67108864',
  ]) assert.ok(env.split(/\r?\n/).includes(entry), entry);
});

let savepoint = 0;
async function rejects(client: pg.PoolClient, action: () => Promise<unknown>, pattern: RegExp) {
  const name = `valuation_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try { await assert.rejects(action, pattern); }
  finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}
async function accepts(client: pg.PoolClient, action: () => Promise<unknown>) {
  const name = `valuation_${++savepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  try { await action(); }
  finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

describe('Wallet Core valuation and alert database boundaries', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(() => { pool = new pg.Pool({ connectionString: TEST_URL, max: 2 }); });
  after(async () => { await pool?.end(); });

  it('accepts only complete canonical Price provenance or explicit PRICE_UNAVAILABLE', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currency = (await client.query(`SELECT id FROM price_conversion_test.currencies
        WHERE symbol='BTC'`)).rows[0].id;
      const price = await createReconciliationPriceFixture(client, currency);
      await isolateReconciliationConfiguration(client, [currency]);
      const run = randomUUID();
      await captureReconciliationFixture(client, run, currency, price);
      const insert = (overrides: Record<string, unknown> = {}) => {
        const value = { runId: run, resolution: price.resolutionId, snapshot: price.snapshotId,
          provider: price.provider, price: price.priceUsd, observedAt: price.observedAt,
          reason: price.resolutionReason, fallback: price.usedFallback,
          reasons: ['TIMEOUT'], ...overrides };
        return client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
          (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
           total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
           collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
           applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
           price_resolution_id,price_snapshot_id,price_provider,price_usd,price_observed_at,
           price_resolution_reason,price_used_fallback,ledger_signed_total,
           ledger_positive_total,applied_reconciliation_alert_basis)
          VALUES (gen_random_uuid(),$1,$2,'PARTIAL',0,0,0,0,0,0,0,0,$3,true,NULL,
            5,0,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$4,$5,$6,$7,$8,$9,$10,
            0,0,'SIGNED')`,
        [value.runId, currency, value.reasons, value.resolution, value.snapshot, value.provider,
          value.price, value.observedAt, value.reason, value.fallback]);
      };
      await accepts(client, () => insert());
      for (const [name, override] of [
        ['partial tuple', { snapshot: null }], ['wrong resolution', { resolution: randomUUID() }],
        ['wrong snapshot', { snapshot: randomUUID() }], ['wrong provider', { provider: 'ALCHEMY' }],
        ['wrong price', { price: '1.000000000000000000' }],
        ['wrong observed', { observedAt: new Date(0) }], ['wrong reason', { reason: 'RECOVERED' }],
        ['wrong fallback', { fallback: true }],
      ] as const) await rejects(client, () => insert(override), /price|foreign key|all present/i);
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='FAILED',
        safe_error_code='DEPENDENCY_UNAVAILABLE',lease_expires_at=NULL,
        finished_at=clock_timestamp() WHERE id=$1`, [run]);
      const unpricedRun = randomUUID();
      await captureReconciliationFixture(client, unpricedRun, currency, null);
      await accepts(client, () => insert({ runId: unpricedRun,
        resolution: null, snapshot: null, provider: null,
        price: null, observedAt: null, reason: null, fallback: null,
        reasons: ['PRICE_UNAVAILABLE'] }));
      await rejects(client, () => insert({ runId: unpricedRun,
        resolution: null, snapshot: null, provider: null,
        price: null, observedAt: null, reason: null, fallback: null }),
      /PRICE_UNAVAILABLE|check constraint/i);
      await rejects(client, () => insert({ reasons: ['PRICE_UNAVAILABLE'] }),
        /PRICE_UNAVAILABLE|check constraint/i);
      assert.equal((await client.query(`SELECT 'PRICE_UNAVAILABLE'::wallet_core_test.
        "WalletReconciliationSafeErrorCode" code`)).rows[0].code, 'PRICE_UNAVAILABLE');
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  it('accepts exact safe alert payloads and rejects extra, raw, or mistyped values', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currency = (await client.query(`SELECT id FROM price_conversion_test.currencies
        WHERE symbol='BTC'`)).rows[0].id;
      const id = () => randomUUID();
      const payloads = {
        SHORTFALL: { runId: id(), itemId: id(), currencyId: currency,
          custodyBalance: '1.000000000000000000',
          requiredBacking: '2.000000000000000000', shortfallPercent: '50.000000000000000000',
          thresholdPercent: '5.000' },
        PARTIAL_DATA: { runId: id(), itemId: id(), currencyId: currency,
          partialReasons: ['TIMEOUT', 'PRICE_UNAVAILABLE'], shortfallSuppressed: true },
        STAKING_TOTAL_MISMATCH: { runId: id(), itemId: id(), componentId: id(),
          currencyId: currency, reportedTotal: '3.000000000000000000',
          componentSum: '2.000000000000000000', selectedSource: 'COMPONENT_SUM' },
      } as const;
      for (const [category, payload] of Object.entries(payloads)) {
        const alert = id();
        await client.query(`INSERT INTO wallet_core_test.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at)
          VALUES ($1,$2,$3,'ACTIVE',$4,$5,now())`, [alert, `${category}:${alert}`, category,
          currency, payload]);
        await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
          (id,alert_id,category,status,payload) VALUES ($1,$2,$3,'ACTIVE',$4)`,
        [id(), alert, category, payload]);
      }
      const catalogue = { safeErrorCode: 'TIMEOUT', failedAt: '2026-09-05T09:00:00.000000Z' };
      const catalogueAlert = id();
      await client.query(`INSERT INTO wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at)
        VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',NULL,$3,now())`,
      [catalogueAlert, `CATALOGUE:${catalogueAlert}`, catalogue]);
      await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
        (id,alert_id,category,status,payload) VALUES
        ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',$3)`, [id(), catalogueAlert, catalogue]);
      const invalid = [
        ['extra', 'SHORTFALL', { ...payloads.SHORTFALL, rawBody: 'secret' }],
        ['decimal', 'SHORTFALL', { ...payloads.SHORTFALL, shortfallPercent: '1.0' }],
        ['threshold', 'SHORTFALL', { ...payloads.SHORTFALL, thresholdPercent: 5 }],
        ['reason', 'PARTIAL_DATA', { ...payloads.PARTIAL_DATA, partialReasons: ['RAW_ERROR'] }],
        ['boolean', 'PARTIAL_DATA', { ...payloads.PARTIAL_DATA, shortfallSuppressed: 'true' }],
        ['uuid', 'STAKING_TOTAL_MISMATCH', { ...payloads.STAKING_TOTAL_MISMATCH,
          componentId: 'not-a-uuid' }],
      ] as const;
      for (const [name, category, payload] of invalid) await rejects(client,
        () => client.query(`INSERT INTO wallet_core_test.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at)
          VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3,$4,now())`,
        [`invalid:${name}:${id()}`, category, currency, payload]), /alert payload/i);
      for (const [name, payload, alertCurrency] of [
        ['code', { ...catalogue, safeErrorCode: 'ENCRYPTION_FAILED' }, null],
        ['extra', { ...catalogue, rawBody: 'secret' }, null],
        ['offset', { ...catalogue, failedAt: '2026-09-05T14:30:00+05:30' }, null],
        ['date', { ...catalogue, failedAt: '2026-13-05T09:00:00Z' }, null],
        ['type', { ...catalogue, failedAt: 1 }, null],
        ['currency', catalogue, currency],
      ] as const) await rejects(client, () => client.query(`INSERT INTO
        wallet_core_test.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at)
        VALUES (gen_random_uuid(),$1,'CATALOGUE_REFRESH_FAILED','ACTIVE',$2,$3,now())`,
      [`invalid:catalogue:${name}:${id()}`, alertCurrency, payload]), /alert payload|check constraint/i);
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });

  it('stores null shortfall for zero liability and requires a value for positive backing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currency = (await client.query(`SELECT id FROM price_conversion_test.currencies
        WHERE symbol='BTC'`)).rows[0].id;
      await client.query(`UPDATE wallet_core_test.wallet_settings
        SET reconciliation_alert_percent=reconciliation_alert_percent WHERE id`);
      await isolateReconciliationConfiguration(client, [currency]);
      const run = randomUUID();
      await captureReconciliationFixture(client, run, currency, null);
      await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='FAILED',
        safe_error_code='DEPENDENCY_UNAVAILABLE',lease_expires_at=NULL,
        finished_at=clock_timestamp() WHERE id=$1`, [run]);
      const positiveRun = randomUUID();
      await captureReconciliationFixture(client, positiveRun, currency, null,
        { signed: '1', positive: '1' });
      const insert = (runId: string, custody: string, backing: string, percent: string | null) =>
        client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_items
          (id,run_id,currency_id,status,hot_cold_balance,staking_balance,binance_balance,
           total_custody_balance,required_backing,user_merchant_balance,treasury_balance,
            collection_balance,partial_reasons,shortfall_suppressed,shortfall_percent,
            applied_reconciliation_alert_percent,applied_configuration_revision,comparison_rule,
            ledger_signed_total,ledger_positive_total,applied_reconciliation_alert_basis)
          VALUES (gen_random_uuid(),$1,$2,'PARTIAL',$3,0,0,$3,$4,$4,0,0,
             ARRAY['PRICE_UNAVAILABLE'],false,$5,5,0,
             'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',$4,$4,'SIGNED')`,
        [runId, currency, custody, backing, percent]);
      await accepts(client, () => insert(run, '0', '0', null));
      await rejects(client, () => insert(run, '0', '0', '0.000000000000000000'),
        /check constraint/i);
      await rejects(client, () => insert(positiveRun, '0', '1', null),
        /reconciliation item Ledger capture mismatch/i);
      await accepts(client, () => insert(positiveRun, '1', '1', '0.000000000000000000'));
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  });
});
