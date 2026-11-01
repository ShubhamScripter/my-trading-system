import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
  type WalletCoreQueryResult,
} from '../wallet-core.database.js';
import { decodeWalletQueryCursor, walletQueryFingerprint } from '../wallet-core.cursor.js';
import { WalletCoreHistoryRepository } from '../wallet-core.history-repository.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
let seededCurrencyId = '';
let seededConfigurationRevision = '';
let seededPolicyRevision = '';
let seededTimes: Record<'configuration' | 'state' | 'recovered' | 'pinned' | 'alert'
  | 'reconciliation' | 'reconciliationCompleted' | 'forfeiture' | 'forfeitureUpdated'
  | 'forfeitureDeadline' | 'jobScheduled' | 'jobStarted' | 'jobFinished' | 'jobLease'
  | 'tie' | 'head', string>;

function uuidv7(): string {
  const chars = randomUUID().split('');
  chars[14] = '7'; chars[19] = '8';
  return chars.join('');
}

const timestamp = (milliseconds: number): string =>
  new Date(milliseconds).toISOString().replace(/Z$/, '000Z');

const IDS = {
  admin: uuidv7(), system: uuidv7(), config: uuidv7(), state: uuidv7(),
  provider: uuidv7(), pin: uuidv7(), alert: uuidv7(), alertEvent: uuidv7(),
  reconciliation: uuidv7(), forfeiture: uuidv7(), job: uuidv7(), ignoredImport: uuidv7(),
} as const;

class PgClient implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient, private readonly released: () => void) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ): Promise<WalletCoreQueryResult<Row>> {
    const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void { this.released(); this.client.release(); }
}

class TestPool implements WalletCorePool {
  releases = 0;
  constructor(readonly pool: pg.Pool) {}
  async connect(): Promise<WalletCoreClient> {
    return new PgClient(await this.pool.connect(), () => { this.releases += 1; });
  }
  async end(): Promise<void> { await this.pool.end(); }
}

class FakeClient implements WalletCoreClient {
  readonly calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  releases = 0;
  constructor(
    private readonly rows: readonly Record<string, unknown>[] = [],
    private readonly failQuery = false,
  ) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values: readonly unknown[] = [],
  ): Promise<WalletCoreQueryResult<Row>> {
    this.calls.push({ sql, values });
    if (this.failQuery && sql.includes('WITH history AS')) throw new Error('query failed');
    return { rows: (sql.includes('WITH history AS') ? this.rows : []) as Row[], rowCount: null };
  }
  release(): void { this.releases += 1; }
}

const fakeRepository = (client: FakeClient): WalletCoreHistoryRepository => {
  const pool: WalletCorePool = { async connect() { return client; }, async end() {} };
  return new WalletCoreHistoryRepository(
    createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS),
  );
};

describe('Wallet Core history transaction boundary', () => {
  it('defaults to 50, uses explicit union columns, and omits forensic/raw fields', async () => {
    const client = new FakeClient();
    const page = await fakeRepository(client).history({ limit: undefined as never });
    const query = client.calls.find((call) => call.sql.includes('WITH history AS'));

    assert.deepEqual(page, { items: [], nextCursor: null });
    assert.ok(query);
    assert.equal(query.values[2], 51);
    assert.match(query.sql, /configuration_changes/);
    assert.match(query.sql, /state_events/);
    assert.match(query.sql, /wallet_alert_events/);
    assert.match(query.sql, /wallet_reconciliation_runs/);
    assert.match(query.sql, /FROM\s+\(SELECT \* FROM wallet_core_test\.wallet_reconciliation_runs WHERE status IS NOT NULL/);
    assert.match(query.sql, /delisting_executions/);
    assert.match(query.sql, /cronjob_runs/);
    assert.match(query.sql, /wallet_reconciliation_items item[\s\S]*item\.currency_id=\$5/);
    assert.doesNotMatch(query.sql, /wallet_reconciliation_(?:components|attempts)/i);
    assert.ok((query.sql.match(/ORDER BY [\s\S]*? LIMIT \$3\)/g) ?? []).length >= 7);
    assert.doesNotMatch(query.sql, /RECONCILIATION\.CONFIG_SNAPSHOT/);
    for (const forbidden of ['snapshot AS', 'payload AS', 'dedupe_key', 'worker_instance_id']) {
      assert.equal(query.sql.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
    assert.deepEqual(client.calls.map(({ sql }) => sql.split(/\s+/).slice(0, 4).join(' ')), [
      'BEGIN', 'SET TRANSACTION ISOLATION LEVEL', 'WITH history AS (', 'COMMIT',
    ]);
    assert.equal(client.releases, 1);
  });

  it('rolls back and releases exactly once after query or mapping failure', async () => {
    for (const client of [new FakeClient([], true), new FakeClient([{ id: 'malformed' }])]) {
      await assert.rejects(() => fakeRepository(client).history({ limit: 1 }));
      assert.equal(client.calls.some(({ sql }) => sql === 'COMMIT'), false);
      assert.equal(client.calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
      assert.equal(client.releases, 1);
    }
  });

  it('rejects invalid limits and cursors before opening a database transaction', async () => {
    for (const input of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 1, cursor: 'not-canonical' },
    ]) {
      const client = new FakeClient();
      await assert.rejects(() => fakeRepository(client).history(input));
      assert.equal(client.calls.length, 0);
      assert.equal(client.releases, 0);
    }
  });

  it('maps whole-currency and currency-chain status history plus binding pin history', async () => {
    const rows = [
      { id: '01980000-0000-7000-8000-000000000010', created_at: '2090-01-01T09:00:04.000000Z',
        category: 'STATE', actor_kind: 'ADMIN', actor_ref: IDS.admin,
        event_type: 'CURRENCY.STATUS_CHANGED', subject_type: 'CURRENCY', subject_id: IDS.config,
        from_state: 'OFF', to_state: 'ON', reason_code: null },
      { id: '01980000-0000-7000-8000-000000000011', created_at: '2090-01-01T09:00:03.000000Z',
        category: 'STATE', actor_kind: 'SYSTEM', actor_ref: IDS.system,
        event_type: 'CURRENCY.STATUS_CHANGED', subject_type: 'CURRENCY_CHAIN', subject_id: IDS.provider,
        from_state: 'ON', to_state: 'MAINTAIN', reason_code: null },
      { id: '01980000-0000-7000-8000-000000000012', created_at: '2090-01-01T09:00:02.000000Z',
        category: 'PROVIDER', actor_kind: 'ADMIN', actor_ref: IDS.admin,
        event_type: 'PROVIDER_MAINTENANCE.PINNED', subject_type: 'CURRENCY_CHAIN',
        subject_id: IDS.provider, from_state: null, to_state: null, before_pin: false, after_pin: true },
      { id: '01980000-0000-7000-8000-000000000013', created_at: '2090-01-01T09:00:01.000000Z',
        category: 'PROVIDER', actor_kind: 'ADMIN', actor_ref: IDS.admin,
        event_type: 'PROVIDER_MAINTENANCE.UNPINNED', subject_type: 'CURRENCY_CHAIN',
        subject_id: IDS.provider, from_state: null, to_state: null, before_pin: true, after_pin: false },
    ];
    const page = await fakeRepository(new FakeClient(rows)).history({ limit: 4 });

    const events = page.items.map((item) => {
      if (item.category !== 'STATE' && item.category !== 'PROVIDER') throw new Error('TEST_HISTORY_CATEGORY');
      return [item.category, item.eventType, item.subject];
    });
    assert.deepEqual(events, [
      ['STATE', 'CURRENCY.STATUS_CHANGED', { type: 'CURRENCY', id: IDS.config }],
      ['STATE', 'CURRENCY.STATUS_CHANGED', { type: 'CURRENCY_CHAIN', id: IDS.provider }],
      ['PROVIDER', 'PROVIDER_MAINTENANCE.PINNED', { type: 'CURRENCY_CHAIN', id: IDS.provider }],
      ['PROVIDER', 'PROVIDER_MAINTENANCE.UNPINNED', { type: 'CURRENCY_CHAIN', id: IDS.provider }],
    ]);
  });
});

async function seed(pool: pg.Pool): Promise<void> {
  const latest = (await pool.query(`SELECT max(sort_at) latest FROM (
    SELECT created_at sort_at FROM wallet_core_test.configuration_changes
    UNION ALL SELECT created_at FROM wallet_core_test.state_events
    UNION ALL SELECT created_at FROM wallet_core_test.wallet_alert_events
    UNION ALL SELECT scheduled_for FROM wallet_core_test.wallet_reconciliation_runs
    UNION ALL SELECT created_at FROM wallet_core_test.delisting_executions
    UNION ALL SELECT started_at FROM wallet_core_test.cronjob_runs
  ) history`)).rows[0].latest as Date | null;
  const base = Math.ceil(Math.max(Date.now(), latest?.getTime() ?? 0) / 1_000) * 1_000
    + 86_400_000;
  seededTimes = {
    configuration: timestamp(base + 7_000), state: timestamp(base + 6_000),
    recovered: timestamp(base + 5_500), pinned: timestamp(base + 5_000),
    alert: timestamp(base + 4_000), reconciliation: timestamp(base + 3_000),
    reconciliationCompleted: timestamp(base + 3_500), forfeiture: timestamp(base + 2_000),
    forfeitureUpdated: timestamp(base + 2_500),
    forfeitureDeadline: timestamp(base + 31 * 86_400_000),
    jobScheduled: timestamp(base), jobStarted: timestamp(base + 1_000),
    jobFinished: timestamp(base + 1_500), jobLease: timestamp(base + 301_000),
    tie: timestamp(base + 2 * 86_400_000 + 123), head: timestamp(base + 2 * 86_400_000 + 1_123),
  };
  const currencyId = String((await pool.query(
    `SELECT id FROM price_conversion_test.currencies WHERE symbol='BTC'`,
  )).rows[0].id);
  seededCurrencyId = currencyId;
  seededPolicyRevision = String((await pool.query(`SELECT policy_revision FROM
    wallet_core_test.currency_settings WHERE currency_id=$1`, [currencyId])).rows[0].policy_revision);
  const revision = String((await pool.query(
    `SELECT COALESCE(max(revision),0)+1 AS revision
       FROM wallet_core_test.configuration_changes`,
  )).rows[0].revision);
  seededConfigurationRevision = revision;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallet_core_test.configuration_changes
      (id,revision,status,effective_at,reason,changelog,actor_id,snapshot,applied_at,created_at)
      VALUES ($1,$3,'DRAFT',NULL,'approved','wallet history',$2,'{}',NULL,
        $4)`,
    [IDS.config, IDS.admin, revision, seededTimes.configuration]);
    await client.query(`UPDATE wallet_core_test.configuration_changes
      SET status='ARCHIVED' WHERE id=$1`, [IDS.config]);
    await client.query(`INSERT INTO wallet_core_test.state_events
      (id,event_type,subject_type,subject_id,run_id,actor_id,payload,created_at) VALUES
      ($1,'CURRENCY.STATUS_CHANGED','CURRENCY',$2,NULL,$3,$4,$13),
      ($5,'PROVIDER_MAINTENANCE.RECOVERED','CHAIN',$6,$7,NULL,$8,$14),
      ($9,'PROVIDER_MAINTENANCE.PINNED','CHAIN',$6,NULL,$3,$10,$15),
      ($11,'CHAIN.IMPORTED','CHAIN',$6,NULL,$3,$12,$16)`, [
      IDS.state, currencyId, IDS.admin, JSON.stringify({ before: { desiredState: 'OFF' },
        after: { desiredState: 'ON' }, metadata: { reasonCode: 'POLICY_CHANGED' } }),
      IDS.provider, IDS.config, IDS.system, JSON.stringify({ before: { providerState: 'UNAVAILABLE' },
        after: { providerState: 'ACTIVATED' }, metadata: {} }),
      IDS.pin, JSON.stringify({ before: { maintenancePinned: false },
        after: { maintenancePinned: true }, metadata: {} }),
      IDS.ignoredImport, JSON.stringify({ before: null, after: { desiredState: 'ON' }, metadata: {} }),
      seededTimes.state, seededTimes.recovered, seededTimes.pinned, seededTimes.head,
    ]);
    await client.query(`INSERT INTO wallet_core_test.wallet_alerts
      (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
      VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',NULL,$3,$4,$4)`, [IDS.alert,
      `history-catalogue-${IDS.alert}`,
      { safeErrorCode: 'TIMEOUT', failedAt: seededTimes.alert }, seededTimes.alert]);
    await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
      (id,alert_id,category,status,payload,created_at)
      VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',$3,$4)`,
    [IDS.alertEvent, IDS.alert,
      { safeErrorCode: 'TIMEOUT', failedAt: seededTimes.alert }, seededTimes.alert]);
    const capture = (await client.query(`SELECT setting.reconciliation_alert_percent,
      setting.include_treasury,setting.include_collection,setting.reconciliation_alert_basis::text,
      COALESCE((SELECT revision FROM wallet_core_test.configuration_changes WHERE status='LIVE'),0)
        configuration_revision,
      (SELECT count(*)::int FROM wallet_core_test.currency_settings currency_setting
        JOIN price_conversion_test.currencies currency
          ON currency.id=currency_setting.currency_id WHERE currency.kind='CRYPTO') expected_currency_count
      FROM wallet_core_test.wallet_settings setting WHERE setting.id`)).rows[0];
    await client.query(`INSERT INTO wallet_core_test.cronjob_runs
      (id,job_name,scheduled_for,worker_instance_id,status)
      VALUES ($1,'wallet-reconciliation',$2,'history-reconciliation','RUNNING')`,
    [IDS.reconciliation, seededTimes.reconciliation]);
    await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_runs
      (id,status,scheduled_for,valuation_at,applied_reconciliation_alert_percent,
       applied_configuration_revision,comparison_rule,expected_currency_count,
       include_treasury,include_collection,applied_reconciliation_alert_basis)
      VALUES ($1,NULL,$2,$2,$3,$4,'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',
        $5,$6,$7,$8)`, [IDS.reconciliation, seededTimes.reconciliation,
      capture.reconciliation_alert_percent, capture.configuration_revision,
      capture.expected_currency_count, capture.include_treasury, capture.include_collection,
      capture.reconciliation_alert_basis]);
    await client.query(`INSERT INTO wallet_core_test.state_events
      (id,event_type,subject_type,subject_id,run_id,payload)
      SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY',currency.id,$1,
        jsonb_build_object('binanceReference',setting.binance_reference,'userMerchant','0',
          'userMerchantPositive','0','treasury','0','collection','0','price',NULL)
      FROM wallet_core_test.currency_settings setting
      JOIN price_conversion_test.currencies currency ON currency.id=setting.currency_id
      WHERE currency.kind='CRYPTO'`, [IDS.reconciliation]);
    await client.query(`INSERT INTO wallet_core_test.state_events
      (id,event_type,subject_type,subject_id,run_id,payload)
      SELECT gen_random_uuid(),'RECONCILIATION.CONFIG_SNAPSHOT','CURRENCY_CHAIN',binding.id,$1,
        jsonb_build_object('currencyId',currency.id,'chainShortName',chain.short_name,
          'currencyName',currency.name,'blockchainPrecision',binding.blockchain_precision,
          'isToken',binding.is_token,'isNative',binding.is_native)
      FROM wallet_core_test.currencies binding
      JOIN wallet_core_test.chains chain ON chain.id=binding.chain_id
      JOIN price_conversion_test.currencies currency ON currency.id=binding.currency_id
      JOIN wallet_core_test.currency_settings setting ON setting.currency_id=currency.id
      WHERE currency.kind='CRYPTO'`, [IDS.reconciliation]);
    await client.query(`UPDATE wallet_core_test.wallet_reconciliation_runs
      SET status='FAILED',safe_error_code='LEDGER_UNAVAILABLE',completed_at=$2 WHERE id=$1`,
    [IDS.reconciliation, seededTimes.reconciliationCompleted]);
    await client.query(`UPDATE wallet_core_test.cronjob_runs SET status='FAILED',
      safe_error_code='DEPENDENCY_UNAVAILABLE',lease_expires_at=NULL,finished_at=$2 WHERE id=$1`,
    [IDS.reconciliation, seededTimes.reconciliationCompleted]);
    await client.query(`INSERT INTO wallet_core_test.delisting_executions
      (id,currency_id,policy_revision,deadline,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'RUNNING',$5,$5)`,
    [IDS.forfeiture, currencyId, seededPolicyRevision,
      seededTimes.forfeitureDeadline, seededTimes.forfeiture]);
    await client.query(`UPDATE wallet_core_test.delisting_executions
      SET status='COMPLETED',updated_at=$2 WHERE id=$1`,
    [IDS.forfeiture, seededTimes.forfeitureUpdated]);
    await client.query(`INSERT INTO wallet_core_test.cronjob_runs
      (id,job_name,scheduled_for,worker_instance_id,attempt_count,status,processed_count,
       failed_count,lease_expires_at,started_at,finished_at) VALUES
      ($1,'wallet-history',$2,'history-worker',1,'RUNNING',1,0,$3,$4,NULL)`,
    [IDS.job, seededTimes.jobScheduled, seededTimes.jobLease, seededTimes.jobStarted]);
    await client.query(`UPDATE wallet_core_test.cronjob_runs
      SET status='SUCCESS',lease_expires_at=NULL,finished_at=$2
       WHERE id=$1`, [IDS.job, seededTimes.jobFinished]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

describe('Wallet Core seven-category history', { skip: !LIVE }, () => {
  let pool: TestPool;
  let repository: WalletCoreHistoryRepository;
  before(async () => {
    pool = new TestPool(new pg.Pool({ connectionString: TEST_URL, max: 4 }));
    repository = new WalletCoreHistoryRepository(
      createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS),
    );
    await seed(pool.pool);
  });
  after(async () => { await pool.end(); });

  it('maps the exact safe union, timestamp sources, and canonical actors', async () => {
    const page = await repository.history({ limit: 20 });
    const items = page.items.slice(0, 8);

    assert.deepEqual(items.map(({ category }) => category), [
      'CONFIGURATION', 'STATE', 'PROVIDER', 'PROVIDER', 'ALERT',
      'RECONCILIATION', 'FORFEITURE', 'JOB',
    ]);
    assert.deepEqual(items.map(({ createdAt }) => createdAt), [
      seededTimes.configuration, seededTimes.state, seededTimes.recovered,
      seededTimes.pinned, seededTimes.alert, seededTimes.reconciliation,
      seededTimes.forfeiture, seededTimes.jobStarted,
    ]);
    assert.deepEqual(items.map(({ actor }) => actor), [
      { kind: 'ADMIN', adminId: IDS.admin }, { kind: 'ADMIN', adminId: IDS.admin },
      { kind: 'SYSTEM', runId: IDS.system }, { kind: 'ADMIN', adminId: IDS.admin },
      null, null, null, null,
    ]);
    const configuration = items[0];
    assert.ok(configuration?.category === 'CONFIGURATION');
    assert.deepEqual(configuration.configuration, {
      id: IDS.config, revision: seededConfigurationRevision, status: 'ARCHIVED', reason: 'approved',
      changelogId: null, actorId: IDS.admin, effectiveAt: null,
      appliedAt: null,
      createdAt: seededTimes.configuration,
    });
    const state = items[1];
    assert.ok(state?.category === 'STATE');
    assert.deepEqual(state, { id: IDS.state, category: 'STATE',
      createdAt: seededTimes.state, actor: { kind: 'ADMIN', adminId: IDS.admin },
      eventType: 'CURRENCY.STATUS_CHANGED', subject: { type: 'CURRENCY', id: seededCurrencyId },
      fromState: 'OFF', toState: 'ON', reasonCode: 'POLICY_CHANGED' });
    const recovered = items[2]; const pinned = items[3];
    assert.ok(recovered?.category === 'PROVIDER' && pinned?.category === 'PROVIDER');
    assert.deepEqual([recovered.fromState, recovered.toState,
      recovered.beforeMaintenancePinned, recovered.afterMaintenancePinned],
    ['UNAVAILABLE', 'ACTIVATED', null, null]);
    assert.deepEqual([pinned.fromState, pinned.toState,
      pinned.beforeMaintenancePinned, pinned.afterMaintenancePinned],
    [null, null, false, true]);
    const alert = items[4]; const reconciliation = items[5];
    const forfeiture = items[6]; const job = items[7];
    assert.ok(alert?.category === 'ALERT' && reconciliation?.category === 'RECONCILIATION'
      && forfeiture?.category === 'FORFEITURE' && job?.category === 'JOB');
    assert.deepEqual(alert, { id: IDS.alertEvent, category: 'ALERT',
      createdAt: seededTimes.alert, actor: null, alertId: IDS.alert,
      alertCategory: 'CATALOGUE_REFRESH_FAILED', status: 'ACTIVE', currencyId: null });
    assert.deepEqual(reconciliation, { id: IDS.reconciliation, category: 'RECONCILIATION',
      createdAt: seededTimes.reconciliation, actor: null, runId: IDS.reconciliation,
      status: 'FAILED', scheduledFor: seededTimes.reconciliation,
      completedAt: seededTimes.reconciliationCompleted, currencyCount: 0, warningCount: 0,
      safeErrorCode: 'LEDGER_UNAVAILABLE' });
    assert.deepEqual(forfeiture, { id: IDS.forfeiture, category: 'FORFEITURE',
      createdAt: seededTimes.forfeiture, actor: null, executionId: IDS.forfeiture,
      currencyId: seededCurrencyId, policyRevision: seededPolicyRevision, status: 'COMPLETED',
      deadline: seededTimes.forfeitureDeadline, processedCount: 0, skippedCount: 0,
      failedCount: 0, safeErrorCode: null });
    assert.deepEqual(job, { id: IDS.job, category: 'JOB',
      createdAt: seededTimes.jobStarted, actor: null, jobName: 'wallet-history',
      scheduledFor: seededTimes.jobScheduled, status: 'SUCCESS', attemptCount: 1,
      processedCount: 1, failedCount: 0, safeErrorCode: null, leaseExpiresAt: null,
      finishedAt: seededTimes.jobFinished });
    const serialized = JSON.stringify(page);
    for (const forbidden of ['eventKey', 'snapshot', 'dedupeKey', 'workerInstanceId',
      'providerPayload', 'authorization', 'ciphertext']) assert.equal(serialized.includes(forbidden), false);
  });

  it('continues exactly across microsecond ties and ignores a new head', async () => {
    const tiedAt = seededTimes.tie;
    const tieIds = [uuidv7(), uuidv7(), uuidv7()].sort();
    for (const id of tieIds) await pool.pool.query(`INSERT INTO wallet_core_test.state_events
      (id,event_type,subject_type,subject_id,actor_id,payload,created_at)
      VALUES ($1,'CHAIN.STATUS_CHANGED','CHAIN',$2,$3,$4,$5)`, [id, IDS.config, IDS.admin,
      { before: { desiredState: 'OFF' }, after: { desiredState: 'ON' }, metadata: {} }, tiedAt]);
    const first = await repository.history({ limit: 2 });
    assert.deepEqual(first.items.map(({ id }) => id), [tieIds[2], tieIds[1]]);
    assert.deepEqual(decodeWalletQueryCursor(first.nextCursor ?? '', 'HISTORY',
      walletQueryFingerprint({ sortDirection: 'desc' }), 2), [tiedAt, tieIds[1]]);

    const headId = uuidv7();
    await pool.pool.query(`INSERT INTO wallet_core_test.state_events
      (id,event_type,subject_type,subject_id,actor_id,payload,created_at)
      VALUES ($1,'CHAIN.STATUS_CHANGED','CHAIN',$2,$3,$4,$5)`, [headId, IDS.config, IDS.admin,
      { before: { desiredState: 'OFF' }, after: { desiredState: 'ON' }, metadata: {} },
      seededTimes.head]);
    const second = await repository.history({ limit: 2, cursor: first.nextCursor ?? undefined });
    assert.equal(second.items[0]?.id, tieIds[0]);
    assert.equal(second.items.some(({ id }) => id === headId), false);
    assert.equal(second.items.some(({ id }) => id === tieIds[1] || id === tieIds[2]), false);
  });
});
