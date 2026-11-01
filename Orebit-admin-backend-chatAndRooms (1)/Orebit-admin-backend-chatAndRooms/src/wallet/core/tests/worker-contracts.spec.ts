import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WALLET_CRON_SAFE_REASON_CODES,
  WALLET_PROVIDER_MAINTENANCE_OUTBOX_EVENTS,
  walletPositiveSkippedBucketCount,
  type AdminWalletAlert,
  type ProviderMaintenanceAlertPayload,
  type WalletAlertSafePayload,
  type WalletCronRunOutcome,
} from '../wallet-core.types.js';
import {
  planWalletProviderCatchup,
  resolveProviderMaintenanceObservation,
} from '../wallet-core.policy.js';

const ID = '01990000-0000-7000-8000-000000000001';

describe('Wallet worker contracts', () => {
  it('closes cron terminal outcomes to their approved safe reasons', () => {
    assert.deepEqual(WALLET_CRON_SAFE_REASON_CODES, [
      'LOGO_CLEANUP_PARTIAL',
      'CONFIGURATION_REJECTED', 'PROVIDER_OBSERVATION_PARTIAL',
      'PROVIDER_OBSERVATION_FAILED', 'DEPENDENCY_UNAVAILABLE',
      'MISSED_SCHEDULE', 'CATCHUP_TRUNCATED', 'UNEXPECTED_ERROR',
    ]);
    const outcomes = [
      { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'CONFIGURATION_REJECTED', skippedBucketCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'PROVIDER_OBSERVATION_PARTIAL', skippedBucketCount: 0 },
      { status: 'PARTIAL', safeErrorCode: 'LOGO_CLEANUP_PARTIAL', skippedBucketCount: 0 },
      { status: 'FAILED', safeErrorCode: 'PROVIDER_OBSERVATION_FAILED', skippedBucketCount: 0 },
      { status: 'FAILED', safeErrorCode: 'DEPENDENCY_UNAVAILABLE', skippedBucketCount: 0 },
      { status: 'FAILED', safeErrorCode: 'UNEXPECTED_ERROR', skippedBucketCount: 0 },
      { status: 'SKIPPED', safeErrorCode: 'MISSED_SCHEDULE', skippedBucketCount: 0 },
      { status: 'SKIPPED', safeErrorCode: 'CATCHUP_TRUNCATED',
        skippedBucketCount: walletPositiveSkippedBucketCount(1) },
    ] as const satisfies readonly WalletCronRunOutcome[];
    assert.deepEqual(JSON.parse(JSON.stringify(outcomes)), outcomes);

    // @ts-expect-error LEASE_LOST exits without creating a terminal outcome
    const leaseLost = { status: 'FAILED', safeErrorCode: 'LEASE_LOST', skippedBucketCount: 0 } satisfies WalletCronRunOutcome;
    assert.equal(leaseLost.safeErrorCode, 'LEASE_LOST');
  });

  it('constructs truncated catch-up counts only from positive safe integers', () => {
    assert.equal(walletPositiveSkippedBucketCount(1), 1);
    assert.equal(walletPositiveSkippedBucketCount(Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER);
    for (const invalid of [
      0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => walletPositiveSkippedBucketCount(invalid),
        /Invalid skipped bucket count/);
    }
    const unvalidated = { status: 'SKIPPED', safeErrorCode: 'CATCHUP_TRUNCATED',
      // @ts-expect-error CATCHUP_TRUNCATED counts must pass the runtime factory first
      skippedBucketCount: 1 } satisfies WalletCronRunOutcome;
    assert.equal(unvalidated.skippedBucketCount, 1);
  });

  it('bounds catch-up to the latest 288 missed buckets and summarizes older backlog', () => {
    assert.deepEqual(planWalletProviderCatchup(0), {
      materializedMissedBucketCount: 0, truncatedSummary: null,
    });
    assert.deepEqual(planWalletProviderCatchup(288), {
      materializedMissedBucketCount: 288, truncatedSummary: null,
    });
    assert.deepEqual(planWalletProviderCatchup(289), {
      materializedMissedBucketCount: 288,
      truncatedSummary: { safeErrorCode: 'CATCHUP_TRUNCATED', skippedBucketCount: 1 },
    });
    assert.deepEqual(planWalletProviderCatchup(1_000), {
      materializedMissedBucketCount: 288,
      truncatedSummary: { safeErrorCode: 'CATCHUP_TRUNCATED', skippedBucketCount: 712 },
    });
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => planWalletProviderCatchup(invalid), /Invalid missed bucket count/);
    }
  });

  it('defines the exact safe provider-maintenance alert and outbox names', () => {
    assert.deepEqual(WALLET_PROVIDER_MAINTENANCE_OUTBOX_EVENTS, [
      'WALLET_PROVIDER_MAINTENANCE_ENTERED',
      'WALLET_PROVIDER_MAINTENANCE_RECOVERED',
    ]);
    const payload = {
      category: 'PROVIDER_MAINTENANCE', subjectType: 'CURRENCY_CHAIN', subjectId: ID,
      providerReference: 'CURRENCY_CHAIN:1:10', providerState: 'UNAVAILABLE',
      failureStreak: 3, maintenancePinned: false, effectiveState: 'MAINTAIN',
      observedAt: '2026-09-05T10:00:00.000000Z',
    } as const satisfies ProviderMaintenanceAlertPayload;
    const safe: WalletAlertSafePayload = payload;
    const adminAlert = {
      id: ID, category: 'PROVIDER_MAINTENANCE', status: 'ACTIVE', currencyId: ID,
      payload: {
        subjectType: 'CURRENCY_CHAIN', subjectId: ID,
        providerReference: 'CURRENCY_CHAIN:1:10', providerState: 'UNAVAILABLE',
        failureStreak: 3, maintenancePinned: false, effectiveState: 'MAINTAIN',
        observedAt: '2026-09-05T10:00:00.000000Z',
      },
      openedAt: '2026-09-05T10:00:00.000000Z',
      updatedAt: '2026-09-05T10:00:00.000000Z',
    } as const satisfies AdminWalletAlert;
    assert.deepEqual(JSON.parse(JSON.stringify(safe)), payload);
    assert.equal(adminAlert.currencyId, ID);

    // @ts-expect-error alert payloads cannot contain raw provider messages
    const raw = { ...payload, rawMessage: 'upstream secret' } satisfies ProviderMaintenanceAlertPayload;
    // @ts-expect-error providerReference must correspond to the subject type
    const wrongReference = { ...payload, providerReference: 'CHAIN:1' } satisfies ProviderMaintenanceAlertPayload;
    // @ts-expect-error provider references use positive canonical decimal IDs
    const zeroReference = { ...payload, providerReference: 'CURRENCY_CHAIN:0:10' } satisfies ProviderMaintenanceAlertPayload;
    // @ts-expect-error provider references reject leading-zero IDs
    const leadingZeroReference = { ...payload, providerReference: 'CURRENCY_CHAIN:01:10' } satisfies ProviderMaintenanceAlertPayload;
    // @ts-expect-error the failure streak is capped at three
    const uncapped = { ...payload, failureStreak: 4 } satisfies ProviderMaintenanceAlertPayload;
    assert.equal([raw, wrongReference, zeroReference, leadingZeroReference, uncapped].length, 5);
  });

  it('caps failed checks at three and enters maintenance only on the third failure', () => {
    const first = resolveProviderMaintenanceObservation({
      previousProviderState: 'ACTIVATED', failureStreak: 0, desiredState: 'ON',
      maintenancePinned: false, outcome: 'FAILED',
    });
    assert.deepEqual(first, {
      providerState: 'ACTIVATED', failureStreak: 1, effectiveState: 'ON',
      transition: null, outboxEvent: null,
    });
    assert.deepEqual(resolveProviderMaintenanceObservation({
      previousProviderState: 'ACTIVATED', failureStreak: 2, desiredState: 'ON',
      maintenancePinned: false, outcome: 'FAILED',
    }), {
      providerState: 'UNAVAILABLE', failureStreak: 3, effectiveState: 'MAINTAIN',
      transition: 'ENTERED', outboxEvent: 'WALLET_PROVIDER_MAINTENANCE_ENTERED',
    });
    assert.deepEqual(resolveProviderMaintenanceObservation({
      previousProviderState: 'UNAVAILABLE', failureStreak: 3, desiredState: 'ON',
      maintenancePinned: false, outcome: 'FAILED',
    }), {
      providerState: 'UNAVAILABLE', failureStreak: 3, effectiveState: 'MAINTAIN',
      transition: null, outboxEvent: null,
    });
  });

  it('applies explicit provider state immediately and resets successful checks', () => {
    for (const outcome of ['DISABLED', 'MAINTENANCE'] as const) {
      assert.deepEqual(resolveProviderMaintenanceObservation({
        previousProviderState: 'ACTIVATED', failureStreak: 2, desiredState: 'ON',
        maintenancePinned: false, outcome,
      }), {
        providerState: outcome, failureStreak: 0, effectiveState: 'MAINTAIN',
        transition: 'ENTERED', outboxEvent: 'WALLET_PROVIDER_MAINTENANCE_ENTERED',
      });
    }
    assert.deepEqual(resolveProviderMaintenanceObservation({
      previousProviderState: 'DISABLED', failureStreak: 2, desiredState: 'ON',
      maintenancePinned: false, outcome: 'FAILED',
    }), {
      providerState: 'DISABLED', failureStreak: 3, effectiveState: 'MAINTAIN',
      transition: null, outboxEvent: null,
    });
  });

  it('recovers the provider facet while pin and desired state still control effective state', () => {
    assert.deepEqual(resolveProviderMaintenanceObservation({
      previousProviderState: 'UNAVAILABLE', failureStreak: 3, desiredState: 'ON',
      maintenancePinned: true, outcome: 'ACTIVATED',
    }), {
      providerState: 'ACTIVATED', failureStreak: 0, effectiveState: 'MAINTAIN',
      transition: 'RECOVERED', outboxEvent: 'WALLET_PROVIDER_MAINTENANCE_RECOVERED',
    });
    assert.deepEqual(resolveProviderMaintenanceObservation({
      previousProviderState: 'MAINTENANCE', failureStreak: 1, desiredState: 'OFF',
      maintenancePinned: false, outcome: 'ACTIVATED',
    }), {
      providerState: 'ACTIVATED', failureStreak: 0, effectiveState: 'OFF',
      transition: 'RECOVERED', outboxEvent: 'WALLET_PROVIDER_MAINTENANCE_RECOVERED',
    });
    assert.throws(() => resolveProviderMaintenanceObservation({
      previousProviderState: 'ACTIVATED', failureStreak: 4, desiredState: 'ON',
      maintenancePinned: false, outcome: 'FAILED',
    }), /Invalid provider failure streak/);
  });
});
