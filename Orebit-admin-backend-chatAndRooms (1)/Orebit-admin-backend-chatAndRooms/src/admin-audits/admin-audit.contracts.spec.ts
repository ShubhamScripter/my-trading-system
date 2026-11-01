import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPOSIT_ADMIN_AUDIT_ACTIONS, type DepositAdminAuditInput, WALLET_CORE_ADMIN_AUDIT_ACTIONS, type WalletCoreAdminAuditInput } from './admin-audit.types.js';
import { ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR, ADMIN_AUDIT_SCHEMA_DESCRIPTOR, buildDepositAdminAuditEvent, buildWalletCoreAdminAuditEvent } from './admin-audit.payloads.js';
const UUID_V7 = '018f0f5e-6b4a-7c8d-8e9f-0123456789ab';
const UUID_V4 = '018f0f5e-6b4a-4c8d-8e9f-0123456789ab';
const admin = {
  kind: 'ADMIN',
  actorId: UUID_V7,
  sessionId: UUID_V7,
  requestId: UUID_V7,
  ipAddress: '127.0.0.1',
  deviceId: 'device-1',
} as const;
const system = { kind: 'SYSTEM', runId: UUID_V7 } as const;
type WalletScheduleRejected = Extract<WalletCoreAdminAuditInput, { readonly action: 'SETTINGS.SCHEDULE_REJECTED' }>;
type DepositScheduleRejected = Extract<DepositAdminAuditInput, { readonly action: 'SETTINGS.SCHEDULE_REJECTED' }>;
const walletRejectedAfter: NonNullable<WalletScheduleRejected['after']>['status'] = 'REJECTED';
const depositRejectedAfter: NonNullable<DepositScheduleRejected['after']>['status'] = 'REJECTED';
// @ts-expect-error schedule rejection cannot report the applied LIVE state
const illegalWalletRejectedAfter: NonNullable<WalletScheduleRejected['after']>['status'] = 'LIVE';
// @ts-expect-error Deposit schedule rejection has the same closed transition
const illegalDepositRejectedAfter: NonNullable<DepositScheduleRejected['after']>['status'] = 'LIVE';
void walletRejectedAfter;
void depositRejectedAfter;
void illegalWalletRejectedAfter;
void illegalDepositRejectedAfter;
const inputFor = (domain: 'WALLET_CORE' | 'DEPOSIT', action: string): Record<string, unknown> => {
  const common = {
    domain,
    action,
    eventKey: `event-${domain}-${action}`,
    reason: 'audit reason',
    actor: admin,
  };
  const settings = {
    subject: { type: 'SETTINGS_REVISION', id: '1' },
    metadata: { configurationRevision: 1 },
  };
  const transitions = {
    'SETTINGS.SAVED': [null, 'DRAFT'],
    'SETTINGS.PUSHED': ['DRAFT', 'LIVE'],
    'SETTINGS.SCHEDULED': ['DRAFT', 'SCHEDULED'],
    'SETTINGS.SCHEDULE_APPLIED': ['SCHEDULED', 'LIVE'],
    'SETTINGS.SCHEDULE_REJECTED': ['SCHEDULED', 'REJECTED'],
  } as const;
  if (action in transitions) {
    const [beforeStatus, afterStatus] = transitions[action as keyof typeof transitions];
    return {
      ...common,
      ...settings,
      before: beforeStatus === null ? null : { revision: 0, status: beforeStatus, effectiveAt: null },
      after: { revision: 1, status: afterStatus, effectiveAt: null },
      actor: action.endsWith('APPLIED') || action.endsWith('REJECTED') ? system : admin,
    };
  }
  if (action === 'LOGO.UPLOADED') return {
    ...common, subject: { type: 'LOGO_ASSET', id: `${'a'.repeat(64)}.webp` },
    reason: 'wallet-logo-upload', before: { stored: false },
    after: { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1 },
    metadata: { sourceFormat: 'PNG' },
  };
  if (domain === 'WALLET_CORE') {
    if (action === 'ADMIN_TIMEZONE.UPDATED')
      return {
        ...common,
        subject: { type: 'ADMIN', id: UUID_V7 },
        before: { timezone: 'UTC' },
        after: { timezone: 'Asia/Kolkata' },
        metadata: { configurationRevision: 1 },
      };
    if (action === 'CATALOGUE.REFRESHED')
      return {
        ...common,
        subject: { type: 'PROVIDER_CATALOGUE', id: 'BLOCKCHAIN' },
        before: { revision: 0, itemCount: 0 },
        after: { revision: 1, itemCount: 1 },
        metadata: { configurationRevision: 1, source: 'BLOCKCHAIN' },
      };
    if (/^(CHAIN|CURRENCY)\.(CREATED|UPDATED|IMPORTED)$/.test(action))
      return action.startsWith('CHAIN')
        ? {
            ...common,
            subject: { type: 'CHAIN', id: UUID_V7 },
            before: {
              name: 'A',
              shortName: 'A',
              blockchainReference: 'a',
              availableFor: 'BOTH',
              logoObjectKey: 'a',
            },
            after: {
              name: 'B',
              shortName: 'B',
              blockchainReference: 'b',
              availableFor: 'BOTH',
              logoObjectKey: 'b',
            },
            metadata: { configurationRevision: 1 },
          }
        : {
            ...common,
            subject: { type: 'CURRENCY', id: UUID_V4 },
            before: {
              symbol: 'A',
              name: 'A',
              kind: 'CRYPTO',
              pricingStatus: 'ACTIVE',
              desiredState: 'ON',
              logoObjectKey: 'a',
            },
            after: {
              symbol: 'B',
              name: 'B',
              kind: 'FIAT',
              pricingStatus: 'DISABLED',
              desiredState: 'OFF',
              logoObjectKey: 'b',
            },
            metadata: { configurationRevision: 1 },
          };
    if (action === 'CHAIN.STATUS_CHANGED')
      return {
        ...common,
        subject: { type: 'CHAIN', id: UUID_V7 },
        before: { desiredState: 'ON', effectiveState: 'ON', maintenancePinned: false },
        after: { desiredState: 'MAINTAIN', effectiveState: 'MAINTAIN', maintenancePinned: true },
        metadata: { configurationRevision: 1 },
      };
    if (action === 'CURRENCY.STATUS_CHANGED')
      return {
        ...common,
        subject: { type: 'CURRENCY', id: UUID_V4 },
        before: { desiredState: 'ON', effectiveState: 'ON', showBalance: true },
        after: { desiredState: 'OFF', effectiveState: 'OFF', showBalance: false },
        metadata: { configurationRevision: 1 },
      };
    if (action.includes('.PINNED') || action.includes('.UNPINNED'))
      return {
        ...common,
        subject: { type: 'CHAIN', id: UUID_V7 },
        before: { maintenancePinned: false, effectiveState: 'ON' },
        after: { maintenancePinned: true, effectiveState: 'MAINTAIN' },
        metadata: { configurationRevision: 1 },
      };
    if (action.includes('MAINTENANCE.'))
      return {
        ...common,
        actor: system,
        subject: { type: 'CHAIN', id: UUID_V7 },
        before: { effectiveState: 'ON', failureStreak: 0, maintenancePinned: false },
        after: { effectiveState: 'MAINTAIN', failureStreak: 1, maintenancePinned: true },
        metadata: { configurationRevision: 1, providerReference: 'provider' },
      };
    if (action === 'RECONCILIATION.COMPLETED')
      return {
        ...common,
        actor: system,
        subject: { type: 'RECONCILIATION_RUN', id: UUID_V7 },
        before: { status: 'PARTIAL', partial: true },
        after: { status: 'SUCCESS', partial: false },
        metadata: { currencyCount: 1, warningCount: 0 },
      };
    if (action.startsWith('RECONCILIATION.WARNING'))
      return {
        ...common,
        actor: system,
        subject: { type: 'CURRENCY', id: UUID_V4 },
        before: { active: true, partial: false, shortfallPercent: '0' },
        after: { active: false, partial: true, shortfallPercent: '1.2' },
        metadata: { reconciliationRunId: UUID_V7 },
      };
    return {
      ...common,
      actor: system,
      subject: { type: 'LEDGER_JOURNAL', id: UUID_V7 },
      before: { balance: '2' },
      after: { balance: '0' },
      metadata: { currencyId: UUID_V7, ownerType: 'USER', ownerId: UUID_V7, amount: '2' },
    };
  }
  if (action.startsWith('DEPOSIT.')) {
    let metadata: Record<string, unknown>;
    if (action === 'DEPOSIT.REVERIFICATION_HELD') {
      metadata = {
        currencyId: UUID_V7, grossAmount: '1', ledgerJournalId: UUID_V7, blockerId: UUID_V7,
      };
    } else if (action.includes('CLAWBACK')) {
      metadata = { currencyId: UUID_V7, ledgerJournalId: UUID_V7, clawbackAmount: '1' };
    } else if (action === 'DEPOSIT.ACCOUNTING_REVERSAL_POSTED') {
      metadata = {
        currencyId: UUID_V7, originalJournalId: UUID_V7, reversalJournalId: UUID_V7,
      };
    } else if (action === 'DEPOSIT.STATUS_CHANGED') {
      metadata = { currencyId: UUID_V7 };
    } else {
      metadata = { currencyId: UUID_V7, grossAmount: '1' };
    }
    return {
      ...common,
      subject: { type: 'DEPOSIT', id: UUID_V7 },
      before: { status: 'PENDING', bucket: 'HOLD', visible: false },
      after: { status: 'SUCCESS', bucket: 'AVAILABLE', visible: true },
      metadata,
    };
  }
  if (action === 'BLOCKER.WAIVED')
    return {
      ...common,
      subject: { type: 'DEPOSIT_BLOCKER', id: UUID_V7 },
      before: { status: 'PENDING' },
      after: { status: 'WAIVED' },
      metadata: { depositId: UUID_V7, blockerKind: 'KYC' },
    };
  if (action.startsWith('QUARANTINE.'))
    return {
      ...common,
      subject: { type: 'QUARANTINE', id: UUID_V7 },
      before: { status: 'OPEN', assignedUserId: null },
      after: { status: 'ASSIGNED', assignedUserId: UUID_V7 },
      metadata: { currencyId: UUID_V7, grossAmount: '1' },
    };
  if (action.startsWith('KILL_SWITCH.'))
    return {
      ...common,
      subject: { type: 'FEATURE_STATE', id: UUID_V7 },
      before: { killed: false },
      after: { killed: true },
      metadata: { configurationRevision: 1 },
    };
  if (action.includes('.ITEM_'))
    return {
      ...common,
      actor: system,
      subject: { type: 'BULK_JOB_ITEM', id: UUID_V7 },
      before: { status: 'RUNNING' },
      after: { status: action.endsWith('SUCCEEDED') ? 'SUCCEEDED' : 'FAILED' },
      metadata: { bulkJobId: UUID_V7, depositId: UUID_V7, attempt: 1 },
    };
  return {
    ...common,
    actor: action === 'BULK_JOB.CREATED' || action === 'BULK_JOB.RESUMED' ? admin : system,
    subject: { type: 'BULK_JOB', id: UUID_V7 },
    before: { status: 'PENDING' },
    after: { status: 'RUNNING' },
    metadata: {
      actionKind: 'RELEASE',
      totalItems: 1,
      attemptedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
  };
};
test('accepts every closed action and freezes copied plain payloads', () => {
  for (const action of WALLET_CORE_ADMIN_AUDIT_ACTIONS) {
    const event = buildWalletCoreAdminAuditEvent(inputFor('WALLET_CORE', action) as never);
    assert.equal(event.action, action);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.metadata));
  }
  for (const action of DEPOSIT_ADMIN_AUDIT_ACTIONS) {
    const event = buildDepositAdminAuditEvent(inputFor('DEPOSIT', action) as never);
    assert.equal(event.action, action);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.after));
  }
});
test('rejects malformed action inputs rather than filtering them', () => {
  const input = inputFor('DEPOSIT', 'DEPOSIT.REJECTED');
  const reject = (value: unknown) => assert.throws(() => buildDepositAdminAuditEvent(value as never), /ADMIN_AUDIT_INPUT_INVALID/);
  reject({ ...input, ignored: true });
  reject({ ...input, metadata: { ...(input.metadata as object), rawPayload: '{}' } });
  reject({ ...input, subject: { type: 'DEPOSIT_BLOCKER', id: UUID_V7 } });
  reject({ ...input, actor: { kind: 'ADMIN', actorId: UUID_V7 } });
  reject({ ...input, eventKey: '  ' });
  reject({ ...input, subject: { type: 'DEPOSIT', id: 'not-a-uuid' } });
  reject({ ...input, before: { status: 'PENDING', bucket: 'HOLD', visible: 'true' } });
  reject({ ...input, before: { status: 'PENDING', bucket: 'NOPE', visible: false } });
  reject({ ...input, metadata: { currencyId: UUID_V7, grossAmount: '1.1234567890123456789' } });
  reject({
    ...input,
    metadata: { currencyId: UUID_V7, grossAmount: '1', priceBasis: 'WEBHOOK_TIME' },
  });
  reject({
    ...input,
    metadata: { currencyId: UUID_V7, grossAmount: '1', nested: { no: 'objects' } },
  });
  const bulk = inputFor('DEPOSIT', 'BULK_JOB.CREATED');
  assert.throws(
    () =>
      buildDepositAdminAuditEvent({
        ...bulk,
        metadata: { ...(bulk.metadata as object), totalItems: -1 },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
});
test('fails closed for an extra state or metadata key in every legal action input', () => {
  for (const action of WALLET_CORE_ADMIN_AUDIT_ACTIONS) {
    const input = inputFor('WALLET_CORE', action);
    assert.throws(
      () =>
        buildWalletCoreAdminAuditEvent({
          ...input,
          before: { ...(input.before as object), unknown: 'x' },
        } as never),
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
    assert.throws(
      () =>
        buildWalletCoreAdminAuditEvent({
          ...input,
          metadata: { ...(input.metadata as object), unknown: 'x' },
        } as never),
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
  }
  for (const action of DEPOSIT_ADMIN_AUDIT_ACTIONS) {
    const input = inputFor('DEPOSIT', action);
    assert.throws(
      () =>
        buildDepositAdminAuditEvent({
          ...input,
          before: { ...(input.before as object), unknown: 'x' },
        } as never),
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
    assert.throws(
      () =>
        buildDepositAdminAuditEvent({
          ...input,
          metadata: { ...(input.metadata as object), unknown: 'x' },
        } as never),
      /ADMIN_AUDIT_INPUT_INVALID/,
    );
  }
});
test('rejects missing required metadata and wrong subjects for every action', () => {
  for (const [domain, actions] of Object.entries({ WALLET_CORE: ADMIN_AUDIT_SCHEMA_DESCRIPTOR.WALLET_CORE, DEPOSIT: ADMIN_AUDIT_SCHEMA_DESCRIPTOR.DEPOSIT }))
    for (const [action, descriptor] of Object.entries(actions)) {
      const input = inputFor(domain as 'WALLET_CORE' | 'DEPOSIT', action);
      const build = domain === 'WALLET_CORE' ? buildWalletCoreAdminAuditEvent : buildDepositAdminAuditEvent;
      const metadata = { ...(input.metadata as object) } as Record<string, unknown>;
      delete metadata[descriptor.required[0] ?? 'missing'];
      assert.throws(() => build({ ...input, metadata } as never), /ADMIN_AUDIT_INPUT_INVALID/, `${domain}/${action} missing required`);
      assert.throws(() => build({ ...input, subject: { type: 'WRONG', id: UUID_V7 } } as never), /ADMIN_AUDIT_INPUT_INVALID/, `${domain}/${action} wrong subject`);
    }
});
test('accepts every optional provenance field and rejects null or undefined optionals', () => {
  const optionalValue: Record<string, unknown> = {
    changelogId: UUID_V7,
    safeErrorCode: 'SAFE',
    importCatalogueRevision: 1,
    providerReferenceCount: 1,
    chainBindingCount: 1,
    scheduledChangeId: UUID_V7,
    feeAmount: '1',
    ledgerJournalId: UUID_V7,
    priceResolutionId: UUID_V7,
    priceSnapshotId: UUID_V7,
    priceBasis: 'WEBHOOK_TIME',
    shortfallAmount: '1',
    depositId: UUID_V7,
    batchNumber: 1,
  };
  for (const [domain, actions] of Object.entries({ WALLET_CORE: ADMIN_AUDIT_SCHEMA_DESCRIPTOR.WALLET_CORE, DEPOSIT: ADMIN_AUDIT_SCHEMA_DESCRIPTOR.DEPOSIT }))
    for (const [action, descriptor] of Object.entries(actions))
      for (const optional of descriptor.optional) {
        const input = inputFor(domain as 'WALLET_CORE' | 'DEPOSIT', action);
        const build = domain === 'WALLET_CORE' ? buildWalletCoreAdminAuditEvent : buildDepositAdminAuditEvent;
        const metadata = {
          ...(input.metadata as object),
          ...(optional.startsWith('price') ? { priceResolutionId: UUID_V7, priceSnapshotId: UUID_V7, priceBasis: 'WEBHOOK_TIME' } : { [optional]: optionalValue[optional] }),
        };
        assert.doesNotThrow(() => build({ ...input, metadata } as never), `${domain}/${action}/${optional} positive`);
        assert.throws(() => build({ ...input, metadata: { ...(input.metadata as object), [optional]: null } } as never), /ADMIN_AUDIT_INPUT_INVALID/);
        assert.throws(() => build({ ...input, metadata: { ...(input.metadata as object), [optional]: undefined } } as never), /ADMIN_AUDIT_INPUT_INVALID/);
      }
});

// @ts-expect-error BULK_JOB.CREATED is ADMIN-only in the public closed union.
const illegalBulkActor: DepositAdminAuditInput = {
  domain: 'DEPOSIT',
  action: 'BULK_JOB.CREATED',
  eventKey: 'invalid-bulk-actor',
  actor: system,
  subject: { type: 'BULK_JOB', id: UUID_V7 },
  reason: 'invalid actor',
  before: { status: 'PENDING' },
  after: { status: 'RUNNING' },
  metadata: {
    actionKind: 'RELEASE',
    totalItems: 1,
    attemptedCount: 0,
    succeededCount: 0,
    failedCount: 0,
  },
};
void illegalBulkActor;
test('supports ADMIN transport and SYSTEM run identity for their permitted actions', () => {
  assert.equal(buildWalletCoreAdminAuditEvent(inputFor('WALLET_CORE', 'SETTINGS.SAVED') as never).actor.kind, 'ADMIN');
  assert.equal(buildWalletCoreAdminAuditEvent(inputFor('WALLET_CORE', 'PRICE_MAINTENANCE.ENTERED') as never).actor.kind, 'SYSTEM');
});
test('normalizes UUIDs while returning detached frozen scalar payloads', () => {
  const input = inputFor('DEPOSIT', 'BLOCKER.WAIVED');
  const upper = UUID_V7.toUpperCase();
  const event = buildDepositAdminAuditEvent({
    ...input,
    actor: { ...admin, actorId: upper, sessionId: upper, requestId: upper },
    subject: { type: 'DEPOSIT_BLOCKER', id: upper },
    metadata: { depositId: upper, blockerKind: 'KYC' },
  } as never);
  assert.equal(event.actor.kind, 'ADMIN');
  if (event.actor.kind === 'ADMIN') assert.equal(event.actor.actorId, UUID_V7);
  assert.equal(event.subject.id, UUID_V7);
  assert.equal(event.metadata.depositId, UUID_V7);
  assert.ok(Object.isFrozen(event.actor));
  assert.ok(Object.isFrozen(event.subject));
});
test('matches database string, timestamp, null, and JSON-byte bounds', () => {
  const wallet = inputFor('WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED');
  assert.throws(
    () =>
      buildWalletCoreAdminAuditEvent({
        ...wallet,
        actor: { ...admin, deviceId: 'd'.repeat(129) },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
  const chain = inputFor('WALLET_CORE', 'CHAIN.CREATED');
  assert.throws(
    () =>
      buildWalletCoreAdminAuditEvent({
        ...chain,
        before: { ...(chain.before as object), name: 'n'.repeat(129) },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
  const settings = inputFor('WALLET_CORE', 'SETTINGS.SAVED');
  assert.throws(
    () =>
      buildWalletCoreAdminAuditEvent({
        ...settings,
        after: { revision: 1, status: 'LIVE', effectiveAt: '0000-01-01T00:00:00Z' },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
  assert.throws(
    () =>
      buildWalletCoreAdminAuditEvent({
        ...settings,
        after: { revision: 1, status: null, effectiveAt: null },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
  assert.throws(
    () =>
      buildWalletCoreAdminAuditEvent({
        ...chain,
        before: { ...(chain.before as object), name: 'n'.repeat(65536) },
      } as never),
    /ADMIN_AUDIT_INPUT_INVALID/,
  );
});
test('exports detached deep-frozen action and scalar descriptors', () => {
  assert.ok(Object.isFrozen(ADMIN_AUDIT_SCHEMA_DESCRIPTOR));
  const descriptor = ADMIN_AUDIT_SCHEMA_DESCRIPTOR.DEPOSIT['BULK_JOB.CREATED'];
  assert.ok(descriptor);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.actors));
  assert.throws(() => (descriptor.actors as string[]).push('SYSTEM'));
  const integer = ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR.totalItems;
  const status = ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR.status;
  assert.ok(integer);
  assert.ok(status?.valuesBySubject);
  assert.ok(Object.isFrozen(ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR));
  assert.ok(Object.isFrozen(integer));
  assert.ok(Object.isFrozen(status.valuesBySubject));
  assert.ok(Object.isFrozen(status.valuesBySubject.BULK_JOB));
  assert.throws(() => {
    (integer as { maximum?: number }).maximum = 0;
  });
  assert.throws(() => (status.valuesBySubject?.BULK_JOB as string[]).push('BROKEN'));
  const input = inputFor('DEPOSIT', 'BULK_JOB.CREATED');
  assert.doesNotThrow(() => buildDepositAdminAuditEvent(input as never));
  assert.throws(() => buildDepositAdminAuditEvent({ ...input, actor: system } as never), /ADMIN_AUDIT_INPUT_INVALID/);
});
