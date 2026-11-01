import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';

import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../../admin-audits/index.js';
import { WalletConfigurationWorker } from '../configuration-worker.js';
import { WalletCronjobRepository, type WalletCronjobLease } from '../cronjob.repository.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import type { WalletCoreConfigurationPatch } from '../wallet-core.types.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };

class Client implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void { this.client.release(); }
}

class Pool implements WalletCorePool {
  constructor(readonly pool: pg.Pool) {}
  async connect(): Promise<WalletCoreClient> { return new Client(await this.pool.connect()); }
  async end(): Promise<void> { await this.pool.end(); }
}

class CountingCronjobs extends WalletCronjobRepository {
  renewWithClientCalls = 0;
  override renewWithClient(client: WalletCoreClient, lease: WalletCronjobLease) {
    this.renewWithClientCalls += 1;
    return super.renewWithClient(client, lease);
  }
}

class Audit implements AdminAuditPort {
  readonly calls: WalletCoreAdminAuditInput[] = [];
  private failed = false;
  constructor(private readonly failFirst: boolean) {}
  async appendWithTransaction(_tx: unknown, input: WalletCoreAdminAuditInput) {
    this.calls.push(input);
    if (this.failFirst && !this.failed) {
      this.failed = true;
      throw new Error('TASK7_AUDIT_FAILURE');
    }
    return { id: uuidv7(), replayed: false };
  }
}

function uuidv7(): string {
  const chars = randomUUID().split('');
  chars[14] = '7'; chars[19] = '8';
  return chars.join('');
}

function fixture() {
  const key = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const providerChainId = 1_000_000 + randomInt(100_000_000);
  const providerCoinId = providerChainId + 1;
  const ids = { chain: uuidv7(), currency: uuidv7(), binding: uuidv7(),
    invalidChange: uuidv7(), validChange: uuidv7() };
  const hotWalletAddresses = Array.from({ length: 10_000 }, (_value, index) =>
    `0x${index.toString(16).padStart(40, '0').toUpperCase()}`);
  const config = {
    currencies: [{
      id: ids.currency, symbol: `T${key.slice(0, 7)}`, name: `Task 7 ${key}`,
      providerRefs: [
        { provider: 'COINGECKO', providerAssetId: `task7-gecko-${key}`, providerSymbol: `T${key.slice(0, 7)}` },
        { provider: 'ALCHEMY', providerAssetId: `task7-alchemy-${key}`, providerSymbol: `T${key.slice(0, 7)}` },
        { provider: 'COINMARKETCAP', providerAssetId: `task7-cmc-${key}`, providerSymbol: `T${key.slice(0, 7)}` },
      ],
      viewEnabled: true, geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL',
      availableFor: 'BOTH', listingKind: 'PERMANENT', showBeforeListing: false,
      premiumOperations: [], soOperations: [], postDelistOperations: [],
      desiredState: 'ON', maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true },
      bindings: [{ id: ids.binding, chainId: ids.chain, providerCoinId,
        blockchainReference: `Task 7 ${key}`,
        isToken: false, blockchainPrecision: 18, desiredState: 'MAINTAIN',
        hotWalletAddresses, coldWalletAddresses: [], stakingWalletAddresses: [] }],
    }],
  } as const satisfies WalletCoreConfigurationPatch;
  const catalogue = { chains: [], currencies: [{ providerChainId, providerCoinId,
    currencyName: config.currencies[0].name, tokenAddress: null, isBaseCurrency: true,
    isStake: true, blockchainPrecision: 18, providerState: 'ACTIVATED', revision: 1 }] };
  return { key, ids, providerChainId, providerCoinId, config, catalogue };
}

async function seedSchedules(raw: pg.Pool, value: ReturnType<typeof fixture>): Promise<void> {
  const client = await raw.connect();
  try {
    await client.query('BEGIN');
    const current = Number((await client.query(`SELECT revision FROM
      wallet_core_test.wallet_settings WHERE id FOR UPDATE`)).rows[0].revision);
    const invalidRevision = current + 1;
    const validRevision = current + 2;
    await client.query(`INSERT INTO wallet_core_test.provider_catalogue_chains
      (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
      VALUES ($1,$2,$3,true,'ACTIVATED',1,clock_timestamp())`,
    [value.providerChainId, `Task 7 Chain ${value.key}`, `T7${value.key.slice(0, 6)}`]);
    await client.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,
       is_stake,blockchain_precision,provider_state,revision,refreshed_at)
      VALUES ($1,$2,$3,NULL,true,true,18,'ACTIVATED',1,clock_timestamp())`,
    [value.providerChainId, value.providerCoinId, value.config.currencies[0].name]);
    await client.query(`INSERT INTO wallet_core_test.chains
      (id,provider_chain_id,name,short_name,is_evm,desired_state,provider_state)
      VALUES ($1,$2,$3,$4,true,'ON','ACTIVATED')`,
    [value.ids.chain, value.providerChainId, `Task 7 Chain ${value.key}`,
      `T7${value.key.slice(0, 6)}`]);
    await client.query(`INSERT INTO price_conversion_test.currencies
      (id,symbol,name,decimals,kind,pricing_status)
      VALUES ($1,$2,$3,18,'CRYPTO','ACTIVE')`,
    [value.ids.currency, value.config.currencies[0].symbol, value.config.currencies[0].name]);
    for (const reference of value.config.currencies[0].providerRefs) {
      await client.query(`INSERT INTO price_conversion_test.currency_provider_refs
        (currency_id,provider_id,external_id,symbol,network,address)
        SELECT $1,id,$3,$4,NULL,NULL FROM price_conversion_test.price_providers
        WHERE code::text=$2`,
      [value.ids.currency, reference.provider, reference.providerAssetId,
        reference.providerSymbol]);
    }
    await client.query(`INSERT INTO wallet_core_test.currency_settings
      (currency_id,desired_state,price_readiness) VALUES ($1,'ON','HEALTHY')`,
    [value.ids.currency]);
    await client.query(`INSERT INTO wallet_core_test.currencies
      (id,currency_id,chain_id,provider_coin_id,is_token,is_native,
       blockchain_precision,desired_state,provider_state)
      VALUES ($1,$2,$3,$4,false,true,18,'ON','ACTIVATED')`,
    [value.ids.binding, value.ids.currency, value.ids.chain, value.providerCoinId]);
    await client.query(`UPDATE wallet_core_test.wallet_settings SET revision=$1 WHERE id`,
      [validRevision]);

    await client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,reason,changelog,actor_id,snapshot)
      VALUES ($1,$2,'DRAFT','invalid due row','invalid due row',$1,$3)`,
    [value.ids.invalidChange, invalidRevision, {
      config: { settings: { unexpected: true } }, catalogue: { chains: [], currencies: [] },
    }]);
    await client.query(`UPDATE wallet_core_test.configuration_changes SET status='SCHEDULED',
      effective_at=clock_timestamp()-interval '2 hours' WHERE id=$1`, [value.ids.invalidChange]);
    await client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,reason,changelog,actor_id,snapshot)
      VALUES ($1,$2,'DRAFT','valid due row','valid due row',$1,$3)`,
    [value.ids.validChange, validRevision,
      { config: value.config, catalogue: value.catalogue }]);
    await client.query(`UPDATE wallet_core_test.configuration_changes SET status='SCHEDULED',
      effective_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [value.ids.validChange]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

it('derives the configuration Cron bucket from PostgreSQL time', async () => {
  const source = await readFile(resolve(__dirname, '../configuration-worker-run.ts'), 'utf8');
  assert.match(source, /clock_timestamp\(\)/);
  assert.doesNotMatch(source, /Date\.now\(\)/);
  assert.match(source, /WALLET_CORE_DATABASE_URL/);
  assert.doesNotMatch(source, /WALLET_CORE_DATABASE_DIRECT_URL/);
});

describe('Wallet configuration worker', { skip: !LIVE }, () => {
  it('isolates a failed due row, applies later work, and audits binding state as CURRENCY_CHAIN', async () => {
    const raw = new pg.Pool({ connectionString: TEST_URL, max: 8 });
    const pool = new Pool(raw);
    const database = createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS);
    const cronjobs = new CountingCronjobs(database);
    const audit = new Audit(true);
    const writer = new WalletCoreConfigurationWriter(
      new WalletCoreRepository(database), audit, LOGO_ASSETS);
    const worker = new WalletConfigurationWorker({ database, cronjobs, writer });
    const value = fixture();
    const scheduledBase = Math.floor(Date.now() / 60_000) * 60_000
      - randomInt(10_000, 100_000) * 60_000;
    const originalRevision = Number((await raw.query(`SELECT revision FROM
      wallet_core_test.wallet_settings WHERE id`)).rows[0].revision);
    try {
      await seedSchedules(raw, value);
      const first = await worker.runOnce({
        scheduledFor: new Date(scheduledBase),
        workerInstanceId: `task7-config-${randomUUID()}`,
      });
      assert.ok(first);
      assert.equal(first.status, 'PARTIAL');
      assert.equal(first.safeErrorCode, 'CONFIGURATION_REJECTED');
      assert.equal(first.processedCount, 2);
      assert.equal(first.failedCount, 1);
      assert.equal(cronjobs.renewWithClientCalls, 2);
      assert.deepEqual((await raw.query(`SELECT count(*)::int count,
        bool_and(address_identity=lower(wallet_address)) normalized
        FROM wallet_core_test.custody_addresses WHERE currency_chain_id=$1 AND kind='HOT' AND retired_at IS NULL`,
      [value.ids.binding])).rows, [{ count: 10_000, normalized: true }]);
      assert.deepEqual((await raw.query(`SELECT id::text,status::text FROM
        wallet_core_test.configuration_changes WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[value.ids.invalidChange, value.ids.validChange]])).rows, [
        { id: value.ids.invalidChange, status: 'SCHEDULED' },
        { id: value.ids.validChange, status: 'LIVE' },
      ].sort((left, right) => left.id.localeCompare(right.id)));

      const bindingAudit = audit.calls.find((call) =>
        call.action === 'CURRENCY.STATUS_CHANGED' && call.subject.id === value.ids.binding);
      assert.ok(bindingAudit);
      assert.deepEqual(bindingAudit.subject, { type: 'CURRENCY_CHAIN', id: value.ids.binding });
      assert.deepEqual(bindingAudit.actor, { kind: 'SYSTEM', runId: first.runId });
      assert.equal(audit.calls.some((call) => call.action === 'PROVIDER_MAINTENANCE.PINNED'
        || call.action === 'PROVIDER_MAINTENANCE.UNPINNED'), false);
      assert.deepEqual((await raw.query(`SELECT event_type,subject_type,subject_id::text,run_id::text
        FROM wallet_core_test.state_events WHERE subject_id=$1`, [value.ids.binding])).rows, [{
        event_type: 'CURRENCY.STATUS_CHANGED', subject_type: 'CURRENCY_CHAIN',
        subject_id: value.ids.binding, run_id: first.runId,
      }]);
      const callsBeforeRepeat = audit.calls.length;
      assert.equal(await worker.runOnce({
        scheduledFor: new Date(scheduledBase),
        workerInstanceId: `task7-config-repeat-${randomUUID()}`,
      }), null);
      assert.equal(audit.calls.length, callsBeforeRepeat);
      assert.equal(cronjobs.renewWithClientCalls, 2);

      const retryAudit = new Audit(false);
      const retryWorker = new WalletConfigurationWorker({
        database, cronjobs,
        writer: new WalletCoreConfigurationWriter(
          new WalletCoreRepository(database), retryAudit, LOGO_ASSETS),
      });
      const second = await retryWorker.runOnce({
        scheduledFor: new Date(scheduledBase + 60_000),
        workerInstanceId: `task7-config-retry-${randomUUID()}`,
      });
      assert.ok(second);
      assert.equal(second.status, 'PARTIAL');
      assert.equal(second.safeErrorCode, 'CONFIGURATION_REJECTED');
      assert.equal(second.processedCount, 1);
      assert.equal(second.failedCount, 1);
      assert.equal(cronjobs.renewWithClientCalls, 3);
      assert.equal((await raw.query(`SELECT status::text FROM
        wallet_core_test.configuration_changes WHERE id=$1`,
      [value.ids.invalidChange])).rows[0].status, 'REJECTED');
      const rejected = retryAudit.calls.find((call) =>
        call.action === 'SETTINGS.SCHEDULE_REJECTED');
      assert.ok(rejected);
      assert.deepEqual(rejected.actor, { kind: 'SYSTEM', runId: second.runId });
      assert.equal(rejected.subject.id, String(
        (await raw.query(`SELECT revision FROM wallet_core_test.configuration_changes WHERE id=$1`,
        [value.ids.invalidChange])).rows[0].revision,
      ));
    } finally {
      const cleanup = await raw.connect();
      try {
        await cleanup.query('BEGIN');
        const retirementRevision = Number((await cleanup.query(`SELECT GREATEST(
          (SELECT revision FROM wallet_core_test.wallet_settings WHERE id),
          (SELECT policy_revision FROM wallet_core_test.currency_settings WHERE currency_id=$1),
          (SELECT COALESCE(max(created_revision),0) FROM wallet_core_test.custody_addresses
            WHERE currency_chain_id=$2))+1 revision`,
        [value.ids.currency, value.ids.binding])).rows[0].revision);
        await cleanup.query(`UPDATE wallet_core_test.wallet_settings SET revision=$1 WHERE id`,
          [retirementRevision]);
        await cleanup.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=$2
          WHERE currency_id=$1`, [value.ids.currency, retirementRevision]);
        await cleanup.query(`UPDATE wallet_core_test.custody_addresses
          SET retired_revision=$2,retired_at=clock_timestamp()
          WHERE currency_chain_id=$1 AND retired_at IS NULL`,
        [value.ids.binding, retirementRevision]);
        await cleanup.query(`UPDATE wallet_core_test.configuration_changes SET status='ARCHIVED'
          WHERE id=ANY($1::uuid[]) AND status IN ('DRAFT','SCHEDULED','LIVE')`,
        [[value.ids.invalidChange, value.ids.validChange]]);
        await cleanup.query(`ALTER TABLE wallet_core_test.configuration_changes
          DISABLE TRIGGER configuration_changes_no_delete`);
        await cleanup.query(`DELETE FROM wallet_core_test.configuration_changes
          WHERE id=ANY($1::uuid[])`, [[value.ids.invalidChange, value.ids.validChange]]);
        await cleanup.query(`ALTER TABLE wallet_core_test.configuration_changes
          ENABLE TRIGGER configuration_changes_no_delete`);
        await cleanup.query(`UPDATE wallet_core_test.wallet_settings SET revision=$1 WHERE id`,
          [originalRevision]);
        assert.equal(Number((await cleanup.query(`SELECT revision FROM
          wallet_core_test.wallet_settings WHERE id`)).rows[0].revision), originalRevision);
        await cleanup.query('COMMIT');
      } catch (error) {
        await cleanup.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        cleanup.release();
        await raw.end();
      }
    }
  });
});
