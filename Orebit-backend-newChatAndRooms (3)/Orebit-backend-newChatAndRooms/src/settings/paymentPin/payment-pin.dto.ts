import { z } from 'zod';
import { PIN_LENGTH, type PaymentPinStatus, type PaymentPinVerificationMethod } from './payment-pin.types';
import { resolvePaymentPinProof } from './payment-pin.utility';

/**
 * Wire shapes for the Payment PIN.
 *
 * The shared vocabulary — a code as typed, a WebAuthn response — mirrors
 * `src/settings/settings.dto.ts` field for field, and the reasoning for each is there.
 * Repeated rather than imported for that file's stated reason: those are that module's
 * private schemas, and exporting them to be shared would make a change to one route's
 * validation a change to another's.
 */

/**
 * A code as typed: TOTP or emailed. Loose on purpose — `min(1).max(64)` rather than a
 * digit count, so a format rule at the door does not tell a caller which guesses were
 * well-formed before any comparison ran. Same argument as `codeSchema` in 2fa.dto.ts.
 */
const codeSchema = z.string().min(1).max(64);

/**
 * The PIN, and the ONE place a format rule is deliberately strict.
 *
 * The opposite decision from `codeSchema` above, and the difference is who owns the
 * value. A TOTP code and an emailed code are minted by something else and compared
 * against a stored secret, so a format rule at the door only leaks which guesses were
 * shaped right. A PIN arriving here is being CHOSEN, not guessed — this is the shape
 * the product requires and telling the user so is the whole point of the field. On the
 * `currentPin` path it is a guess, but of a value whose format the guesser already
 * knows from having set one, so the rule leaks nothing there either.
 *
 * Strength is not here. `^\d{6}$` is a shape and `assessPin` is a policy, and the two
 * produce different errors — `validation_failed` versus `payment_pin_weak` — because a
 * screen has to say "six digits" for one and "choose something less predictable" for
 * the other.
 */
const pinSchema = z.string().regex(new RegExp(`^\\d{${PIN_LENGTH}}$`), {
  message: `Must be exactly ${PIN_LENGTH} digits.`,
});

/** The WebAuthn response, passed through to `@simplewebauthn/server`, which owns this
 *  shape and verifies every field cryptographically. */
const webauthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

/**
 * The opaque handle a verification returns.
 *
 * Bounded but not parsed: it is 32 random bytes base64url today, and a rule tighter
 * than "a plausible token" would have to change with the mechanism. `max(128)` is what
 * stops a caller posting a megabyte to be hashed into a cache key.
 */
const challengeIdSchema = z.string().min(1).max(128);

/** Which operation a verification is FOR. Bound into the challenge and compared
 *  against the action that spends it — see `PaymentPinGrant`. */
const operationSchema = z.enum(['update', 'disable']);

// ─── POST /settings/security/payment-pin/verify ─────────────────────────────

/**
 * One verification, naming exactly one method.
 *
 * ─── Why `.strict()` on every member, which is the security control here ────
 *
 * A discriminated union alone would still accept `{method:'pin', currentPin, totpCode}`
 * — Zod strips unknown keys by default, so the extra proof would vanish silently and
 * the request would succeed as the PIN path. `.strict()` makes it a validation error
 * instead, which is the requirement that conflicting proofs are REFUSED rather than
 * resolved. It runs before any comparison, so a caller sending everything learns
 * nothing about which of their proofs would have verified.
 *
 * The `superRefine` below is not redundant with it: `.strict()` catches a field this
 * member does not declare, and the resolver catches the rest of the rule — a missing
 * proof, a missing `emailCode`, an unknown method — with messages the service will
 * produce identically when it re-runs the same function.
 *
 * ─── Why `operation` is in the body ────────────────────────────────────────
 *
 * Because the server cannot bind an operation it was never told, and binding it is the
 * whole point: a challenge verified for `update` must not remove the PIN. The action
 * request that spends the challenge carries no method and no operation — it names the
 * action, and the server compares. So this field is where the client's intent enters,
 * once, and every later check is against the server's own record of it.
 */
const verifyPinSchema = z
  .object({
    operation: operationSchema,
    method: z.literal('pin'),
    currentPin: pinSchema,
    emailCode: codeSchema,
  })
  .strict();

const verifyAuthenticatorSchema = z
  .object({
    operation: operationSchema,
    method: z.literal('authenticator'),
    totpCode: codeSchema,
    emailCode: codeSchema,
  })
  .strict();

const verifyPasskeySchema = z
  .object({
    operation: operationSchema,
    method: z.literal('passkey'),
    passkey: webauthnResponseSchema,
    emailCode: codeSchema,
  })
  .strict();

export const paymentPinVerifySchema = z
  .discriminatedUnion('method', [verifyPinSchema, verifyAuthenticatorSchema, verifyPasskeySchema])
  .superRefine((value, ctx) => {
    const resolved = resolvePaymentPinProof(value);
    if (resolved.ok) return;

    for (const problem of resolved.problems) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // `''` from the resolver means "the request as a whole", which is what an
        // empty path array means to Zod as well.
        path: problem.path === '' ? [] : [problem.path],
        message: problem.message,
      });
    }
  });

export type PaymentPinVerifyRequest = z.infer<typeof paymentPinVerifySchema>;

// ─── POST /settings/security/payment-pin ────────────────────────────────────

/**
 * Turn the PIN on. One request, no challenge.
 *
 * ─── Why this one takes proofs directly and the other two do not ───────────
 *
 * Enabling is authorised by an emailed code plus the EXISTENCE of a factor. There is
 * nothing for the user to prove interactively — the backend reads the factor state —
 * so there is no verification step for a challenge to record, and inventing one would
 * mean a challenge that could be minted without proving anything.
 *
 * That it is weaker than update and disable is deliberate and bounded: enabling
 * creates a PIN where there was none, so there is no existing secret for it to
 * overwrite and nothing to lose that the emailed code does not already guard. Update
 * and disable both act on a PIN that already exists, which is why both cost a proof.
 */
const enableSchema = z
  .object({
    action: z.literal('enable'),
    pin: pinSchema,
    emailCode: codeSchema,
  })
  .strict();

/**
 * Change the PIN. Everything but the new value comes from the challenge.
 *
 * No `userId`, no `operation`, no `method`, and no `currentPin` — the server already
 * knows all four from the verification this challenge records, and re-accepting any of
 * them from the client would be handing back a decision that has already been made
 * safely. `currentPin` in particular: it was proved at `verify` time, and asking for it
 * again would mean a second place the PIN travels for no additional assurance.
 */
const updateSchema = z
  .object({
    action: z.literal('update'),
    challengeId: challengeIdSchema,
    newPin: pinSchema,
  })
  .strict();

/** Remove the PIN. The challenge is the entire request. */
const disableSchema = z
  .object({
    action: z.literal('disable'),
    challengeId: challengeIdSchema,
  })
  .strict();

export const paymentPinRequestSchema = z.discriminatedUnion('action', [
  enableSchema,
  updateSchema,
  disableSchema,
]);

export type PaymentPinRequest = z.infer<typeof paymentPinRequestSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface PaymentPinStatusPayload extends PaymentPinStatus {
  readonly outcome: 'payment_pin_status';
}

/**
 * A verification succeeded; here is what it authorises.
 *
 * `operation` and `method` are echoed from the SERVER's record rather than from the
 * request, so a client can render "verified with your authenticator" without having to
 * remember what it sent, and an integration bug shows up as a mismatch rather than as
 * a confident wrong label.
 *
 * `expiresInSeconds` so a client can show a countdown and re-verify before the user
 * finishes typing rather than after — the same courtesy `ElevationService.issue`
 * extends.
 */
export interface PaymentPinVerifiedPayload {
  readonly outcome: 'payment_pin_verified';
  /** Opaque. Send it back as `challengeId` on the matching action, once. */
  readonly challengeId: string;
  readonly operation: 'update' | 'disable';
  readonly method: PaymentPinVerificationMethod;
  readonly expiresInSeconds: number;
}

/**
 * The PIN is on.
 *
 * Carries no PIN and no hash, here or anywhere else — the value the caller sent is the
 * only copy that ever existed outside argon2, and nothing in this service can show it
 * again.
 */
export interface PaymentPinEnabledPayload {
  readonly outcome: 'payment_pin_enabled';
  /** Always false. Explicit for `BiometricsDisabledPayload.otherSessionsRevoked`'s
   *  reason — a client should be able to say so rather than assume — and false because
   *  a Payment PIN never established a session. See `PaymentPinService.disable`. */
  readonly otherSessionsRevoked: boolean;
}

export interface PaymentPinUpdatedPayload {
  readonly outcome: 'payment_pin_updated';
  /** Which credential authorised this, from the challenge. Echoed so an audit trail
   *  has it without re-deriving it from a request that no longer carries it. */
  readonly method: PaymentPinVerificationMethod;
  readonly otherSessionsRevoked: boolean;
}

export interface PaymentPinDisabledPayload {
  readonly outcome: 'payment_pin_disabled';
  readonly method: PaymentPinVerificationMethod;
  readonly otherSessionsRevoked: boolean;
}

export type PaymentPinPayload =
  | PaymentPinStatusPayload
  | PaymentPinVerifiedPayload
  | PaymentPinEnabledPayload
  | PaymentPinUpdatedPayload
  | PaymentPinDisabledPayload;
