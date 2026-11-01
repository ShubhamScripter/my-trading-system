import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { PoolLike } from './admin-audit.postgres.fixtures.js';

type Guard = (
  env: NodeJS.ProcessEnv,
  connect?: (connectionString: string) => Promise<PoolLike>,
  inspectDocker?: () => Promise<unknown>,
) => Promise<PoolLike>;

const TEST_URL =
  'postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin';
const BASE_ENV = {
  NODE_ENV: 'test',
  ADMIN_AUDIT_TEST_ALLOW_RESET: 'true',
  ADMIN_AUDIT_TEST_DATABASE_URL: TEST_URL,
  DATABASE_URL: 'postgresql://admin:test@127.0.0.1:5432/orebit_admin?schema=admin',
  DATABASE_DIRECT_URL: 'postgresql://admin:test@127.0.0.1:5432/orebit_admin?schema=admin',
} as const;

const VERIFIED_DOCKER_INSPECTION = [
  {
    Name: '/orebit-admin-audit-postgres-test',
    State: { Running: true },
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55434' }] },
    },
  },
];

export async function loadGuard(): Promise<Guard> {
  const module = (await import(
    pathToFileURL(resolve(__dirname, 'provision-test-database.mjs')).href
  )) as {
    assertSafeAdminAuditTestDatabase?: Guard;
  };
  if (typeof module.assertSafeAdminAuditTestDatabase !== 'function') {
    throw new Error('assertSafeAdminAuditTestDatabase export is required');
  }
  return module.assertSafeAdminAuditTestDatabase;
}

export function registerAdminAuditGuardTests() {
  describe('admin audit PostgreSQL reset guard', () => {
    it('rejects every unsafe reset target before connecting', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      for (const env of [
        { ...BASE_ENV, NODE_ENV: 'production' },
        { ...BASE_ENV, ADMIN_AUDIT_TEST_ALLOW_RESET: 'false' },
        { ...BASE_ENV, DATABASE_URL: '' },
        { ...BASE_ENV, DATABASE_DIRECT_URL: '' },
        {
          ...BASE_ENV,
          ADMIN_AUDIT_TEST_DATABASE_URL:
            'postgresql://audit_test:test@db.internal:5432/orebit_admin_audit_test?schema=admin',
        },
        {
          ...BASE_ENV,
          ADMIN_AUDIT_TEST_DATABASE_URL:
            'postgresql://audit_test:test@localhost:55434/orebit_admin_audit_test?schema=admin',
        },
        {
          ...BASE_ENV,
          ADMIN_AUDIT_TEST_DATABASE_URL:
            'postgresql://audit_test:test@127.0.0.1:5432/orebit_admin_audit_test?schema=admin',
        },
        { ...BASE_ENV, ADMIN_AUDIT_TEST_DATABASE_URL: BASE_ENV.DATABASE_URL },
        {
          ...BASE_ENV,
          ADMIN_AUDIT_TEST_DATABASE_URL:
            'postgresql://audit_test:test@127.0.0.1:5432/not_the_test_database?schema=admin',
        },
      ]) {
        let connected = false;
        await assert.rejects(() =>
          assertSafeAdminAuditTestDatabase(
            env,
            async () => {
              connected = true;
              throw new Error('must not connect');
            },
            async () => VERIFIED_DOCKER_INSPECTION,
          ),
        );
        assert.equal(connected, false);
      }
    });

    it('rejects absent, malformed, and non-PostgreSQL URLs before connecting', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      for (const urlName of [
        'ADMIN_AUDIT_TEST_DATABASE_URL',
        'DATABASE_URL',
        'DATABASE_DIRECT_URL',
      ] as const) {
        for (const value of ['', 'not a URL', 'https://example.test/admin']) {
          let connected = false;
          await assert.rejects(() =>
            assertSafeAdminAuditTestDatabase(
              {
                ...BASE_ENV,
                [urlName]: value,
              },
              async () => {
                connected = true;
                throw new Error('must not connect');
              },
              async () => VERIFIED_DOCKER_INSPECTION,
            ),
          );
          assert.equal(connected, false);
        }
      }
    });

    it('rejects duplicate test schema parameters before connecting', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      let connected = false;
      await assert.rejects(() =>
        assertSafeAdminAuditTestDatabase(
          {
            ...BASE_ENV,
            ADMIN_AUDIT_TEST_DATABASE_URL: `${TEST_URL}&schema=admin`,
          },
          async () => {
            connected = true;
            throw new Error('must not connect');
          },
          async () => VERIFIED_DOCKER_INSPECTION,
        ),
      );
      assert.equal(connected, false);
    });

    it('rejects runtime endpoints equal to the test endpoint despite credential or query differences', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      for (const runtimeUrl of [
        'postgresql://another_user:another_password@localhost:55434/orebit_admin_audit_test?application_name=admin&schema=admin',
        'postgresql://another_user:another_password@127.0.0.1:55434/orebit_admin_audit_test?schema=admin&application_name=admin',
      ]) {
        let connected = false;
        await assert.rejects(() =>
          assertSafeAdminAuditTestDatabase(
            {
              ...BASE_ENV,
              DATABASE_URL: runtimeUrl,
            },
            async () => {
              connected = true;
              throw new Error('must not connect');
            },
            async () => VERIFIED_DOCKER_INSPECTION,
          ),
        );
        assert.equal(connected, false);
      }
    });

    it('rejects the dedicated host port independently for both runtime URLs', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      const dedicatedPort =
        'postgresql://another_user:another_password@127.0.0.1:55434/not_the_test_database?schema=admin';
      for (const urlName of ['DATABASE_URL', 'DATABASE_DIRECT_URL'] as const) {
        let connected = false;
        await assert.rejects(() =>
          assertSafeAdminAuditTestDatabase(
            {
              ...BASE_ENV,
              [urlName]: dedicatedPort,
            },
            async () => {
              connected = true;
              throw new Error('must not connect');
            },
            async () => VERIFIED_DOCKER_INSPECTION,
          ),
        );
        assert.equal(connected, false);
      }
    });

    it('rejects a noncanonical Docker container or published binding before connecting', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      for (const inspection of [
        [{ ...VERIFIED_DOCKER_INSPECTION[0], Name: '/another-postgres' }],
        [{ ...VERIFIED_DOCKER_INSPECTION[0], State: { Running: false } }],
        [],
        [{}],
        [
          {
            ...VERIFIED_DOCKER_INSPECTION[0],
            NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55434' }] } },
          },
        ],
        [
          {
            ...VERIFIED_DOCKER_INSPECTION[0],
            NetworkSettings: {
              Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55433' }] },
            },
          },
        ],
      ]) {
        let connected = false;
        await assert.rejects(() =>
          assertSafeAdminAuditTestDatabase(
            BASE_ENV,
            async () => {
              connected = true;
              throw new Error('must not connect');
            },
            async () => inspection,
          ),
        );
        assert.equal(connected, false);
      }
    });

    it('returns the connected pool only after the verified dedicated server identity', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      const queries: string[] = [];
      const pool: PoolLike = {
        async query(sql) {
          queries.push(sql);
          return {
            rows: [
              {
                currentDatabase: 'orebit_admin_audit_test',
                clusterName: 'orebit_admin_audit_test',
                serverAddress: '172.18.0.2',
                serverPort: 5432,
              },
            ],
          };
        },
        async end() {},
      };

      const result = await assertSafeAdminAuditTestDatabase(
        BASE_ENV,
        async () => pool,
        async () => VERIFIED_DOCKER_INSPECTION,
      );

      assert.equal(result, pool);
      assert.match(queries[0] ?? '', /current_database\(\)/);
    });

    it('closes the pool exactly once when post-connect identity verification fails', async () => {
      const assertSafeAdminAuditTestDatabase = await loadGuard();
      for (const result of [
        {
          currentDatabase: 'another_database',
          clusterName: 'orebit_admin_audit_test',
          serverAddress: '172.18.0.2',
          serverPort: 5432,
        },
        {
          currentDatabase: 'orebit_admin_audit_test',
          clusterName: 'another_cluster',
          serverAddress: '172.18.0.2',
          serverPort: 5432,
        },
        {
          currentDatabase: 'orebit_admin_audit_test',
          clusterName: 'orebit_admin_audit_test',
          serverAddress: null,
          serverPort: 5432,
        },
        {
          currentDatabase: 'orebit_admin_audit_test',
          clusterName: 'orebit_admin_audit_test',
          serverAddress: '172.18.0.2',
          serverPort: 5433,
        },
        new Error('identity query failed'),
      ]) {
        let ended = 0;
        const pool: PoolLike = {
          async query() {
            if (result instanceof Error) throw result;
            return { rows: [result] };
          },
          async end() {
            ended += 1;
          },
        };
        await assert.rejects(() =>
          assertSafeAdminAuditTestDatabase(
            BASE_ENV,
            async () => pool,
            async () => VERIFIED_DOCKER_INSPECTION,
          ),
        );
        assert.equal(ended, 1);
      }
    });
  });
}
