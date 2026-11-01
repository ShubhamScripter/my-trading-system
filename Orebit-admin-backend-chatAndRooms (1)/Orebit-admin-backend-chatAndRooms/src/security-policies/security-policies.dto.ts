import { z } from 'zod';
import {
  DURATION_UNITS,
  DURATION_UNIT_NAMES,
  POLICY_CONTEXTS,
  TRIGGER_ACTIONS,
  type SecurityPolicyView,
} from './security-policies.types';

/**
 * Request schemas for the security-restriction policy surface.
 *
 * Zod, `.strict()`, applied by hand at the controller — the house convention. Every
 * refusal here is a refusal BEFORE anything is written, which is where a refusal is
 * cheapest and where the operator gets the most useful message.
 */

/** An opaque feature or sub-feature id. */
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // `/` is the delimiter that qualifies a sub-feature by its parent in storage. An id
  // containing one would make the stored value ambiguous on the way back out, so it is
  // refused at the boundary rather than guessed at on read.
  .refine((v) => !v.includes('/'), 'must not contain "/"');

/**
 * A duration as an operator expresses it.
 *
 * ═══ NORMALISED TO SECONDS HERE, AND STORED ONLY AS SECONDS ════════════════
 *
 * Every stored duration in both repositories is an integer count of seconds —
 * `OTP.TTL_SECONDS`, `LOCKOUT.DURATION_SECONDS`, the wire's `retryAfterSeconds`.
 * Nothing anywhere stores a value beside a unit, and a second column would be a second
 * thing that can disagree with the first.
 *
 * The cost is accepted and worth naming: the round-trip is lossy. An operator who
 * enters "90 minutes" is shown the canonical rendering of 5400 seconds.
 *
 * The ceiling is deliberately NOT invented here. The product has not set a maximum,
 * and a number chosen in this file would be a policy decision buried in a validator.
 * The floor IS enforced — and again by the database, via
 * `ck_security_restriction_policies_duration_positive`, because a non-positive
 * duration produces an already-expired restriction, which fails OPEN and silently.
 */
const durationSchema = z
  .object({
    value: z.number().int().positive(),
    unit: z.enum(DURATION_UNIT_NAMES as unknown as [string, ...string[]]),
  })
  .strict()
  .transform((d) => d.value * DURATION_UNITS[d.unit as keyof typeof DURATION_UNITS]);

export const securityPolicyUpsertSchema = z
  .object({
    action: z.enum(TRIGGER_ACTIONS as unknown as [string, ...string[]]),
    context: z.enum(POLICY_CONTEXTS as unknown as [string, ...string[]]),
    enabled: z.boolean(),
    features: z.array(idSchema).max(64).default([]),
    /**
     * Sub-features, each qualified by its parent as `{ feature, subFeature }`.
     *
     * A PAIR rather than a bare id, because a bare one identifies nothing: two features
     * may legitimately declare a sub-feature with the same name, so `alpha` alone
     * cannot be validated and cannot be matched. The storage layer joins them with `/`.
     */
    subFeatures: z
      .array(z.object({ feature: idSchema, subFeature: idSchema }).strict())
      .max(256)
      .default([]),
    duration: durationSchema,
    reason: z.string().trim().min(1).max(256).optional(),
    /**
     * The version the caller read.
     *
     * ZERO means "I expect no row to exist" — a create. That works because a stored
     * version starts at 1 and only increments, so 0 is never a stored value and cannot
     * be confused with one. Create and update are therefore the same call with the same
     * token, and there is no separate create path that could skip the swap.
     */
    expectedVersion: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A reason is required whenever protection is being WEAKENED — turning a policy
    // off, or shortening it. The same rule `captchaToggleRequestSchema` applies to a
    // provider toggle, and for the same reason: the row is what somebody reads at 3am.
    if (!value.enabled && value.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason is required when disabling a policy',
      });
    }

    // Targets must not repeat. Rejected rather than silently de-duplicated so an
    // operator who selected the same box twice learns their UI is wrong.
    const features = new Set<string>();
    for (const f of value.features) {
      if (features.has(f)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['features'],
          message: `duplicate feature "${f}"`,
        });
      }
      features.add(f);
    }

    const subs = new Set<string>();
    for (const s of value.subFeatures) {
      const key = `${s.feature}/${s.subFeature}`;
      if (subs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subFeatures'],
          message: `duplicate sub-feature "${key}"`,
        });
      }
      subs.add(key);
    }

    // An enabled policy that restricts nothing is almost certainly a mistake — and it
    // would store a row that can never do anything. Refused so the operator sees it now
    // rather than wondering later why nothing happens.
    if (value.enabled && value.features.length === 0 && value.subFeatures.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['features'],
        message: 'an enabled policy must restrict at least one feature or sub-feature',
      });
    }
  });

export type SecurityPolicyUpsertRequest = z.infer<typeof securityPolicyUpsertSchema>;

/**
 * The whole table, plus what a form needs to render it.
 *
 * Every policy in one response, the way `CaptchaProvidersPayload` returns every
 * provider: the interesting question after a write is "what is configured NOW", and
 * answering it here means a screen does not have to follow a write with a read, nor
 * risk rendering a stale list beside a fresh success message.
 */
export interface SecurityPoliciesPayload {
  readonly policies: readonly SecurityPolicyView[];
  /** Every action an operator may configure, including the inert phone entries. */
  readonly actions: readonly string[];
  readonly contexts: readonly string[];
  readonly durationUnits: readonly string[];
  /**
   * How long a write may take to reach every user-backend instance, in seconds.
   *
   * Surfaced for `CaptchaProvidersPayload`'s reason: a policy that has not yet
   * propagated should read as expected rather than as a bug.
   */
  readonly propagationSeconds: number;
}
