import assert from 'node:assert/strict';
import { it } from 'node:test';

import { AdminAuditRepository } from './admin-audit.repository.js';
import { DEPOSIT_STATE, settingsState } from './admin-audit.postgres.action-cases.js';
import {
  REQUEST_ID,
  RFC_UUID,
  RUN_ID,
  SESSION_ID,
  UUID7_A,
  UUID7_B,
  actor,
  append,
  rejectsSqlState,
  settingsInput,
  uuid7,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';
import type { AdminAuditTransaction, WalletCoreAdminAuditInput } from './admin-audit.types.js';
import { AdminAuditWriterService } from './admin-audit.writer.service.js';

export function registerAdminAuditPersistenceTests(context: LiveTestContext) {
  it('replays semantic duplicates, preserves first transport, and conflicts on every semantic field', async () => {
    const original = settingsInput({
      eventKey: '  replay:key  ',
      reason: '  replay reason  ',
      subjectId: ' 42 ',
    });
    const first = await append(context.pool, original);
    assert.deepEqual(first.rows, [{ audit_event_id: original.id, replayed: false }]);
    const retry = {
      ...original,
      id: uuid7(),
      eventKey: 'replay:key',
      sessionId: '550e8400-e29b-41d4-a716-446655440011',
      requestId: '550e8400-e29b-41d4-a716-446655440012',
      ipAddress: '127.0.0.99',
      deviceId: 'retry-device',
    };
    assert.deepEqual((await append(context.pool, retry)).rows, [
      { audit_event_id: original.id, replayed: true },
    ]);
    const stored = await context.pool.query(
      `SELECT event_key, subject_id, reason, session_id::text, request_id::text,
      ip_address::text, device_id FROM admin.admin_audit_events WHERE id = $1`,
      [original.id],
    );
    assert.deepEqual(stored.rows, [
      {
        event_key: 'replay:key',
        subject_id: '42',
        reason: 'replay reason',
        session_id: SESSION_ID,
        request_id: REQUEST_ID,
        ip_address: '127.0.0.10/32',
        device_id: 'test-device',
      },
    ]);

    const conflictBase = settingsInput({
      domain: 'DEPOSIT',
      action: 'DEPOSIT.RELEASED',
      subjectType: 'DEPOSIT',
      subjectId: UUID7_A,
      eventKey: 'conflict:key',
      before: DEPOSIT_STATE,
      after: { ...DEPOSIT_STATE, status: 'SUCCESS' },
      metadata: { currencyId: RFC_UUID, grossAmount: '1' },
    });
    await append(context.pool, conflictBase);
    for (const changed of [
      { ...actor('SYSTEM') },
      { reason: 'different reason' },
      { subjectId: UUID7_B },
      { before: { ...DEPOSIT_STATE, visible: false } },
      { after: { ...DEPOSIT_STATE, status: 'FAILED' } },
      { metadata: { currencyId: RFC_UUID, grossAmount: '2' } },
    ]) {
      await rejectsSqlState(
        () => append(context.pool, { ...conflictBase, id: uuid7(), ...changed }),
        '23505',
        /ADMIN_AUDIT_EVENT_KEY_CONFLICT/,
      );
    }
  });

  it('conflicts when only ADMIN actorId or only SYSTEM runId changes', async () => {
    const adminBase = settingsInput({ eventKey: 'conflict:admin-actor-id' });
    await append(context.pool, adminBase);
    await rejectsSqlState(
      () =>
        append(context.pool, {
          ...adminBase,
          id: uuid7(),
          actorId: '550e8400-e29b-41d4-a716-446655440099',
        }),
      '23505',
      /ADMIN_AUDIT_EVENT_KEY_CONFLICT/,
    );

    const systemBase = settingsInput({
      eventKey: 'conflict:system-run-id',
      action: 'SETTINGS.SCHEDULE_APPLIED',
      ...actor('SYSTEM'),
      before: settingsState('SCHEDULED'),
      after: settingsState('LIVE'),
    });
    await append(context.pool, systemBase);
    await rejectsSqlState(
      () =>
        append(context.pool, {
          ...systemBase,
          id: uuid7(),
          runId: '550e8400-e29b-41d4-a716-446655440098',
        }),
      '23505',
      /ADMIN_AUDIT_EVENT_KEY_CONFLICT/,
    );
  });

  it('participates in rollback and converges concurrent equal appends to one row and id', async () => {
    const rolledBack = settingsInput({ eventKey: 'rollback:key' });
    assert.ok(context.pool.connect);
    const transaction = await context.pool.connect();
    try {
      await transaction.query('BEGIN');
      await append(transaction, rolledBack);
      await transaction.query('ROLLBACK');
    } finally {
      transaction.release();
    }
    assert.deepEqual(
      (
        await context.pool.query('SELECT id FROM admin.admin_audit_events WHERE event_key = $1', [
          'rollback:key',
        ])
      ).rows,
      [],
    );

    const concurrent = settingsInput({ eventKey: 'concurrent:key' });
    const [one, two] = await Promise.all([
      append(context.pool, concurrent),
      append(context.pool, {
        ...concurrent,
        id: uuid7(),
        sessionId: '550e8400-e29b-41d4-a716-446655440021',
      }),
    ]);
    const firstConcurrent = one.rows[0];
    const secondConcurrent = two.rows[0];
    assert.ok(firstConcurrent);
    assert.ok(secondConcurrent);
    assert.equal(firstConcurrent.audit_event_id, secondConcurrent.audit_event_id);
    assert.deepEqual([firstConcurrent.replayed, secondConcurrent.replayed].sort(), [false, true]);
    const concurrentCount = (
      await context.pool.query(
        'SELECT count(*)::int AS count FROM admin.admin_audit_events WHERE event_key = $1',
        ['concurrent:key'],
      )
    ).rows[0];
    assert.ok(concurrentCount);
    assert.equal(concurrentCount.count, 1);
  });

  it('runs the typed writer port through the live function for ADMIN and caller-rolled-back SYSTEM events', async () => {
    const writer = new AdminAuditWriterService(new AdminAuditRepository());
    const adminInput: WalletCoreAdminAuditInput = {
      domain: 'WALLET_CORE',
      action: 'SETTINGS.SAVED',
      eventKey: 'writer:live:admin',
      actor: {
        kind: 'ADMIN',
        actorId: RFC_UUID,
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        ipAddress: '127.0.0.20',
        deviceId: 'writer-device',
      },
      subject: { type: 'SETTINGS_REVISION', id: '88' },
      reason: 'typed live writer',
      before: null,
      after: { revision: 88, status: 'DRAFT', effectiveAt: null },
      metadata: { configurationRevision: 88 },
    };
    const adminResult = await writer.appendWithTransaction(
      context.pool as unknown as AdminAuditTransaction,
      adminInput,
    );
    assert.match(
      adminResult.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(adminResult.replayed, false);
    assert.deepEqual(
      (
        await context.pool.query(
          `SELECT actor_kind, actor_id::text, run_id::text
      FROM admin.admin_audit_events WHERE id = $1`,
          [adminResult.id],
        )
      ).rows,
      [
        {
          actor_kind: 'ADMIN',
          actor_id: RFC_UUID,
          run_id: null,
        },
      ],
    );

    assert.ok(context.pool.connect);
    const client = await context.pool.connect();
    try {
      await client.query('BEGIN');
      const systemResult = await writer.appendWithTransaction(
        client as unknown as AdminAuditTransaction,
        {
          ...adminInput,
          action: 'SETTINGS.SCHEDULE_APPLIED',
          eventKey: 'writer:live:system:rollback',
          actor: { kind: 'SYSTEM', runId: RUN_ID },
          reason: 'typed live worker',
          before: { revision: 88, status: 'SCHEDULED', effectiveAt: null },
          after: { revision: 88, status: 'LIVE', effectiveAt: null },
        },
      );
      assert.equal(systemResult.replayed, false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(
      (
        await context.pool.query('SELECT id FROM admin.admin_audit_events WHERE event_key = $1', [
          'writer:live:system:rollback',
        ])
      ).rows,
      [],
    );
  });
}
