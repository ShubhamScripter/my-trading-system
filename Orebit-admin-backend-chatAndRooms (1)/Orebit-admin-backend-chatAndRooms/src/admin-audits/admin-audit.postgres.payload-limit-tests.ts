import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ADMIN_AUDIT_SCHEMA_DESCRIPTOR } from './admin-audit.payloads.js';
import { matrixInput } from './admin-audit.postgres.action-cases.js';
import {
  RFC_UUID,
  append,
  auditSequence,
  payloadRecord,
  rejectsSqlState,
  settingsInput,
  uuid7,
  withPayloadValue,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditPayloadLimitTests(context: LiveTestContext) {
  it('matches canonical timestamps, scalar null closure, required keys, and decimal boundaries', async () => {
    for (const value of [
      '0001-01-01T00:00:00Z',
      '2024-02-29T23:59:59Z',
      '2024-02-29T23:59:59.123Z',
      '9999-12-31T23:59:59.999Z',
    ]) {
      const input = settingsInput({ after: { revision: 1, status: 'DRAFT', effectiveAt: value } });
      assert.deepEqual((await append(context.pool, input)).rows, [
        { audit_event_id: input.id, replayed: false },
      ]);
    }
    for (const value of [
      '0000-01-01T00:00:00Z',
      '10000-01-01T00:00:00Z',
      '2023-02-29T00:00:00Z',
      '2024-02-30T00:00:00Z',
      '2024-13-01T00:00:00Z',
      '2024-01-01T24:00:00Z',
      '2024-01-01T00:00:00+00:00',
      '2024-01-01T00:00:00.12Z',
    ])
      await rejectsSqlState(
        () =>
          append(
            context.pool,
            settingsInput({ after: { revision: 1, status: 'DRAFT', effectiveAt: value } }),
          ),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        value,
      );

    for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
      for (const [action, descriptor] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
        const base = matrixInput(domain, action);
        for (const key of descriptor.required) {
          const metadata = { ...payloadRecord(base.metadata) };
          delete metadata[key];
          await rejectsSqlState(
            () =>
              append(context.pool, {
                ...base,
                id: uuid7(),
                eventKey: `required:${auditSequence}`,
                metadata,
              }),
            '22023',
            /ADMIN_AUDIT_INPUT_INVALID/,
            `${domain}/${action}/${key}`,
          );
        }
        for (const key of descriptor.state) {
          const candidate = withPayloadValue(base, 'after', key, null);
          if (key === 'effectiveAt' || key === 'assignedUserId') {
            assert.deepEqual((await append(context.pool, candidate)).rows, [
              { audit_event_id: candidate.id, replayed: false },
            ]);
          } else {
            await rejectsSqlState(
              () => append(context.pool, candidate),
              '22023',
              /ADMIN_AUDIT_INPUT_INVALID/,
            );
          }
        }
        for (const key of [...descriptor.required, ...descriptor.optional]) {
          await rejectsSqlState(
            () => append(context.pool, withPayloadValue(base, 'metadata', key, null)),
            '22023',
            /ADMIN_AUDIT_INPUT_INVALID/,
            `${domain}/${action}/${key} null`,
          );
        }
      }
    }

    const decimal128 = `1${'0'.repeat(127)}`;
    const validDecimal = matrixInput('DEPOSIT', 'DEPOSIT.RELEASED', {
      metadata: { currencyId: RFC_UUID, grossAmount: decimal128 },
    });
    assert.deepEqual((await append(context.pool, validDecimal)).rows, [
      { audit_event_id: validDecimal.id, replayed: false },
    ]);
    await rejectsSqlState(
      () =>
        append(
          context.pool,
          matrixInput('DEPOSIT', 'DEPOSIT.RELEASED', {
            metadata: { currencyId: RFC_UUID, grossAmount: `1${'0'.repeat(128)}` },
          }),
        ),
      '22023',
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
  });

  it('allows reconciliation warning shortfall null only when the same state is partial or inactive', async () => {
    for (const action of ['RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED']) {
      for (const section of ['before', 'after'] as const) {
        const base = matrixInput('WALLET_CORE', action);
        for (const [active, partial, shortfallPercent, accepted] of [
          [true, true, null, true],
          [true, true, '1.25', true],
          [true, false, '1.25', true],
          [true, false, null, false],
          [false, false, null, true],
        ] as const) {
          const candidate = {
            ...base,
            id: uuid7(),
            eventKey: `warning-shortfall:${auditSequence}`,
            [section]: {
              ...payloadRecord(base[section]),
              active,
              partial,
              shortfallPercent,
            },
          };
          const label = `${action}/${section}/active=${String(active)}/partial=${String(partial)}/${String(shortfallPercent)}`;
          if (accepted) {
            assert.deepEqual(
              (await append(context.pool, candidate)).rows,
              [{ audit_event_id: candidate.id, replayed: false }],
              label,
            );
          } else {
            await rejectsSqlState(
              () => append(context.pool, candidate),
              '22023',
              /ADMIN_AUDIT_INPUT_INVALID/,
              label,
            );
          }
        }
        const state: Record<string, unknown> = {
          ...payloadRecord(base[section]),
          active: true,
          shortfallPercent: null,
        };
        delete state.partial;
        await rejectsSqlState(
          () =>
            append(context.pool, {
              ...base,
              id: uuid7(),
              eventKey: `warning-shortfall:${auditSequence}`,
              [section]: state,
            }),
          '22023',
          /ADMIN_AUDIT_INPUT_INVALID/,
          `${action}/${section}/missing partial`,
        );
      }
    }
  });

  it('accepts only absent or complete price provenance and reaches the JSON byte cap first', async () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const metadata: Record<string, unknown> = { currencyId: RFC_UUID, grossAmount: '1' };
      if (mask & 1) metadata.priceBasis = 'WEBHOOK_TIME';
      if (mask & 2) metadata.priceResolutionId = RFC_UUID;
      if (mask & 4) metadata.priceSnapshotId = RFC_UUID;
      const input = matrixInput('DEPOSIT', 'DEPOSIT.RELEASED', { metadata });
      if (mask === 0 || mask === 7) {
        assert.deepEqual((await append(context.pool, input)).rows, [
          { audit_event_id: input.id, replayed: false },
        ]);
      } else {
        await rejectsSqlState(
          () => append(context.pool, input),
          '22023',
          /ADMIN_AUDIT_INPUT_INVALID/,
        );
      }
    }

    const oversized = Object.fromEntries(
      Array.from({ length: 7_000 }, (_, index) => [`padding${index}`, true]),
    );
    const bytes = await context.pool.query('SELECT octet_length($1::jsonb::text) AS bytes', [
      oversized,
    ]);
    assert.ok(Number(bytes.rows[0]?.bytes) > 65_536);
    await rejectsSqlState(
      () => append(context.pool, settingsInput({ after: oversized })),
      '22023',
      /ADMIN_AUDIT_INPUT_INVALID/,
      'oversized boolean-only JSON reaches the byte cap before key or string validation',
    );
  });
}
