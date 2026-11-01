import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';
import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import {
  createValidatedWalletCoreTestDatabase,
  validateWalletCoreProductionUrl,
  WALLET_CORE_TEST_SCHEMAS,
  type WalletCoreClient,
  type WalletCorePool,
} from '../wallet-core.database.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import { WalletConfigurationConflict, WalletConfigurationInvalid } from '../wallet-core.errors.js';
import type {
  WalletAuditContext,
  WalletCorePatch,
  WalletCoreSystemAuditContext,
} from '../wallet-core.types.js';
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const AUDIT_TOKEN = 'admin.append_admin_audit_event_v1';
const ADMIN_TOKEN = 'admin_test.append_admin_audit_event_v1';
const ACTOR: WalletAuditContext = {
  actor: {
    kind: 'ADMIN',
    actorId: '550e8400-e29b-41d4-a716-446655440000',
    sessionId: '550e8400-e29b-41d4-a716-446655440001',
    requestId: '550e8400-e29b-41d4-a716-446655440002',
    ipAddress: '127.0.0.1',
    deviceId: 'task4-test',
  },
};
const SYSTEM: WalletCoreSystemAuditContext = {
  actor: { kind: 'SYSTEM', runId: '550e8400-e29b-41d4-a716-446655440003' },
};
const LOGO_ASSETS = { async attachReferencedWithTransaction() {} };
function rewriteAuditSql(sql: string): string {
  const count = sql.split(AUDIT_TOKEN).length - 1;
  if (count === 0) return sql;
  if (count !== 1) throw new Error('TEST_AUDIT_SQL_TOKEN_COUNT_INVALID');
  return sql.replace(AUDIT_TOKEN, ADMIN_TOKEN);
}
class AuditMappedClient implements WalletCoreClient {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly released: () => void,
  ) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const result = await this.client.query(rewriteAuditSql(sql), values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void {
    this.released();
    this.client.release();
  }
}
class AuditMappedPool implements WalletCorePool {
  releases = 0;
  constructor(readonly pool: pg.Pool) {}
  async connect(): Promise<WalletCoreClient> {
    return new AuditMappedClient(await this.pool.connect(), () => { this.releases += 1; });
  }
  async end(): Promise<void> {
    await this.pool.end();
  }
}
function settings(threshold: string) {
  return {
    globalDesiredState: 'ON' as const,
    catalogueMode: 'ALL' as const,
    reconciliationIncludeTreasury: true,
    reconciliationIncludeCollection: false,
    reconciliationAlertPercent: threshold, defaultCurrencyIds: [],
  };
}
function patch(
  action: WalletCorePatch['action'],
  expectedRevision: number,
  threshold: string,
  extra: Partial<WalletCorePatch> = {},
): WalletCorePatch {
  return {
    action,
    expectedRevision,
    reason: `${action.toLowerCase()} reason`,
    config: { settings: settings(threshold) },
    ...extra,
  };
}
const ENTITY_IDS = {
  chain: '01950000-0000-7000-8000-000000000001',
  currency: '01950000-0000-7000-8000-000000000002',
  binding: '01950000-0000-7000-8000-000000000003',
} as const;
function entityConfig() {
  return {
    settings: { ...settings('14'), globalDesiredState: 'OFF' as const },
    chains: [{
      id: ENTITY_IDS.chain,
      providerChainId: 950001,
      blockchainReference: 'task-four-chain',
      name: 'Task Four Chain',
      shortName: 'T4CHAIN',
      isEvm: true,
      availableFor: 'BOTH' as const,
      desiredState: 'ON' as const,
    }],
    currencies: [{
      id: ENTITY_IDS.currency,
      symbol: 'TFOUR',
      name: 'Task Four Coin',
      providerRefs: ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'].map((provider) => ({
        provider: provider as 'COINGECKO' | 'ALCHEMY' | 'COINMARKETCAP',
        providerAssetId: `task-four-${provider.toLowerCase()}`,
        providerSymbol: 'TFOUR',
      })),
      viewEnabled: true,
      geoCountryDeny: [],
      geoContinentDeny: [],
      accessLevel: 'ALL' as const,
      availableFor: 'BOTH' as const,
      listingKind: 'PERMANENT' as const,
      showBeforeListing: false,
      premiumOperations: [],
      soOperations: [],
      postDelistOperations: [],
      desiredState: 'ON' as const,
      maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true },
      bindings: [{
        id: ENTITY_IDS.binding,
        chainId: ENTITY_IDS.chain,
        providerCoinId: 950002,
        blockchainReference: 'Task Four Coin',
        isToken: false,
        blockchainPrecision: 18,
        desiredState: 'ON' as const,
        hotWalletAddresses: [' 0xAbC '],
        coldWalletAddresses: ['0xDef'],
        stakingWalletAddresses: ['0xabc'],
      }],
    }],
  };
}
describe('Wallet Core Task 4 database boundary', () => {
  it('rejects production/test URL crossover and accepts only runtime wallet_core', () => {
    assert.equal(
      validateWalletCoreProductionUrl(
        'postgresql://wallet:secret@db.internal:5432/orebit?schema=wallet_core',
      ).searchParams.get('schema'),
      'wallet_core',
    );
    for (const value of [
      '', 'not-a-url', 'https://db.internal/orebit?schema=wallet_core',
      TEST_URL,
      'postgresql://wallet:x@127.0.0.1:55435/other?schema=wallet_core',
      'postgresql://wallet:x@db.internal:5432/orebit_wallet_core_test?schema=wallet_core',
      'postgresql://wallet:x@db.internal:5432/orebit?schema=wallet_core_test',
      'postgresql://wallet:x@db.internal:5432/orebit?schema=wallet_core&schema=wallet_core',
    ]) assert.throws(() => validateWalletCoreProductionUrl(value));
  });
  it('accepts only the fixed validated test schema map', async () => {
    const fake: WalletCorePool = {
      async connect() { throw new Error('not used'); },
      async end() {},
    };
    assert.equal(
      createValidatedWalletCoreTestDatabase(fake, WALLET_CORE_TEST_SCHEMAS).schemas,
      WALLET_CORE_TEST_SCHEMAS,
    );
    assert.throws(() => createValidatedWalletCoreTestDatabase(fake, {
      ...WALLET_CORE_TEST_SCHEMAS, wallet: 'wallet_core',
    }));
  });
  it('commits or rolls back and releases the checked-out client exactly once', async () => {
    const run = async (failure: 'none' | 'work' | 'commit') => {
      const calls: string[] = [];
      let releases = 0;
      const client: WalletCoreClient = {
        async query(sql) {
          calls.push(sql);
          if (failure === 'commit' && sql === 'COMMIT') throw new Error('commit failed');
          return { rows: [], rowCount: 0 };
        },
        release() { releases += 1; },
      };
      const pool: WalletCorePool = {
        async connect() { return client; },
        async end() {},
      };
      const database = createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS);
      const operation = database.transaction(async () => {
        calls.push('WORK');
        if (failure === 'work') throw new Error('work failed');
        return 'ok';
      });
      if (failure === 'none') assert.equal(await operation, 'ok');
      else await assert.rejects(() => operation, /failed/);
      return { calls, releases };
    };
    assert.deepEqual(await run('none'), { calls: ['BEGIN', 'WORK', 'COMMIT'], releases: 1 });
    assert.deepEqual(await run('work'), {
      calls: ['BEGIN', 'WORK', 'ROLLBACK'], releases: 1,
    });
    assert.deepEqual(await run('commit'), {
      calls: ['BEGIN', 'WORK', 'COMMIT', 'ROLLBACK'], releases: 1,
    });
  });
  it('rewrites exactly one canonical audit function token and nothing else', async () => {
    const source = await readFile(resolve(
      __dirname, '../../../admin-audits/admin-audit.repository.ts',
    ), 'utf8');
    assert.equal(source.split(AUDIT_TOKEN).length - 1, 1);
    const sql = `SELECT * FROM ${AUDIT_TOKEN}($1)`;
    assert.equal(rewriteAuditSql(sql), `SELECT * FROM ${ADMIN_TOKEN}($1)`);
    assert.equal(rewriteAuditSql('SELECT 1'), 'SELECT 1');
    assert.throws(() => rewriteAuditSql(`${AUDIT_TOKEN}; ${AUDIT_TOKEN}`));
  });
});
describe('Wallet Core Task 4 configuration persistence', { skip: !LIVE }, () => {
  it('persists settings actions atomically with canonical audit and exact results', async () => {
    const { WalletCoreConfigurationWriter } =
      await import('../wallet-core.configuration-writer.js');
    const mappedPool = new AuditMappedPool(new pg.Pool({ connectionString: TEST_URL, max: 8 }));
    const database = createValidatedWalletCoreTestDatabase(mappedPool, WALLET_CORE_TEST_SCHEMAS);
    const repository = new WalletCoreRepository(database);
    const audit = new AdminAuditWriterService(new AdminAuditRepository());
    const writer = new WalletCoreConfigurationWriter(repository, audit, LOGO_ASSETS);
    try {
      const direct = await writer.updateAtomically(patch('PUSH', 0, '7'), ACTOR);
      assert.deepEqual({ outcome: direct.outcome, revision: direct.revision, status: direct.status },
        { outcome: 'PUSHED', revision: '1', status: 'LIVE' });
      assert.equal((await mappedPool.pool.query(`SELECT status::text FROM wallet_core_test.configuration_changes
        WHERE id=$1`, [direct.configurationId])).rows[0].status, 'LIVE');
      assert.equal(Number((await mappedPool.pool.query(`SELECT count(*) FROM
        wallet_core_test.configuration_changes WHERE status='DRAFT'`)).rows[0].count), 0);
      const due = new Date(Date.now() + 60_000);
      const scheduled = await writer.updateAtomically(patch('SCHEDULE', 1, '8', {
        effectiveAt: due.toISOString(),
      }), ACTOR);
      assert.deepEqual({ outcome: scheduled.outcome, revision: scheduled.revision, status: scheduled.status },
        { outcome: 'SCHEDULED', revision: '2', status: 'SCHEDULED' });
      await assert.rejects(
        () => writer.applyScheduledChangeAtomically(scheduled.configurationId, new Date(), SYSTEM),
        WalletConfigurationInvalid,
      );
      const applied = await writer.applyScheduledChangeAtomically(
        scheduled.configurationId, new Date(due.getTime() + 1), SYSTEM,
      );
      assert.deepEqual({ outcome: applied.outcome, revision: applied.revision, status: applied.status },
        { outcome: 'SCHEDULE_APPLIED', revision: '2', status: 'LIVE' });
      assert.equal((await writer.applyScheduledChangeAtomically(
        scheduled.configurationId, new Date(due.getTime() + 2), SYSTEM,
      )).outcome, 'ALREADY_PROCESSED');
      const staleDue = new Date(Date.now() + 120_000);
      const stale = await writer.updateAtomically(patch('SCHEDULE', 2, '9', {
        effectiveAt: staleDue.toISOString(),
      }), ACTOR);
      await writer.updateAtomically(patch('PUSH', 3, '10'), ACTOR);
      const rejected = await writer.applyScheduledChangeAtomically(
        stale.configurationId, new Date(staleDue.getTime() + 1), SYSTEM,
      );
      assert.deepEqual({
        outcome: rejected.outcome, status: rejected.status,
        reasonCode: rejected.outcome === 'SCHEDULE_REJECTED' ? rejected.reasonCode : null,
      }, {
        outcome: 'SCHEDULE_REJECTED', status: 'REJECTED',
        reasonCode: 'STALE_SETTINGS_REVISION',
      });
      assert.equal((await writer.applyScheduledChangeAtomically(
        stale.configurationId, new Date(staleDue.getTime() + 2), SYSTEM,
      )).outcome, 'ALREADY_PROCESSED');
      const actions = (await mappedPool.pool.query(`SELECT action FROM admin_test.admin_audit_events
        WHERE domain='WALLET_CORE' AND subject_type='SETTINGS_REVISION' ORDER BY created_at,id`))
        .rows.map((row) => row.action);
      assert.deepEqual(actions.slice(-6), [
        'SETTINGS.PUSHED',
        'SETTINGS.SCHEDULED', 'SETTINGS.SCHEDULE_APPLIED',
        'SETTINGS.SCHEDULED', 'SETTINGS.PUSHED', 'SETTINGS.SCHEDULE_REJECTED',
      ]);
      assert.ok(mappedPool.releases >= 9);
    } finally {
      await mappedPool.end();
    }
  });
  it('rolls back conflicts, audit throws, replay, and concurrent losers', async () => {
    const { WalletCoreConfigurationWriter } =
      await import('../wallet-core.configuration-writer.js');
    const mappedPool = new AuditMappedPool(new pg.Pool({ connectionString: TEST_URL, max: 8 }));
    const database = createValidatedWalletCoreTestDatabase(mappedPool, WALLET_CORE_TEST_SCHEMAS);
    const repository = new WalletCoreRepository(database);
    const current = Number((await mappedPool.pool.query(
      'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
    )).rows[0].revision);
    const throwing = new WalletCoreConfigurationWriter(repository, {
      async appendWithTransaction() { throw new Error('audit down'); },
    }, LOGO_ASSETS);
    const replaying = new WalletCoreConfigurationWriter(repository, {
      async appendWithTransaction() {
        return { id: '01920000-0000-7000-8000-000000000099', replayed: true };
      },
    }, LOGO_ASSETS);
    try {
      await assert.rejects(
        () => throwing.updateAtomically(patch('PUSH', current, '11'), ACTOR),
        /audit down/,
      );
      await assert.rejects(
        () => replaying.updateAtomically(patch('PUSH', current, '11'), ACTOR),
        /replay/i,
      );
      assert.equal(Number((await mappedPool.pool.query(
        'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
      )).rows[0].revision), current);
      await assert.rejects(
        () => throwing.updateAtomically(patch('PUSH', current - 1, '11'), ACTOR),
        (error: unknown) => error instanceof WalletConfigurationConflict
          && error.actualRevision === current,
      );
      const realAudit = new AdminAuditWriterService(new AdminAuditRepository());
      const writer = new WalletCoreConfigurationWriter(repository, realAudit, LOGO_ASSETS);
      const settled = await Promise.allSettled([
        writer.updateAtomically(patch('PUSH', current, '12'), ACTOR),
        writer.updateAtomically(patch('PUSH', current, '13'), ACTOR),
      ]);
      assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
      assert.equal(settled.filter((entry) => entry.status === 'rejected'
        && entry.reason instanceof WalletConfigurationConflict).length, 1);
    } finally {
      await mappedPool.end();
    }
  });
  it('persists verified entities, references, address lists, and ordered audit events', async () => {
    const { WalletCoreConfigurationWriter } =
      await import('../wallet-core.configuration-writer.js');
    const mappedPool = new AuditMappedPool(new pg.Pool({ connectionString: TEST_URL, max: 4 }));
    const database = createValidatedWalletCoreTestDatabase(mappedPool, WALLET_CORE_TEST_SCHEMAS);
    const writer = new WalletCoreConfigurationWriter(
      new WalletCoreRepository(database),
      new AdminAuditWriterService(new AdminAuditRepository()),
      LOGO_ASSETS,
    );
    try {
      await mappedPool.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_chains
        (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
        VALUES (950001,'Task Four Chain','T4CHAIN',true,'ACTIVATED',41,now())`);
      await mappedPool.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies
        (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,
         is_stake,blockchain_precision,provider_state,revision,refreshed_at)
        VALUES (950001,950002,'Task Four Coin',NULL,true,true,18,'ACTIVATED',42,now())`);
      const current = Number((await mappedPool.pool.query(
        'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
      )).rows[0].revision);
      const result = await writer.updateAtomically({
        action: 'PUSH', expectedRevision: current, reason: 'verified import',
        config: entityConfig(),
      }, ACTOR);
      assert.equal(result.outcome, 'PUSHED');
      const states = await mappedPool.pool.query(`SELECT
        (SELECT global_desired_state::text FROM wallet_core_test.wallet_settings WHERE id) global,
        (SELECT desired_state::text FROM wallet_core_test.chains WHERE id=$1) chain,
        (SELECT desired_state::text FROM wallet_core_test.currency_settings WHERE currency_id=$2) currency,
        (SELECT desired_state::text FROM wallet_core_test.currencies WHERE id=$3) binding,
        (SELECT count(*)::int FROM price_conversion_test.currency_provider_refs WHERE currency_id=$2) refs`,
      [ENTITY_IDS.chain, ENTITY_IDS.currency, ENTITY_IDS.binding]);
      assert.deepEqual(states.rows[0], {
        global: 'OFF', chain: 'ON', currency: 'ON', binding: 'ON', refs: 3,
      });
      const addresses = await mappedPool.pool.query(`SELECT kind::text,wallet_address,address_identity
        FROM wallet_core_test.custody_addresses WHERE currency_chain_id=$1 AND retired_at IS NULL ORDER BY kind`,
      [ENTITY_IDS.binding]);
      assert.deepEqual(addresses.rows, [
        { kind: 'COLD', wallet_address: '0xDef', address_identity: '0xdef' },
        { kind: 'HOT', wallet_address: '0xAbC', address_identity: '0xabc' },
        { kind: 'STAKING', wallet_address: '0xabc', address_identity: '0xabc' },
      ]);
      const actions = await mappedPool.pool.query(`SELECT action FROM admin_test.admin_audit_events
        WHERE event_key LIKE $1 ORDER BY created_at,id`, [`wallet:${result.configurationId}:%`]);
      assert.deepEqual(actions.rows.map((row) => row.action), [
        'SETTINGS.PUSHED', 'CHAIN.IMPORTED', 'CURRENCY.IMPORTED',
      ]);
      const snapshot = await mappedPool.pool.query(`SELECT snapshot FROM
        wallet_core_test.configuration_changes WHERE id=$1`, [result.configurationId]);
      const catalogue = snapshot.rows[0].snapshot.catalogue;
      assert.deepEqual(catalogue.chains.map(({ providerChainId, revision }: Record<string, number>) =>
        ({ providerChainId, revision })), [{ providerChainId: 950001, revision: 41 }]);
      assert.deepEqual(catalogue.currencies.map(({ providerChainId, providerCoinId, revision }: Record<string, number>) => ({ providerChainId, providerCoinId, revision })),
      [{ providerChainId: 950001, providerCoinId: 950002, revision: 42 }]);
    } finally {
      await mappedPool.end();
    }
  });
  it('rejects stale catalogue schedules and claims a due schedule exactly once', async () => {
    const { WalletCoreConfigurationWriter } =
      await import('../wallet-core.configuration-writer.js');
    const mappedPool = new AuditMappedPool(new pg.Pool({ connectionString: TEST_URL, max: 6 }));
    const writer = new WalletCoreConfigurationWriter(
      new WalletCoreRepository(createValidatedWalletCoreTestDatabase(
        mappedPool, WALLET_CORE_TEST_SCHEMAS,
      )),
      new AdminAuditWriterService(new AdminAuditRepository()),
      LOGO_ASSETS,
    );
    try {
      let current = Number((await mappedPool.pool.query(
        'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
      )).rows[0].revision);
      const due = new Date(Date.now() + 60_000);
      const scheduled = await writer.updateAtomically({
        action: 'SCHEDULE', expectedRevision: current, reason: 'catalogue schedule',
        effectiveAt: due.toISOString(),
        config: entityConfig(),
      }, ACTOR);
      await mappedPool.pool.query(`UPDATE wallet_core_test.provider_catalogue_currencies
        SET revision=revision+1 WHERE provider_chain_id=950001 AND provider_coin_id=950002`);
      const rejected = await writer.applyScheduledChangeAtomically(
        scheduled.configurationId, new Date(due.getTime() + 1), SYSTEM,
      );
      assert.equal(rejected.outcome, 'SCHEDULE_REJECTED');
      assert.equal(rejected.outcome === 'SCHEDULE_REJECTED'
        ? rejected.reasonCode : null, 'CATALOGUE_REVISION_CHANGED');
      assert.equal((await writer.applyScheduledChangeAtomically(
        scheduled.configurationId, new Date(due.getTime() + 2), SYSTEM,
      )).outcome, 'ALREADY_PROCESSED');
      await assert.rejects(() => writer.applyScheduledChangeAtomically(
        '01950000-0000-7000-8000-000000000099', new Date(due.getTime() + 2), SYSTEM,
      ), WalletConfigurationInvalid);
      current = Number((await mappedPool.pool.query(
        'SELECT revision FROM wallet_core_test.wallet_settings WHERE id',
      )).rows[0].revision);
      const secondDue = new Date(Date.now() + 120_000);
      const second = await writer.updateAtomically(patch('SCHEDULE', current, '15', {
        effectiveAt: secondDue.toISOString(),
      }), ACTOR);
      const claims = await Promise.all([
        writer.applyScheduledChangeAtomically(
          second.configurationId, new Date(secondDue.getTime() + 1), SYSTEM,
        ),
        writer.applyScheduledChangeAtomically(
          second.configurationId, new Date(secondDue.getTime() + 1), SYSTEM,
        ),
      ]);
      assert.deepEqual(claims.map((result) => result.outcome).sort(),
        ['ALREADY_PROCESSED', 'SCHEDULE_APPLIED']);
      const audits = await mappedPool.pool.query(`SELECT actor_kind,run_id::text FROM
        admin_test.admin_audit_events WHERE action='SETTINGS.SCHEDULE_APPLIED'
        AND event_key LIKE $1`, [`wallet:${second.configurationId}:%`]);
      assert.deepEqual(audits.rows, [{ actor_kind: 'SYSTEM', run_id: SYSTEM.actor.runId }]);
    } finally {
      await mappedPool.end();
    }
  });
  it('rolls back every entity and audit when the last provider reference fails', async () => {
    const { WalletCoreConfigurationWriter } = await import('../wallet-core.configuration-writer.js');
    const mapped = new AuditMappedPool(new pg.Pool({ connectionString: TEST_URL, max: 3 }));
    const writer = new WalletCoreConfigurationWriter(new WalletCoreRepository(
      createValidatedWalletCoreTestDatabase(mapped, WALLET_CORE_TEST_SCHEMAS)),
    new AdminAuditWriterService(new AdminAuditRepository()), LOGO_ASSETS);
    const base = entityConfig();
    const chain = { ...base.chains[0]!, id: '01960000-0000-7000-8000-000000000001', providerChainId: 960001, name: 'Rollback Chain', shortName: 'ROLLBACK' };
    const sourceCurrency = base.currencies[0]!;
    const binding = { ...sourceCurrency.bindings[0]!, id: '01960000-0000-7000-8000-000000000003', chainId: chain.id, providerCoinId: 960002 };
    const currency = { ...sourceCurrency, id: '01960000-0000-7000-8000-000000000002', name: 'Rollback Coin', symbol: 'ROLLBACK', bindings: [binding], providerRefs: sourceCurrency.providerRefs.map((ref, index) => index === 2 ? { ...ref, providerAssetId: 'task4-final-conflict' } : ref) };
    const config = { ...base, chains: [chain], currencies: [currency] };
    try {
      await mapped.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_chains VALUES
        (960001,'Rollback Chain','ROLLBACK',true,'ACTIVATED',51,now())`);
      await mapped.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies VALUES
        (960001,960002,'Rollback Coin',NULL,true,true,18,'ACTIVATED',52,now())`);
      await mapped.pool.query(`INSERT INTO price_conversion_test.currency_provider_refs
        (currency_id,provider_id,external_id,symbol) SELECT c.id,p.id,'task4-final-conflict','BTC'
        FROM price_conversion_test.currencies c,price_conversion_test.price_providers p
        WHERE c.symbol='BTC' AND p.code='COINMARKETCAP'`);
      const before = (await mapped.pool.query(`SELECT revision,(SELECT count(*) FROM admin_test.admin_audit_events) audits
        FROM wallet_core_test.wallet_settings WHERE id`)).rows[0];
      await assert.rejects(() => writer.updateAtomically({ action: 'PUSH', expectedRevision: Number(before.revision),
        reason: 'rollback', config }, ACTOR));
      assert.deepEqual((await mapped.pool.query(`SELECT revision,(SELECT count(*) FROM admin_test.admin_audit_events) audits,
        (SELECT count(*) FROM wallet_core_test.chains WHERE id=$1) chains,
        (SELECT count(*) FROM price_conversion_test.currencies WHERE id=$2) currencies
        FROM wallet_core_test.wallet_settings WHERE id`, [chain.id, currency.id])).rows[0],
      { ...before, chains: '0', currencies: '0' });
    } finally { await mapped.end(); }
  });
});
