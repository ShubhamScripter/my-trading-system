import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES,
  ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR,
  ADMIN_AUDIT_SCHEMA_DESCRIPTOR,
  buildDepositAdminAuditEvent,
  buildWalletCoreAdminAuditEvent,
} from './admin-audit.payloads.js';
const UUID_V7 = '01920000-0000-7000-8000-000000000001';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ASCII_WHITESPACE = ' \t\n\r\f\v';
const EMOJI = '\u{1F642}';
type Domain = keyof typeof ADMIN_AUDIT_SCHEMA_DESCRIPTOR;
type Section = 'before' | 'after' | 'metadata';
type Input = Record<string, unknown>;
const admin = {
  kind: 'ADMIN', actorId: UUID_V7, sessionId: UUID_V7,
  requestId: UUID_V7, ipAddress: '127.0.0.1', deviceId: 'device',
} as const;
const system = { kind: 'SYSTEM', runId: UUID_V7 } as const;
function scalar(key: string, subject: string, action: string): string | number | boolean | null {
  if (ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.integer.includes(key)) return 1;
  if (ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.decimal.includes(key)) return '1';
  if (ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.uuid.includes(key)) return UUID;
  if (ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.boolean.includes(key)) return true;
  if (key === 'effectiveAt') return '2024-02-29T23:59:59.123Z';
  if (key === 'status') {
    if (action.startsWith('SETTINGS.')) return 'DRAFT';
    if (subject === 'DEPOSIT') return 'PENDING';
    if (subject === 'DEPOSIT_BLOCKER') return 'PENDING';
    if (subject === 'QUARANTINE') return 'OPEN';
    if (subject === 'BULK_JOB') return 'PENDING';
    if (subject === 'BULK_JOB_ITEM') return 'PENDING';
    return 'SUCCESS';
  }
  const enums: Record<string, string> = {
    desiredState: 'ON', effectiveState: 'ON', bucket: 'AVAILABLE', ownerType: 'USER',
    priceBasis: 'WEBHOOK_TIME', kind: 'CRYPTO', pricingStatus: 'ACTIVE',
    availableFor: 'USER', source: 'BLOCKCHAIN', sourceFormat: 'PNG',
    mediaType: 'image/webp', actionKind: 'RELEASE',
  };
  return enums[key] ?? key;
}
function validInput(domain: Domain, action: string, includeOptional = false): Input {
  const descriptor = ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain][action];
  assert.ok(descriptor);
  const subjectType = descriptor.subject[0] as string;
  const subjectId = subjectType === 'SETTINGS_REVISION'
    ? '1'
    : subjectType === 'PROVIDER_CATALOGUE' ? 'BLOCKCHAIN' : subjectType === 'LOGO_ASSET'
      ? `${'a'.repeat(64)}.webp` : subjectType === 'CURRENCY' ? UUID : UUID_V7;
  const state = Object.fromEntries(descriptor.state.map((key) => [key, scalar(key, subjectType, action)]));
  const metadataKeys = includeOptional
    ? [...descriptor.required, ...descriptor.optional]
    : [...descriptor.required];
  const metadata = Object.fromEntries(metadataKeys.map((key) => [key, scalar(key, subjectType, action)]));
  const transitions = {
    'SETTINGS.SAVED': [null, 'DRAFT'],
    'SETTINGS.PUSHED': ['DRAFT', 'LIVE'],
    'SETTINGS.SCHEDULED': ['DRAFT', 'SCHEDULED'],
    'SETTINGS.SCHEDULE_APPLIED': ['SCHEDULED', 'LIVE'],
    'SETTINGS.SCHEDULE_REJECTED': ['SCHEDULED', 'REJECTED'],
  } as const;
  const transition = transitions[action as keyof typeof transitions];
  const logo = action === 'LOGO.UPLOADED';
  return {
    domain,
    action,
    eventKey: `event-${domain}-${action}`,
    actor: descriptor.actors[0] === 'ADMIN' ? admin : system,
    subject: { type: subjectType, id: subjectId },
    reason: logo ? 'wallet-logo-upload' : 'reason',
    before: logo ? { stored: false } : transition?.[0] === null ? null : { ...state, ...(transition ? { status: transition[0] } : {}) },
    after: logo ? { stored: true, mediaType: 'image/webp', width: 500, height: 500, bytes: 1 } : { ...state, ...(transition ? { status: transition[1] } : {}) },
    metadata,
  };
}
function build(domain: Domain, input: Input) {
  return domain === 'WALLET_CORE'
    ? buildWalletCoreAdminAuditEvent(input as never)
    : buildDepositAdminAuditEvent(input as never);
}
function changed(input: Input, section: Section, key: string, value: unknown): Input {
  const sectionValue: Record<string, unknown> = {
    ...(input[section] as Record<string, unknown>),
  };
  if (key.startsWith('price')) {
    Object.assign(sectionValue, {
      priceBasis: 'WEBHOOK_TIME', priceResolutionId: UUID, priceSnapshotId: UUID,
    });
  }
  sectionValue[key] = value;
  return { ...input, [section]: sectionValue };
}
function sample(key: string): { domain: Domain; input: Input; section: Section } {
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, descriptor] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
      if (descriptor.state.includes(key)) return { domain, input: validInput(domain, action), section: key === 'stored' ? 'before' : 'after' };
      if (descriptor.required.includes(key) || descriptor.optional.includes(key)) {
        return { domain, input: validInput(domain, action), section: 'metadata' };
      }
    }
  }
  throw new Error(`missing scalar fixture for ${key}`);
}
const outputSection = (event: ReturnType<typeof build>, section: Section) => (
  event[section] as Readonly<Record<string, unknown>>
);
const rejects = (domain: Domain, input: Input, label?: string) => assert.throws(
  () => build(domain, input), /ADMIN_AUDIT_INPUT_INVALID/, label,
);
const jsonbTextBytes = (value: Readonly<Record<string, unknown>>): number => {
  const entries = Object.keys(value).length;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') + Math.max(0, (entries * 2) - 1);
};

test('trims exactly ASCII space, TAB, LF, CR, FF, and VT on free text and identities', () => {
  for (const whitespace of [...ASCII_WHITESPACE]) {
    const input = validInput('WALLET_CORE', 'SETTINGS.SAVED');
    const event = build('WALLET_CORE', {
      ...input,
      eventKey: `${whitespace}key${whitespace}`,
      reason: `${whitespace}reason${whitespace}`,
      actor: { ...admin, deviceId: `${whitespace}device${whitespace}` },
      subject: { type: 'SETTINGS_REVISION', id: `${whitespace}42${whitespace}` },
    });
    assert.equal(event.eventKey, 'key');
    assert.equal(event.reason, 'reason');
    assert.equal(event.subject.id, '42');
    assert.equal(event.actor.kind === 'ADMIN' && event.actor.deviceId, 'device');
  }

  const bounded: Array<[Domain, string, Section, string]> = [
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'name'],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'shortName'],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'blockchainReference'],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'logoObjectKey'],
    ['WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED', 'after', 'timezone'],
    ['WALLET_CORE', 'CURRENCY.CREATED', 'after', 'symbol'],
    ['WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED', 'metadata', 'providerReference'],
    ['DEPOSIT', 'BLOCKER.WAIVED', 'metadata', 'blockerKind'],
    ['DEPOSIT', 'BULK_JOB.CREATED', 'metadata', 'safeErrorCode'],
  ];
  for (const [domain, action, section, key] of bounded) {
    const input = changed(validInput(domain, action), section, key, `${ASCII_WHITESPACE}value${ASCII_WHITESPACE}`);
    assert.equal(outputSection(build(domain, input), section)[key], 'value', key);
    rejects(domain, changed(input, section, key, ASCII_WHITESPACE), `${key} blank`);
  }
});

test('measures every text bound in Unicode code points', () => {
  const bounded: Array<[Domain, string, Section, string, number]> = [
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'name', 128],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'shortName', 64],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'blockchainReference', 160],
    ['WALLET_CORE', 'CHAIN.CREATED', 'after', 'logoObjectKey', 255],
    ['WALLET_CORE', 'ADMIN_TIMEZONE.UPDATED', 'after', 'timezone', 64],
    ['WALLET_CORE', 'CURRENCY.CREATED', 'after', 'symbol', 32],
    ['WALLET_CORE', 'PROVIDER_MAINTENANCE.ENTERED', 'metadata', 'providerReference', 160],
    ['DEPOSIT', 'BLOCKER.WAIVED', 'metadata', 'blockerKind', 64],
    ['DEPOSIT', 'BULK_JOB.CREATED', 'metadata', 'safeErrorCode', 64],
  ];
  for (const [domain, action, section, key, limit] of bounded) {
    const input = validInput(domain, action);
    assert.doesNotThrow(() => build(domain, changed(input, section, key, EMOJI.repeat(limit))), `${key} boundary`);
    rejects(domain, changed(input, section, key, EMOJI.repeat(limit + 1)), `${key} overflow`);
  }
  const input = validInput('WALLET_CORE', 'SETTINGS.SAVED');
  assert.doesNotThrow(() => build('WALLET_CORE', {
    ...input,
    eventKey: EMOJI.repeat(200),
    reason: EMOJI.repeat(500),
    actor: { ...admin, deviceId: EMOJI.repeat(128) },
  }));
  rejects('WALLET_CORE', { ...input, eventKey: EMOJI.repeat(201) });
  rejects('WALLET_CORE', { ...input, reason: EMOJI.repeat(501) });
  rejects('WALLET_CORE', { ...input, actor: { ...admin, deviceId: EMOJI.repeat(129) } });
});

test('accepts only real canonical four-digit UTC effectiveAt timestamps', () => {
  const input = validInput('WALLET_CORE', 'SETTINGS.SAVED');
  for (const value of [
    '0001-01-01T00:00:00Z',
    '2024-02-29T23:59:59Z',
    '2024-02-29T23:59:59.123Z',
    '9999-12-31T23:59:59.999Z',
  ]) assert.doesNotThrow(() => build('WALLET_CORE', changed(input, 'after', 'effectiveAt', value)), value);
  for (const value of [
    '0000-01-01T00:00:00Z',
    '10000-01-01T00:00:00Z',
    '2023-02-29T00:00:00Z',
    '2024-02-30T00:00:00Z',
    '2024-13-01T00:00:00Z',
    '2024-01-01T24:00:00Z',
    '2024-01-01T00:00:00+00:00',
    '2024-01-01T00:00:00.12Z',
  ]) rejects('WALLET_CORE', changed(input, 'after', 'effectiveAt', value), value);
});

test('allows reconciliation warning shortfall null only when the same state is partial', () => {
  for (const action of ['RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED']) {
    for (const section of ['before', 'after'] as const) {
      const input = validInput('WALLET_CORE', action);
      for (const [partial, shortfallPercent, accepted] of [
        [true, null, true],
        [true, '1.25', true],
        [false, '1.25', true],
        [false, null, false],
      ] as const) {
        const candidate = {
          ...input,
          [section]: {
            ...(input[section] as Record<string, unknown>),
            partial,
            shortfallPercent,
          },
        };
        const label = `${action}/${section}/partial=${String(partial)}/${String(shortfallPercent)}`;
        if (accepted) assert.doesNotThrow(() => build('WALLET_CORE', candidate), label);
        else rejects('WALLET_CORE', candidate, label);
      }
      const state: Record<string, unknown> = {
        ...(input[section] as Record<string, unknown>), shortfallPercent: null,
      };
      delete state.partial;
      rejects('WALLET_CORE', { ...input, [section]: state }, `${action}/${section}/missing partial`);
    }
  }
});

test('allows scalar null only for effectiveAt, assignedUserId, and partial warning shortfall state values', () => {
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, descriptor] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
      const input = validInput(domain, action, true);
      for (const key of descriptor.state) {
        const candidate = changed(input, 'after', key, null);
        if (key === 'effectiveAt' || key === 'assignedUserId' || key === 'shortfallPercent') {
          assert.doesNotThrow(() => build(domain, candidate), `${domain}/${action}/${key}`);
        } else {
          rejects(domain, candidate, `${domain}/${action}/${key}`);
        }
      }
      for (const key of [...descriptor.required, ...descriptor.optional]) {
        rejects(domain, changed(input, 'metadata', key, null), `${domain}/${action}/${key}`);
      }
    }
  }
});

test('rejects null for every decimal state or metadata field except partial warning shortfall', () => {
  for (const key of ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.decimal) {
    if (key === 'shortfallPercent') continue;
    const { domain, input, section } = sample(key);
    rejects(domain, changed(input, section, key, null), key);
  }
});

test('accepts 128-digit decimals and rejects 129 digits for every decimal key', () => {
  const decimal128 = `1${'0'.repeat(127)}`;
  const decimal129 = `1${'0'.repeat(128)}`;
  for (const key of ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.decimal) {
    const { domain, input, section } = sample(key);
    assert.doesNotThrow(() => build(domain, changed(input, section, key, decimal128)), `${key} 128`);
    rejects(domain, changed(input, section, key, decimal129), `${key} 129`);
    assert.doesNotThrow(
      () => build(domain, changed(input, section, key, '1.123456789012345678')),
      `${key} fraction`,
    );
    for (const invalid of [-1, '-1', '01', '1.1234567890123456789']) {
      rejects(domain, changed(input, section, key, invalid), `${key}/${String(invalid)}`);
    }
  }
});

test('rejects every required top-level, identity, and action metadata omission', () => {
  const base = validInput('WALLET_CORE', 'SETTINGS.SAVED');
  for (const key of [
    'domain', 'action', 'eventKey', 'actor', 'subject', 'reason', 'before', 'after', 'metadata',
  ]) {
    const candidate = { ...base };
    delete candidate[key];
    rejects('WALLET_CORE', candidate, `top-level ${key}`);
  }
  for (const key of ['kind', 'actorId', 'sessionId', 'requestId', 'ipAddress', 'deviceId']) {
    const actorValue = { ...admin } as Record<string, unknown>;
    delete actorValue[key];
    rejects('WALLET_CORE', { ...base, actor: actorValue }, `ADMIN ${key}`);
  }
  const systemInput = validInput('WALLET_CORE', 'SETTINGS.SCHEDULE_APPLIED');
  rejects('WALLET_CORE', { ...systemInput, actor: { kind: 'SYSTEM' } }, 'SYSTEM runId');
  for (const key of ['type', 'id']) {
    const subject = { ...(base.subject as Record<string, unknown>) };
    delete subject[key];
    rejects('WALLET_CORE', { ...base, subject }, `subject ${key}`);
  }
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, descriptor] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
      for (const key of descriptor.required) {
        const input = validInput(domain, action);
        const metadata = { ...(input.metadata as Record<string, unknown>) };
        delete metadata[key];
        rejects(domain, { ...input, metadata }, `${domain}/${action}/${key}`);
      }
    }
  }
});

test('rejects every prohibited actor kind for every action', () => {
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, descriptor] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
      const input = validInput(domain, action);
      for (const [kind, actorValue] of [['ADMIN', admin], ['SYSTEM', system]] as const) {
        if (!descriptor.actors.includes(kind)) {
          rejects(domain, { ...input, actor: actorValue }, `${domain}/${action}/${kind}`);
        }
      }
    }
  }
});

test('accepts and rejects every integer, UUID, and boolean scalar family', () => {
  for (const key of ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.integer) {
    const { domain, input, section } = sample(key);
    const validator = ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR[key];
    assert.ok(validator);
    for (const value of [Number(validator.minimum), validator.maximum]) {
      const candidate = ['width', 'height'].includes(key) ? { ...input, after: { ...(input.after as object), width: value, height: value } } : changed(input, section, key, value);
      assert.doesNotThrow(() => build(domain, candidate), `${key}/${value}`);
    }
    for (const value of [Number(validator.minimum) - 1, 1.5, '1', Number(validator.maximum) + 1]) {
      rejects(domain, changed(input, section, key, value), `${key}/${String(value)}`);
    }
  }
  for (const key of ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.uuid) {
    const { domain, input, section } = sample(key);
    assert.equal(
      outputSection(build(domain, changed(input, section, key, UUID.toUpperCase())), section)[key],
      UUID,
      key,
    );
    rejects(domain, changed(input, section, key, 'not-a-uuid'), key);
  }
  for (const key of ADMIN_AUDIT_SCALAR_VALIDATOR_CATEGORIES.boolean) {
    const { domain, input, section } = sample(key);
    assert.doesNotThrow(() => build(domain, changed(input, section, key, false)), `${key}/false`);
    rejects(domain, changed(input, section, key, 'false'), key);
  }
});

test('accepts lowercase-normalized RFC UUID actors without weakening designated v7 subjects', () => {
  const upper = UUID.toUpperCase();
  const adminInput = validInput('WALLET_CORE', 'SETTINGS.SAVED');
  const adminEvent = build('WALLET_CORE', {
    ...adminInput,
    actor: {
      kind: 'ADMIN', actorId: upper, sessionId: upper,
      requestId: upper, ipAddress: '127.0.0.1', deviceId: 'device',
    },
  });
  assert.deepEqual(adminEvent.actor, {
    kind: 'ADMIN', actorId: UUID, sessionId: UUID,
    requestId: UUID, ipAddress: '127.0.0.1', deviceId: 'device',
  });

  const systemInput = validInput('WALLET_CORE', 'SETTINGS.SCHEDULE_APPLIED');
  assert.deepEqual(build('WALLET_CORE', {
    ...systemInput,
    actor: { kind: 'SYSTEM', runId: upper },
  }).actor, { kind: 'SYSTEM', runId: UUID });

  for (const field of ['actorId', 'sessionId', 'requestId'] as const) {
    const actorValue = { ...admin, [field]: 'not-a-uuid' };
    rejects('WALLET_CORE', { ...adminInput, actor: actorValue }, field);
  }
  rejects('WALLET_CORE', { ...systemInput, actor: { kind: 'SYSTEM', runId: 'not-a-uuid' } }, 'runId');
  const designatedSubject = validInput('DEPOSIT', 'DEPOSIT.STATUS_CHANGED');
  rejects('DEPOSIT', { ...designatedSubject, subject: { type: 'DEPOSIT', id: UUID } }, 'v7 subject');
});

test('rejects U+0000 in every string-bearing input slot before returning an event', () => {
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const action of Object.keys(ADMIN_AUDIT_SCHEMA_DESCRIPTOR[domain])) {
      const input = validInput(domain, action, true);
      for (const key of ['domain', 'action', 'eventKey', 'reason']) {
        rejects(domain, { ...input, [key]: `${String(input[key])}\0` }, `${domain}/${action}/${key}`);
      }
      for (const container of ['actor', 'subject'] as const) {
        for (const [key, value] of Object.entries(input[container] as Record<string, unknown>)) {
          if (typeof value === 'string') {
            rejects(domain, {
              ...input,
              [container]: { ...(input[container] as Record<string, unknown>), [key]: `${value}\0` },
            }, `${domain}/${action}/${container}.${key}`);
          }
        }
      }
      for (const section of ['before', 'after', 'metadata'] as const) {
        if (input[section] === null) continue;
        for (const [key, value] of Object.entries(input[section] as Record<string, unknown>)) {
          if (typeof value === 'string') {
            rejects(domain, changed(input, section, key, `${value}\0`), `${domain}/${action}/${section}.${key}`);
          }
        }
      }
    }
  }
});

test('measures raw JSONB text bytes before normalization and accepts the exact limit', () => {
  const input = validInput('WALLET_CORE', 'CHAIN.CREATED');
  const after = input.after as Record<string, unknown>;
  const baseline = jsonbTextBytes({ ...after, name: 'A' });
  const exact = { ...after, name: `${' '.repeat(65_536 - baseline)}A` };
  assert.equal(jsonbTextBytes(exact), 65_536);
  const event = build('WALLET_CORE', { ...input, after: exact });
  assert.equal((event.after as Readonly<Record<string, unknown>>).name, 'A');
  rejects('WALLET_CORE', { ...input, after: { ...exact, name: ` ${String(exact.name)}` } }, '65,537 raw bytes');
  rejects('WALLET_CORE', changed(input, 'after', 'name', `${' '.repeat(70_000)}A`), '70k leading spaces');
});

test('accepts every member and rejects an outsider for every non-settings enum family', () => {
  const families: Array<[Domain, string, Section, string, readonly string[]]> = [
    ['WALLET_CORE', 'CHAIN.STATUS_CHANGED', 'after', 'desiredState', ['ON', 'OFF', 'MAINTAIN', 'UPCOMING']],
    ['DEPOSIT', 'DEPOSIT.STATUS_CHANGED', 'after', 'status', ['PENDING', 'HELD', 'SUCCESS', 'FAILED', 'REJECTED', 'CANCELLED', 'QUARANTINED', 'RETRY_PENDING']],
    ['DEPOSIT', 'BLOCKER.WAIVED', 'after', 'status', ['PENDING', 'RESOLVED', 'WAIVED']],
    ['DEPOSIT', 'QUARANTINE.ASSIGNED', 'after', 'status', ['OPEN', 'RETRY_PENDING', 'ASSIGNED', 'RETAINED', 'SETTLED']],
    ['DEPOSIT', 'BULK_JOB.COMPLETED', 'after', 'status', ['PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED']],
    ['DEPOSIT', 'BULK_JOB.ITEM_SUCCEEDED', 'after', 'status', ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']],
    ['WALLET_CORE', 'RECONCILIATION.COMPLETED', 'after', 'status', ['SUCCESS', 'PARTIAL', 'FAILED']],
    ['WALLET_CORE', 'DELISTING.FORFEITURE_POSTED', 'metadata', 'ownerType', ['USER', 'MERCHANT']],
    ['DEPOSIT', 'DEPOSIT.STATUS_CHANGED', 'after', 'bucket', ['AVAILABLE', 'HOLD', 'OREBIT_TREASURY', 'OREBIT_COLLECTION']],
    ['DEPOSIT', 'DEPOSIT.RELEASED', 'metadata', 'priceBasis', ['WEBHOOK_TIME', 'ADMIN_CREDIT_TIME']],
    ['WALLET_CORE', 'CURRENCY.UPDATED', 'after', 'kind', ['CRYPTO', 'FIAT']],
    ['WALLET_CORE', 'CURRENCY.UPDATED', 'after', 'pricingStatus', ['ACTIVE', 'DISABLED']],
    ['WALLET_CORE', 'CHAIN.UPDATED', 'after', 'availableFor', ['USER', 'MERCHANT', 'BOTH']],
    ['DEPOSIT', 'BULK_JOB.CREATED', 'metadata', 'actionKind', ['RELEASE', 'REJECT', 'MAINTENANCE_RELEASE', 'MAINTENANCE_CANCEL', 'REVERIFICATION_HOLD', 'CLAWBACK_TO_ZERO', 'CLAWBACK_NEGATIVE', 'WAIT_FOR_SETTLEMENT', 'SCHEDULED_STATE_TRANSITION']],
    ['WALLET_CORE', 'CATALOGUE.REFRESHED', 'metadata', 'source', ['BLOCKCHAIN']],
  ];
  for (const [domain, action, section, key, values] of families) {
    const input = validInput(domain, action);
    for (const value of values) {
      assert.doesNotThrow(
        () => build(domain, changed(input, section, key, value)),
        `${action}/${key}/${value}`,
      );
    }
    rejects(domain, changed(input, section, key, 'NOT_ALLOWED'), `${action}/${key}`);
  }
});

test('enforces the exact settings lifecycle before/after status matrix in both domains', () => {
  const transitions = [
    ['SETTINGS.SAVED', null, 'DRAFT'], ['SETTINGS.PUSHED', 'DRAFT', 'LIVE'],
    ['SETTINGS.SCHEDULED', 'DRAFT', 'SCHEDULED'], ['SETTINGS.SCHEDULE_APPLIED', 'SCHEDULED', 'LIVE'],
    ['SETTINGS.SCHEDULE_REJECTED', 'SCHEDULED', 'REJECTED'],
  ] as const;
  const statuses = ['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED'] as const;
  for (const domain of ['WALLET_CORE', 'DEPOSIT'] as const) {
    for (const [action, beforeStatus, afterStatus] of transitions) {
      const input = validInput(domain, action);
      assert.doesNotThrow(() => build(domain, input), `${domain}/${action}`);
      for (const status of statuses) {
        const before = status === beforeStatus ? input.before : { revision: 1, status, effectiveAt: null };
        const after = { revision: 1, status, effectiveAt: null };
        if (status !== beforeStatus) rejects(domain, { ...input, before }, `${domain}/${action}/before/${status}`);
        if (status !== afterStatus) rejects(domain, { ...input, after }, `${domain}/${action}/after/${status}`);
      }
      if (beforeStatus !== null) rejects(domain, { ...input, before: null }, `${domain}/${action}/before/null`);
      else rejects(domain, { ...input, before: { revision: 1, status: 'DRAFT', effectiveAt: null } }, `${domain}/${action}/before/object`);
      rejects(domain, { ...input, after: null }, `${domain}/${action}/after/null`);
      rejects(domain, { ...input, after: { revision: 1, effectiveAt: null } }, `${domain}/${action}/after/missing-status`);
    }
  }
});

test('accepts no provenance or the complete triple and rejects every partial triple', () => {
  const input = validInput('DEPOSIT', 'DEPOSIT.RELEASED');
  for (let mask = 0; mask < 8; mask += 1) {
    const metadata = { ...(input.metadata as Record<string, unknown>) };
    if (mask & 1) metadata.priceBasis = 'WEBHOOK_TIME';
    if (mask & 2) metadata.priceResolutionId = UUID;
    if (mask & 4) metadata.priceSnapshotId = UUID;
    const candidate = { ...input, metadata };
    if (mask === 0 || mask === 7) {
      assert.doesNotThrow(() => build('DEPOSIT', candidate), `mask ${mask}`);
    } else {
      rejects('DEPOSIT', candidate, `mask ${mask}`);
    }
  }
});

test('rejects an over-limit JSON object made only of boolean scalars', () => {
  const input = validInput('WALLET_CORE', 'SETTINGS.SAVED');
  const oversized = Object.fromEntries(
    Array.from({ length: 7_000 }, (_, index) => [`padding${index}`, true]),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 65_536);
  rejects('WALLET_CORE', { ...input, after: oversized });
});
