import { z } from 'zod';

/**
 * ═══ THE WIRE SHAPE FOR X AND Y ════════════════════════════════════════════
 *
 * Two numbers. That is the entire renewal configuration, on the way in and on the way
 * out, and most of this file is refusals rather than parsing — getting either wrong is
 * a platform-wide event.
 *
 * ─── Days on the wire, seconds in the column ──────────────────────────────
 *
 * The consumer's schema stores every duration as whole seconds and nothing anywhere
 * stores a value beside a unit. But an operator configuring a KYC renewal period thinks
 * in days, and `31536000` in a form field is an invitation to a typo nobody would spot.
 * So the API takes DAYS and normalises at this boundary — the same split
 * `kyc-policy.dto.ts` makes between what a human writes and what the column holds.
 *
 * ─── What is deliberately absent ──────────────────────────────────────────
 *
 * No `version`, no `expectedVersion`, no `reason`, no `renewalEnabled`, and no history
 * of previous configurations. All of those shipped with the first cut and were removed:
 * the product requirement is a single current setting.
 *
 * `renewalEnabled` in particular is NOT coming back as a field. It is
 * `mandatoryPeriodDays !== null` and nothing else, so returning it would be a second
 * copy of a fact the payload already carries — and two copies of one fact eventually
 * disagree. A client that needs the boolean computes it; it cannot get it wrong.
 */

/** `int4` on the column, and a period long enough to overflow it is a typo anyway. */
const MAX_DAYS = 36_500;

/**
 * A renewal period in whole days, or `null` to disable that half.
 *
 * Null is a real configuration and the shipped one. It is NOT "leave unchanged": this is
 * a full-state write, so a field sent as null turns that half of renewal OFF. Both
 * fields are required for exactly that reason; there is no partial update, and no way
 * to change X while being vague about Y.
 */
const periodDays = z.number().int().positive().max(MAX_DAYS).nullable();

export const kycRenewalRequestSchema = z
  .object({
    /**
     * X — after this many days a verification lapses and re-verification is REQUIRED.
     * Null means verifications never expire.
     */
    mandatoryPeriodDays: periodDays,
    /**
     * Y — after this many days the holder MAY voluntarily redo a level that is still
     * valid. Null keeps voluntary redo closed.
     */
    voluntaryPeriodDays: periodDays,
  })
  .strict()
  .superRefine((input, ctx) => {
    // ─── ck_kyc_renewal_settings_ordering ─────────────────────────────────
    //
    // Y must open strictly BEFORE X falls due. Y >= X is dead configuration that reads
    // as though it worked: the voluntary window would never open on a credential that
    // was still valid, because the credential would already be mandatory by then.
    if (
      input.mandatoryPeriodDays !== null &&
      input.voluntaryPeriodDays !== null &&
      input.voluntaryPeriodDays >= input.mandatoryPeriodDays
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['voluntaryPeriodDays'],
        message:
          'must be strictly less than mandatoryPeriodDays — a voluntary window that ' +
          'opens at or after the mandatory deadline never opens at all',
      });
    }

    // Stricter than the database, deliberately, and for `kyc-policy.dto.ts`'s reason: a
    // voluntary window with no deadline to precede is configuration that does nothing
    // and will read as if it did the day somebody sets X.
    if (input.mandatoryPeriodDays === null && input.voluntaryPeriodDays !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['voluntaryPeriodDays'],
        message: 'must be null when mandatoryPeriodDays is null — there is nothing to renew before',
      });
    }
  });

export type KycRenewalRequest = z.infer<typeof kycRenewalRequestSchema>;

// ─── payload ────────────────────────────────────────────────────────────────

/**
 * The renewal configuration, and the whole of it.
 *
 * The same shape `GET` returns and `POST` accepts, so a screen reads, edits and writes
 * back one object with no field to add or strip in between.
 *
 * Days, not seconds. The column holds seconds and this converts, which means a period
 * written into the table by hand during an incident might not divide evenly into days —
 * see `toDays` in the service for what happens then, because rounding it would hand an
 * operator a number they could re-submit and silently change the configuration by doing
 * so.
 */
export interface KycRenewalPayload {
  /** X. Null means verifications never expire — and null/null is renewal disabled. */
  readonly mandatoryPeriodDays: number | null;
  /** Y. Null means voluntary same-level redo is closed. */
  readonly voluntaryPeriodDays: number | null;
}
