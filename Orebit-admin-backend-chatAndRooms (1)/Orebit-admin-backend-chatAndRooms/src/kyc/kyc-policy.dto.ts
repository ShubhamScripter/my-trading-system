import { z } from 'zod';
import {
  KYC_GLOBAL_REGION,
  KYC_POLICY_LEVELS,
  ROLLING_WINDOW_OPERATIONS,
  type KycPolicyView,
  type KycPolicyVersionView,
} from './kyc.types';

/**
 * Wire shapes for KYC policy configuration.
 *
 * ═══ THIS DTO IS THE ENFORCEMENT BOUNDARY, NOT A FORMALITY ═════════════════
 *
 * Two separate contracts have to be satisfied, and neither of them reports a friendly
 * error on its own:
 *
 *   1. The DATABASE. `identity.kyc_policies` carries eight CHECK constraints. A body
 *      that violates one raises SQLSTATE 23514, which `ProblemJsonFilter` reports as
 *      `internal_error` — a 500 for what is really a bad request. Every CHECK is
 *      mirrored below so the operator gets a 400 naming the field.
 *
 *   2. The CONSUMER. ../Orebit-backend's `narrowPolicy` SILENTLY DISCARDS a row it
 *      cannot interpret — logged over there, invisible here. Four rejection reasons,
 *      and the rules below make all four unwritable through this API, so a policy an
 *      operator saved is a policy that is actually in force.
 *
 * A third hazard has no constraint behind it at all and is caught here only — see the
 * lockout guard in `superRefine`.
 */

// ─── leaves ─────────────────────────────────────────────────────────────────

/**
 * `*` or an ISO-3166-1 alpha-2 country, uppercased.
 *
 * Mirrors `normaliseRegion` in the consumer (trim, uppercase, then accept `*` or two
 * letters) and `ck_kyc_policies_region`. The column is `VarChar(2)`, so nothing wider
 * can be stored; `.max(2)` refuses it here rather than at the driver.
 */
const regionSchema = z
  .string()
  .trim()
  .max(2)
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => value === KYC_GLOBAL_REGION || /^[A-Z]{2}$/.test(value),
    'must be "*" or an ISO-3166-1 alpha-2 country code',
  );

const levelSchema = z.enum(KYC_POLICY_LEVELS as unknown as [string, ...string[]]);

/**
 * An exact decimal amount, as a STRING.
 *
 * ═══ NEVER A NUMBER ════════════════════════════════════════════════════════
 *
 * The column is `numeric(38,18)`, which carries far more precision than a float64
 * mantissa holds: `10000.000000000000000001` parsed as a JS number is `10000`, and a
 * threshold comparison at the boundary would silently return the wrong answer. The
 * consumer reaches the same conclusion from the other side — it reads these back as
 * strings and compares them as scaled bigints.
 *
 * The grammar is deliberately narrow:
 *   · at most 20 integer digits — 38 precision minus 18 scale. A 21-digit value is
 *     SQLSTATE 22003 (numeric field overflow), a 500, so this ceiling is the DTO's to
 *     own rather than the database's to crash on.
 *   · at most 18 fractional digits — past that the consumer's own parser throws.
 *   · no sign and no exponent. `ck_kyc_policies_thresholds_positive` refuses <= 0, and
 *     the consumer's read-side parser rejects exponential notation outright — an
 *     exponential string reaching it means somebody used `.toString()` where
 *     `.toFixed()` was required, and silently accepting it would hide that.
 *   · no leading zeros, so what is stored is canonical and a round-trip is lossless.
 */
const DECIMAL = /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/;

const thresholdSchema = z
  .string()
  .trim()
  .regex(DECIMAL, 'must be an exact decimal with at most 20 integer and 18 decimal places')
  // The grammar admits no sign, so any nonzero digit anywhere proves the value is
  // positive. Mirrors `ck_kyc_policies_thresholds_positive`.
  .refine((value) => /[1-9]/.test(value), 'must be greater than zero')
  .nullable();

/** `int4`. Anything larger is SQLSTATE 22003 rather than a validation error, so the
 *  ceiling belongs here. */
const INT4_MAX = 2_147_483_647;
const positiveSeconds = z.number().int().positive().max(INT4_MAX).nullable();

/**
 * The denomination a threshold is expressed in.
 *
 * `ck_kyc_policies_threshold_currency` demands `= upper(btrim(x)) AND x <> ''`.
 * Uppercasing satisfies it; the character class additionally refuses `'US D'`, which
 * `btrim` would have let through.
 */
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9]{1,16}$/.test(value), 'must be 1-16 uppercase letters or digits')
  .nullable();

/** A Didit workflow id. The column is TEXT with no ceiling, so one is imposed here;
 *  `.min(1)` after trimming stops `''` being stored and handed to the provider as an
 *  id, which would fail at Didit rather than here. */
const workflowIdSchema = z.string().trim().min(1).max(128).nullable();

/**
 * A feature or sub-feature id.
 *
 * `/` is banned because storage joins the pair as `feature/subFeature` — the same rule
 * and the same reason as `security-policies.dto.ts`. Shape only: this service has no
 * feature registry and inventing one here would be a second registry to keep in step.
 * The consumer validates names on read and drops the ones it does not know.
 */
const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !value.includes('/'), 'must not contain "/"');

/** Why this change was made. Required on EVERY write — see the note on the schema. */
const reasonSchema = z.string().trim().min(1).max(256);

/** `expectedVersion: 0` means "I expect no row yet"; the stored version starts at 1. */
const expectedVersionSchema = z.number().int().min(0).max(INT4_MAX - 1);

// ─── POST /kyc-policies ─────────────────────────────────────────────────────

const upsertSchema = z
  .object({
    action: z.literal('upsert'),
    region: regionSchema,
    level: levelSchema,
    enabled: z.boolean(),
    required: z.boolean(),
    triggersOnly: z.boolean(),
    workflowId: workflowIdSchema,
    renewalWorkflowId: workflowIdSchema,
    balanceThreshold: thresholdSchema,
    lifetimeDepositThreshold: thresholdSchema,
    lifetimeWithdrawalThreshold: thresholdSchema,
    rollingWindowAmount: thresholdSchema,
    rollingWindowSeconds: positiveSeconds,
    rollingWindowOperation: z
      .enum(ROLLING_WINDOW_OPERATIONS as unknown as [string, ...string[]])
      .nullable(),
    thresholdCurrency: currencySchema,
    features: z.array(idSchema).max(64),
    subFeatures: z.array(z.object({ feature: idSchema, subFeature: idSchema }).strict()).max(256),
    reason: reasonSchema,
    expectedVersion: expectedVersionSchema,
  })
  .strict();

/**
 * Remove a policy entirely.
 *
 * ═══ NOT THE SAME AS DISABLING, AND THAT IS WHY IT EXISTS ══════════════════
 *
 * The consumer resolves exact country, then global `*`, and a DISABLED country row
 * still wins its region — precedence is a property of the key, not of the contents. So
 * `enabled: false` means "this region has a rule and the rule is off"; it does NOT
 * restore the global rule. Deleting the row is the only thing that does, and the
 * consumer names it as the mechanism.
 *
 * The version history is not lost: a tombstone version is appended, so the record of
 * what was in force and when it stopped stays complete.
 *
 * Same compare-and-swap as an update — deleting a row somebody has edited since is
 * refused the same way overwriting it would be.
 */
const deleteSchema = z
  .object({
    action: z.literal('delete'),
    region: regionSchema,
    level: levelSchema,
    reason: reasonSchema,
    expectedVersion: z.number().int().min(1).max(INT4_MAX - 1),
  })
  .strict();

/**
 * The two things an operator can do to a policy.
 *
 * ═══ WHY THE CROSS-FIELD RULES LIVE ON THE UNION, NOT THE MEMBER ═══════════
 *
 * `z.discriminatedUnion` requires every member to be a plain `ZodObject`, because it
 * reads the discriminator off the shape to build its lookup table. `.superRefine()`
 * wraps a schema in `ZodEffects`, which has no shape — so refining `upsertSchema`
 * in place would not compile.
 *
 * The refinement therefore sits here and returns immediately for `delete`, which has
 * no cross-field rules of its own. Parsing order still works in our favour: the
 * discriminator and every field schema run first, so by the time this executes the
 * shape is known-good and the checks below only have to consider combinations.
 */
export const kycPolicyRequestSchema = z
  .discriminatedUnion('action', [upsertSchema, deleteSchema])
  .superRefine((input, ctx) => {
    if (input.action !== 'upsert') return;
    const policy = input;

    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    const thresholds = [
      policy.balanceThreshold,
      policy.lifetimeDepositThreshold,
      policy.lifetimeWithdrawalThreshold,
      policy.rollingWindowAmount,
    ];
    const hasThreshold = thresholds.some((value) => value !== null);

    // ─── ck_kyc_policies_threshold_currency, both directions ────────────────
    if (hasThreshold && policy.thresholdCurrency === null) {
      issue('thresholdCurrency', 'is required when any threshold is set');
    }
    // Stricter than the database, deliberately: a denomination with nothing to
    // denominate is dead configuration that reads as if a limit were in force.
    if (!hasThreshold && policy.thresholdCurrency !== null) {
      issue('thresholdCurrency', 'must be null when no threshold is set');
    }

    // ─── ck_kyc_policies_rolling_window_complete ────────────────────────────
    //
    // All three together or none. The issue is raised on each MISSING field by name
    // rather than once generically, so an operator is told what to supply.
    const windowParts: ReadonlyArray<readonly [string, unknown]> = [
      ['rollingWindowAmount', policy.rollingWindowAmount],
      ['rollingWindowSeconds', policy.rollingWindowSeconds],
      ['rollingWindowOperation', policy.rollingWindowOperation],
    ];
    const present = windowParts.filter(([, value]) => value !== null);
    if (present.length > 0 && present.length < windowParts.length) {
      for (const [path, value] of windowParts) {
        if (value === null) issue(path, 'is required when a rolling window is configured');
      }
    }

    // ─── the renewal refinements are GONE, with the columns they mirrored ────
    //
    // `renewalEnabled`, `renewalPeriodSeconds` and `gracePeriodSeconds` were dropped
    // from `kyc_policies`: renewal periods are GLOBAL and live on
    // `identity.kyc_renewal_settings`, which has its own surface at `/kyc-renewal` and
    // its own ordering rules. Nothing here mirrors them any more.
    //
    // `renewalWorkflowId` survived, and it is deliberately UNGATED now. It used to be
    // refused unless `renewalEnabled` was set; with that flag gone the gate would have
    // made the override permanently unsettable. It is an optional per-(region, level)
    // workflow override, exactly like `workflowId` beside it, and neither is gated.

    // ─── duplicates are rejected, never silently collapsed ──────────────────
    //
    // The precedent's rule: de-duplicating for the operator would mean the thing they
    // saved is not the thing they sent, and they would never learn the list was wrong.
    const seenFeature = new Set<string>();
    for (const feature of policy.features) {
      if (seenFeature.has(feature)) issue('features', `duplicate feature "${feature}"`);
      seenFeature.add(feature);
    }
    const seenPair = new Set<string>();
    for (const pair of policy.subFeatures) {
      const key = `${pair.feature}/${pair.subFeature}`;
      if (seenPair.has(key)) issue('subFeatures', `duplicate sub-feature "${key}"`);
      seenPair.add(key);
    }

    const namesAFeature = policy.features.length > 0 || policy.subFeatures.length > 0;

    // ═══ THE LOCKOUT GUARD ═══════════════════════════════════════════════════
    //
    // No database constraint catches this and the consumer will not either.
    //
    // `mayStart` in the consumer's evaluator REFUSES to open a verification when
    // `triggersOnly` is set and the account has no open requirement. A requirement is
    // only ever raised by a configured trigger — a threshold crossing or an attempt at
    // a named feature. So an enabled `triggersOnly` policy that configures NO trigger
    // means no requirement can ever be raised, which means nobody in that region can
    // ever start verification at that level. Permanently.
    //
    // Nothing in this phase can unstick it: there is no admin route that raises a
    // requirement directly. A self-inflicted regional outage, one checkbox deep, and
    // this is the only place it can be refused.
    // ═══ THE LOCKOUT GUARD THAT USED TO LIVE HERE, AND WHY IT IS GONE ════════
    //
    // This refused `triggersOnly` unless the policy also carried a threshold or named
    // a feature, on the reasoning that otherwise "no verification could ever be
    // started in this region and nothing in this phase can unstick it".
    //
    // That was true when it was written and is not true now. `mayStart` in the
    // consumer's `kyc.evaluator.ts` opens verification on ANY open requirement,
    // whatever the policy triggers on:
    //
    //     if (input.renewalDue === true) return true;
    //     return input.openRequirements.length > 0;
    //
    // and `/kyc-requirements` on this service imposes exactly such a row against a
    // named case reference. The consumer's own
    // `tests/kyc/kyc.enforcement.integration.spec.ts` carries a case called "opens
    // verification in a triggersOnly region, and closes it again on waiver".
    //
    // ⚠ It was also the WRONG WAY ROUND in practice, which is the sharper half. Of the
    //   six trigger kinds, `BALANCE`, `LIFETIME_DEPOSIT`, `LIFETIME_WITHDRAWAL` and
    //   `ROLLING_WINDOW` cannot fire — `KYC_THRESHOLD_DATA_PORT` is bound to `null` —
    //   and `FEATURE_ATTEMPT` cannot fire either, because `PLATFORM_FEATURES` is `{}`
    //   so the consumer drops every feature name on read. `ADMIN` is the only trigger
    //   that works today. So this rule refused the one triggersOnly configuration that
    //   could actually function, while ACCEPTING a policy that named a feature — which
    //   satisfies the check and then resolves to zero targets in the consumer, i.e.
    //   precisely the dead region the rule existed to prevent.
    //
    // So the shape is now accepted: "this region verifies only the people we manually
    // flag" is a legitimate and supported product configuration. The guard below is
    // kept, because its reasoning is unaffected — an enabled policy that demands
    // nothing AND triggers on nothing still silently suppresses the global rule.

    // An enabled policy that demands nothing and triggers on nothing is
    // indistinguishable from having no row at all, except that it takes precedence
    // over the global `*` rule and so silently suppresses it.
    if (
      policy.enabled &&
      !policy.required &&
      !policy.triggersOnly &&
      !hasThreshold &&
      !namesAFeature
    ) {
      issue(
        'enabled',
        'an enabled policy must require verification, configure a trigger, or name a feature',
      );
    }
  });

export type KycPolicyRequest = z.infer<typeof kycPolicyRequestSchema>;
export type KycPolicyUpsertRequest = z.infer<typeof upsertSchema>;
export type KycPolicyDeleteRequest = z.infer<typeof deleteSchema>;

// ─── GET /kyc-policies/history ──────────────────────────────────────────────

/** `z.coerce` because every query value arrives as text. */
export const kycPolicyHistoryQuerySchema = z
  .object({
    region: regionSchema,
    level: levelSchema,
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type KycPolicyHistoryQuery = z.infer<typeof kycPolicyHistoryQuerySchema>;

// ─── payloads ───────────────────────────────────────────────────────────────

export interface KycPoliciesPayload {
  readonly policies: readonly KycPolicyView[];
  readonly levels: readonly string[];
  readonly rollingWindowOperations: readonly string[];
  /** The region that applies when no country-specific policy does. */
  readonly globalRegion: string;
  /**
   * What to send as `expectedVersion` to create a policy that does not exist.
   *
   * Stated rather than inferred: this list returns only CONFIGURED rows, because the
   * target space is every country times two levels, so there is no `version: 0`
   * placeholder for a client to discover the convention from.
   */
  readonly createVersion: number;
}

export interface KycPolicyHistoryPayload {
  readonly region: string;
  readonly level: string;
  readonly versions: readonly KycPolicyVersionView[];
}
