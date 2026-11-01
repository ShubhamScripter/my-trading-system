import { z } from 'zod';
import {
  ANTI_PHISHING,
  ANTI_PHISHING_PATTERN,
  type AntiPhishingAction,
  type AntiPhishingStatus,
} from './antiPhishing.types';

/**
 * Wire shapes for `GET`/`POST /settings/security/anti-phishing`.
 *
 * The shared vocabulary — a code as typed — mirrors `password/password.dto.ts` and
 * `paymentPin/payment-pin.dto.ts`. Repeated rather than imported for those files'
 * stated reason: those are their modules' private schemas, and exporting them to be
 * shared would make a change to one route's validation a change to another's.
 */

/**
 * The emailed code, as typed.
 *
 * Loose on purpose — `min(1).max(64)` rather than a digit count — so a format rule at
 * the door does not tell a caller which guesses were well-formed before any comparison
 * ran. Same argument as `codeSchema` in 2fa.dto.ts, and the reason this is not
 * `otpCodeSchema` from common.dto.ts.
 */
const emailCodeSchema = z.string().min(1).max(64);

/**
 * ═══ THE ANTI-PHISHING CODE, AND WHY THIS RULE IS STRICT ════════════════════
 *
 * The opposite decision from `emailCodeSchema` above, and the difference is who owns
 * the value. An emailed code is minted by this service and compared against a stored
 * hash, so a format rule at the door only leaks which guesses were shaped right. A code
 * arriving here is being CHOSEN, and telling the user the shape it must have is the
 * entire purpose of the field.
 *
 * ─── No `.trim()`, deliberately ─────────────────────────────────────────────
 *
 * `" ABC123 "` is REJECTED, not silently trimmed. Trimming would accept a value whose
 * displayed form differs from what the user typed, and this is a value whose whole job
 * is to be compared by eye — so the one thing the input rule must not do is quietly
 * change it. The pattern excludes whitespace entirely, so this falls out of
 * `ANTI_PHISHING_PATTERN` rather than needing its own refinement; the note is here
 * because "why not trim" is the obvious question.
 *
 * ─── Why `regex` before `min`/`max` in the message a user sees ──────────────
 *
 * Zod reports every failing check, so a caller sending `"ab cd"` learns both that it is
 * too short and that it has an illegal character. That is right for a chosen value:
 * fixing one and resubmitting to discover the other is two round trips for one mistake.
 *
 * See `ANTI_PHISHING_PATTERN` in antiPhishing.types.ts for why the alphabet is this
 * narrow — homoglyphs, bidi overrides and collapsible whitespace all defeat a
 * compared-by-eye value.
 */
const codeSchema = z
  .string()
  .min(ANTI_PHISHING.MIN_LENGTH, {
    message: `Must be at least ${ANTI_PHISHING.MIN_LENGTH} characters.`,
  })
  .max(ANTI_PHISHING.MAX_LENGTH, {
    message: `Must be at most ${ANTI_PHISHING.MAX_LENGTH} characters.`,
  })
  .regex(ANTI_PHISHING_PATTERN, {
    message: 'Must contain only letters and numbers, with no spaces or symbols.',
  });

/**
 * The code being PRESENTED rather than chosen, on `change`.
 *
 * Bounded but deliberately not pattern-checked, following `presentedPasswordSchema` in
 * password.dto.ts. Applying the format rule to `currentCode` would reject a wrong value
 * with complaints about its composition — and here that is worse than merely unhelpful:
 * a code stored before any future widening of the alphabet would be un-presentable by
 * its own owner, who would be told their real code is invalid.
 *
 * The upper bound is what stops a caller posting a megabyte to be compared.
 */
const presentedCodeSchema = z.string().min(1).max(200);

// ─── POST /settings/security/anti-phishing ──────────────────────────────────

/**
 * ═══ THREE OPERATIONS, ONE ROUTE, ONE DISCRIMINANT ══════════════════════════
 *
 * The convention every multi-step flow in this service uses. See
 * `antiPhishing.types.ts` for what distinguishes the three — and in particular for why
 * `change`'s extra field is mistake-prevention rather than a control.
 *
 * ─── `.strict()` on every member, which is a security control here ──────────
 *
 * Zod strips unknown keys by default, so without `.strict()` a `set` body carrying
 * `currentCode` would have it silently dropped and succeed as the operation that checks
 * nothing — and, worse, a body carrying `configured: false` would look to the caller as
 * though the server had accepted their assertion about the account. `.strict()` makes
 * both a `validation_failed` naming the offending key.
 *
 * That is the wire half of "the frontend cannot claim a code is not set". The other half
 * is that no such field appears in any member below and no code reads one: the service
 * asks `UserDbOperation.findAntiPhishing` and nothing else.
 *
 * ─── What is deliberately NOT an action here ────────────────────────────────
 *
 * No `request-code`. `POST /auth/2fa {"action":"credential-otp"}` already mints the
 * emailed code, and an anti-phishing-shaped copy would be a second way to mint the same
 * credential, metered by a second bucket. The precedent and the argument are in
 * `paymentPin/payment-pin.routes.ts`.
 *
 * No `remove`. Nothing in the requirement asks for one, and there is a reason not to
 * invent it: an account that has had a code and then has none teaches its owner that a
 * missing footer is normal, which is precisely the signal the feature exists to make
 * abnormal. If it is ever wanted it needs a product decision, not a fourth union member.
 */

/**
 * `set` — no code exists. The emailed code is the whole authorisation.
 *
 * No `currentCode` field, because there is no current code. An account that DOES have
 * one is refused by the service with `anti_phishing_code_already_set`, and by the write
 * itself if that answer went stale.
 */
const setSchema = z
  .object({
    action: z.literal('set'),
    code: codeSchema,
    emailCode: emailCodeSchema,
  })
  .strict();

/**
 * `change` — a code exists and the caller says they know it.
 *
 * `currentCode` is required by this schema and is NOT a security boundary: `replace`
 * below reaches the same write without it. It is here so a user who misremembers their
 * code is told, rather than overwriting a value they will then fail to recognise. See
 * the policy table in antiPhishing.types.ts.
 */
const changeSchema = z
  .object({
    action: z.literal('change'),
    currentCode: presentedCodeSchema,
    code: codeSchema,
    emailCode: emailCodeSchema,
  })
  .strict();

/**
 * `replace` — a code exists and the caller cannot produce it.
 *
 * Identical to `set` but for the discriminant, and that is not redundancy: the two are
 * authorised by opposite states of the account, and the service refuses each on the
 * other's. Collapsing them into one action would mean a single request that both
 * creates and overwrites, which is the direction-blind write
 * `UserDbOperation.upsertPassword` documents as the thing to avoid.
 */
const replaceSchema = z
  .object({
    action: z.literal('replace'),
    code: codeSchema,
    emailCode: emailCodeSchema,
  })
  .strict();

/**
 * The union.
 *
 * ─── Why there is no `confirmCode` ──────────────────────────────────────────
 *
 * `passwordRequestSchema` compares `password` against `confirmPassword` because a
 * mistyped password locks its owner out of the account with no way to discover the
 * typo. A mistyped anti-phishing code is self-correcting: it arrives in the user's next
 * email, where they see it, and `change` fixes it. A confirmation field would add a
 * round trip's worth of friction to guard against a mistake the feature reveals by
 * itself.
 *
 * A plain `discriminatedUnion` rather than one wrapped in `superRefine`, which is what
 * dropping `confirmCode` buys: this stays a `ZodDiscriminatedUnion` rather than
 * degrading to `ZodEffects`, so unlike `passwordRequestSchema` it remains extensible
 * with `.and()` if a later member needs it.
 */
export const antiPhishingRequestSchema = z.discriminatedUnion('action', [
  setSchema,
  changeSchema,
  replaceSchema,
]);

export type AntiPhishingRequest = z.infer<typeof antiPhishingRequestSchema>;
export type AntiPhishingSetRequest = Extract<AntiPhishingRequest, { action: 'set' }>;
export type AntiPhishingChangeRequest = Extract<AntiPhishingRequest, { action: 'change' }>;
export type AntiPhishingReplaceRequest = Extract<AntiPhishingRequest, { action: 'replace' }>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface AntiPhishingStatusPayload extends AntiPhishingStatus {
  readonly outcome: 'anti_phishing_code_status';
}

/**
 * The code was written.
 *
 * ─── What this carries, and what it must never carry ───────────────────────
 *
 * No code, here or anywhere else in the API. The user will see it in their next email,
 * which is the channel the feature is about; echoing it into an HTTP response would put
 * it in a browser cache and a proxy log for no benefit.
 *
 * `action` is echoed from the SERVER's dispatch rather than from the request, so an
 * integration bug shows up as a mismatch rather than as a confident wrong label — the
 * property `PasswordChangedPayload.operation` relies on.
 *
 * `otherSessionsRevoked` is always false, and stated explicitly rather than left for a
 * client to assume; `BiometricsDisabledPayload` sets that precedent and
 * `PaymentPinEnabledPayload` states the same `false`. It is false because no session was
 * ever established with an anti-phishing code, so there is nothing for a sweep to
 * invalidate. See `AntiPhishingService.finish`.
 */
export interface AntiPhishingUpdatedPayload {
  readonly outcome: 'anti_phishing_code_updated';
  readonly action: AntiPhishingAction;
  readonly otherSessionsRevoked: boolean;
}

export type AntiPhishingPayload = AntiPhishingStatusPayload | AntiPhishingUpdatedPayload;
