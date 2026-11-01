import assert from 'node:assert/strict';
import test from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { Test } from '@nestjs/testing';
import 'reflect-metadata';

import '../../tests/setup.js';
import { buildWalletCoreAdminAuditEvent } from './admin-audit.payloads.js';
import { AdminAuditRepository } from './admin-audit.repository.js';
import type {
  AdminAuditPort,
  AdminAuditTransaction,
  DepositAdminAuditInput,
  WalletCoreAdminAuditInput,
} from './admin-audit.types.js';
import { AdminAuditWriterModule } from './admin-audit.writer.module.js';
import { ADMIN_AUDIT_PORT, AdminAuditWriterService } from './admin-audit.writer.service.js';
import * as publicApi from './index.js';

const UUID_V7 = '01920000-0000-7000-8000-000000000001';
const UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';
const UPPER_UUID_V7 = '0192ABCD-ABCD-7ABC-BABC-ABCDEFABCDEF';
const INVALID_VARIANT_UUID_V7 = '0192abcd-abcd-7abc-7abc-abcdefabcdef';
const APPEND_FUNCTION = ['append', 'admin', 'audit', 'event', 'v1'].join('_');
const APPEND_SQL = `SELECT audit_event_id AS id, replayed
FROM admin.${APPEND_FUNCTION}(
  $1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid,
  $9::uuid, $10::inet, $11, $12, $13, $14,
  $15::jsonb, $16::jsonb, $17::jsonb
)`;

const adminInput: WalletCoreAdminAuditInput = {
  domain: 'WALLET_CORE',
  action: 'SETTINGS.SAVED',
  eventKey: '  wallet:settings:1  ',
  actor: {
    kind: 'ADMIN', actorId: UUID_V4.toUpperCase(), sessionId: UUID_V4,
    requestId: UUID_V4, ipAddress: '127.0.0.1', deviceId: ' device-1 ',
  },
  subject: { type: 'SETTINGS_REVISION', id: ' 1 ' },
  reason: ' save settings ',
  before: null,
  after: { revision: 1, status: 'DRAFT', effectiveAt: null },
  metadata: { configurationRevision: 1 },
};

const systemInput: WalletCoreAdminAuditInput = {
  domain: 'WALLET_CORE',
  action: 'SETTINGS.SCHEDULE_APPLIED',
  eventKey: 'wallet:settings:scheduled:1',
  actor: { kind: 'SYSTEM', runId: UUID_V4 },
  subject: { type: 'SETTINGS_REVISION', id: '1' },
  reason: 'apply scheduled settings',
  before: { revision: 1, status: 'SCHEDULED', effectiveAt: null },
  after: { revision: 1, status: 'LIVE', effectiveAt: null },
  metadata: { configurationRevision: 1 },
};

const depositInput: DepositAdminAuditInput = {
  domain: 'DEPOSIT',
  action: 'DEPOSIT.STATUS_CHANGED',
  eventKey: 'deposit:status:1',
  actor: { kind: 'SYSTEM', runId: UUID_V4 },
  subject: { type: 'DEPOSIT', id: UUID_V7 },
  reason: 'settlement status changed',
  before: { status: 'PENDING', bucket: 'HOLD', visible: false },
  after: { status: 'SUCCESS', bucket: 'AVAILABLE', visible: true },
  metadata: { currencyId: UUID_V4 },
};

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] | undefined }>;

function recordingTransaction(rows: readonly Record<string, unknown>[]) {
  const calls: QueryCall[] = [];
  const tx: AdminAuditTransaction = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: rows as readonly Row[] };
    },
  };
  return { calls, tx };
}

test('repository makes one exact bound 17-argument function call for an ADMIN event', async () => {
  const { calls, tx } = recordingTransaction([{ id: UUID_V7, replayed: false }]);
  const repository = new AdminAuditRepository();
  const event = buildWalletCoreAdminAuditEvent(adminInput);
  const result = await repository.appendPreparedWithTransaction(tx, event);

  assert.deepEqual(result, { id: UUID_V7, replayed: false });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.sql, APPEND_SQL);
  assert.equal(call.values?.length, 17);
  assert.match(String(call.values?.[0]), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(call.values?.slice(1), [
    'wallet:settings:1', 'WALLET_CORE', 'SETTINGS.SAVED', 'ADMIN',
    UUID_V4, UUID_V4, UUID_V4, null, '127.0.0.1', 'device-1',
    'SETTINGS_REVISION', '1', 'save settings', null,
    JSON.stringify({ revision: 1, status: 'DRAFT', effectiveAt: null }),
    JSON.stringify({ configurationRevision: 1 }),
  ]);
  assert.doesNotMatch(call.sql, /\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(call.sql, new RegExp(['admin', 'audit', 'events'].join('_'), 'i'));
});

test('repository maps SYSTEM context to run_id and requires exactly one result row', async () => {
  const repository = new AdminAuditRepository();
  const event = buildWalletCoreAdminAuditEvent(systemInput);
  const recorded = recordingTransaction([{ id: UUID_V7, replayed: true }]);

  assert.deepEqual(await repository.appendPreparedWithTransaction(recorded.tx, event), {
    id: UUID_V7, replayed: true,
  });
  assert.deepEqual(recorded.calls[0]?.values?.slice(5, 11), [
    null, null, null, UUID_V4, null, null,
  ]);

  for (const rows of [[], [
    { id: UUID_V7, replayed: false },
    { id: UUID_V7, replayed: true },
  ]]) {
    const malformed = recordingTransaction(rows);
    await assert.rejects(
      () => repository.appendPreparedWithTransaction(malformed.tx, event),
      /ADMIN_AUDIT_APPEND_RESULT_INVALID/,
    );
  }
});

test('repository rejects a malformed single result row', async () => {
  const repository = new AdminAuditRepository();
  const event = buildWalletCoreAdminAuditEvent(systemInput);
  for (const row of [
    { id: 7, replayed: false },
    { id: 'not-a-uuid', replayed: false },
    { id: UUID_V4, replayed: false },
    { id: UUID_V7, replayed: 'false' },
    { id: UUID_V7 },
  ]) {
    const malformed = recordingTransaction([row]);
    await assert.rejects(
      () => repository.appendPreparedWithTransaction(malformed.tx, event),
      /ADMIN_AUDIT_APPEND_RESULT_INVALID/,
    );
  }
});

test('repository accepts uppercase UUIDv7 text and returns its lowercase form', async () => {
  const repository = new AdminAuditRepository();
  const event = buildWalletCoreAdminAuditEvent(systemInput);
  const recorded = recordingTransaction([{ id: UPPER_UUID_V7, replayed: false }]);

  assert.deepEqual(await repository.appendPreparedWithTransaction(recorded.tx, event), {
    id: UPPER_UUID_V7.toLowerCase(),
    replayed: false,
  });
});

test('repository rejects UUID-shaped v7 text with invalid variant nibble 7', async () => {
  const repository = new AdminAuditRepository();
  const event = buildWalletCoreAdminAuditEvent(systemInput);
  const malformed = recordingTransaction([{
    id: INVALID_VARIANT_UUID_V7,
    replayed: false,
  }]);

  await assert.rejects(
    () => repository.appendPreparedWithTransaction(malformed.tx, event),
    /ADMIN_AUDIT_APPEND_RESULT_INVALID/,
  );
});

test('writer accepts raw closed inputs and builder rejection happens before SQL', async () => {
  const accepted = recordingTransaction([{ id: UUID_V7, replayed: false }]);
  const writer: AdminAuditPort = new AdminAuditWriterService(new AdminAuditRepository());

  assert.deepEqual(await writer.appendWithTransaction(accepted.tx, adminInput), {
    id: UUID_V7, replayed: false,
  });
  assert.equal(accepted.calls[0]?.values?.[1], 'wallet:settings:1');

  const rejected = recordingTransaction([{ id: UUID_V7, replayed: false }]);
  assert.throws(
    () => writer.appendWithTransaction(rejected.tx, {
      ...adminInput,
      metadata: { configurationRevision: 1, rawPayload: '{}' },
    } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
  assert.equal(rejected.calls.length, 0);
});

test('writer routes Deposit input through the Deposit builder', async () => {
  const recorded = recordingTransaction([{ id: UUID_V7, replayed: false }]);
  const writer: AdminAuditPort = new AdminAuditWriterService(new AdminAuditRepository());

  await writer.appendWithTransaction(recorded.tx, depositInput);

  assert.equal(recorded.calls[0]?.values?.[2], 'DEPOSIT');
  assert.equal(recorded.calls[0]?.values?.[3], 'DEPOSIT.STATUS_CHANGED');
  assert.equal(recorded.calls[0]?.values?.[11], 'DEPOSIT');
});

test('writer module resolves only the port alias and has no imports or controllers', async () => {
  assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminAuditWriterModule), [
    AdminAuditRepository,
    AdminAuditWriterService,
    { provide: ADMIN_AUDIT_PORT, useExisting: AdminAuditWriterService },
  ]);
  assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminAuditWriterModule), [ADMIN_AUDIT_PORT]);
  assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminAuditWriterModule) ?? [], []);
  assert.deepEqual(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminAuditWriterModule) ?? [], []);

  const moduleRef = await Test.createTestingModule({ imports: [AdminAuditWriterModule] }).compile();
  try {
    assert.equal(moduleRef.get<AdminAuditPort>(ADMIN_AUDIT_PORT), moduleRef.get(AdminAuditWriterService));
  } finally {
    await moduleRef.close();
  }
});

test('barrel exposes only the canonical writer surface and unmounted history module at runtime', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'ADMIN_AUDIT_PORT',
    'AdminAuditHistoryModule',
    'AdminAuditWriterModule',
    'DEPOSIT_ADMIN_AUDIT_ACTIONS',
    'PRICE_CONVERSION_ADMIN_AUDIT_ACTIONS',
    'WALLET_CORE_ADMIN_AUDIT_ACTIONS',
    'buildDepositAdminAuditEvent',
    'buildPriceConversionAdminAuditEvent',
    'buildWalletCoreAdminAuditEvent',
  ]);
  assert.equal('AdminAuditRepository' in publicApi, false);
  assert.equal('AdminAuditWriterService' in publicApi, false);
  assert.equal('ADMIN_AUDIT_SCHEMA_DESCRIPTOR' in publicApi, false);
});
