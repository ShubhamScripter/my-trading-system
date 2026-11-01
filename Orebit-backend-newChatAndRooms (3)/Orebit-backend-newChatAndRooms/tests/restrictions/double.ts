import { vi } from 'vitest';
import type {
  RequestFacts,
  RestrictionPlan,
  RestrictionTarget,
  RiskAssessment,
  SecurityContext,
} from '../../src/restrictions/restrictions.types';

/**
 * Doubles for the restriction engine, for the specs of services that merely TRIGGER it.
 *
 * Those specs are about password policy, factor-disable paths and Payment PIN rules.
 * None of them is about classification, and none should have to construct a session
 * history to test a password rule — so the default double classifies nothing, plans
 * nothing, and writes nothing. The engine's own behaviour is tested in
 * `restrictions.evaluator.spec.ts` and `restrictions.enforcement.spec.ts`.
 */

/** The request facts every settings spec now passes instead of a bare ipClass. */
export const FACTS: RequestFacts = {
  ipClass: '203.0.113.0/24',
  country: null,
  requestId: 'req-test-0001',
};

export const CONTEXT: SecurityContext = {
  userId: 'user-1',
  sessionId: 'session-1',
  deviceFingerprint: 'a'.repeat(64),
  ipClass: FACTS.ipClass,
  country: null,
  requestId: FACTS.requestId,
};

export function assessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    isNewIp: false,
    isNewDevice: false,
    isNewCountry: false,
    classification: 'COMMON_IP_DEVICE',
    policyContext: 'COMMON_IP_DEVICE',
    observedIpClass: FACTS.ipClass,
    observedDevice: CONTEXT.deviceFingerprint,
    observedCountry: null,
    ...overrides,
  };
}

/** A plan that writes nothing — the state of every deployment while `PLATFORM_FEATURES` is empty. */
export function noPlan(action = 'password.change'): RestrictionPlan {
  return {
    action: action as RestrictionPlan['action'],
    assessment: assessment(),
    policyVersion: null,
    durationSeconds: 0,
    targets: [],
  };
}

/** A plan that writes the given targets, for specs that assert the rows land. */
export function planWith(
  targets: readonly RestrictionTarget[],
  durationSeconds = 1800,
  overrides: Partial<RestrictionPlan> = {},
): RestrictionPlan {
  return {
    action: 'password.change',
    assessment: assessment(),
    policyVersion: 1,
    durationSeconds,
    targets,
    ...overrides,
  };
}

/**
 * A `SecurityRestrictionService` double.
 *
 * `contextFrom` and `planFor` are the only two methods the sensitive services call,
 * and both are spies so a spec can assert WHICH trigger action was reported — which is
 * the one thing about restrictions those specs legitimately care about.
 */
export function makeRestrictions(plan: RestrictionPlan = noPlan()) {
  return {
    contextFrom: vi.fn(async () => CONTEXT),
    planFor: vi.fn(async (action: string) => ({ ...plan, action })),
    record: vi.fn(() => undefined),
  };
}
