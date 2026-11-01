import assert from 'node:assert/strict';
import { it } from 'node:test';

import { DEPOSIT_STATE, matrixInput } from './admin-audit.postgres.action-cases.js';
import {
  RFC_UUID,
  UUID7_A,
  actor,
  append,
  rejectsSqlState,
  settingsInput,
  withPayloadValue,
  type AuditInput,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditPayloadValidationTests(context: LiveTestContext) {
  it('rejects bad keys, shapes, sizes, scalar types, bounds, enums, and dependent price fields', async () => {
    const cases: AuditInput[] = [
      settingsInput({ eventKey: ' ' }),
      settingsInput({ eventKey: 'x'.repeat(201) }),
      settingsInput({ reason: ' ' }),
      settingsInput({ reason: 'x'.repeat(501) }),
      settingsInput({ before: '[]' }),
      settingsInput({ after: { revision: { nested: true } } }),
      settingsInput({ metadata: { configurationRevision: 1, unknown: true } }),
      settingsInput({ metadata: { configurationRevision: null } }),
      settingsInput({ metadata: { configurationRevision: '1' } }),
      settingsInput({ metadata: { configurationRevision: -1 } }),
      settingsInput({ metadata: { configurationRevision: 1.5 } }),
      settingsInput({ metadata: { configurationRevision: 9007199254740992 } }),
      settingsInput({ after: { revision: 1, status: 'UNKNOWN', effectiveAt: null } }),
      settingsInput({
        after: { revision: 1, status: 'DRAFT', effectiveAt: '2026-09-03T00:00:00+00:00' },
      }),
      settingsInput({
        after: { revision: 1, status: 'DRAFT', effectiveAt: '2026-09-00T00:00:00Z' },
      }),
      settingsInput({
        after: { revision: 1, status: 'DRAFT', effectiveAt: '2026-02-31T00:00:00Z' },
      }),
      settingsInput({ metadata: { configurationRevision: 1, safeErrorCode: 'x'.repeat(65) } }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'CURRENCY.UPDATED',
        subjectType: 'CURRENCY',
        subjectId: RFC_UUID,
        after: {
          symbol: 'BTC',
          name: 'Bitcoin',
          kind: 'TOKEN',
          pricingStatus: 'ACTIVE',
          desiredState: 'ON',
        },
      }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'CHAIN.STATUS_CHANGED',
        subjectType: 'CHAIN',
        subjectId: UUID7_A,
        before: { desiredState: 'ON', effectiveState: 'ON', maintenancePinned: false },
        after: { desiredState: 'BROKEN', effectiveState: 'ON', maintenancePinned: false },
      }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'RECONCILIATION.WARNING_RAISED',
        subjectType: 'CURRENCY',
        subjectId: RFC_UUID,
        ...actor('SYSTEM'),
        before: null,
        after: { active: true, partial: false, shortfallPercent: 1.5 },
        metadata: { reconciliationRunId: UUID7_A },
      }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'RECONCILIATION.WARNING_RAISED',
        subjectType: 'CURRENCY',
        subjectId: RFC_UUID,
        ...actor('SYSTEM'),
        before: null,
        after: { active: true, partial: false, shortfallPercent: '-1' },
        metadata: { reconciliationRunId: UUID7_A },
      }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'RECONCILIATION.WARNING_RAISED',
        subjectType: 'CURRENCY',
        subjectId: RFC_UUID,
        ...actor('SYSTEM'),
        before: null,
        after: { active: true, partial: false, shortfallPercent: '1.1234567890123456789' },
        metadata: { reconciliationRunId: UUID7_A },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.RELEASED',
        subjectType: 'DEPOSIT',
        subjectId: UUID7_A,
        before: DEPOSIT_STATE,
        after: { ...DEPOSIT_STATE, visible: 'true' },
        metadata: { currencyId: RFC_UUID, grossAmount: '1' },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.RELEASED',
        subjectType: 'DEPOSIT',
        subjectId: UUID7_A,
        before: DEPOSIT_STATE,
        after: DEPOSIT_STATE,
        metadata: { currencyId: 'not-a-uuid', grossAmount: '1' },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.RELEASED',
        subjectType: 'DEPOSIT',
        subjectId: UUID7_A,
        before: DEPOSIT_STATE,
        after: DEPOSIT_STATE,
        metadata: { currencyId: RFC_UUID, grossAmount: '1', priceBasis: 'WEBHOOK_TIME' },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.RELEASED',
        subjectType: 'DEPOSIT',
        subjectId: UUID7_A,
        before: DEPOSIT_STATE,
        after: DEPOSIT_STATE,
        metadata: { currencyId: RFC_UUID, grossAmount: '1', priceResolutionId: RFC_UUID },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.RELEASED',
        subjectType: 'DEPOSIT',
        subjectId: UUID7_A,
        before: DEPOSIT_STATE,
        after: DEPOSIT_STATE,
        metadata: {
          currencyId: RFC_UUID,
          grossAmount: '1',
          priceBasis: 'CURRENT',
          priceResolutionId: RFC_UUID,
          priceSnapshotId: RFC_UUID,
        },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'BLOCKER.WAIVED',
        subjectType: 'DEPOSIT_BLOCKER',
        subjectId: UUID7_A,
        before: { status: 'PENDING' },
        after: { status: 'WAIVED' },
        metadata: { depositId: UUID7_A, blockerKind: ' ' },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'QUARANTINE.ASSIGNED',
        subjectType: 'QUARANTINE',
        subjectId: UUID7_A,
        before: { status: 'OPEN', assignedUserId: null },
        after: { status: 'ASSIGNED', assignedUserId: 'bad' },
        metadata: { currencyId: RFC_UUID, grossAmount: '1' },
      }),
      settingsInput({
        after: { revision: 1, status: 'DRAFT', effectiveAt: null, padding: 'x'.repeat(65_536) },
      }),
    ];
    for (const [index, input] of cases.entries()) {
      await rejectsSqlState(
        () => append(context.pool, input),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `invalid value case ${index}`,
      );
    }
    const validTimestamp = settingsInput({
      after: { revision: 1, status: 'DRAFT', effectiveAt: '2026-09-03T00:00:00.123Z' },
    });
    assert.deepEqual((await append(context.pool, validTimestamp)).rows, [
      { audit_event_id: validTimestamp.id, replayed: false },
    ]);
  });

  it('normalizes all six ASCII edge-whitespace characters on free text and identities', async () => {
    const whitespace = [' ', '\t', '\n', '\r', '\f', '\v'];
    for (const edge of whitespace) {
      const input = settingsInput();
      Object.assign(input, {
        eventKey: `${edge}${input.eventKey}${edge}`,
        subjectId: `${edge}42${edge}`,
        reason: `${edge}reason${edge}`,
        deviceId: `${edge}device${edge}`,
      });
      assert.deepEqual((await append(context.pool, input)).rows, [
        { audit_event_id: input.id, replayed: false },
      ]);
      const stored = await context.pool.query(
        `SELECT event_key AS "eventKey", subject_id AS "subjectId",
        reason, device_id AS "deviceId" FROM admin.admin_audit_events WHERE id = $1`,
        [input.id],
      );
      assert.deepEqual(stored.rows, [
        {
          eventKey: input.eventKey.trim(),
          subjectId: '42',
          reason: 'reason',
          deviceId: 'device',
        },
      ]);
    }

    const identity = matrixInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED', {
      subjectId: `\t${UUID7_A.toUpperCase()}\n`,
      metadata: { currencyId: `\r${RFC_UUID.toUpperCase()}\f` },
    });
    assert.deepEqual((await append(context.pool, identity)).rows, [
      { audit_event_id: identity.id, replayed: false },
    ]);
    const storedIdentity = await context.pool.query(
      `SELECT subject_id AS "subjectId",
      metadata_json->>'currencyId' AS "currencyId"
      FROM admin.admin_audit_events WHERE id = $1`,
      [identity.id],
    );
    assert.deepEqual(storedIdentity.rows, [{ subjectId: UUID7_A, currencyId: RFC_UUID }]);

    const bounded: Array<[AuditInput, 'after' | 'metadata', string]> = [
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'name'],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'shortName'],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'blockchainReference'],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'logoObjectKey'],
      [matrixInput('WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED'), 'after', 'timezone'],
      [matrixInput('WALLET_CORE', 'CURRENCY.CREATED'), 'after', 'symbol'],
      [matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED'), 'metadata', 'providerReference'],
      [matrixInput('DEPOSIT', 'BLOCKER.WAIVED'), 'metadata', 'blockerKind'],
      [matrixInput('DEPOSIT', 'BULK_JOB.CREATED'), 'metadata', 'safeErrorCode'],
    ];
    for (const [base, section, key] of bounded) {
      const input = withPayloadValue(base, section, key, ` \t\n\r\f\vvalue \t\n\r\f\v`);
      assert.deepEqual((await append(context.pool, input)).rows, [
        { audit_event_id: input.id, replayed: false },
      ]);
      const stored = await context.pool.query(
        `SELECT ${section}_json AS payload
        FROM admin.admin_audit_events WHERE id = $1`,
        [input.id],
      );
      assert.equal((stored.rows[0]?.payload as Record<string, unknown>)[key], 'value', key);
      await rejectsSqlState(
        () => append(context.pool, withPayloadValue(base, section, key, ' \t\n\r\f\v')),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `${key} rejects ASCII-whitespace-only text`,
      );
    }
  });

  it('measures text limits in Unicode code points, including emoji boundaries', async () => {
    const emoji = '\u{1F642}';
    const common = settingsInput({
      eventKey: emoji.repeat(200),
      reason: emoji.repeat(500),
      deviceId: emoji.repeat(128),
    });
    assert.deepEqual((await append(context.pool, common)).rows, [
      { audit_event_id: common.id, replayed: false },
    ]);
    for (const input of [
      settingsInput({ eventKey: emoji.repeat(201) }),
      settingsInput({ reason: emoji.repeat(501) }),
      settingsInput({ deviceId: emoji.repeat(129) }),
    ])
      await rejectsSqlState(
        () => append(context.pool, input),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
      );

    const bounded: Array<[AuditInput, 'after' | 'metadata', string, number]> = [
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'name', 128],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'shortName', 64],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'blockchainReference', 160],
      [matrixInput('WALLET_CORE', 'CHAIN.CREATED'), 'after', 'logoObjectKey', 255],
      [matrixInput('WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED'), 'after', 'timezone', 64],
      [matrixInput('WALLET_CORE', 'CURRENCY.CREATED'), 'after', 'symbol', 32],
      [
        matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED'),
        'metadata',
        'providerReference',
        160,
      ],
      [matrixInput('DEPOSIT', 'BLOCKER.WAIVED'), 'metadata', 'blockerKind', 64],
      [matrixInput('DEPOSIT', 'BULK_JOB.CREATED'), 'metadata', 'safeErrorCode', 64],
    ];
    for (const [base, section, key, limit] of bounded) {
      const valid = withPayloadValue(base, section, key, emoji.repeat(limit));
      assert.deepEqual((await append(context.pool, valid)).rows, [
        { audit_event_id: valid.id, replayed: false },
      ]);
      await rejectsSqlState(
        () => append(context.pool, withPayloadValue(base, section, key, emoji.repeat(limit + 1))),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `${key} code-point overflow`,
      );
    }
  });
}
