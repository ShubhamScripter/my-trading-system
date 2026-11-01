import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

type PoolLike = {
  query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
};
type ClientLike = Pick<PoolLike, 'query'>;

type GuardModule = {
  assertSafeWalletCoreTestDatabase(
    env: NodeJS.ProcessEnv,
    connect?: (connectionString: string) => Promise<PoolLike>,
    inspectDocker?: () => Promise<unknown>,
  ): Promise<PoolLike>;
  mapSchemaIdentifiers(sql: string, from: string, to: string): string;
  unwrapMigrationTransaction(source: string): string;
  applyMappedAuditBootstrap(client: ClientLike, sources: readonly string[]): Promise<void>;
};

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const BASE_ENV = {
  NODE_ENV: 'test',
  WALLET_CORE_TEST_ALLOW_RESET: 'true',
  WALLET_CORE_TEST_DATABASE_URL: TEST_URL,
  WALLET_CORE_DATABASE_URL: 'postgresql://wallet_runtime:x@127.0.0.1:1/runtime?schema=wallet_core',
  WALLET_CORE_DATABASE_DIRECT_URL: 'postgresql://wallet_owner:x@127.0.0.1:2/runtime?schema=wallet_core',
  DATABASE_URL: 'postgresql://ledger_runtime:x@127.0.0.1:3/runtime?schema=ledger',
  DATABASE_DIRECT_URL: 'postgresql://ledger_owner:x@127.0.0.1:4/runtime?schema=ledger',
  PRICE_DATABASE_URL: 'postgresql://price_runtime:x@127.0.0.1:5/runtime?schema=price_conversion',
  PRICE_DATABASE_DIRECT_URL: 'postgresql://price_owner:x@127.0.0.1:6/runtime?schema=price_conversion',
} satisfies NodeJS.ProcessEnv;
const DOCUMENTED_ENV = {
  NODE_ENV: 'test',
  WALLET_CORE_TEST_ALLOW_RESET: 'true',
  WALLET_CORE_TEST_DATABASE_URL: TEST_URL,
  WALLET_CORE_DATABASE_URL: BASE_ENV.WALLET_CORE_DATABASE_URL,
  WALLET_CORE_DATABASE_DIRECT_URL: BASE_ENV.WALLET_CORE_DATABASE_DIRECT_URL,
} satisfies NodeJS.ProcessEnv;
const DOCKER = [{
  Name: '/orebit-wallet-core-postgres-test',
  State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55435' }] } },
}];
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;

async function loadGuard(): Promise<GuardModule> {
  return import(pathToFileURL(resolve(
    __dirname, '../provision-test-database.cjs',
  )).href) as Promise<GuardModule>;
}

describe('Wallet Core destructive database guard', () => {
  it('accepts the documented environment and rejects optional runtime collisions when present', async () => {
    const { assertSafeWalletCoreTestDatabase } = await loadGuard();
    const pool: PoolLike = {
      async query() {
        return { rows: [{ database: 'orebit_wallet_core_test', cluster: 'orebit_wallet_core_test', address: '172.18.0.2/32', port: 5432 }] };
      },
      async end() {},
    };
    assert.equal(await assertSafeWalletCoreTestDatabase(
      DOCUMENTED_ENV, async () => pool, async () => DOCKER,
    ), pool);
    for (const name of ['DATABASE_URL', 'DATABASE_DIRECT_URL',
      'PRICE_DATABASE_URL', 'PRICE_DATABASE_DIRECT_URL']) {
      let connected = false;
      await assert.rejects(() => assertSafeWalletCoreTestDatabase(
        { ...DOCUMENTED_ENV, [name]: TEST_URL },
        async () => { connected = true; return pool; }, async () => DOCKER,
      ));
      assert.equal(connected, false);
    }
  });

  it('rejects unsafe URLs and runtime collisions before connect', async () => {
    const { assertSafeWalletCoreTestDatabase } = await loadGuard();
    const cases: NodeJS.ProcessEnv[] = [
      { ...BASE_ENV, NODE_ENV: 'production' },
      { ...BASE_ENV, WALLET_CORE_TEST_ALLOW_RESET: 'false' },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: '' },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: 'not-a-url' },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: TEST_URL.replace('127.0.0.1', 'localhost') },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: TEST_URL.replace('55435', '5432') },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: TEST_URL.replace('orebit_wallet_core_test', 'production') },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: TEST_URL.replace('wallet_core_test', 'wallet_core') },
      { ...BASE_ENV, WALLET_CORE_TEST_DATABASE_URL: TEST_URL + '&schema=wallet_core_test' },
      { ...BASE_ENV, DATABASE_URL: TEST_URL },
      { ...BASE_ENV, PRICE_DATABASE_DIRECT_URL: TEST_URL.replace('schema=wallet_core_test', 'schema=price_conversion') },
    ];
    for (const env of cases) {
      let connected = false;
      await assert.rejects(() => assertSafeWalletCoreTestDatabase(env, async () => {
        connected = true;
        throw new Error('must not connect');
      }, async () => DOCKER));
      assert.equal(connected, false);
    }
  });

  it('rejects wrong Docker identity or binding before connect', async () => {
    const { assertSafeWalletCoreTestDatabase } = await loadGuard();
    for (const inspection of [
      [],
      [{ ...DOCKER[0], Name: '/wrong' }],
      [{ ...DOCKER[0], State: { Running: false } }],
      [{ ...DOCKER[0], NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55435' }] } } }],
      [{ ...DOCKER[0], NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55434' }] } } }],
    ]) {
      let connected = false;
      await assert.rejects(() => assertSafeWalletCoreTestDatabase(BASE_ENV, async () => {
        connected = true;
        throw new Error('must not connect');
      }, async () => inspection));
      assert.equal(connected, false);
    }
  });

  it('returns only the exact connected disposable server', async () => {
    const { assertSafeWalletCoreTestDatabase } = await loadGuard();
    const pool: PoolLike = {
      async query() {
        return { rows: [{ database: 'orebit_wallet_core_test', cluster: 'orebit_wallet_core_test', address: '172.18.0.2/32', port: 5432 }] };
      },
      async end() {},
    };
    assert.equal(await assertSafeWalletCoreTestDatabase(BASE_ENV, async () => pool, async () => DOCKER), pool);
  });

  it('closes a connected pool when server identity is wrong', async () => {
    const { assertSafeWalletCoreTestDatabase } = await loadGuard();
    for (const identity of [
      { database: 'wrong', cluster: 'orebit_wallet_core_test', address: 'x', port: 5432 },
      { database: 'orebit_wallet_core_test', cluster: 'wrong', address: 'x', port: 5432 },
      { database: 'orebit_wallet_core_test', cluster: 'orebit_wallet_core_test', address: null, port: 5432 },
      { database: 'orebit_wallet_core_test', cluster: 'orebit_wallet_core_test', address: 'x', port: 55435 },
    ]) {
      let closed = 0;
      const pool: PoolLike = { async query() { return { rows: [identity] }; }, async end() { closed += 1; } };
      await assert.rejects(() => assertSafeWalletCoreTestDatabase(BASE_ENV, async () => pool, async () => DOCKER));
      assert.equal(closed, 1);
    }
  });

  it('maps code identifiers including dollar bodies while preserving comments and literals', async () => {
    const { mapSchemaIdentifiers } = await loadGuard();
    const source = [
      '-- admin.events remains prose',
      '/* admin.events remains block prose */',
      "SELECT 'admin.events' AS literal;",
      'SELECT "admin.events" FROM admin.events;',
      'CREATE SCHEMA IF NOT EXISTS admin;',
      'REVOKE ALL ON SCHEMA admin FROM PUBLIC;',
      'CREATE TABLE admin.events (id uuid);',
      'CREATE TABLE "admin".quoted_events (id uuid);',
      'SET search_path = pg_catalog, admin',
      'CREATE FUNCTION admin.guard() RETURNS trigger LANGUAGE plpgsql AS $body$',
      'BEGIN',
      '  -- admin.events remains body prose',
      '  /* admin.events remains body block prose */',
      "  RAISE NOTICE 'admin.events remains a literal';",
      '  PERFORM admin.events.id FROM admin.events;',
      'END;',
      '$body$;',
    ].join('\n');
    assert.equal(mapSchemaIdentifiers(source, 'admin', 'admin_test'), [
      '-- admin.events remains prose',
      '/* admin.events remains block prose */',
      "SELECT 'admin.events' AS literal;",
      'SELECT "admin.events" FROM admin_test.events;',
      'CREATE SCHEMA IF NOT EXISTS admin_test;',
      'REVOKE ALL ON SCHEMA admin_test FROM PUBLIC;',
      'CREATE TABLE admin_test.events (id uuid);',
      'CREATE TABLE "admin_test".quoted_events (id uuid);',
      'SET search_path = pg_catalog, admin_test',
      'CREATE FUNCTION admin_test.guard() RETURNS trigger LANGUAGE plpgsql AS $body$',
      'BEGIN',
      '  -- admin.events remains body prose',
      '  /* admin.events remains body block prose */',
      "  RAISE NOTICE 'admin.events remains a literal';",
      '  PERFORM admin_test.events.id FROM admin_test.events;',
      'END;',
      '$body$;',
    ].join('\n'));
  });

  it('rejects an unhandled production schema target split by non-code text', async () => {
    const { mapSchemaIdentifiers } = await loadGuard();
    await assert.rejects(async () => mapSchemaIdentifiers([
      'CREATE SCHEMA admin;',
      'CREATE TABLE admin /* ambiguous */ .events (id uuid);',
    ].join('\n'), 'admin', 'admin_test'), /production admin target/i);
  });

  it('unwraps exactly two canonical audit transactions and restores only the known membership', async () => {
    const { applyMappedAuditBootstrap } = await loadGuard();
    const calls: string[] = [];
    let membershipRead = 0;
    const options = { admin_option: false, inherit_option: true, set_option: true,
      current_grantor: true };
    const client: ClientLike = { async query(sql) {
      calls.push(sql);
      if (sql.includes('membership.admin_option')) {
        membershipRead += 1;
        return { rows: membershipRead <= 2 ? [options] : [] };
      }
      return { rows: [] };
    } };
    await applyMappedAuditBootstrap(client, [
      'BEGIN;\nSELECT 1 AS audit_one;\nCOMMIT;',
      'BEGIN;\nSELECT 2 AS audit_two;\nCOMMIT;',
    ]);
    assert.equal(calls[0], 'BEGIN');
    assert.match(calls[1] ?? '', /wallet_lifecycle_test_worker/);
    assert.equal(calls[2], 'REVOKE orebit_admin_audit_writer FROM wallet_lifecycle_test_worker');
    assert.match(calls[3] ?? '', /^DROP SCHEMA IF EXISTS admin_test CASCADE;/);
    assert.equal(calls[4], 'SELECT 1 AS audit_one;');
    assert.equal(calls[5], 'SELECT 2 AS audit_two;');
    assert.equal(calls[6], 'GRANT orebit_admin_audit_writer TO wallet_lifecycle_test_worker WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER');
    assert.match(calls[7] ?? '', /membership.admin_option/);
    assert.equal(calls[8], 'COMMIT');
  });

  it('rejects malformed audit units and rolls back unsafe membership or audit states', async () => {
    const { applyMappedAuditBootstrap, unwrapMigrationTransaction } = await loadGuard();
    assert.equal(unwrapMigrationTransaction('BEGIN;\nSELECT 1;\nCOMMIT;'), 'SELECT 1;');
    for (const invalid of ['SELECT 1;', 'BEGIN;\nCOMMIT;', 'BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;']) {
      assert.throws(() => unwrapMigrationTransaction(invalid));
    }
    await assert.rejects(() => applyMappedAuditBootstrap({ async query() {
      return { rows: [] };
    } }, ['BEGIN;\nSELECT 1;\nCOMMIT;']), /exactly two/);

    const wrongGrantorCalls: string[] = [];
    await assert.rejects(() => applyMappedAuditBootstrap({ async query(sql) {
      wrongGrantorCalls.push(sql);
      return { rows: sql.includes('membership.admin_option') ? [{
        admin_option: false, inherit_option: true, set_option: true,
        current_grantor: false,
      }] : [] };
    } }, ['BEGIN;\nSELECT 1;\nCOMMIT;', 'BEGIN;\nSELECT 2;\nCOMMIT;']),
    /membership options/);
    assert.deepEqual(wrongGrantorCalls.slice(-1), ['ROLLBACK']);
    assert.equal(wrongGrantorCalls.some((sql) => sql.startsWith('DROP SCHEMA')), false);

    const failedAuditCalls: string[] = [];
    await assert.rejects(() => applyMappedAuditBootstrap({ async query(sql) {
      failedAuditCalls.push(sql);
      if (sql.includes('membership.admin_option')) return { rows: [] };
      if (sql === 'SELECT 2;') throw new Error('audit failed');
      return { rows: [] };
    } }, ['BEGIN;\nSELECT 1;\nCOMMIT;', 'BEGIN;\nSELECT 2;\nCOMMIT;']),
    /audit failed/);
    assert.deepEqual(failedAuditCalls.slice(-1), ['ROLLBACK']);
    assert.equal(failedAuditCalls.includes('COMMIT'), false);
  });

  it('rolls back mapped schemas and the known membership after an Audit-unit failure',
    { skip: !LIVE }, async () => {
      const { applyMappedAuditBootstrap, mapSchemaIdentifiers } = await loadGuard();
      const pool = new pg.Pool({ connectionString: TEST_URL, max: 1 });
      const client = await pool.connect();
      const snapshot = async () => ({
        schemas: (await client.query(`SELECT
          to_regclass('admin_test.admin_audit_events')::text audit,
          to_regclass('wallet_core_test.wallet_settings')::text wallet`)).rows,
        membership: (await client.query(`SELECT granted.rolname granted,
          member.rolname member,grantor.rolname grantor,membership.admin_option,
          membership.inherit_option,membership.set_option
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid=membership.roleid
          JOIN pg_roles member ON member.oid=membership.member
          JOIN pg_roles grantor ON grantor.oid=membership.grantor
          WHERE granted.rolname='orebit_admin_audit_writer'
            AND member.rolname='wallet_lifecycle_test_worker'`)).rows,
      });
      try {
        const before = await snapshot();
        assert.equal(before.schemas[0]?.audit, 'admin_test.admin_audit_events');
        assert.equal(before.schemas[0]?.wallet, 'wallet_core_test.wallet_settings');
        assert.equal(before.membership.length, 1);
        const canonical = mapSchemaIdentifiers(await readFile(resolve(__dirname,
          '../../../admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql'),
        'utf8'), 'admin', 'admin_test');
        await assert.rejects(() => applyMappedAuditBootstrap(client, [canonical,
          'BEGIN;\nSELECT pg_catalog.injected_audit_failure();\nCOMMIT;']),
        /injected_audit_failure/);
        assert.deepEqual(await snapshot(), before);
      } finally {
        client.release();
        await pool.end();
      }
    });
});
