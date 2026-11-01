import { z } from 'zod';
import {
  KYC_POLICY_LEVELS,
  KYC_TRIGGER_SEGMENT,
  type KycRequirementView,
} from './kyc.types';

/**
 * Wire shapes for manually imposed KYC obligations.
 *
 * ═══ WHICH DIRECTION THIS WRITE POINTS ═════════════════════════════════════
 *
 * The opposite of an exemption, and that is what makes it the safer of the two admin
 * writes on per-account KYC state. A grant RAISES an account's effective level with no
 * provider attesting anything; this only ever WITHHOLDS standing — it records that an
 * account owes a verification. It cannot manufacture a credential, and nothing it
 * writes is ever read as one.
 *
 * It is still not harmless: an obligation is permanent until an approved verification
 * or an explicit waiver discharges it, and nothing in either service reopens it when
 * the reason evaporates. So a mandatory reason on both verbs, a mandatory reference on
 * `require`, and no edit route — changing a requirement is a waiver plus a new one,
 * which leaves both facts on the record.
 */

const reasonSchema = z.string().trim().min(1).max(256);

const levelSchema = z.enum(KYC_POLICY_LEVELS as unknown as [string, ...string[]]);

/**
 * The human reference that becomes the key's qualifier.
 *
 * ═══ MANDATORY, AND THE REASON IS THE UNIQUE INDEX ═════════════════════════
 *
 * `trigger_key` is the obligation's identity, and
 * `ux_kyc_requirements_open (user_id, trigger_key) WHERE open` is what makes a repeat
 * write idempotent. The consumer's `adminTrigger(reference?)` permits omitting it,
 * yielding the bare key `ADMIN` — and then a SECOND manual requirement for one account
 * collides with the first and the index silently drops it. The consumer says so
 * outright: "without it, a second manual requirement for the same account collides
 * with the first and the index silently drops it."
 *
 * So it is required here. Two distinct compliance cases against one account must be
 * two rows, each discharged on its own, and a ticket id is what distinguishes them.
 *
 * ─── Validated against the SEGMENT grammar, not a loose string ─────────────
 *
 * `KYC_TRIGGER_SEGMENT` is byte-for-byte the consumer's, applied AFTER trim and
 * uppercase so the DTO refuses exactly what `adminTriggerKey` would throw on. A colon
 * is excluded by the character class, because the key is colon-delimited and a segment
 * containing one would make it ambiguous to anything that splits it.
 *
 * The transform is what is stored: `case-123` and `CASE-123` are the same obligation,
 * and normalising at the edge means they cannot become two rows.
 */
const referenceSchema = z
  .string()
  .trim()
  .min(1, 'is required — an empty reference would collide with every other manual requirement')
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => KYC_TRIGGER_SEGMENT.test(value),
    'must start alphanumeric and contain only letters, digits, dot, underscore or hyphen (max 63)',
  );

/**
 * Impose a verification obligation on one account.
 *
 * ⚠ DELIBERATELY DOES NOT CHECK WHETHER THE ACCOUNT ALREADY HOLDS THE LEVEL.
 *
 * Answering that needs `effectiveLevel` — credentials folded with a live exemption,
 * each level's own renewal clock, the ladder and the supersession flag — which is the
 * consumer's validity algorithm. Reproducing it here would be a second authority for
 * "what does this account hold", and the two would eventually disagree.
 *
 * So the row is written unconditionally and the consumer decides whether it bites:
 * `evaluate` filters open requirements by `!satisfiesLevel(heldLevel, requiredLevel)`,
 * so a requirement against a currently-sufficient credential stays open and
 * contributes nothing — and becomes effective on its own the moment that credential
 * lapses. Self-correcting, with the rule in exactly one place.
 */
const requireSchema = z
  .object({
    action: z.literal('require'),
    userId: z.string().uuid(),
    requiredLevel: levelSchema,
    reference: referenceSchema,
    reason: reasonSchema,
  })
  .strict();

/**
 * Discharge an obligation by administrative decision.
 *
 * The only exit other than an approved verification, and the consumer states that as
 * `KycRequirement`'s whole contract.
 *
 * ─── `reason` is audited, not stored ───────────────────────────────────────
 *
 * `kyc_requirements` has `waived_at` and `waived_by` and no reason column, unlike
 * `kyc_exemptions.revoke_reason`. Rather than migrate the table, the reason is carried
 * on the `ADMIN_KYC_REQUIREMENT_WAIVED` audit event — independent infrastructure with
 * its own retention, which is where `kyc_renewal_settings` already sends the same
 * question. ⚠ The consequence, stated rather than discovered later: `identity` cannot
 * answer "why was this waived"; the admin audit log is the only place that can.
 */
const waiveSchema = z
  .object({
    action: z.literal('waive'),
    userId: z.string().uuid(),
    requirementId: z.string().uuid(),
    reason: reasonSchema,
  })
  .strict();

/**
 * The two things an operator can do to an obligation.
 *
 * A discriminated union rather than two routes, matching `kyc-policies` and
 * `kyc-exemptions` — and the reason both of those give for spending elevation in the
 * controller rather than a guard applies here too, when elevation arrives: a guard
 * cannot read the action out of a union body.
 */
export const kycRequirementRequestSchema = z.discriminatedUnion('action', [
  requireSchema,
  waiveSchema,
]);

export type KycRequirementRequest = z.infer<typeof kycRequirementRequestSchema>;
export type KycRequirementRequireRequest = z.infer<typeof requireSchema>;
export type KycRequirementWaiveRequest = z.infer<typeof waiveSchema>;

/**
 * The list filter.
 *
 * `userId` is REQUIRED here, unlike `kyc-exemptions` where it is optional. The
 * difference is boundedness: `ux_kyc_exemptions_live` permits one live exemption per
 * account, so "everyone currently exempt" is a small, meaningful answer. Requirements
 * have no such ceiling — an account can owe several at once and every closed row is
 * kept forever — so an unfiltered listing would be an unbounded scan whose page
 * boundary means nothing. Naming an account is the only question this surface answers.
 */
export const kycRequirementQuerySchema = z
  .object({
    userId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type KycRequirementQuery = z.infer<typeof kycRequirementQuerySchema>;

/**
 * One account's obligations, open and closed.
 *
 * `levels` rides along for the same reason it does on the other two payloads: a form
 * needs the vocabulary, and deriving it client-side would be a third copy.
 */
export interface KycRequirementsPayload {
  readonly requirements: readonly KycRequirementView[];
  readonly levels: readonly string[];
}
