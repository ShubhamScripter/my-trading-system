import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';

import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../../admin-audits/index.js';
import type { NormalizedCatalogueSnapshot } from '../blockchain-admin.client.js';
import { encodeWalletQueryCursor, walletQueryFingerprint } from '../wallet-core.cursor.js';
import { createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient, type WalletCorePool } from '../wallet-core.database.js';
import { ProviderCataloguePersistenceError,
  ProviderCatalogueRepository } from '../provider-catalogue.repository.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { WALLET_CATALOGUE_REFRESH_ERROR_CODES } from '../wallet-core.types.js';
import type { WalletAuditContext } from '../wallet-core.types.js';

const URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === URL;
const CONTEXT: WalletAuditContext = { actor: { kind: 'ADMIN',
  actorId: '019f1000-0000-7000-8000-000000000001',
  sessionId: '019f1000-0000-7000-8000-000000000002',
  requestId: '019f1000-0000-7000-8000-000000000003', ipAddress: '127.0.0.1',
  deviceId: 'catalogue-persistence-test' } };
const FIRST: NormalizedCatalogueSnapshot = {
  decodedBytes: 700,
  chains: [
    { providerChainId: 9007199254740001, name: 'Ethereum', shortName: 'ETH', state: 'ACTIVATED', isEvm: true },
    { providerChainId: 9007199254740002, name: 'Bitcoin', shortName: 'BTC', state: 'MAINTENANCE', isEvm: false },
  ],
  coins: [
    { providerChainId: 9007199254740001, providerCoinId: 9007199254740101, currencyName: 'ETH', tokenAddress: null,
      blockchainPrecision: 18, isBaseCurrency: true, isStake: true, state: 'ACTIVATED' },
    { providerChainId: 9007199254740001, providerCoinId: 9007199254740102, currencyName: 'USDT',
      tokenAddress: '0x0000000000000000000000000000000000000001', blockchainPrecision: 6,
      isBaseCurrency: false, isStake: false, state: 'DISABLED' },
    { providerChainId: 9007199254740002, providerCoinId: 9007199254740103, currencyName: 'BTC', tokenAddress: null,
      blockchainPrecision: 8, isBaseCurrency: true, isStake: true, state: 'MAINTENANCE' },
  ],
};
const SECOND: NormalizedCatalogueSnapshot = {
  decodedBytes: 300,
  chains: [{ providerChainId: 9007199254740001, name: 'Ethereum Mainnet', shortName: 'ETH',
    state: 'ACTIVATED', isEvm: true }],
  coins: [{ providerChainId: 9007199254740001, providerCoinId: 9007199254740101, currencyName: 'ETH', tokenAddress: null,
    blockchainPrecision: 18, isBaseCurrency: true, isStake: true, state: 'ACTIVATED' }],
};
const EMPTY: NormalizedCatalogueSnapshot = { decodedBytes: 100, chains: [], coins: [] };
let eventSequence = 100;
const eventKey = () =>
  `019f1000-0000-7000-8001-${(++eventSequence).toString(16).padStart(12, '0')}`;
const IDENTITY = { nextUuidV7: eventKey };

class FakeAudit implements AdminAuditPort {
  readonly attempts: WalletCoreAdminAuditInput[] = [];
  readonly accepted: WalletCoreAdminAuditInput[] = [];
  replayNext = false; throwNext = false;
  async appendWithTransaction(_tx: Parameters<AdminAuditPort['appendWithTransaction']>[0],
    input: Parameters<AdminAuditPort['appendWithTransaction']>[1]) {
    assert.equal(input.domain, 'WALLET_CORE'); this.attempts.push(input as WalletCoreAdminAuditInput);
    if (this.throwNext) { this.throwNext = false; throw new Error('AUDIT_DOWN'); }
    const replayed = this.replayNext; this.replayNext = false;
    if (!replayed) this.accepted.push(input as WalletCoreAdminAuditInput);
    return { id: '019f1000-0000-7000-8000-000000000004', replayed };
  }
}

class FaultClient implements WalletCoreClient {
  private failed = false;
  constructor(private readonly client: pg.PoolClient, private readonly marker: string,
    private readonly released: () => void) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ) {
    if (!this.failed && sql.includes(this.marker)) {
      this.failed = true; throw new Error(`DB_FAIL:${this.marker}`);
    }
    const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release() { this.released(); this.client.release(); }
}
class FaultPool implements WalletCorePool {
  releases = 0;
  constructor(private readonly pool: pg.Pool, private readonly marker: string) {}
  async connect() { return new FaultClient(await this.pool.connect(), this.marker,
    () => { this.releases += 1; }); }
  async end() { await this.pool.end(); }
}

async function catalogue(pool: pg.Pool) {
  const [settings, chains, coins, alerts, events, protectedState] = await Promise.all([
    pool.query(`SELECT revision::text,provider_catalogue_revision::text
      FROM wallet_core_test.wallet_settings WHERE id`),
    pool.query(`SELECT provider_chain_id::text,name,short_name,is_evm,provider_state::text,
      revision::text FROM wallet_core_test.provider_catalogue_chains ORDER BY provider_chain_id`),
    pool.query(`SELECT provider_chain_id::text,provider_coin_id::text,currency_name,token_address,
      is_base_currency,is_stake,blockchain_precision,provider_state::text,revision::text
      FROM wallet_core_test.provider_catalogue_currencies ORDER BY provider_chain_id,provider_coin_id`),
    pool.query(`SELECT id::text,status::text,payload,opened_at,cleared_at,updated_at
      FROM wallet_core_test.wallet_alerts WHERE dedupe_key='provider-catalogue:BLOCKCHAIN'`),
    pool.query(`SELECT event.status::text,event.payload FROM wallet_core_test.wallet_alert_events event
      JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
      WHERE alert.dedupe_key='provider-catalogue:BLOCKCHAIN' ORDER BY event.created_at,event.id`),
    pool.query(`SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]')::text
        FROM price_conversion_test.currencies row) price_currencies,
      (SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]')::text
        FROM wallet_core_test.chains row) wallet_chains,
      (SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.id),'[]')::text
        FROM wallet_core_test.currencies row) wallet_currencies,
      (SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.revision),'[]')::text
        FROM wallet_core_test.configuration_changes row) configurations`),
  ]);
  return { settings: settings.rows, chains: chains.rows, coins: coins.rows,
    alerts: alerts.rows, events: events.rows, protectedState: protectedState.rows[0] };
}

describe('Wallet Core Task 5 provider catalogue persistence', { skip: !LIVE }, () => {
  it('persists increasing empty-snapshot revisions and returns revision-pinned empty pages', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 2 });
    const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY);
    try {
      const start = Number((await catalogue(pool)).settings[0]?.provider_catalogue_revision);
      const first = await repository.refresh(EMPTY, CONTEXT, eventKey());
      const second = await repository.refresh(EMPTY, CONTEXT, eventKey());
      assert.deepEqual([first, second], [
        { revision: String(start + 1), itemCount: 0 },
        { revision: String(start + 2), itemCount: 0 },
      ]);
      assert.deepEqual(await repository.chains({ limit: 1 }),
        { revision: String(start + 2), items: [], nextCursor: null });
      assert.deepEqual(await repository.coins('99999', { limit: 1 }),
        { revision: String(start + 2), items: [], nextCursor: null });
      await assert.rejects(() => repository.chains({ limit: 1,
        cursor: encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint({
          sortBy: 'providerChainId', sortDirection: 'asc',
        }), [String(start + 1), '1', '1']) }),
      WalletConfigurationInvalid);
    } finally { await pool.end(); }
  });

  it('persists complete increasing revisions, durable failure alert lifecycle, and one audit', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 4 });
    const audit = new FakeAudit();
    const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS), audit, IDENTITY);
    try {
      const initial = await catalogue(pool); const untouched = initial.protectedState;
      const configurationRevision = Number(initial.settings[0]?.revision);
      const startingRevision = Number(initial.settings[0]?.provider_catalogue_revision);
      const startingItemCount = initial.chains.filter((row) => row.provider_state !== 'UNAVAILABLE').length
        + initial.coins.filter((row) => row.provider_state !== 'UNAVAILABLE').length;
      await repository.recordFailure('TIMEOUT');
      const opened = await catalogue(pool);
      assert.equal(opened.alerts[0]?.payload.safeErrorCode, 'TIMEOUT');
      assert.match(opened.alerts[0]?.payload.failedAt,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.equal(opened.events.at(-1)?.status, 'ACTIVE');
      const openedAt = opened.alerts[0]?.opened_at;
      await repository.recordFailure('TRANSPORT_ERROR');
      const updated = await catalogue(pool);
      assert.equal(updated.alerts[0]?.opened_at.valueOf(), openedAt.valueOf());
      assert.equal(updated.events.length, opened.events.length);

      const firstKey = eventKey();
      const first = await repository.refresh(FIRST, CONTEXT, firstKey);
      assert.deepEqual(first, { revision: String(startingRevision + 1), itemCount: 5 });
      const afterFirst = await catalogue(pool);
      assert.equal(afterFirst.settings[0]?.revision, String(configurationRevision));
      assert.deepEqual(afterFirst.protectedState, untouched);
      assert.equal(afterFirst.chains.filter((row) => row.provider_state !== 'UNAVAILABLE').length, 2);
      assert.equal(afterFirst.coins.filter((row) => row.provider_state !== 'UNAVAILABLE').length, 3);
      assert.equal(afterFirst.alerts[0]?.status, 'CLEARED');
      assert.equal(afterFirst.events.length, opened.events.length + 1);
      assert.equal(afterFirst.events.at(-1)?.status, 'CLEARED');
      assert.equal(audit.accepted.length, 1);
      assert.equal(audit.accepted[0]!.eventKey, firstKey);
      assert.deepEqual(audit.accepted[0], { domain: 'WALLET_CORE', action: 'CATALOGUE.REFRESHED',
        eventKey: audit.accepted[0]!.eventKey, actor: CONTEXT.actor,
        subject: { type: 'PROVIDER_CATALOGUE', id: 'BLOCKCHAIN' },
        reason: 'Blockchain provider catalogue refreshed.',
        before: { revision: startingRevision, itemCount: startingItemCount },
        after: { revision: startingRevision + 1, itemCount: 5 },
        metadata: { configurationRevision, source: 'BLOCKCHAIN' } });

      audit.replayNext = true;
      await assert.rejects(() => repository.refresh(SECOND, CONTEXT, eventKey()), /AUDIT_ERROR/);
      const replayed = await catalogue(pool);
      assert.equal(replayed.chains.find((row) =>
        row.provider_chain_id === '9007199254740001')?.name, 'Ethereum');
      assert.ok(replayed.chains.every((row) => row.revision === String(startingRevision + 1)));
      assert.deepEqual(replayed.alerts[0]?.payload.safeErrorCode, 'AUDIT_ERROR');
      assert.deepEqual(replayed.events.slice(-2).map((row) => row.status), ['CLEARED', 'ACTIVE']);
      assert.equal(audit.accepted.length, 1);

      const second = await repository.refresh(SECOND, CONTEXT, eventKey());
      const currentRevision = startingRevision + 2;
      assert.deepEqual(second, { revision: String(currentRevision), itemCount: 2 });
      const afterSecond = await catalogue(pool);
      assert.equal(afterSecond.chains.find((row) =>
        row.provider_chain_id === '9007199254740001')?.name,
        'Ethereum Mainnet');
      assert.equal(afterSecond.chains.find((row) =>
        row.provider_chain_id === '9007199254740002')?.provider_state,
        'UNAVAILABLE');
      assert.equal(afterSecond.coins.find((row) =>
        row.provider_coin_id === '9007199254740102')?.provider_state,
        'UNAVAILABLE');
      assert.ok(afterSecond.chains.every((row) => row.revision === String(currentRevision)));
      assert.ok(afterSecond.coins.every((row) => row.revision === String(currentRevision)));
      assert.deepEqual(audit.accepted[1]?.before,
        { revision: startingRevision + 1, itemCount: 5 });
      assert.deepEqual(audit.accepted[1]?.after, { revision: currentRevision, itemCount: 2 });
      assert.equal(afterSecond.alerts[0]?.status, 'CLEARED');
    } finally { await pool.end(); }
  });

  it('rolls audit throws back, records only the safe alert, and rejects unsafe failure codes', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 2 });
    const audit = new FakeAudit(); const repository = new ProviderCatalogueRepository(
      createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS), audit, IDENTITY);
    try {
      const before = await catalogue(pool); audit.throwNext = true;
      await assert.rejects(() => repository.refresh(FIRST, CONTEXT, 'not-a-uuidv7'),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.refresh(FIRST, CONTEXT, eventKey()), /AUDIT_ERROR/);
      const after = await catalogue(pool);
      assert.deepEqual(after.chains, before.chains); assert.deepEqual(after.coins, before.coins);
      assert.equal(after.alerts[0]?.payload.safeErrorCode, 'AUDIT_ERROR');
      await assert.rejects(() => repository.recordFailure('RAW_PROVIDER_BODY' as never),
        WalletConfigurationInvalid);
    } finally { await pool.end(); }
  });

  it('pages stored chains and per-chain coins with revision-pinned canonical cursors', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 2 });
    const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY);
    try {
      const currentRevision = Number((await repository.refresh(
        FIRST, CONTEXT, eventKey())).revision);
      const chainFirst = await repository.chains({ limit: 1,
        cursor: encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint({
          sortBy: 'providerChainId', sortDirection: 'asc',
        }), [String(currentRevision), '9007199254740000', '9007199254740000']) });
      assert.equal(chainFirst.revision, String(currentRevision));
      assert.equal(chainFirst.items[0]?.providerChainId, '9007199254740001');
      assert.equal(chainFirst.items[0]?.revision, chainFirst.revision);
      assert.match(chainFirst.items[0]?.refreshedAt ?? '',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.ok(chainFirst.nextCursor);
      const chainSecond = await repository.chains({ limit: 1, cursor: chainFirst.nextCursor! });
      assert.equal(chainSecond.items[0]?.providerChainId, '9007199254740002');
      assert.equal(chainSecond.items[0]?.providerState, 'MAINTENANCE');
      assert.equal(chainSecond.nextCursor, null);
      await assert.rejects(() => repository.chains({ limit: 1,
        cursor: encodeWalletQueryCursor('PROVIDER_CHAIN', walletQueryFingerprint({
          sortBy: 'providerChainId', sortDirection: 'asc',
        }), [String(currentRevision + 1), '9007199254740001', '9007199254740001']) }), WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ limit: 1, cursor: 'bad' }),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ limit: 0 }), WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ limit: 101 }), WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ limit: 1, raw: true } as never),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains([] as never), WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains(null as never), WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ limit: null } as never),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.chains({ cursor: null } as never),
        WalletConfigurationInvalid);

      const chainId = '9007199254740001';
      const coinFirst = await repository.coins(chainId, { limit: 1 });
      assert.equal(coinFirst.revision, String(currentRevision));
      assert.equal(coinFirst.items[0]?.providerCoinId, '9007199254740101');
      assert.equal(coinFirst.items[0]?.revision, coinFirst.revision);
      assert.ok(coinFirst.nextCursor);
      const coinSecond = await repository.coins(chainId, { limit: 1, cursor: coinFirst.nextCursor! });
      assert.equal(coinSecond.items[0]?.providerCoinId, '9007199254740102');
      assert.equal(coinSecond.items[0]?.providerState, 'DISABLED');
      assert.equal(coinSecond.nextCursor, null);
      await assert.rejects(() => repository.coins(chainId, { limit: 1,
        cursor: encodeWalletQueryCursor('PROVIDER_COIN', walletQueryFingerprint({
          providerChainId: chainId, sortBy: 'providerCoinId', sortDirection: 'asc',
        }), [String(currentRevision + 1), '9007199254740101', chainId, '9007199254740101']) }),
      WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(chainId, { limit: 1,
        cursor: encodeWalletQueryCursor('PROVIDER_COIN', walletQueryFingerprint({
          providerChainId: chainId, sortBy: 'providerCoinId', sortDirection: 'asc',
        }), [String(currentRevision), '9007199254740101', '9007199254740002', '9007199254740101']) }),
      WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(chainId, { limit: 1, raw: true } as never),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(chainId, [] as never), WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(chainId, { limit: null } as never),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(chainId, { cursor: null } as never),
        WalletConfigurationInvalid);
      await assert.rejects(() => repository.coins(9007199254740001 as never, { limit: 1 }),
        WalletConfigurationInvalid);
      assert.deepEqual(await repository.coins('99999', { limit: 100 }),
        { revision: String(currentRevision), items: [], nextCursor: null });
      await assert.rejects(() => repository.coins('0', { limit: 1 }), WalletConfigurationInvalid);
    } finally { await pool.end(); }
  });

  it('pages one flat current coin-chain row with safe nested chain support', async () => {
    const pool = new pg.Pool({ connectionString: URL, max: 2 });
    const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
      pool, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY);
    try {
      const revision = (await repository.refresh(FIRST, CONTEXT, eventKey())).revision;
      const first = await repository.allCoins({ limit: 1 });
      assert.deepEqual(first.items, [{ providerCoinId: '9007199254740101', currencyName: 'ETH',
        tokenAddress: null, blockchainPrecision: 18, isBaseCurrency: true, isStake: true,
        providerState: 'ACTIVATED', chain: { providerChainId: '9007199254740001', name: 'Ethereum',
          shortName: 'ETH', isEvm: true, providerState: 'ACTIVATED' } }]);
      assert.equal(first.revision, revision); assert.ok(first.nextCursor);
      const second = await repository.allCoins({ limit: 1, cursor: first.nextCursor! });
      assert.equal(second.items[0]?.providerCoinId, '9007199254740102');
      assert.equal(second.items[0]?.chain.providerChainId, '9007199254740001');
      const third = await repository.allCoins({ limit: 1, cursor: second.nextCursor! });
      assert.equal(third.items[0]?.providerCoinId, '9007199254740103');
      assert.equal(third.items[0]?.chain.providerChainId, '9007199254740002');
      assert.equal(third.nextCursor, null);
      assert.equal(JSON.stringify(first).includes('decodedBytes'), false);
      await assert.rejects(() => repository.allCoins({ cursor:
        encodeWalletQueryCursor('PROVIDER_COIN', walletQueryFingerprint({
          sortBy: 'providerChainId', sortDirection: 'asc',
        }), [String(Number(revision) + 1), '9007199254740001',
          '9007199254740001', '9007199254740101']), limit: 1 }), WalletConfigurationInvalid);
      for (const invalid of [{ limit: null }, { cursor: null }, { providerChainId: '1' }, []]) {
        await assert.rejects(() => repository.allCoins(invalid as never), WalletConfigurationInvalid);
      }
    } finally { await pool.end(); }
  });

  it('rolls back every catalogue database statement and releases its client exactly once', async () => {
    const control = new pg.Pool({ connectionString: URL, max: 2 });
    await new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
      control, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY).recordFailure('TIMEOUT');
    const before = await catalogue(control);
    const markers = [
      'wallet_settings WHERE id FOR UPDATE',
      'SELECT ((SELECT count(*)',
      'SELECT to_char(clock_timestamp()',
      'INSERT INTO wallet_core_test.provider_catalogue_chains',
      'INSERT INTO wallet_core_test.provider_catalogue_currencies',
      'UPDATE wallet_core_test.provider_catalogue_currencies existing',
      'UPDATE wallet_core_test.provider_catalogue_chains SET',
      'wallet_alerts WHERE dedupe_key=$1 FOR UPDATE',
      "UPDATE wallet_core_test.wallet_alerts alert SET status='CLEARED'",
      'INSERT INTO wallet_core_test.wallet_alert_events',
      'SET provider_catalogue_revision=$1',
      'RELEASE SAVEPOINT provider_catalogue_refresh',
    ];
    try {
      for (const marker of markers) {
        const fault = new FaultPool(control, marker);
        const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
          fault, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY);
        await assert.rejects(() => repository.refresh(FIRST, CONTEXT, eventKey()), (error) =>
          error instanceof ProviderCataloguePersistenceError && error.code === 'DATABASE_ERROR');
        const after = await catalogue(control);
        assert.deepEqual(after.chains, before.chains, marker);
        assert.deepEqual(after.coins, before.coins, marker);
        assert.equal(fault.releases, 1, marker);
      }
    } finally { await control.end(); }
  });

  it('serializes concurrent complete snapshots into increasing, never mixed revisions', async () => {
    const raw = new pg.Pool({ connectionString: URL, max: 4 });
    const audit = new FakeAudit(); const database = createValidatedWalletCoreTestDatabase(
      raw, WALLET_CORE_TEST_SCHEMAS);
    try {
      const repository = new ProviderCatalogueRepository(database, audit, IDENTITY);
      const currentRevision = Number((await catalogue(raw)).settings[0]?.provider_catalogue_revision);
      const results = await Promise.all([
        repository.refresh(FIRST, CONTEXT, eventKey()),
        repository.refresh(SECOND, CONTEXT, eventKey()),
      ]);
      assert.deepEqual(results.map((entry) => Number(entry.revision)).sort(),
        [currentRevision + 1, currentRevision + 2]);
      const finalRevision = currentRevision + 2;
      const after = await catalogue(raw);
      assert.ok(after.chains.every((row) => row.revision === String(finalRevision)));
      assert.ok(after.coins.every((row) => row.revision === String(finalRevision)));
      const available = after.chains.filter((row) => row.provider_state !== 'UNAVAILABLE').length
        + after.coins.filter((row) => row.provider_state !== 'UNAVAILABLE').length;
      assert.equal(available, results.find((entry) =>
        entry.revision === String(finalRevision))?.itemCount);
      const events = audit.accepted.map((entry) => entry as Extract<WalletCoreAdminAuditInput,
        { action: 'CATALOGUE.REFRESHED' }>).sort((left, right) =>
        (left.after?.revision ?? -1) - (right.after?.revision ?? -1));
      assert.deepEqual(events.map((entry) => [entry.before?.revision, entry.after?.revision]),
        [[currentRevision, currentRevision + 1], [currentRevision + 1, finalRevision]]);
    } finally { await raw.end(); }
  });

  it('accepts only every closed failure code and never leaks a partial refresh on alert failure', async () => {
    const raw = new pg.Pool({ connectionString: URL, max: 2 });
    try {
      const repository = new ProviderCatalogueRepository(createValidatedWalletCoreTestDatabase(
        raw, WALLET_CORE_TEST_SCHEMAS), new FakeAudit(), IDENTITY);
      for (const code of WALLET_CATALOGUE_REFRESH_ERROR_CODES) {
        await repository.recordFailure(code);
        const current = await catalogue(raw);
        assert.deepEqual(Object.keys(current.alerts[0]?.payload).sort(), ['failedAt', 'safeErrorCode']);
        assert.equal(current.alerts[0]?.payload.safeErrorCode, code);
      }
      const before = await catalogue(raw); const fault = new FaultPool(raw,
        "UPDATE wallet_core_test.wallet_alerts alert SET status='ACTIVE'");
      const audit = new FakeAudit(); audit.throwNext = true;
      await assert.rejects(() => new ProviderCatalogueRepository(
        createValidatedWalletCoreTestDatabase(fault, WALLET_CORE_TEST_SCHEMAS), audit, IDENTITY)
        .refresh(FIRST, CONTEXT, eventKey()), /DB_FAIL/);
      const after = await catalogue(raw);
      assert.deepEqual(after.chains, before.chains); assert.deepEqual(after.coins, before.coins);
      assert.deepEqual(after.alerts, before.alerts); assert.equal(fault.releases, 1);
    } finally { await raw.end(); }
  });
});
