import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDepositAdminAuditEvent, buildWalletCoreAdminAuditEvent } from './admin-audit.payloads.js';
import type { WalletCoreAdminAuditInput } from './admin-audit.types.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADMIN = { kind: 'ADMIN', actorId: UUID, sessionId: UUID, requestId: UUID,
  ipAddress: '127.0.0.1', deviceId: 'device' } as const;
const SYSTEM = { kind: 'SYSTEM', runId: UUID } as const;
type ActionInput<A extends string> = WalletCoreAdminAuditInput extends infer Entry
  ? Entry extends { readonly action: infer Allowed } ? A extends Allowed ? Entry : never : never : never;
type SubjectFor<A extends string> = ActionInput<A>['subject']['type'];
const statusBindingSubject: SubjectFor<'CURRENCY.STATUS_CHANGED'> = 'CURRENCY_CHAIN';
const providerBindingSubject: SubjectFor<'PROVIDER_MAINTENANCE.ENTERED'> = 'CURRENCY_CHAIN';
const pinBindingSubject: SubjectFor<'PROVIDER_MAINTENANCE.PINNED'> = 'CURRENCY_CHAIN';
const pinChainSubject: SubjectFor<'PROVIDER_MAINTENANCE.PINNED'> = 'CHAIN';
// @ts-expect-error pin actions cannot target a whole currency
const pinCurrencySubject: SubjectFor<'PROVIDER_MAINTENANCE.PINNED'> = 'CURRENCY';
// @ts-expect-error price maintenance remains whole-coin/chain only
const priceBindingSubject: SubjectFor<'PRICE_MAINTENANCE.ENTERED'> = 'CURRENCY_CHAIN';
void statusBindingSubject; void providerBindingSubject; void pinBindingSubject; void pinChainSubject;
void pinCurrencySubject; void priceBindingSubject;

const common = (action: string, actor: typeof ADMIN | typeof SYSTEM, type = 'CURRENCY_CHAIN') => ({
  domain: 'WALLET_CORE', action, eventKey: `subject:${action}:${type}`, actor,
  subject: { type, id: `\t${UUID.toUpperCase()}\n` }, reason: 'subject transition',
});
const status = (type = 'CURRENCY_CHAIN', actor: typeof ADMIN | typeof SYSTEM = ADMIN) => ({
  ...common('CURRENCY.STATUS_CHANGED', actor, type),
  before: { desiredState: 'ON', effectiveState: 'ON', showBalance: true },
  after: { desiredState: 'OFF', effectiveState: 'OFF', showBalance: false },
  metadata: { configurationRevision: 1 },
});
const provider = (action: string, type = 'CURRENCY_CHAIN') => ({ ...common(action, SYSTEM, type),
  before: { effectiveState: 'ON', failureStreak: 2, maintenancePinned: false },
  after: { effectiveState: 'MAINTAIN', failureStreak: 3, maintenancePinned: false },
  metadata: { configurationRevision: 1, providerReference: 'provider' },
});
const pin = (action = 'PROVIDER_MAINTENANCE.PINNED', type = 'CURRENCY_CHAIN') => ({
  ...common(action, ADMIN, type),
  before: { maintenancePinned: false, effectiveState: 'ON' },
  after: { maintenancePinned: true, effectiveState: 'MAINTAIN' },
  metadata: { configurationRevision: 1 },
});

test('normalizes binding UUID subjects for status, provider health, and provider pin actions', () => {
  for (const input of [status(), status('CURRENCY', SYSTEM),
    provider('PROVIDER_MAINTENANCE.ENTERED'), provider('PROVIDER_MAINTENANCE.RECOVERED'),
    provider('PROVIDER_MAINTENANCE.ENTERED', 'CURRENCY'),
    pin(), pin('PROVIDER_MAINTENANCE.UNPINNED')]) {
    const event = buildWalletCoreAdminAuditEvent(input as never);
    assert.equal(event.subject.id, UUID);
  }
});

test('rejects whole currencies for pin actions and keeps excluded Wallet and Deposit subjects closed', () => {
  const excluded = [
    { ...common('CURRENCY.CREATED', ADMIN), before: null,
      after: { symbol: 'BTC', name: 'Bitcoin', kind: 'CRYPTO', pricingStatus: 'ACTIVE', desiredState: 'ON' },
      metadata: { configurationRevision: 1 } },
    pin('PROVIDER_MAINTENANCE.PINNED', 'CURRENCY'),
    pin('PROVIDER_MAINTENANCE.UNPINNED', 'CURRENCY'),
    provider('PRICE_MAINTENANCE.ENTERED'),
  ];
  for (const input of excluded) assert.throws(
    () => buildWalletCoreAdminAuditEvent(input as never), /ADMIN_AUDIT_INPUT_INVALID/);
  for (const input of [status(), pin()]) assert.throws(
    () => buildWalletCoreAdminAuditEvent({ ...input,
      subject: { type: 'CURRENCY_CHAIN', id: 'not-a-uuid' } } as never), /ADMIN_AUDIT_INPUT_INVALID/);
  assert.throws(() => buildDepositAdminAuditEvent({ ...status(), domain: 'DEPOSIT',
    action: 'DEPOSIT.STATUS_CHANGED', subject: { type: 'CURRENCY_CHAIN', id: UUID },
    before: { status: 'PENDING', bucket: 'HOLD', visible: false },
    after: { status: 'SUCCESS', bucket: 'AVAILABLE', visible: true },
    metadata: { currencyId: UUID } } as never), /ADMIN_AUDIT_INPUT_INVALID/);
});
