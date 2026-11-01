import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { decodeAdminAuditCursor, encodeAdminAuditCursor } from './admin-audit.cursor.js';
import { AdminAuditDatabase } from './admin-audit.database.js';
import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import { AdminAuditHistoryService } from './admin-audit.history.service.js';

type QueryResult = { readonly rows: readonly Record<string, unknown>[] };
type QueryLike = { query(sql: string, values?: readonly unknown[]): Promise<QueryResult> };
type OwnerPool = QueryLike & {
  connect(): Promise<QueryLike & { release(): void }>;
  end(): Promise<void>;
};
type Guard = (env: NodeJS.ProcessEnv) => Promise<OwnerPool>;
type Fixture = Readonly<{
  id: string;
  eventKey: string;
  domain: 'WALLET_CORE' | 'DEPOSIT';
  action: string;
  actor: Readonly<{
    kind: 'ADMIN'; actorId: string; sessionId: string; requestId: string;
    ipAddress: string; deviceId: string;
  }> | Readonly<{ kind: 'SYSTEM'; runId: string }>;
  subjectType: string;
  subjectId: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

const OWNER_URL = 'postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin';
const READER_URL = 'postgresql://orebit_admin_audit_history_runtime:local_history_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin';
const UUID = {
  tie1: '01920000-0000-7000-8000-000000000001',
  tie2: '01920000-0000-7000-8000-000000000002',
  tie3: '01920000-0000-7000-8000-000000000003',
  admin: '01920000-0000-7000-8000-000000000011',
  session: '01920000-0000-7000-8000-000000000012',
  request: '01920000-0000-7000-8000-000000000013',
  run: '01920000-0000-7000-8000-000000000014',
  subject: '01920000-0000-7000-8000-000000000015',
  system: '01920000-0000-7000-8000-000000000016',
} as const;
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.ADMIN_AUDIT_TEST_ALLOW_RESET === 'true'
  && process.env.ADMIN_AUDIT_TEST_DATABASE_URL === OWNER_URL;
const canonical = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('admin audit cursor and direct history boundary', () => {
  it('round-trips only the canonical six-fraction UTC and lowercase UUIDv7 tuple', () => {
    const tuple = ['2026-09-03T12:00:00.123456Z', UUID.tie2] as const;
    const encoded = encodeAdminAuditCursor(...tuple);
    assert.equal(encoded, canonical(tuple));
    assert.deepEqual(decodeAdminAuditCursor(encoded), tuple);
  });

  it('rejects malformed or noncanonical cursors before querying', async () => {
    let queries = 0;
    const repository = new AdminAuditHistoryRepository({
      async query() { queries += 1; return { rows: [] }; },
    } as never);
    const validTuple = ['2026-09-03T12:00:00.123456Z', UUID.tie1];
    const invalid = [
      '', 'a'.repeat(513), '***', canonical(validTuple) + '=',
      Buffer.from(' ' + JSON.stringify(validTuple)).toString('base64url'),
      canonical(['2026-09-03T12:00:00.123Z', UUID.tie1]),
      canonical(['0000-01-01T00:00:00.000000Z', UUID.tie1]),
      canonical(['2026-02-31T12:00:00.123456Z', UUID.tie1]),
      canonical(['2026-09-03T12:00:00.123456Z', '550e8400-e29b-41d4-a716-446655440000']),
      canonical(['2026-09-03T12:00:00.123456Z',
        '0192a000-0000-7000-8000-000000000001'.toUpperCase()]),
      canonical(['2026-09-03T12:00:00.123456Z']),
      canonical(['2026-09-03T12:00:00.123456Z', UUID.tie1, 'extra']),
    ];
    for (const cursor of invalid) {
      assert.throws(() => decodeAdminAuditCursor(cursor), /INVALID_ADMIN_AUDIT_CURSOR/);
      await assert.rejects(
        () => repository.history({ limit: 2, cursor }),
        /INVALID_ADMIN_AUDIT_CURSOR/,
      );
    }
    assert.equal(queries, 0);
  });

  it('normalizes every filter into fixed SQL and bound parameters', async () => {
    let captured: { sql: string; values?: readonly unknown[] } | undefined;
    const repository = new AdminAuditHistoryRepository({
      async query(sql: string, values?: readonly unknown[]) {
        captured = { sql, values };
        return { rows: [] };
      },
    } as never);
    const cursor = encodeAdminAuditCursor('2026-09-03T12:00:00.123456Z', UUID.tie3);
    assert.deepEqual(await repository.history({
      domain: 'DEPOSIT', action: 'DEPOSIT.STATUS_CHANGED', actorId: UUID.admin,
      runId: UUID.run, subjectType: 'DEPOSIT', subjectId: UUID.subject,
      from: '2026-09-03T10:00:00.000000Z', to: '2026-09-04T10:00:00.000000Z',
      cursor, limit: 7,
    }), { items: [], nextCursor: null });
    for (const fragment of [
      'FROM admin.admin_audit_events', 'domain = $1', 'action = $2',
      'actor_id = $3::uuid', 'run_id = $4::uuid', 'subject_type = $5',
      'subject_id = $6', 'created_at >= $7::timestamptz',
      'created_at < $8::timestamptz',
      '(created_at, id) < ($9::timestamptz, $10::uuid)',
      'ORDER BY created_at DESC, id DESC', 'LIMIT $11',
    ]) assert.ok(captured?.sql.includes(fragment), fragment);
    assert.deepEqual(captured?.values, [
      'DEPOSIT', 'DEPOSIT.STATUS_CHANGED', UUID.admin, UUID.run, 'DEPOSIT', UUID.subject,
      '2026-09-03T10:00:00.000000Z', '2026-09-04T10:00:00.000000Z',
      '2026-09-03T12:00:00.123456Z', UUID.tie3, 8,
    ]);
  });

  it('fails closed on invalid direct-service queries and defaults limit to 50', async () => {
    const limits: unknown[] = [];
    const service = new AdminAuditHistoryService(new AdminAuditHistoryRepository({
      async query(_sql: string, values?: readonly unknown[]) {
        limits.push(values?.at(-1));
        return { rows: [] };
      },
    } as never));
    await service.history({} as never);
    assert.deepEqual(limits, [51]);
    const invalid = [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' },
      { limit: 2, domain: 'OTHER' }, { limit: 2, action: 'UNKNOWN.ACTION' },
      { limit: 2, actorId: 'not-a-uuid' }, { limit: 2, runId: 'not-a-uuid' },
      { limit: 2, subjectType: 'DEPOSIT' }, { limit: 2, subjectId: UUID.subject },
      { limit: 2, from: '2026-09-04T00:00:00.000000Z',
        to: '2026-09-03T00:00:00.000000Z' },
      { limit: 2, extra: true },
    ];
    for (const query of invalid) {
      await assert.rejects(
        () => service.history(query as never),
        /INVALID_ADMIN_AUDIT_HISTORY_QUERY/,
      );
    }
    assert.deepEqual(limits, [51]);
  });

  it('rejects non-reader URLs before opening a usable pool', () => {
    const previous = process.env.ADMIN_AUDIT_READER_DATABASE_URL;
    try {
      for (const value of [
        '', 'not-a-url', 'https://example.test/a?schema=admin', OWNER_URL,
        READER_URL.replace('schema=admin', 'schema=public'),
        READER_URL + '&schema=admin',
      ]) {
        process.env.ADMIN_AUDIT_READER_DATABASE_URL = value;
        assert.throws(() => new AdminAuditDatabase(), /ADMIN_AUDIT_READER_DATABASE_URL/);
      }
    } finally {
      if (previous === undefined) delete process.env.ADMIN_AUDIT_READER_DATABASE_URL;
      else process.env.ADMIN_AUDIT_READER_DATABASE_URL = previous;
    }
  });
});

async function loadGuard(): Promise<Guard> {
  const loaded = await import(pathToFileURL(
    resolve(__dirname, 'provision-test-database.mjs'),
  ).href) as { assertSafeAdminAuditTestDatabase?: Guard };
  if (typeof loaded.assertSafeAdminAuditTestDatabase !== 'function') {
    throw new Error('test guard unavailable');
  }
  return loaded.assertSafeAdminAuditTestDatabase;
}

async function insertOwnerFixture(pool: OwnerPool, fixture: Fixture): Promise<void> {
  const client = await pool.connect();
  const admin = fixture.actor.kind === 'ADMIN' ? fixture.actor : null;
  const system = fixture.actor.kind === 'SYSTEM' ? fixture.actor : null;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE orebit_admin_audit_owner');
    await client.query([
      'INSERT INTO admin.admin_audit_events (',
      'id,event_key,event_hash,domain,action,actor_kind,actor_id,session_id,request_id,run_id,',
      'ip_address,device_id,subject_type,subject_id,reason,before_json,after_json,metadata_json,created_at',
      ') VALUES (',
      '$1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::uuid,$10::uuid,',
      '$11::inet,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::timestamptz)',
    ].join('\n'), [
      fixture.id, fixture.eventKey, 'a'.repeat(64), fixture.domain, fixture.action,
      fixture.actor.kind, admin?.actorId ?? null, admin?.sessionId ?? null,
      admin?.requestId ?? null, system?.runId ?? null, admin?.ipAddress ?? null,
      admin?.deviceId ?? null, fixture.subjectType, fixture.subjectId, fixture.reason,
      JSON.stringify(fixture.before), JSON.stringify(fixture.after),
      JSON.stringify(fixture.metadata), fixture.createdAt,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const adminFixture = (overrides: Partial<Fixture>): Fixture => ({
  id: UUID.tie1, eventKey: 'history:' + UUID.tie1, domain: 'DEPOSIT',
  action: 'DEPOSIT.STATUS_CHANGED',
  actor: {
    kind: 'ADMIN', actorId: UUID.admin, sessionId: UUID.session,
    requestId: UUID.request, ipAddress: '203.0.113.8', deviceId: 'history-device',
  },
  subjectType: 'DEPOSIT', subjectId: UUID.subject, reason: 'history fixture',
  before: { status: 'PENDING' }, after: { status: 'SUCCESS' },
  metadata: { currencyId: UUID.subject },
  createdAt: '2026-09-03T12:00:00.123456Z',
  ...overrides,
});

describe('admin audit reader database and live history', { skip: !LIVE }, () => {
  let owner: OwnerPool;
  let reader: AdminAuditDatabase;
  let repository: AdminAuditHistoryRepository;

  before(async () => {
    owner = await (await loadGuard())(process.env);
    await owner.query([
      'DO $cleanup$ BEGIN',
      "IF to_regrole('orebit_admin_audit_history_runtime') IS NOT NULL THEN",
      "IF to_regrole('orebit_admin_audit_reader') IS NOT NULL THEN",
      'REVOKE orebit_admin_audit_reader FROM orebit_admin_audit_history_runtime;',
      'END IF;',
      "IF to_regrole('orebit_admin_audit_writer') IS NOT NULL THEN",
      'REVOKE orebit_admin_audit_writer FROM orebit_admin_audit_history_runtime;',
      'END IF; END IF; END $cleanup$',
    ].join('\n'));
    await owner.query('DROP SCHEMA IF EXISTS admin CASCADE');
    await owner.query(await readFile(resolve(
      __dirname, 'migrations/202609030001_global_admin_audit_events/migration.sql',
    ), 'utf8'));
    await owner.query([
      'DO $runtime$ BEGIN',
      "IF to_regrole('orebit_admin_audit_history_runtime') IS NULL THEN",
      "CREATE ROLE orebit_admin_audit_history_runtime LOGIN PASSWORD 'local_history_audit_test_only';",
      'END IF; END $runtime$;',
      'ALTER ROLE orebit_admin_audit_history_runtime LOGIN INHERIT NOSUPERUSER',
      "NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'local_history_audit_test_only';",
      'REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_history_runtime;',
      'REVOKE ALL ON FUNCTION admin.append_admin_audit_event_v1(',
      'uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb',
      ') FROM orebit_admin_audit_history_runtime;',
      'REVOKE CREATE ON SCHEMA admin FROM orebit_admin_audit_history_runtime;',
      'GRANT orebit_admin_audit_reader TO orebit_admin_audit_history_runtime;',
    ].join('\n'));
    process.env.ADMIN_AUDIT_READER_DATABASE_URL = READER_URL;
    reader = new AdminAuditDatabase();
    await reader.onModuleInit();
    repository = new AdminAuditHistoryRepository(reader);
  });

  after(async () => {
    if (reader) await reader.onModuleDestroy();
    if (!owner) return;
    try {
      await owner.query([
        'REVOKE orebit_admin_audit_reader FROM orebit_admin_audit_history_runtime;',
        'REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_history_runtime;',
        'REVOKE CREATE ON SCHEMA admin FROM orebit_admin_audit_history_runtime;',
      ].join('\n'));
    } finally {
      await owner.end();
      delete process.env.ADMIN_AUDIT_READER_DATABASE_URL;
    }
  });

  it('uses id as the exact tiebreaker at an equal microsecond timestamp', async () => {
    for (const id of [UUID.tie3, UUID.tie2, UUID.tie1]) {
      await insertOwnerFixture(owner, adminFixture({ id, eventKey: 'tie:' + id }));
    }
    const first = await repository.history({
      domain: 'DEPOSIT', action: 'DEPOSIT.STATUS_CHANGED', limit: 2,
    });
    assert.deepEqual(first.items.map((item) => item.id), [UUID.tie3, UUID.tie2]);
    assert.equal(first.items[0]?.createdAt, '2026-09-03T12:00:00.123456Z');
    assert.ok(first.nextCursor);
    const second = await repository.history({
      domain: 'DEPOSIT', action: 'DEPOSIT.STATUS_CHANGED', limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.items.map((item) => item.id), [UUID.tie1]);
    assert.equal(second.nextCursor, null);
  });

  it('continues after a new head append without gaps or repeats', async () => {
    const ids = [1, 2, 3, 4].map(
      (n) => '01920000-0000-7000-8000-00000000010' + n,
    );
    for (const [index, id] of ids.entries()) {
      await insertOwnerFixture(owner, adminFixture({
        id, eventKey: 'append:' + id, domain: 'WALLET_CORE',
        action: 'CURRENCY.UPDATED',
        createdAt: '2026-09-03T0' + (index + 1) + ':00:00.000001Z',
      }));
    }
    const first = await repository.history({
      domain: 'WALLET_CORE', action: 'CURRENCY.UPDATED', limit: 2,
    });
    const newer = '01920000-0000-7000-8000-000000000109';
    await insertOwnerFixture(owner, adminFixture({
      id: newer, eventKey: 'append:' + newer, domain: 'WALLET_CORE',
      action: 'CURRENCY.UPDATED', createdAt: '2026-09-03T09:00:00.000001Z',
    }));
    const second = await repository.history({
      domain: 'WALLET_CORE', action: 'CURRENCY.UPDATED', limit: 100,
      cursor: first.nextCursor ?? undefined,
    });
    const traversed = [...first.items, ...second.items].map((item) => item.id);
    assert.equal(new Set(traversed).size, traversed.length);
    assert.equal(traversed.includes(newer), false);
    assert.deepEqual(traversed, [...ids].reverse());
  });

  it('applies all filters and reconstructs both actor variants', async () => {
    const atFrom = adminFixture({
      id: UUID.admin, eventKey: 'filters:admin', action: 'BLOCKER.WAIVED',
      subjectType: 'DEPOSIT_BLOCKER', createdAt: '2026-09-03T10:00:00.000001Z',
    });
    const atTo = adminFixture({
      id: UUID.system, eventKey: 'filters:exclusive', action: 'BLOCKER.WAIVED',
      subjectType: 'DEPOSIT_BLOCKER', createdAt: '2026-09-03T11:00:00.000001Z',
    });
    const system = adminFixture({
      id: '01920000-0000-7000-8000-000000000017', eventKey: 'filters:system',
      domain: 'WALLET_CORE', action: 'SETTINGS.SCHEDULE_APPLIED',
      actor: { kind: 'SYSTEM', runId: UUID.run }, subjectType: 'SETTINGS_REVISION',
      createdAt: '2026-09-03T10:30:00.000001Z',
    });
    await insertOwnerFixture(owner, atFrom);
    await insertOwnerFixture(owner, atTo);
    await insertOwnerFixture(owner, system);
    const adminPage = await repository.history({
      domain: 'DEPOSIT', action: 'BLOCKER.WAIVED', actorId: UUID.admin,
      subjectType: 'DEPOSIT_BLOCKER', subjectId: UUID.subject,
      from: '2026-09-03T10:00:00.000001Z', to: '2026-09-03T11:00:00.000001Z',
      limit: 10,
    });
    assert.deepEqual(adminPage.items.map((item) => item.id), [UUID.admin]);
    assert.deepEqual(adminPage.items[0], {
      id: atFrom.id,
      eventKey: atFrom.eventKey,
      domain: atFrom.domain,
      action: atFrom.action,
      actor: atFrom.actor,
      subject: { type: atFrom.subjectType, id: atFrom.subjectId },
      reason: atFrom.reason,
      before: atFrom.before,
      after: atFrom.after,
      metadata: atFrom.metadata,
      createdAt: atFrom.createdAt,
    });
    assert.deepEqual(
      Object.keys(adminPage.items[0] ?? {}).sort(),
      ['action', 'actor', 'after', 'before', 'createdAt', 'domain', 'eventKey',
        'id', 'metadata', 'reason', 'subject'].sort(),
    );
    assert.equal(Object.isFrozen(adminPage.items[0]), true);
    assert.equal(Object.isFrozen(adminPage.items[0]?.actor), true);
    assert.equal(Object.isFrozen(adminPage.items[0]?.subject), true);
    assert.equal(Object.isFrozen(adminPage.items[0]?.metadata), true);
    const systemPage = await repository.history({ runId: UUID.run, limit: 10 });
    assert.deepEqual(systemPage.items.map((item) => item.id), [system.id]);
    assert.deepEqual(systemPage.items[0]?.actor, system.actor);
  });

  it('rejects SET-reachable mutation, schema-create, and function capabilities', async () => {
    const functionSignature = [
      'admin.append_admin_audit_event_v1(',
      'uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)',
    ].join('');
    const cases = [
      ...['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN']
        .map((privilege) => ({
          grant: 'GRANT ' + privilege +
            ' ON admin.admin_audit_events TO orebit_admin_audit_history_probe',
          revoke: 'REVOKE ' + privilege +
            ' ON admin.admin_audit_events FROM orebit_admin_audit_history_probe',
        })),
      {
        grant: 'GRANT CREATE ON SCHEMA admin TO orebit_admin_audit_history_probe',
        revoke: 'REVOKE CREATE ON SCHEMA admin FROM orebit_admin_audit_history_probe',
      },
      {
        grant: 'GRANT EXECUTE ON FUNCTION ' + functionSignature +
          ' TO orebit_admin_audit_history_probe',
        revoke: 'REVOKE EXECUTE ON FUNCTION ' + functionSignature +
          ' FROM orebit_admin_audit_history_probe',
      },
    ];
    for (const testCase of cases) {
      await owner.query([
        'DROP ROLE IF EXISTS orebit_admin_audit_history_probe;',
        'CREATE ROLE orebit_admin_audit_history_probe NOLOGIN;',
        testCase.grant + ';',
        'GRANT orebit_admin_audit_history_probe',
        'TO orebit_admin_audit_history_runtime WITH INHERIT FALSE;',
        'GRANT orebit_admin_audit_history_probe',
        'TO orebit_admin_audit_history_runtime WITH SET TRUE;',
      ].join('\n'));
      try {
        const contaminated = new AdminAuditDatabase();
        await assert.rejects(
          () => contaminated.onModuleInit(),
          /ADMIN_AUDIT_READER_CAPABILITY_INVALID/,
        );
      } finally {
        await owner.query([
          'REVOKE orebit_admin_audit_history_probe FROM orebit_admin_audit_history_runtime;',
          testCase.revoke + ';',
          'DROP ROLE orebit_admin_audit_history_probe;',
        ].join('\n'));
      }
    }
  });

  it('closes its reader-only pool cleanly', async () => {
    const database = new AdminAuditDatabase();
    await database.onModuleInit();
    await database.onModuleDestroy();
    await assert.rejects(() => database.query('SELECT 1'));
  });
});
