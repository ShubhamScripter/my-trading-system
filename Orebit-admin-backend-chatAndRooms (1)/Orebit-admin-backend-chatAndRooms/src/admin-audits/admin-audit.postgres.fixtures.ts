import assert from 'node:assert/strict';

export type QueryLike = {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
  }>;
};

export type PoolLike = QueryLike & {
  end(): Promise<void>;
  connect?(): Promise<QueryLike & { release(): void }>;
};

export type LiveTestContext = {
  readonly pool: PoolLike;
  readonly migrationSql: string;
  readonly membershipSql: string;
};
export const APPEND_SQL = `SELECT * FROM admin.append_admin_audit_event_v1(
  $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::uuid,$7::uuid,$8::uuid,
  $9::uuid,$10::inet,$11::text,$12::text,$13::text,$14::text,$15::jsonb,$16::jsonb,$17::jsonb
)`;
export const UUID7_A = '01920000-0000-7000-8000-000000000001';
export const UUID7_B = '01920000-0000-7000-8000-000000000002';
export const RFC_UUID = '550e8400-e29b-41d4-a716-446655440000';
export const SESSION_ID = '550e8400-e29b-41d4-a716-446655440001';
export const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440002';
export const RUN_ID = '550e8400-e29b-41d4-a716-446655440003';

export type ActorKind = 'ADMIN' | 'SYSTEM';
export type AuditInput = {
  id: string | null;
  eventKey: string;
  domain: 'WALLET_CORE' | 'DEPOSIT';
  action: string;
  actorKind: ActorKind;
  actorId: string | null;
  sessionId: string | null;
  requestId: string | null;
  runId: string | null;
  ipAddress: string | null;
  deviceId: string | null;
  subjectType: string;
  subjectId: string;
  reason: string;
  before: Record<string, unknown> | readonly unknown[] | string | null;
  after: Record<string, unknown> | readonly unknown[] | string | null;
  metadata: Record<string, unknown> | readonly unknown[] | string | null;
};

export let auditSequence = 100;

export function uuid7(): string {
  auditSequence += 1;
  return `01920000-0000-7000-8000-${auditSequence.toString(16).padStart(12, '0')}`;
}

export function actor(
  kind: ActorKind,
): Pick<
  AuditInput,
  'actorKind' | 'actorId' | 'sessionId' | 'requestId' | 'runId' | 'ipAddress' | 'deviceId'
> {
  return kind === 'ADMIN'
    ? {
        actorKind: 'ADMIN',
        actorId: RFC_UUID,
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        runId: null,
        ipAddress: '127.0.0.10',
        deviceId: 'test-device',
      }
    : {
        actorKind: 'SYSTEM',
        actorId: null,
        sessionId: null,
        requestId: null,
        runId: RUN_ID,
        ipAddress: null,
        deviceId: null,
      };
}

export function settingsInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    id: uuid7(),
    eventKey: `test:${auditSequence}`,
    domain: 'WALLET_CORE',
    action: 'SETTINGS.SAVED',
    ...actor('ADMIN'),
    subjectType: 'SETTINGS_REVISION',
    subjectId: '1',
    reason: 'test reason',
    before: null,
    after: { revision: 1, status: 'DRAFT', effectiveAt: null },
    metadata: { configurationRevision: 1 },
    ...overrides,
  };
}

export function append(pool: QueryLike, input: AuditInput) {
  return pool.query(APPEND_SQL, [
    input.id,
    input.eventKey,
    input.domain,
    input.action,
    input.actorKind,
    input.actorId,
    input.sessionId,
    input.requestId,
    input.runId,
    input.ipAddress,
    input.deviceId,
    input.subjectType,
    input.subjectId,
    input.reason,
    input.before,
    input.after,
    input.metadata,
  ]);
}

export async function rejectsSqlState(
  work: () => Promise<unknown>,
  code: string,
  message?: RegExp,
  label?: string,
) {
  await assert.rejects(
    work,
    (error: unknown) => {
      const databaseError = error as { code?: unknown; message?: unknown };
      assert.equal(databaseError.code, code);
      if (message) assert.match(String(databaseError.message), message);
      return true;
    },
    label,
  );
}

const SWITCHABLE_ROLES = new Set([
  'orebit_admin_audit_owner',
  'orebit_admin_audit_writer',
  'orebit_admin_audit_reader',
  'orebit_admin_audit_public_probe',
  'orebit_admin_runtime',
  'orebit_wallet_core_user_runtime',
  'orebit_deposit_user_runtime',
  'orebit_admin_audit_history_runtime',
]);

export async function asRole<T>(
  pool: PoolLike,
  role: string,
  work: (client: QueryLike) => Promise<T>,
): Promise<T> {
  assert.equal(SWITCHABLE_ROLES.has(role), true);
  assert.ok(pool.connect, 'live PostgreSQL pool must expose connect() for session-bound SET ROLE');
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    return await work(client);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

export function payloadRecord(value: AuditInput['before']): Record<string, unknown> {
  if (value === null) return {};
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function withPayloadValue(
  input: AuditInput,
  section: 'before' | 'after' | 'metadata',
  key: string,
  value: unknown,
): AuditInput {
  return {
    ...input,
    id: uuid7(),
    eventKey: `coverage:${auditSequence}`,
    [section]: { ...payloadRecord(input[section]), [key]: value },
  };
}
