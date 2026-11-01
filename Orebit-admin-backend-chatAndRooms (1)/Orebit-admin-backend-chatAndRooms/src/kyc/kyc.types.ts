/**
 * ═══ VOCABULARIES COPIED FROM A SERVICE THIS ONE DOES NOT BUILD AGAINST ════
 *
 * Every tuple here also exists in ../Orebit-backend/src/kyc/kyc.constants.ts. There is
 * no shared package between the two services — no workspace, no monorepo — and every
 * other shared vocabulary in this platform is copied the same way (see
 * `security-policies.types.ts`, which copies the restriction catalogue).
 *
 * The duplication is only safe because of `tests/kyc/kyc.drift.spec.ts`. These values
 * are STORED: an admin writes `L2` into `identity.kyc_policies.level` and the consumer
 * matches on it. If the lists drift, TypeScript says nothing in either repository —
 * the symptom is a policy an operator configured that the enforcer silently discards
 * and nobody finds out.
 */

/**
 * The levels a policy may demand.
 *
 * `NONE` is deliberately absent. It exists in the consumer's `KYC_LEVELS` as a STATE
 * an account can be in, never as a destination a policy can require, and
 * `ck_kyc_policies_level` refuses it at the database.
 */
export const KYC_POLICY_LEVELS = ['L1', 'L2'] as const;
export type KycPolicyLevel = (typeof KYC_POLICY_LEVELS)[number];

/**
 * ═══ THE ONE PLACE `NONE` IS A DESTINATION AND NOT A STATE ══════════════════
 *
 * Every other level list in this service refuses `NONE`, because a policy is about a
 * level to REACH and an obligation is about a level to PROVE. The entitlement matrix is
 * the exception: "what may an unverified account do" is a configuration question with a
 * real answer, and an operator must be able to set it.
 *
 * So this is `KYC_LEVELS` from the consumer's `kyc.constants.ts` — all three — and
 * `ck_kyc_level_entitlements_level` is the only level CHECK in the identity schema that
 * admits `NONE`. `tests/kyc/kyc.drift.spec.ts` compares this tuple against the
 * consumer's, in its declared order, because the values are STORED: an admin writes
 * `NONE` into `identity.kyc_level_entitlements.level` and the consumer looks it up by
 * exactly that string.
 *
 * Declared in RANK order, which is also the order `GET /kyc-entitlements` returns rows
 * in — a config screen renders least-privileged first.
 */
export const KYC_ENTITLEMENT_LEVELS = ['NONE', 'L1', 'L2'] as const;
export type KycEntitlementLevel = (typeof KYC_ENTITLEMENT_LEVELS)[number];

/** The operations a rolling-window threshold can measure. Matches
 *  `ck_kyc_policies_rolling_window_complete`. */
export const ROLLING_WINDOW_OPERATIONS = ['WITHDRAWAL', 'DEPOSIT'] as const;
export type RollingWindowOperation = (typeof ROLLING_WINDOW_OPERATIONS)[number];

/**
 * The region of the policy that applies when no country-specific one does.
 *
 * A real ROW with this region rather than an absence, so the consumer's resolution is
 * two lookups of the same shape — exact country, then this. One character, and the
 * column is `VarChar(2)` rather than `Char(2)` precisely so it is not blank-padded to
 * `'* '`, which no equality test would match.
 */
export const KYC_GLOBAL_REGION = '*';

/**
 * ═══ THE TRIGGER-KEY GRAMMAR, DUPLICATED ═══════════════════════════════════
 *
 * `identity.kyc_requirements.trigger_key` is the deterministic IDENTITY of an
 * obligation: `ux_kyc_requirements_open (user_id, trigger_key) WHERE satisfied_at IS
 * NULL AND waived_at IS NULL` is what stops a re-imposed requirement accumulating a
 * duplicate row, and what makes a repeat write idempotent rather than additive.
 *
 * The consumer builds it in `buildTriggerKey` (../Orebit-backend/src/kyc/kyc.utility.ts)
 * and this service cannot import that function. So the grammar is duplicated, exactly
 * as `KYC_POLICY_LEVELS` and `enforcementRejectionOf` already are, and
 * `tests/kyc/kyc.drift.spec.ts` is what keeps the copy honest.
 *
 * ⚠ THIS IS THE ONE COPY WHERE DRIFT IS SILENT AND EXPENSIVE. A key this service
 *   spells differently from the consumer does not error: it simply occupies a
 *   different slot in the unique index, so the same administrative decision can be
 *   recorded twice and the user is asked to discharge it twice. That is precisely the
 *   failure `KycRequirementService`'s header warns about — "eventually mint a key that
 *   never matches the first".
 */

/**
 * The trigger kinds the consumer recognises, in its declared order.
 *
 * This service only ever writes `ADMIN`. The full list is copied anyway because the
 * drift test compares the tuples, and a kind added over there without a thought for
 * this surface is exactly what the comparison is for.
 */
export const KYC_TRIGGER_KINDS = [
  'BALANCE',
  'LIFETIME_WITHDRAWAL',
  'LIFETIME_DEPOSIT',
  'ROLLING_WINDOW',
  'FEATURE_ATTEMPT',
  'ADMIN',
] as const;
export type KycTriggerKind = (typeof KYC_TRIGGER_KINDS)[number];

/** The kind this service writes. Named rather than inlined so the drift test can
 *  assert it is a member of the tuple above. */
export const ADMIN_TRIGGER_KIND: KycTriggerKind = 'ADMIN';

/**
 * One qualifier segment, after trimming and uppercasing.
 *
 * Byte-for-byte `TRIGGER_SEGMENT` in the consumer's kyc.utility.ts. `:` is excluded by
 * the character class and that is load-bearing — the key is colon-delimited, so a
 * colon inside a segment would make the key ambiguous to anything splitting it, and
 * `triggerKindOf` reconstructs the kind by taking the first segment.
 */
export const KYC_TRIGGER_SEGMENT = /^[A-Z0-9][A-Z0-9._-]{0,62}$/;

/**
 * `ADMIN:<REFERENCE>` — the key for a manually imposed obligation.
 *
 * Mirrors `buildTriggerKey(adminTrigger(reference))` for the one descriptor this
 * service constructs: trim, uppercase, validate, join on `:`.
 *
 * Throws rather than returning null, matching the consumer: every caller is
 * server-side code composing a key from a value the DTO has already validated, so a
 * malformed segment here is a bug in this service and not a user error. The DTO is the
 * layer that turns a bad reference into a 400.
 *
 * ⚠ The reference is MANDATORY on this surface, though the consumer's `adminTrigger`
 *   permits omitting it. An empty qualifier list yields the bare key `ADMIN`, and then
 *   every manual requirement for one account collides on it and the partial unique
 *   index silently drops the second — see the note on `adminTrigger`.
 */
export function adminTriggerKey(reference: string): string {
  const segment = reference.trim().toUpperCase();
  if (!KYC_TRIGGER_SEGMENT.test(segment)) {
    throw new Error(`invalid kyc trigger qualifier: ${reference}`);
  }
  return `${ADMIN_TRIGGER_KIND}:${segment}`;
}

/**
 * The version an operator sends to CREATE a policy that does not exist yet.
 *
 * Surfaced in the list payload rather than left to be inferred. `GET /security-policies`
 * can enumerate its whole cross-product (eight actions × two contexts) and hand back
 * un-created rows at `version: 0`, so its clients discover this by looking. The target
 * space here is every ISO country × two levels, so this list returns only CONFIGURED
 * rows — and the create affordance has to be stated instead.
 */
export const KYC_POLICY_CREATE_VERSION = 0;

// ─── elevation: deferred ────────────────────────────────────────────────────
//
// There are deliberately no elevation constants here yet. The second factor is being
// applied to the KYC surface in a later phase, so these writes are gated by
// `SuperAdminGuard` alone — see `KycPolicyController` and `KycExemptionController`,
// which state what that costs and carry the exact spend to restore.
//
// The action NAMES are recorded here so the eventual implementation does not invent
// new ones, and so a reader can see the intended shape without reconstructing it:
//
//   admin.kyc-policy.update      POST /kyc-policies   action: "upsert"
//   admin.kyc-policy.delete      POST /kyc-policies   action: "delete"
//   admin.kyc-exemption.grant    POST /kyc-exemptions action: "grant"
//   admin.kyc-exemption.revoke   POST /kyc-exemptions action: "revoke"
//
// Four, not one. The rule `ADMIN_ELEVATION` states and `SECURITY_POLICY_ELEVATION`
// follows: a proof given for one administrative write must not be spendable on
// another. Removing a policy re-exposes the global rule for its region, and granting
// relief raises an account's standing platform-wide — different powers, different
// blast radii, different tickets.
//
// They are comments rather than exported constants on purpose: an exported value
// nothing imports is dead code, and a reader cannot tell dead code from a wiring bug.

// ─── what the enforcer would silently drop ──────────────────────────────────

/**
 * The reasons ../Orebit-backend's `narrowPolicy` DISCARDS a stored policy row.
 *
 * ═══ THIS SHOULD ALWAYS BE NULL, AND THAT IS THE POINT ═════════════════════
 *
 * The consumer drops an uninterpretable row, logs a warning over there, and carries on
 * — the under-enforcing direction, chosen so one bad row cannot 500 every KYC path.
 * The cost is that a policy an operator configured could sit in the table, look
 * configured on a screen, and enforce nothing.
 *
 * In practice it cannot, and it is worth being precise about why rather than claiming
 * more than this earns. All four reasons are ALSO blocked by CHECK constraints on the
 * table — `ck_kyc_policies_level`, `_region`, `_threshold_currency` and
 * `_rolling_window_complete` — so a row carrying one cannot be stored at all, by this
 * API or by a hand-written INSERT.
 *
 * So this is a REDUNDANT READBACK, and its value is exactly that redundancy: it is a
 * canary. A non-null result means the database constraints and the consumer's
 * interpretation have diverged — a constraint dropped in a migration, or a rule added
 * over there that the table does not enforce — which is otherwise invisible from this
 * side until a policy quietly stops applying.
 *
 * Cheap to compute, and `tests/kyc/kyc.drift.spec.ts` keeps it in step with the
 * original, so the copy cannot rot unnoticed.
 */
export type KycEnforcementRejection =
  | 'unknown_level'
  | 'unknown_region'
  | 'threshold_without_currency'
  | 'incomplete_rolling_window';

/** The subset of a stored row the mirror needs. Structural, so it accepts a database
 *  row and a test literal alike. */
export interface KycPolicyShape {
  readonly region: string;
  readonly level: string;
  readonly balanceThreshold: string | null;
  readonly lifetimeDepositThreshold: string | null;
  readonly lifetimeWithdrawalThreshold: string | null;
  readonly rollingWindowAmount: string | null;
  readonly rollingWindowSeconds: number | null;
  readonly rollingWindowOperation: string | null;
  readonly thresholdCurrency: string | null;
}

/**
 * Would the consumer act on this row, or discard it?
 *
 * Null means it is genuinely in force. Otherwise the reason, in the consumer's own
 * vocabulary. The order of the checks matches `narrowPolicy` so that a row failing
 * two rules reports the same one both services would name first.
 */
export function enforcementRejectionOf(row: KycPolicyShape): KycEnforcementRejection | null {
  if (!(KYC_POLICY_LEVELS as readonly string[]).includes(row.level)) return 'unknown_level';

  const region = row.region.trim().toUpperCase();
  if (region !== KYC_GLOBAL_REGION && !/^[A-Z]{2}$/.test(region)) return 'unknown_region';

  const hasThreshold =
    row.balanceThreshold !== null ||
    row.lifetimeDepositThreshold !== null ||
    row.lifetimeWithdrawalThreshold !== null ||
    row.rollingWindowAmount !== null;

  if (hasThreshold && row.thresholdCurrency === null) return 'threshold_without_currency';

  const windowConfigured =
    row.rollingWindowAmount !== null ||
    row.rollingWindowSeconds !== null ||
    row.rollingWindowOperation !== null;
  const windowComplete =
    row.rollingWindowAmount !== null &&
    row.rollingWindowSeconds !== null &&
    row.rollingWindowSeconds > 0 &&
    row.rollingWindowOperation !== null &&
    (ROLLING_WINDOW_OPERATIONS as readonly string[]).includes(row.rollingWindowOperation);

  if (windowConfigured && !windowComplete) return 'incomplete_rolling_window';

  return null;
}

// ─── views ──────────────────────────────────────────────────────────────────

/** One policy, as an admin screen reads it. Thresholds are exact decimal STRINGS —
 *  `numeric(38,18)` carries more precision than a float64 mantissa holds. */
export interface KycPolicyView {
  readonly region: string;
  readonly level: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly triggersOnly: boolean;
  readonly workflowId: string | null;
  readonly renewalWorkflowId: string | null;
  readonly balanceThreshold: string | null;
  readonly lifetimeDepositThreshold: string | null;
  readonly lifetimeWithdrawalThreshold: string | null;
  readonly rollingWindowAmount: string | null;
  readonly rollingWindowSeconds: number | null;
  readonly rollingWindowOperation: string | null;
  readonly thresholdCurrency: string | null;
  readonly features: readonly string[];
  readonly subFeatures: readonly string[];
  readonly version: number;
  readonly updatedByAdminId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
  /** Null when the enforcer acts on this row; otherwise why it is being discarded.
   *  See `enforcementRejectionOf`. */
  readonly enforcementRejection: KycEnforcementRejection | null;
}

/** One historical version. Identical to the live view minus the live-only fields, plus
 *  when it was recorded. */
export type KycPolicyVersionView = Omit<KycPolicyView, 'updatedAt' | 'enforcementRejection'> & {
  readonly recordedAt: string;
};

/**
 * One exemption, as an admin screen reads it.
 *
 * `live` is computed by the DATABASE, never in this process. The enforcer's answer
 * comes from the database clock, and a panel deciding "is this in force" from the Node
 * clock could disagree with the service actually gating the user.
 */
export interface KycExemptionView {
  readonly id: string;
  readonly userId: string;
  readonly effectiveLevel: string;
  readonly reason: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly live: boolean;
}

/**
 * One requirement row, as an admin screen reads it.
 *
 * ═══ AN OBLIGATION, NOT A CREDENTIAL ═══════════════════════════════════════
 *
 * Every field is a fact about what an account OWES. Nothing here says an account is
 * verified: that lives in `kyc_level_states` and `kyc_verifications`, which this
 * service never writes.
 *
 * `open` is computed by the DATABASE, never in this process — the same discipline
 * `KycExemptionView.live` states. The consumer's `listOpenRequirements` filters on
 * `satisfied_at IS NULL AND waived_at IS NULL` against the database clock, and a panel
 * deciding openness from the Node clock could disagree with the evaluator that is
 * actually gating the user.
 *
 * ⚠ `open` is NOT the same as "currently required". A row can be open and contribute
 *   nothing, because the consumer additionally filters by whether the account's
 *   EFFECTIVE level already satisfies it — see `evaluate`. That filtering is the
 *   consumer's and is deliberately not reproduced here: this surface reports the
 *   obligation's own state, and `GET /kyc/status` in the other service reports whether
 *   it currently bites.
 */
export interface KycRequirementView {
  readonly id: string;
  readonly userId: string;
  readonly requiredLevel: string;
  readonly triggerKind: string;
  /** The deterministic identity — `ADMIN:CASE-123` for a manual obligation. */
  readonly triggerKey: string;
  readonly satisfiedAt: string | null;
  /** The verification that discharged it, when an approval did. */
  readonly satisfiedByVerificationId: string | null;
  readonly waivedAt: string | null;
  /** The ADMIN who waived it. An opaque uuid — admin identities live in the `admin`
   *  schema and this column carries no foreign key into it. */
  readonly waivedBy: string | null;
  /** Provenance, for a requirement a POLICY raised. Null for every ADMIN row: the
   *  cause was a human decision, and pointing it at a policy version would claim a
   *  rule that did not raise it. */
  readonly policyRegion: string | null;
  readonly policyVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly open: boolean;
}
