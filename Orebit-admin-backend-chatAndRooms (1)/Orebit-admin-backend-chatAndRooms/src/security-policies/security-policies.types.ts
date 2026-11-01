/**
 * ═══ THE VOCABULARY THE SECURITY-RESTRICTION POLICY IS WRITTEN IN ══════════
 *
 * The trigger actions and configurable contexts an Admin may name, plus the elevation
 * each write demands.
 *
 * ═══ WHY THIS IS DUPLICATED FROM THE USER BACKEND, NOT SHARED ══════════════
 *
 * `Orebit-backend/src/restrictions/restrictions.catalogue.ts` declares the same two
 * lists. That is a copy, and it is deliberate rather than an oversight:
 *
 * There is no shared package. The two services have separate `package.json` files,
 * separate lockfiles and no workspace, and every other thing they share is copied the
 * same way — `src/2fa/elevation.ts` says "Ported from Orebit-admin-backend", and
 * `auth/security/device.cookie.ts` in the consumer backend says it was lifted from
 * here. Introducing a monorepo to share two string tuples would be a larger and more
 * disruptive change than the duplication it removes.
 *
 * What makes the copy safe is that these values are STORED. An Admin writes
 * `password.change` into `identity.security_restriction_policies.action`, and the user
 * backend matches on it; if the two lists ever diverge, the symptom is not a type error
 * but a policy that silently matches nothing. `security-policies.drift.spec.ts` reads
 * both files and asserts they agree, which is the check a shared import would have
 * given for free.
 */

export const TRIGGER_ACTIONS = [
  'password.change',
  'email.update',
  /**
   * INERT. There is no phone feature in either backend — no column, no table, no
   * route. These are configurable so an operator can set them up before the feature
   * exists, and nothing ever emits them until it does.
   */
  'phone.update',
  'phone.remove',
  'passkey.remove',
  'authenticator.remove',
  'paymentPin.update',
  'paymentPin.remove',
] as const;

export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export function isTriggerAction(value: string): value is TriggerAction {
  return (TRIGGER_ACTIONS as readonly string[]).includes(value);
}

/**
 * The two contexts a policy may be configured FOR.
 *
 * `UNCLASSIFIED` is deliberately absent and must never be added. It is a conclusion
 * the user backend's evaluator reaches when a request matches neither rule — not a
 * context an operator configures. Admitting it here would ask an Admin to configure a
 * policy for "we could not tell", and would let them configure it more leniently than
 * the strict one it is defined to fall back to.
 */
export const POLICY_CONTEXTS = ['COMMON_IP_DEVICE', 'NEW_CONTEXT'] as const;

export type PolicyContext = (typeof POLICY_CONTEXTS)[number];

export function isPolicyContext(value: string): value is PolicyContext {
  return (POLICY_CONTEXTS as readonly string[]).includes(value);
}

/**
 * The units an operator may express a duration in, and what each is worth in seconds.
 *
 * A table rather than a `switch`, for `ADMIN_ELEVATION`'s reason: the conversion is
 * the contract, and a contract spread across cases is one a reviewer reconstructs.
 *
 * Seconds is the only STORED form — see `security-policies.dto.ts`.
 */
export const DURATION_UNITS = {
  MINUTES: 60,
  HOURS: 60 * 60,
  DAYS: 24 * 60 * 60,
} as const;

export type DurationUnit = keyof typeof DURATION_UNITS;

export const DURATION_UNIT_NAMES = Object.keys(DURATION_UNITS) as readonly DurationUnit[];

/**
 * The elevation a policy write must have been proved for.
 *
 * Its own action rather than a shared `admin.write`, following `ADMIN_ELEVATION`'s
 * rule: a proof given for one administrative write must not be spendable on another.
 *
 * Elevation IS required here, unlike the captcha toggle next door. That route's
 * exemption was argued from incident response — an operator switching a provider off
 * mid-incident should not have to re-prove a factor. A security-restriction policy is
 * not an incident lever: weakening it weakens protection for every platform user, and
 * there is no outage it is the remedy for.
 */
export const SECURITY_POLICY_ELEVATION = 'admin.security-policy.update';

/** One live policy, as the API reports it. */
export interface SecurityPolicyView {
  readonly action: TriggerAction;
  readonly context: PolicyContext;
  readonly enabled: boolean;
  readonly features: readonly string[];
  readonly subFeatures: readonly string[];
  readonly durationSeconds: number;
  /** 0 when no row exists yet — the token a create must send as `expectedVersion`. */
  readonly version: number;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}
