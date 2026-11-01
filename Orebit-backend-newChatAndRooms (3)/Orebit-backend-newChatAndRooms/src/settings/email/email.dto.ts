import { z } from 'zod';
import { emailSchema } from '../../../auth/dto/common.dto';
import type { EmailChangeMethod, EmailChangeStatus, EmailProofTarget } from './email.types';
import { resolveEmailChangeProof } from './email.utility';

/**
 * Wire shapes for changing the account's email.
 *
 * ─── One import that matters more than it looks ─────────────────────────────
 *
 * `emailSchema` comes from `auth/dto/common.dto.ts` rather than being restated here, and
 * that is the single most important line in this file. The codebase already has two
 * independent implementations of "what is the same address" — `normaliseEmail` in
 * auth.utility.ts, and that schema's `.trim().toLowerCase()` — which agree today and are
 * kept in step by nothing. A third would be the one that drifts, and the failure mode is
 * an address that registration considers taken and an email change considers free.
 *
 * The other shared shapes (a code as typed, a WebAuthn response) mirror
 * `settings.dto.ts` field for field; the reasoning for each is there.
 */

/** A code as typed. Loose on purpose — `min(1).max(64)` rather than a digit count, so a
 *  format rule at the door does not tell a caller which guesses were well-formed before
 *  any comparison ran. Same argument as `codeSchema` in 2fa.dto.ts. */
const codeSchema = z.string().min(1).max(64);

/** The WebAuthn response, passed through to `@simplewebauthn/server`, which owns this
 *  shape and verifies every field cryptographically. */
const webauthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

/** Opaque to this service — see `KycEvidence`. Bounded, not parsed. */
const kycEvidenceSchema = z.object({ reference: z.string().min(1).max(512) });

/**
 * The password, as it exists today rather than as policy would have it.
 *
 * NOT `passwordSchema`: an existing password predates the current policy and must still
 * be presentable. Validating it here would refuse the proof and strand exactly the
 * accounts whose owners most need to move address. The same decision `password.dto.ts`
 * makes for `currentPassword`, for the same reason.
 */
const currentPasswordSchema = z.string().min(1).max(200);

/** Bounded but not parsed: an opaque handle, sized to reject a caller posting a megabyte
 *  to be hashed into a comparison. */
const opaqueIdSchema = z.string().min(1).max(128);

const methodSchema = z.enum(['authenticator', 'passkey', 'kyc', 'password', 'none']);

// ─── POST /settings/security/email ──────────────────────────────────────────

/**
 * Start a change. Authenticated.
 *
 * `method` is chosen HERE rather than at verify time, and that ordering is the defence
 * against a downgrade: the tier is written into the server's record before any code is
 * sent, so a caller who started against a passkey cannot finish against a password. The
 * verify request restates it only so a mismatch produces a clear refusal rather than a
 * confusing proof failure.
 */
const startSchema = z
  .object({
    action: z.literal('start'),
    newEmail: emailSchema,
    method: methodSchema,
    /**
     * The previous address is still retained but its mailbox is unreachable — usually
     * because it is the address the user changed away FROM after losing it.
     *
     * Accepting this costs the retention: completing the change expires it. And it is
     * refused unless the declared method is an authenticator, a passkey or KYC, because
     * on an account whose only proof is a password an attacker holding that password
     * would otherwise be able to shed the very record the real owner needs.
     */
    skipRetainedEmail: z.boolean().optional(),
  })
  .strict();

/**
 * Resend one of the codes.
 *
 * Per-target rather than all-at-once: a user who found two of three codes and lost the
 * third should not have the two they have invalidated to get the one they need —
 * `ChallengeDbOperation.issue` supersedes the live row for a purpose, so resending
 * everything would do exactly that.
 */
const resendSchema = z
  .object({
    action: z.literal('resend'),
    challengeId: opaqueIdSchema,
    target: z.enum(['current', 'new', 'retained']),
  })
  .strict();

/**
 * Start a recovery from a released address. UNAUTHENTICATED.
 *
 * `recoveryId` is the token from the "did you do this?" notification, and it is the
 * whole of the caller's identity here — there is deliberately no session, because a
 * completed change sweeps every session and the address being recovered cannot sign in.
 * That is the situation this exists for.
 *
 * It travels in the body and never in a query string, so it stays out of access logs and
 * `Referer` headers.
 */
const recoverStartSchema = z
  .object({
    action: z.literal('recover-start'),
    recoveryId: opaqueIdSchema,
    intent: z.enum(['restore', 'replace']),
    /** Required for `replace`, forbidden for `restore`. Not expressible in the shape —
     *  a discriminated union keys on one field, and this rule keys on two — so it is
     *  enforced by the refinement on the union below. */
    newEmail: emailSchema.optional(),
    /** "No, this wasn't me". Changes the notifications and the log level; the mutation
     *  is identical to a deliberate "go back". */
    reportedCompromise: z.boolean().optional(),
  })
  .strict();

/**
 * The three actions, plus the one cross-field rule none of them can state alone.
 *
 * The refinement lives on the UNION rather than on `recoverStartSchema`, and that is not
 * a stylistic choice: `superRefine` produces a `ZodEffects`, and `discriminatedUnion`
 * accepts only `ZodObject` members. Refining the member first and then unwrapping it
 * with `.innerType()` to satisfy the union compiles and silently discards the rule,
 * which is the failure this arrangement exists to avoid.
 */
export const emailChangeRequestSchema = z
  .discriminatedUnion('action', [startSchema, resendSchema, recoverStartSchema])
  .superRefine((value, ctx) => {
    if (value.action !== 'recover-start') return;

    if (value.intent === 'replace' && value.newEmail === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newEmail'],
        message: 'Required when moving the account to a different address.',
      });
    }
    if (value.intent === 'restore' && value.newEmail !== undefined) {
      // Refused rather than ignored: a caller sending it believes the account will end
      // up somewhere it will not.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newEmail'],
        message: 'Not permitted when restoring — the account returns to this address.',
      });
    }
  });

export type EmailChangeRequest = z.infer<typeof emailChangeRequestSchema>;

// ─── POST /settings/security/email/verify ───────────────────────────────────

/**
 * The emailed codes, one per mailbox the ceremony demanded.
 *
 * All three are optional in the SHAPE because which are required is a property of the
 * challenge, not of the wire — the server knows, and re-deriving it here would be a
 * second copy of the policy that could disagree. The service refuses a request missing
 * one its challenge requires, and refuses one carrying a code its challenge did not ask
 * for.
 */
const emailCodes = {
  currentEmailCode: codeSchema.optional(),
  newEmailCode: codeSchema.optional(),
  retainedEmailCode: codeSchema.optional(),
};

/**
 * Complete a change. One member per tier, every one `.strict()`.
 *
 * ─── Why `.strict()` is the security control and not a nicety ──────────────
 *
 * A discriminated union alone would still accept `{method:'password', password, passkey}`
 * — Zod strips unknown keys by default, so the stronger proof would vanish silently and
 * the request would succeed on the weaker branch. `.strict()` makes it a validation
 * error, before any comparison runs, so a caller sending everything learns nothing about
 * which of their proofs would have verified.
 *
 * The `superRefine` below is not redundant with it: `.strict()` catches a field this
 * member does not declare, and the resolver catches the rest of the rule with the exact
 * messages the service will produce when it re-runs the same function.
 */
const verifyBase = {
  challengeId: opaqueIdSchema,
  ...emailCodes,
};

const verifyAuthenticatorSchema = z
  .object({ ...verifyBase, method: z.literal('authenticator'), totpCode: codeSchema })
  .strict();

const verifyPasskeySchema = z
  .object({ ...verifyBase, method: z.literal('passkey'), passkey: webauthnResponseSchema })
  .strict();

const verifyKycSchema = z
  .object({ ...verifyBase, method: z.literal('kyc'), kyc: kycEvidenceSchema })
  .strict();

const verifyPasswordSchema = z
  .object({ ...verifyBase, method: z.literal('password'), password: currentPasswordSchema })
  .strict();

/** The account with no factor, no KYC and no password. The two emailed codes are the
 *  whole proof, and this member carries no proof field at all. */
const verifyNoneSchema = z.object({ ...verifyBase, method: z.literal('none') }).strict();

const changeVerifySchema = z
  .discriminatedUnion('method', [
    verifyAuthenticatorSchema,
    verifyPasskeySchema,
    verifyKycSchema,
    verifyPasswordSchema,
    verifyNoneSchema,
  ])
  .superRefine((value, ctx) => {
    const resolved = resolveEmailChangeProof(value);
    if (resolved.ok) return;

    for (const problem of resolved.problems) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: problem.path === '' ? [] : [problem.path],
        message: problem.message,
      });
    }
  });

/**
 * Complete a recovery. Unauthenticated, and carries no security factor.
 *
 * Deliberately weaker than a change, and bounded by what it can do: the ticket proves
 * possession of the mailbox the notification went to, and every operation it authorises
 * points the account at an address the caller has proved control of in the same request.
 * Demanding a factor here would close the flow for exactly the user it exists to save —
 * someone locked out of an account whose factors they may never have had.
 */
const recoveryVerifySchema = z
  .object({
    recoveryId: opaqueIdSchema,
    /** The code sent to the released address. Always required. */
    retainedEmailCode: codeSchema,
    /** The code sent to the replacement address. Required for `replace`, refused for
     *  `restore` — the server knows which from the recovery record, so this is checked
     *  there rather than here. */
    newEmailCode: codeSchema.optional(),
  })
  .strict();

/**
 * The verify endpoint takes either shape.
 *
 * A union on the PRESENCE of `challengeId` versus `recoveryId` rather than an explicit
 * discriminant, because the two are genuinely different ceremonies reached by different
 * callers — one authenticated, one not — and inventing a shared `kind` field would ask
 * every client to send a constant it can never vary.
 */
export const emailVerifySchema = z.union([changeVerifySchema, recoveryVerifySchema]);

export type EmailVerifyRequest = z.infer<typeof emailVerifySchema>;
export type EmailChangeVerifyRequest = z.infer<typeof changeVerifySchema>;
export type EmailRecoveryVerifyRequest = z.infer<typeof recoveryVerifySchema>;

/** Which ceremony a parsed verify body belongs to. A type guard rather than a field, so
 *  the controller branches on something the compiler checks. */
export function isRecoveryVerify(
  input: EmailVerifyRequest,
): input is EmailRecoveryVerifyRequest {
  return 'recoveryId' in input;
}

// ─── responses ──────────────────────────────────────────────────────────────

export interface EmailStatusPayload extends EmailChangeStatus {
  readonly outcome: 'email_status';
}

/**
 * A change has started and the codes are on their way.
 *
 * `requiredTargets` is what a client renders its input boxes from — two entries
 * ordinarily, three while a previous address is still retained. It comes from the
 * server's record rather than being inferred, so a client never has to know what
 * retention is.
 */
export interface EmailChangeStartedPayload {
  readonly outcome: 'email_change_started';
  readonly challengeId: string;
  readonly newEmail: string;
  readonly method: EmailChangeMethod;
  readonly requiredTargets: readonly EmailProofTarget[];
  readonly expiresInSeconds: number;
}

export interface EmailCodeResentPayload {
  readonly outcome: 'email_code_resent';
  readonly target: EmailProofTarget;
}

export interface EmailRecoveryStartedPayload {
  readonly outcome: 'email_recovery_started';
  readonly recoveryId: string;
  readonly intent: 'restore' | 'replace';
  /** Masked. The caller already knows the address — the code went to it — and an
   *  unauthenticated response should not echo one in full. */
  readonly targetEmail: string;
  readonly expiresInSeconds: number;
}

/**
 * The address changed.
 *
 * `email` is masked for the same reason the status payload's is. A client that needs the
 * full value has `GET /auth/me`, which is authenticated and already returns it.
 */
export interface EmailChangedPayload {
  readonly outcome: 'email_changed';
  readonly email: string;
  /** Always true. Explicit so a client can say so rather than assume — and true here
   *  where it is false for the Payment PIN, because the old address is a sign-in
   *  credential and a session may have been established with it. */
  readonly otherSessionsRevoked: boolean;
}

export interface EmailRecoveredPayload {
  readonly outcome: 'email_recovered';
  readonly email: string;
  readonly intent: 'restore' | 'replace';
  readonly otherSessionsRevoked: boolean;
}

export type EmailPayload =
  | EmailStatusPayload
  | EmailChangeStartedPayload
  | EmailCodeResentPayload
  | EmailRecoveryStartedPayload
  | EmailChangedPayload
  | EmailRecoveredPayload;
