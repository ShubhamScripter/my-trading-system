import { z } from 'zod';
import { passwordSchema } from '../../../auth/dto/common.dto';
import { resolveFactorProof } from './password.utility';
import type { PasswordFactorMethod, PasswordOperation, PasswordStatus } from './password.types';

/**
 * Wire shapes for `GET`/`POST /settings/security/password`.
 *
 * The shared vocabulary — a code as typed, a WebAuthn response — mirrors
 * `paymentPin/payment-pin.dto.ts` field for field, and the reasoning for each is
 * there. Repeated rather than imported for that file's stated reason: those are that
 * module's private schemas, and exporting them to be shared would make a change to
 * one route's validation a change to another's.
 *
 * `passwordSchema` is the deliberate exception and IS imported. It is the account
 * password policy, shared with registration and login, and a second copy here would
 * be a second answer to "what is a valid password" — the one duplication that would
 * actually matter. The rules it cannot express, because they compare against the
 * account's own email and username, are applied by `CredentialService.assertPolicy`.
 */

/**
 * A code as typed: TOTP or emailed. Loose on purpose — `min(1).max(64)` rather than
 * a digit count, so a format rule at the door does not tell a caller which guesses
 * were well-formed before any comparison ran. Same argument as `codeSchema` in
 * 2fa.dto.ts, and the reason this is NOT `otpCodeSchema` from common.dto.ts.
 */
const codeSchema = z.string().min(1).max(64);

/** The WebAuthn response, passed through to `@simplewebauthn/server`, which owns this
 *  shape and verifies every field cryptographically. */
const webauthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

/**
 * The password being PRESENTED rather than chosen.
 *
 * Bounded but deliberately not policy-checked. Applying `passwordSchema` to
 * `currentPassword` would reject a wrong guess with a list of complaints about its
 * composition — which narrows the search space, and which strands exactly the users
 * whose passwords predate the current policy and therefore most need changing. The
 * same distinction `auth/dto/password.dto.ts` draws on its own `currentPassword`.
 */
const presentedPasswordSchema = z.string().min(1).max(200);

// ─── POST /settings/security/password ───────────────────────────────────────

/**
 * ═══ THREE OPERATIONS, ONE ROUTE, ONE DISCRIMINANT ══════════════════════════
 *
 * The convention every multi-step flow in this service uses. See
 * `password.types.ts` for what distinguishes the three and why the split is by what
 * the caller can prove.
 *
 * ─── `.strict()` on every member, which is a security control here ──────────
 *
 * Zod strips unknown keys by default, so without `.strict()` a `set` body carrying
 * `currentPassword` would have it silently dropped and succeed as the weakest
 * operation — and, worse, a `forgot` body carrying `hasPasskey: false` would look to
 * the caller as though the server had accepted their assertion about the account.
 * `.strict()` makes both a `validation_failed` naming the offending key.
 *
 * That is the wire half of "the frontend cannot claim no factor exists". The other
 * half is that no such field appears in any member below, and no code reads one:
 * `factorRequirementFor` takes the account snapshot and nothing else.
 *
 * ─── What is deliberately NOT an action here ────────────────────────────────
 *
 * No `request-code`, and no WebAuthn challenge action. Both already exist —
 * `POST /auth/2fa {"action":"credential-otp"}` and `{"action":"reauth-challenge"}` —
 * and a password-shaped copy of either would be a second way to mint the same
 * credential, metered by a second bucket. The precedent, and the argument, is
 * `paymentPin/payment-pin.routes.ts`.
 */

/**
 * `set` — no password yet. The emailed code is the whole authorisation.
 *
 * No `currentPassword` field, because there is no current password: an account
 * reaching this operation legitimately has nothing to prove beyond the mailbox. An
 * account that DOES have one is refused by the service with `password_already_set`,
 * and by the write itself if that answer went stale.
 */
const setSchema = z
  .object({
    action: z.literal('set'),
    password: passwordSchema,
    confirmPassword: z.string(),
    emailCode: codeSchema,
  })
  .strict();

/** `reset` — the current password AND the emailed code. Both, never either; see the
 *  policy table in password.types.ts. */
const resetSchema = z
  .object({
    action: z.literal('reset'),
    currentPassword: presentedPasswordSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    emailCode: codeSchema,
  })
  .strict();

/**
 * `forgot` — the emailed code, plus one factor if the account has one.
 *
 * Both proof fields are optional HERE and conditionally required in the SERVICE,
 * and the split is not laziness: whether a factor is required is a fact about the
 * account, which a wire schema structurally cannot see. What this schema does
 * enforce is the ambiguity rule — at most one proof — which is a shape question.
 * `resolveFactorProof` is the same pure function the service re-runs, so the two
 * cannot disagree about what a body names.
 */
const forgotSchema = z
  .object({
    action: z.literal('forgot'),
    password: passwordSchema,
    confirmPassword: z.string(),
    emailCode: codeSchema,
    totpCode: codeSchema.optional(),
    passkey: webauthnResponseSchema.optional(),
  })
  .strict();

/**
 * The union, plus the one rule that spans every member.
 *
 * `confirmPassword` is compared here rather than in the service, because it is a
 * property of the REQUEST and not of the account — the service never sees two
 * candidate passwords. Answered as `validation_failed` on the `confirmPassword`
 * path, matching `auth/dto/password.dto.ts`; `ERR.PASSWORD_MISMATCH` exists but is
 * the registration flow's answer and changing which one this route uses would be a
 * wire change for no gain.
 *
 * `superRefine` rather than `.refine()` on each member, and note the consequence:
 * this yields a `ZodEffects`, so `parseDto` still works but the union can no longer
 * be extended with `.and()`. That is the same trade `paymentPinVerifySchema` makes.
 */
export const passwordRequestSchema = z
  .discriminatedUnion('action', [setSchema, resetSchema, forgotSchema])
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match',
      });
    }

    if (value.action !== 'forgot') return;

    const resolved = resolveFactorProof(value);
    if (resolved.ok) return;

    for (const problem of resolved.problems) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: problem.path === '' ? [] : [problem.path],
        message: problem.message,
      });
    }
  });

export type PasswordRequest = z.infer<typeof passwordRequestSchema>;
export type PasswordSetRequest = Extract<PasswordRequest, { action: 'set' }>;
export type PasswordResetRequest = Extract<PasswordRequest, { action: 'reset' }>;
export type PasswordForgotRequest = Extract<PasswordRequest, { action: 'forgot' }>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface PasswordStatusPayload extends PasswordStatus {
  readonly outcome: 'password_status';
}

/**
 * The password changed.
 *
 * ─── What this carries, and what it must never carry ───────────────────────
 *
 * No password and no hash, here or anywhere else. The value the caller sent is the
 * only copy that ever existed outside argon2, and nothing in this service can show
 * it again.
 *
 * `operation` is echoed from the SERVER's dispatch rather than from the request, so
 * an integration bug shows up as a mismatch rather than as a confident wrong label.
 *
 * `factorVerified` names the credential that was actually spent, or `null` when none
 * was required. Echoed for the same reason `PaymentPinUpdatedPayload.method` is: an
 * audit trail should not have to re-derive it from a request that no longer exists.
 *
 * `otherSessionsRevoked` is always true, and stated explicitly rather than left for
 * a client to assume — `BiometricsDisabledPayload` sets that precedent. Every one of
 * the three operations sweeps the account's other sessions; see
 * `PasswordSettingsService.commit`.
 */
export interface PasswordChangedPayload {
  readonly outcome: 'password_changed';
  readonly operation: PasswordOperation;
  readonly factorVerified: PasswordFactorMethod | null;
  readonly otherSessionsRevoked: boolean;
}

export type PasswordPayload = PasswordStatusPayload | PasswordChangedPayload;
