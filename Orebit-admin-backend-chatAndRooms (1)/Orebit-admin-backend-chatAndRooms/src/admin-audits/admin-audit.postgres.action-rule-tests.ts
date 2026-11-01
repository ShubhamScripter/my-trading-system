import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  DEPOSIT_ACTION_CASES,
  DEPOSIT_STATE,
  WALLET_ACTION_CASES,
  matrixInput,
  settingsState,
} from './admin-audit.postgres.action-cases.js';
import {
  RFC_UUID,
  actor,
  append,
  auditSequence,
  rejectsSqlState,
  settingsInput,
  uuid7,
  withPayloadValue,
  type ActorKind,
  type AuditInput,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditActionRuleTests(context: LiveTestContext) {
  it('accepts every closed non-settings enum value and rejects an unknown value in every enum family', async () => {
    const enumFamilies: Array<{
      name: string;
      input: AuditInput;
      section: 'after' | 'metadata';
      key: string;
      values: readonly string[];
    }> = [
      {
        name: 'wallet state',
        input: matrixInput('WALLET_CORE', 'CHAIN.STATUS_CHANGED'),
        section: 'after',
        key: 'desiredState',
        values: ['ON', 'OFF', 'MAINTAIN', 'UPCOMING'],
      },
      {
        name: 'deposit status',
        input: matrixInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED'),
        section: 'after',
        key: 'status',
        values: [
          'PENDING',
          'HELD',
          'SUCCESS',
          'FAILED',
          'REJECTED',
          'CANCELLED',
          'QUARANTINED',
          'RETRY_PENDING',
        ],
      },
      {
        name: 'blocker status',
        input: matrixInput('DEPOSIT', 'BLOCKER.WAIVED'),
        section: 'after',
        key: 'status',
        values: ['PENDING', 'RESOLVED', 'WAIVED'],
      },
      {
        name: 'quarantine status',
        input: matrixInput('DEPOSIT', 'QUARANTINE.ASSIGNED'),
        section: 'after',
        key: 'status',
        values: ['OPEN', 'RETRY_PENDING', 'ASSIGNED', 'RETAINED', 'SETTLED'],
      },
      {
        name: 'bulk job status',
        input: matrixInput('DEPOSIT', 'BULK_JOB.COMPLETED'),
        section: 'after',
        key: 'status',
        values: ['PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED'],
      },
      {
        name: 'bulk item status',
        input: matrixInput('DEPOSIT', 'BULK_JOB.ITEM_SUCCEEDED'),
        section: 'after',
        key: 'status',
        values: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'],
      },
      {
        name: 'owner type',
        input: matrixInput('WALLET_CORE', 'DELISTING.FORFEITURE_POSTED'),
        section: 'metadata',
        key: 'ownerType',
        values: ['USER', 'MERCHANT'],
      },
      {
        name: 'deposit bucket',
        input: matrixInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED'),
        section: 'after',
        key: 'bucket',
        values: ['AVAILABLE', 'HOLD', 'OREBIT_TREASURY', 'OREBIT_COLLECTION'],
      },
      {
        name: 'price basis',
        input: matrixInput('DEPOSIT', 'DEPOSIT.RELEASED', {
          metadata: {
            currencyId: RFC_UUID,
            grossAmount: '1',
            priceResolutionId: RFC_UUID,
            priceSnapshotId: RFC_UUID,
            priceBasis: 'WEBHOOK_TIME',
          },
        }),
        section: 'metadata',
        key: 'priceBasis',
        values: ['WEBHOOK_TIME', 'ADMIN_CREDIT_TIME'],
      },
      {
        name: 'currency kind',
        input: matrixInput('WALLET_CORE', 'CURRENCY.UPDATED'),
        section: 'after',
        key: 'kind',
        values: ['CRYPTO', 'FIAT'],
      },
      {
        name: 'pricing status',
        input: matrixInput('WALLET_CORE', 'CURRENCY.UPDATED'),
        section: 'after',
        key: 'pricingStatus',
        values: ['ACTIVE', 'DISABLED'],
      },
      {
        name: 'chain audience',
        input: matrixInput('WALLET_CORE', 'CHAIN.UPDATED'),
        section: 'after',
        key: 'availableFor',
        values: ['USER', 'MERCHANT', 'BOTH'],
      },
      {
        name: 'reconciliation status',
        input: matrixInput('WALLET_CORE', 'RECONCILIATION.COMPLETED'),
        section: 'after',
        key: 'status',
        values: ['SUCCESS', 'PARTIAL', 'FAILED'],
      },
      {
        name: 'bulk action kind',
        input: matrixInput('DEPOSIT', 'BULK_JOB.CREATED'),
        section: 'metadata',
        key: 'actionKind',
        values: [
          'RELEASE',
          'REJECT',
          'MAINTENANCE_RELEASE',
          'MAINTENANCE_CANCEL',
          'REVERIFICATION_HOLD',
          'CLAWBACK_TO_ZERO',
          'CLAWBACK_NEGATIVE',
          'WAIT_FOR_SETTLEMENT',
          'SCHEDULED_STATE_TRANSITION',
        ],
      },
      {
        name: 'catalogue source',
        input: matrixInput('WALLET_CORE', 'CATALOGUE.REFRESHED'),
        section: 'metadata',
        key: 'source',
        values: ['BLOCKCHAIN'],
      },
    ];

    for (const family of enumFamilies) {
      for (const value of family.values) {
        const input = withPayloadValue(family.input, family.section, family.key, value);
        assert.deepEqual((await append(context.pool, input)).rows, [
          { audit_event_id: input.id, replayed: false },
        ]);
      }
      await rejectsSqlState(
        () =>
          append(
            context.pool,
            withPayloadValue(family.input, family.section, family.key, 'NOT_ALLOWED'),
          ),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
        `${family.name} is closed`,
      );
    }
  });

  it('enforces exact settings transitions, including REJECTED only for schedule rejection', async () => {
    const statuses = ['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED'];
    for (const actionCase of [...WALLET_ACTION_CASES, ...DEPOSIT_ACTION_CASES].filter(
      ({ action }) => action.startsWith('SETTINGS.'),
    )) {
      const valid = settingsInput({
        ...actionCase,
        ...actor(actionCase.actors[0] as ActorKind),
        id: uuid7(),
        eventKey: `settings-transition:${auditSequence}`,
      });
      assert.deepEqual((await append(context.pool, valid)).rows, [
        { audit_event_id: valid.id, replayed: false },
      ]);
      for (const status of statuses) {
        if (status !== (valid.after as Record<string, unknown>).status) {
          await rejectsSqlState(
            () =>
              append(context.pool, {
                ...valid,
                id: uuid7(),
                eventKey: `bad-after:${auditSequence}`,
                after: settingsState(status),
              }),
            '22023',
          );
        }
        if (valid.before !== null && status !== (valid.before as Record<string, unknown>).status) {
          await rejectsSqlState(
            () =>
              append(context.pool, {
                ...valid,
                id: uuid7(),
                eventKey: `bad-before:${auditSequence}`,
                before: settingsState(status),
              }),
            '22023',
          );
        }
      }
      await rejectsSqlState(
        () =>
          append(context.pool, {
            ...valid,
            id: uuid7(),
            eventKey: `missing-after:${auditSequence}`,
            after: null,
          }),
        '22023',
      );
    }
  });

  it('rejects malformed audit and subject identities while accepting legacy RFC currency UUIDs', async () => {
    const invalid: AuditInput[] = [
      settingsInput({ id: null }),
      settingsInput({ id: RFC_UUID }),
      settingsInput({ subjectId: ' ' }),
      settingsInput({ subjectId: 'x'.repeat(129) }),
      settingsInput({ subjectId: '1.5' }),
      settingsInput({ subjectId: '-1' }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'CURRENCY.CREATED',
        subjectType: 'CURRENCY',
        subjectId: 'not-a-uuid',
        after: {
          symbol: 'BTC',
          name: 'Bitcoin',
          kind: 'CRYPTO',
          pricingStatus: 'ACTIVE',
          desiredState: 'ON',
          logoObjectKey: null,
        },
      }),
      settingsInput({
        domain: 'WALLET_CORE',
        action: 'CHAIN.CREATED',
        subjectType: 'CHAIN',
        subjectId: RFC_UUID,
        after: {
          name: 'Chain',
          shortName: 'CH',
          blockchainReference: 'chain',
          availableFor: 'USER',
          logoObjectKey: null,
        },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'DEPOSIT.STATUS_CHANGED',
        subjectType: 'DEPOSIT',
        subjectId: RFC_UUID,
        before: DEPOSIT_STATE,
        after: DEPOSIT_STATE,
        metadata: { currencyId: RFC_UUID },
      }),
      settingsInput({
        domain: 'DEPOSIT',
        action: 'BULK_JOB.CREATED',
        subjectType: 'BULK_JOB',
        subjectId: RFC_UUID,
        before: { status: 'PENDING' },
        after: { status: 'RUNNING' },
        metadata: {
          actionKind: 'RELEASE',
          totalItems: 1,
          attemptedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
      }),
    ];
    for (const input of invalid) {
      await rejectsSqlState(
        () => append(context.pool, input),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
      );
    }

    const legacyCurrency = settingsInput({
      domain: 'WALLET_CORE',
      action: 'CURRENCY.CREATED',
      subjectType: 'CURRENCY',
      subjectId: RFC_UUID,
      after: {
        symbol: 'BTC',
        name: 'Bitcoin',
        kind: 'CRYPTO',
        pricingStatus: 'ACTIVE',
        desiredState: 'ON',
        logoObjectKey: 'currencies/btc.svg',
      },
    });
    assert.deepEqual((await append(context.pool, legacyCurrency)).rows, [
      { audit_event_id: legacyCurrency.id, replayed: false },
    ]);
  });

  it('allows provider pins for chains or normalized currency-chain bindings only', async () => {
    for (const action of ['PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED']) {
      const chain = matrixInput('WALLET_CORE', action);
      assert.deepEqual((await append(context.pool, chain)).rows, [
        { audit_event_id: chain.id, replayed: false },
      ]);

      const binding = matrixInput('WALLET_CORE', action, {
        subjectType: 'CURRENCY_CHAIN',
        subjectId: `\t${RFC_UUID.toUpperCase()}\n`,
      });
      assert.deepEqual((await append(context.pool, binding)).rows, [
        { audit_event_id: binding.id, replayed: false },
      ]);
      assert.deepEqual(
        (
          await context.pool.query(
            `SELECT subject_id AS "subjectId" FROM admin.admin_audit_events
        WHERE id = $1`,
            [binding.id],
          )
        ).rows,
        [{ subjectId: RFC_UUID }],
      );

      await rejectsSqlState(
        () =>
          append(
            context.pool,
            matrixInput('WALLET_CORE', action, {
              subjectType: 'CURRENCY',
              subjectId: RFC_UUID,
            }),
          ),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
      );
      await rejectsSqlState(
        () =>
          append(
            context.pool,
            matrixInput('WALLET_CORE', action, {
              subjectType: 'CURRENCY_CHAIN',
              subjectId: 'not-a-uuid',
            }),
          ),
        '22023',
        /ADMIN_AUDIT_INPUT_INVALID/,
      );
    }
    await rejectsSqlState(
      () =>
        append(
          context.pool,
          matrixInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED', {
            subjectType: 'CURRENCY_CHAIN',
            subjectId: RFC_UUID,
          }),
        ),
      '22023',
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
  });
}
