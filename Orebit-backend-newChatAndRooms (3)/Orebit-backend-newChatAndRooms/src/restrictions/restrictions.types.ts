import type { Classification, PolicyContext, TriggerAction } from './restrictions.catalogue';

/**
 * ═══ THE TYPES THE RESTRICTION ENGINE PASSES BETWEEN ITS LAYERS ════════════
 *
 * Four shapes and one direction of flow:
 *
 *   SecurityContext   captured at request entry, before anything is proved
 *          ↓
 *   RiskSignals       what the history says about that context
 *          ↓
 *   RestrictionPlan   what the policy says to do about it — a plain VALUE
 *          ↓
 *   (written inside the sensitive mutation's own transaction)
 *
 * The plan being a plain value is the load-bearing part. By the time a transaction
 * opens, every question has been answered and there is nothing left to look up, so
 * the write adds one INSERT to an existing transaction rather than dragging a
 * classifier, a policy read and a thirty-day history scan inside a `users` row lock
 * that is already held.
 */

/**
 * The facts only the raw request can supply, extracted at the route.
 *
 * ─── Why this is separate from `SecurityContext` ──────────────────────────
 *
 * Building a full `SecurityContext` needs the session row, which is a database read,
 * and `*.routes.ts` files in this repository are declarative and do no I/O. So the
 * route extracts the three things that exist only on the request — and are gone by
 * the time any service runs — and the service turns them into a context.
 *
 * It also replaces the bare `ipClass` that every settings route already passes for
 * the notification email, rather than being threaded alongside it: two parameters
 * carrying the same `ipClass` would be two chances for them to disagree.
 */
export interface RequestFacts {
  /** `ipClassOf(req.ip)` — the /24 or /48. Never the raw address. */
  readonly ipClass: string;
  /** `cloudflareCountry(req.headers)`, already gated on the deployment's proxy trust. */
  readonly country: string | null;
  /** Fastify's `req.id`. */
  readonly requestId: string | null;
}

/**
 * What the request layer captured, before the sensitive action ran.
 *
 * ═══ WHY THIS IS CAPTURED AT ENTRY AND NEVER RECONSTRUCTED ════════════════
 *
 * Because it stops being available. Six of the eight trigger actions revoke sessions
 * as part of succeeding, and `EmailChangeService.commitChange` revokes EVERY session
 * including the caller's own. Anything that tried to read the acting session after
 * the mutation would be reading a row that had just been revoked, or in the email
 * case a session that no longer authorises anything.
 *
 * It is also the only moment the raw request exists at all: `req.ip`, `req.id` and
 * the Cloudflare header are gone by the time a service reaches its persistence layer.
 */
export interface SecurityContext {
  readonly userId: string;
  /** The acting session. Excluded from its own history — see `securityHistory`. */
  readonly sessionId: string;
  /**
   * `sessions.deviceFingerprint` for the acting session — the peppered device key.
   *
   * Read from the SESSION ROW, never from a cookie. `orebit_device` is scoped to
   * `/auth` and never reaches `/settings/*`, so a cookie read here would be null for
   * every settings mutation. This is also why there is no second device identity in
   * this feature: the canonical one is already on the row the guard authenticated.
   *
   * Null only for a session somehow written without one.
   */
  readonly deviceFingerprint: string | null;
  /** The /24 or /48 from `ipClassOf(req.ip)` — the same form `sessions.ipClass` holds. */
  readonly ipClass: string;
  /** Cloudflare's country for this request, or null. Never a declared country. */
  readonly country: string | null;
  /** Fastify's per-request id, for correlating the restriction row with the log. */
  readonly requestId: string | null;
}

/**
 * What the history says. Produced by the evaluator, consumed by nothing else.
 *
 * The three booleans are independent by design — §9 of the specification asks for
 * them separately so the classification rule reads as the rule rather than as an
 * opaque verdict, and so a log line can say WHICH signal was unfamiliar.
 */
export interface RiskSignals {
  readonly isNewIp: boolean;
  readonly isNewDevice: boolean;
  /**
   * True only on positive evidence: a country was established for this request AND
   * the account has not been seen from it. Unknown country is false, never true.
   */
  readonly isNewCountry: boolean;
}

/** The evaluator's whole output: the signals, the verdict, and what was observed. */
export interface RiskAssessment extends RiskSignals {
  readonly classification: Classification;
  /** Which configured policy this classification resolves to. */
  readonly policyContext: PolicyContext;
  readonly observedIpClass: string;
  readonly observedDevice: string | null;
  readonly observedCountry: string | null;
}

/** One row the plan will write. */
export interface RestrictionTarget {
  readonly feature: string;
  /** Null restricts the whole feature. */
  readonly subFeature: string | null;
}

/**
 * The fully-resolved decision, ready to be written with no further I/O.
 *
 * `targets` empty means "nothing to do", and that is an ordinary outcome rather than
 * an error: the policy may be absent, disabled, zero-duration, or name only features
 * the catalogue does not know. Every one of those resolves to no restriction, which
 * is the safe direction.
 */
export interface RestrictionPlan {
  readonly action: TriggerAction;
  readonly assessment: RiskAssessment;
  /** The policy version this decision was made against, or null when none applied. */
  readonly policyVersion: number | null;
  readonly durationSeconds: number;
  readonly targets: readonly RestrictionTarget[];
}

/** A plan that writes nothing. Shared so the "no restriction" path is one value. */
export function emptyPlan(action: TriggerAction, assessment: RiskAssessment): RestrictionPlan {
  return { action, assessment, policyVersion: null, durationSeconds: 0, targets: [] };
}
