import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  ACTION_CASES,
  DEPOSIT_ACTION_CASES,
  WALLET_ACTION_CASES,
  matrixInput,
} from './admin-audit.postgres.action-cases.js';
import {
  RFC_UUID,
  UUID7_A,
  UUID7_B,
  actor,
  append,
  auditSequence,
  rejectsSqlState,
  settingsInput,
  uuid7,
  withPayloadValue,
  type AuditInput,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditActionMatrixTests(context: LiveTestContext) {
  it('accepts every closed domain/action/subject/actor combination and rejects excluded actors', async () => {
    assert.equal(WALLET_ACTION_CASES.length, 26);
    assert.equal(DEPOSIT_ACTION_CASES.length, 30);
    for (const actionCase of ACTION_CASES) {
      for (const actorKind of actionCase.actors) {
        const input = settingsInput({
          ...actionCase,
          ...actor(actorKind),
          id: uuid7(),
          eventKey: `matrix:${auditSequence}`,
        });
        const result = await append(context.pool, input);
        assert.deepEqual(result.rows, [{ audit_event_id: input.id, replayed: false }]);
      }
      for (const excluded of (['ADMIN', 'SYSTEM'] as const).filter(
        (kind) => !actionCase.actors.includes(kind),
      )) {
        const input = settingsInput({
          ...actionCase,
          ...actor(excluded),
          id: uuid7(),
          eventKey: `actor-reject:${auditSequence}`,
        });
        await rejectsSqlState(
          () => append(context.pool, input),
          '22023',
          /ADMIN_AUDIT_INPUT_INVALID/,
        );
      }
    }

    await rejectsSqlState(
      () => append(context.pool, settingsInput({ action: 'SETTINGS.UNKNOWN' })),
      '22023',
    );
    await rejectsSqlState(
      () =>
        append(
          context.pool,
          settingsInput({ domain: 'DEPOSIT', action: 'ADMIN_TIMEZONE.UPDATED' }),
        ),
      '22023',
    );
    await rejectsSqlState(
      () => append(context.pool, settingsInput({ subjectType: 'CHAIN' })),
      '22023',
    );
  });

  it('accepts every allowed subject alternative and rejects a malformed identity for each', async () => {
    for (const action of [
      'PROVIDER_MAINTENANCE.ENTERED',
      'PROVIDER_MAINTENANCE.RECOVERED',
      'PRICE_MAINTENANCE.ENTERED',
      'PRICE_MAINTENANCE.RECOVERED',
    ]) {
      const currencySubject = matrixInput('WALLET_CORE', action, {
        subjectType: 'CURRENCY',
        subjectId: RFC_UUID,
      });
      assert.deepEqual((await append(context.pool, currencySubject)).rows, [
        { audit_event_id: currencySubject.id, replayed: false },
      ]);
      await rejectsSqlState(
        () =>
          append(context.pool, {
            ...currencySubject,
            id: uuid7(),
            eventKey: `bad-subject:${auditSequence}`,
            subjectId: 'not-a-uuid',
          }),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `${action} rejects a malformed currency subject`,
      );
    }
  });

  it('uses CURRENCY_CHAIN only for binding status and provider-maintenance subjects', async () => {
    const bindingId = `\t${RFC_UUID.toUpperCase()}\n`;
    const allowed = [
      matrixInput('WALLET_CORE', 'CURRENCY.STATUS_CHANGED', {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: bindingId,
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.PINNED', {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: bindingId,
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.UNPINNED', {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: bindingId,
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED', {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: bindingId,
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.RECOVERED', {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: bindingId,
      }),
    ];
    for (const input of allowed) {
      assert.deepEqual((await append(context.pool, input)).rows, [
        { audit_event_id: input.id, replayed: false },
      ]);
      assert.deepEqual(
        (
          await context.pool.query('SELECT subject_id FROM admin.admin_audit_events WHERE id=$1', [
            input.id,
          ])
        ).rows,
        [{ subject_id: RFC_UUID }],
      );
    }
    for (const action of ['CURRENCY.CREATED', 'CURRENCY.UPDATED', 'CURRENCY.IMPORTED']) {
      const base = matrixInput('WALLET_CORE', action, {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: RFC_UUID,
      });
      await rejectsSqlState(
        () => append(context.pool, base),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        action,
      );
    }
    for (const action of ['PRICE_MAINTENANCE.ENTERED', 'PRICE_MAINTENANCE.RECOVERED']) {
      const base = matrixInput('WALLET_CORE', action, {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: RFC_UUID,
      });
      await rejectsSqlState(
        () => append(context.pool, base),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        action,
      );
    }
    await rejectsSqlState(
      () =>
        append(context.pool, {
          ...allowed[0]!,
          id: uuid7(),
          eventKey: `bad-binding:${auditSequence}`,
          subjectId: 'not-a-uuid',
        }),
      '22023',
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
  });

  it('accepts only the safe bounded LOGO.UPLOADED fact and normalizes its opaque key', async () => {
    const logo = matrixInput('WALLET_CORE', 'LOGO.UPLOADED', {
      subjectId: `\t${'a'.repeat(64)}.webp\n`,
      reason: ' wallet-logo-upload ',
    });
    assert.deepEqual((await append(context.pool, logo)).rows, [
      { audit_event_id: logo.id, replayed: false },
    ]);
    for (const sourceFormat of ['JPEG', 'WEBP', 'AVIF']) {
      const candidate = {
        ...logo,
        id: uuid7(),
        eventKey: `logo-format:${auditSequence}`,
        metadata: { sourceFormat },
      };
      assert.deepEqual((await append(context.pool, candidate)).rows, [
        { audit_event_id: candidate.id, replayed: false },
      ]);
    }
    for (const changed of [
      { subjectId: `${'A'.repeat(64)}.webp` },
      { subjectId: '../logo.webp' },
      { reason: 'logo-upload' },
      { before: { stored: true } },
      { after: { stored: true, mediaType: 'image/png', width: 500, height: 500, bytes: 1 } },
      { after: { stored: true, mediaType: 'image/webp', width: 0, height: 0, bytes: 1 } },
      { after: { stored: true, mediaType: 'image/webp', width: 501, height: 501, bytes: 1 } },
      { after: { stored: true, mediaType: 'image/webp', width: 499, height: 500, bytes: 1 } },
      { after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 0 } },
      {
        after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1_048_577 },
      },
      { metadata: { sourceFormat: 'GIF' } },
      { metadata: { sourceFormat: 'PNG', sha256: 'x' } },
      {
        after: {
          stored: true,
          mediaType: 'image/webp',
          width: 500,
          height: 500,
          bytes: 1,
          rawImage: 'x',
        },
      },
    ])
      await rejectsSqlState(
        () =>
          append(context.pool, {
            ...logo,
            id: uuid7(),
            eventKey: `bad-logo:${auditSequence}`,
            ...changed,
          }),
        '22023',
      );
  });

  it('accepts every allowed payload key/type and rejects wrong types and unknown keys per family', async () => {
    const completeFamilies = [
      matrixInput('WALLET_CORE', 'SETTINGS.SAVED', {
        before: null,
        after: { revision: 1, status: 'DRAFT', effectiveAt: '2026-09-03T00:00:00.123Z' },
        metadata: { configurationRevision: 1, changelogId: RFC_UUID, safeErrorCode: 'SAFE_CODE' },
      }),
      matrixInput('WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED'),
      matrixInput('WALLET_CORE', 'CATALOGUE.REFRESHED'),
      matrixInput('WALLET_CORE', 'CHAIN.UPDATED', {
        metadata: { configurationRevision: 1, importCatalogueRevision: 2 },
      }),
      matrixInput('WALLET_CORE', 'CURRENCY.UPDATED', {
        metadata: {
          configurationRevision: 1,
          providerReferenceCount: 1,
          chainBindingCount: 1,
          importCatalogueRevision: 2,
        },
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.PINNED'),
      matrixInput('WALLET_CORE', 'CHAIN.STATUS_CHANGED', {
        metadata: { configurationRevision: 1, scheduledChangeId: RFC_UUID },
      }),
      matrixInput('WALLET_CORE', 'CURRENCY.STATUS_CHANGED', {
        metadata: { configurationRevision: 1, scheduledChangeId: RFC_UUID },
      }),
      matrixInput('WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED'),
      matrixInput('WALLET_CORE', 'RECONCILIATION.COMPLETED'),
      matrixInput('WALLET_CORE', 'RECONCILIATION.WARNING_RAISED'),
      matrixInput('WALLET_CORE', 'DELISTING.FORFEITURE_POSTED'),
      matrixInput('DEPOSIT', 'DEPOSIT.RELEASED', {
        metadata: {
          currencyId: RFC_UUID,
          grossAmount: '10',
          feeAmount: '0.1',
          ledgerJournalId: RFC_UUID,
          priceResolutionId: RFC_UUID,
          priceSnapshotId: RFC_UUID,
          priceBasis: 'WEBHOOK_TIME',
        },
      }),
      matrixInput('DEPOSIT', 'DEPOSIT.REVERIFICATION_HELD'),
      matrixInput('DEPOSIT', 'DEPOSIT.CLAWBACK_NEGATIVE_POSTED'),
      matrixInput('DEPOSIT', 'DEPOSIT.ACCOUNTING_REVERSAL_POSTED'),
      matrixInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED', {
        metadata: { currencyId: RFC_UUID, ledgerJournalId: RFC_UUID },
      }),
      matrixInput('DEPOSIT', 'BLOCKER.WAIVED'),
      matrixInput('DEPOSIT', 'QUARANTINE.ASSIGNED', {
        metadata: {
          currencyId: RFC_UUID,
          grossAmount: '10',
          depositId: RFC_UUID,
          ledgerJournalId: RFC_UUID,
          priceResolutionId: RFC_UUID,
          priceSnapshotId: RFC_UUID,
          priceBasis: 'ADMIN_CREDIT_TIME',
        },
      }),
      matrixInput('DEPOSIT', 'KILL_SWITCH.ACTIVATED'),
      matrixInput('DEPOSIT', 'BULK_JOB.COMPLETED', {
        metadata: {
          actionKind: 'RELEASE',
          totalItems: 5,
          attemptedCount: 5,
          succeededCount: 5,
          failedCount: 0,
          batchNumber: 1,
          safeErrorCode: 'SAFE_CODE',
        },
      }),
      matrixInput('DEPOSIT', 'BULK_JOB.ITEM_SUCCEEDED', {
        metadata: {
          bulkJobId: UUID7_A,
          depositId: UUID7_B,
          attempt: 1,
          ledgerJournalId: RFC_UUID,
          safeErrorCode: 'SAFE_CODE',
        },
      }),
    ];

    const keySamples = new Map<
      string,
      {
        input: AuditInput;
        section: 'before' | 'after' | 'metadata';
        value: unknown;
      }
    >();
    for (const family of completeFamilies) {
      assert.deepEqual((await append(context.pool, family)).rows, [
        { audit_event_id: family.id, replayed: false },
      ]);
      for (const section of ['before', 'after', 'metadata'] as const) {
        const original = family[section];
        const record =
          original && typeof original === 'object' && !Array.isArray(original)
            ? (original as Record<string, unknown>)
            : {};
        for (const [key, value] of Object.entries(record)) {
          if (value !== null && (!keySamples.has(key) || keySamples.get(key)?.value === null)) {
            keySamples.set(key, { input: family, section, value });
          }
        }
        const unknown = withPayloadValue(family, section, 'unexpectedKey', 'x');
        await rejectsSqlState(
          () => append(context.pool, unknown),
          '22023',
          /ADMIN_AUDIT_INPUT_INVALID/,
          `${family.domain}/${family.action} rejects unknown ${section} key`,
        );
      }
    }

    for (const [key, sample] of keySamples) {
      const wrongType =
        typeof sample.value === 'number'
          ? 'not-a-number'
          : typeof sample.value === 'boolean'
            ? 'not-a-boolean'
            : 99;
      await rejectsSqlState(
        () => append(context.pool, withPayloadValue(sample.input, sample.section, key, wrongType)),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `${key} rejects the wrong JSON scalar type`,
      );
    }
  });
}
