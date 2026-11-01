import { z } from 'zod';
import { TOTP } from '../../auth/auth.constants';
import { loginIdSchema } from '../../auth/dto/common.dto';
import { REAUTH_INTENTS } from './elevation';

/**
 * The wire shapes for the second-factor surface.
 *
 * Two routes and two unions, split by who is asking:
 *
 *   `POST /auth/2fa/verify` — a HALF-authenticated caller finishing a sign-in. Its
 *   credential is the `loginId` in the body — the SAME handle `POST /auth/login`
 *   returned with `mfa_required`, carried across the route boundary rather than
 *   swapped for a second one. It has its own path rather than an action on the
 *   union below: a client calls it at a different moment, holding a different
 *   thing, and folding it in would mean one schema where half the fields are
 *   meaningless to half the callers.
 *
 *   `POST /auth/2fa` — a signed-in caller managing their own factors. One route
 *   with a discriminated body, the same shape `POST /auth/login` uses, because the
 *   nine actions differ only in which credential they demand — a table in
 *   2fa.types.ts rather than nine route declarations.
 */

// The handle is validated by the SHARED `loginIdSchema`, imported above rather
// than declared here.
//
// It used to be a local `z.string().min(1).max(512)`, which accepted any 512-byte
// string — so the login route and this one disagreed about what a handle even
// looks like, and junk reached sha256 and a database round trip on every request.
// One schema for one value means the two routes cannot drift, and the derived
// length check means changing `SECRET_BYTES` cannot leave either validating the
// old size.

/**
 * A TOTP or recovery code as typed.
 *
 * Deliberately loose — `min(1).max(64)` rather than six digits — and the reason is
 * the same one `passwordModeSchema` gives for not applying the password policy at
 * login: a format rule at the door tells an attacker which guesses were
 * well-formed before any comparison ran, and it would reject a recovery code the
 * moment its format changed. The real bound is five attempts.
 */
const codeSchema = z.string().min(1).max(64);

/** What a caller may name at `POST /auth/2fa/verify`. Mirrors `SignInMethod`. */
const signInMethodSchema = z.enum(['totp', 'passkey', 'recovery_code']);

/**
 * The WebAuthn response object, passed through to `@simplewebauthn/server`.
 *
 * `passthrough` rather than a mirrored schema: the library owns this shape, it
 * changes with the spec, and every field is verified cryptographically downstream.
 * A second copy of the definition here would only be a place for the two to
 * disagree — and a mismatch would surface as an unexplained verification failure.
 */
const webauthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

/**
 * A user-facing name for an authenticator. Cosmetic, so it is bounded and
 * otherwise unvalidated.
 *
 * Optional where it is offered, with no `.default()` here on purpose. The default
 * is a column default in Postgres and the service passes through to it, so the
 * name a nameless factor gets is decided in one place instead of two that can
 * drift. (`parseDto` types its schema as `ZodType<T>`, which collapses input and
 * output, so a `.default()` would not narrow the type here anyway.)
 */
const labelSchema = z.string().trim().min(1).max(64);

// ─── POST /auth/2fa/verify ──────────────────────────────────────────────────

/**
 * Complete a sign-in that stopped at `mfa_required`.
 *
 * The passkey branch is two calls on one action: send `method: 'passkey'` with no
 * `passkey` field to receive the WebAuthn options, then send it again with the
 * assertion. One action rather than two because the client is doing one thing, and
 * because the challenge is bound to the attempt either way.
 */
export const twoFactorVerifySchema = z
  .object({
    loginId: loginIdSchema,
    method: signInMethodSchema,
    /** Required for `totp` and `recovery_code`; meaningless for `passkey`. */
    code: codeSchema.optional(),
    /** The assertion, on the second call of the passkey branch. */
    passkey: webauthnResponseSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Checked here rather than in the service so a client that forgets the code
    // gets a validation error naming the field, instead of a wrong-code error that
    // costs it one of five attempts.
    if (value.method !== 'passkey' && value.code === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: 'Required for this method',
      });
    }

    // ─── Exactly the proof the method names, and no other ────────────────────
    //
    // Both fields were independently optional, so `{ method: 'totp', code, passkey }`
    // validated. Nothing was exploitable — the controller dispatches on `method` and
    // never on which fields are populated — but an over-permissive contract is one a
    // client can satisfy while believing something else will happen, and the next
    // reader has to check the dispatch to find out which field wins. Making the
    // schema say what the service does removes that question.
    if (value.method !== 'passkey' && value.passkey !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passkey'],
        message: 'Only permitted when method is "passkey"',
      });
    }

    if (value.method === 'passkey' && value.code !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: 'Not permitted when method is "passkey"',
      });
    }
  });

export type TwoFactorVerifyRequest = z.infer<typeof twoFactorVerifySchema>;

// ─── POST /auth/2fa ─────────────────────────────────────────────────────────

/**
 * `intent` names the write the ticket will be spent on.
 *
 * Required, and drawn from a closed union. A ticket that named no action would be a
 * permit for whichever guarded write the holder reached first, which is exactly the
 * unscoped elevation the ticket design exists to avoid.
 *
 * ─── `REAUTH_INTENTS`, not `ELEVATION_ACTIONS` ──────────────────────────────
 *
 * These were the same list until Settings → Social accounts grew an action whose
 * proof policy this route cannot express: `account.social.link` owes an emailed code
 * on every path, and owes nothing beyond it when no factor is enrolled, whereas
 * `reauthVerify` demands no emailed code for a provider link and falls back to the
 * account password. Accepting it here would hand out a ticket for that write on the
 * WRONG terms, which is a bypass rather than a mismatch.
 *
 * The values are otherwise unchanged, so nothing a client sends today is affected —
 * see `REAUTH_INTENTS` in elevation.ts.
 */
const intentSchema = z.enum(REAUTH_INTENTS);

const reauthChallengeSchema = z.object({
  action: z.literal('reauth-challenge'),
  /**
   * Which write the caller intends, so the advertised methods match what will
   * actually be accepted.
   *
   * Optional for backward compatibility: a client that omits it gets the methods for
   * the strictest case. It matters because a recovery code is accepted for REMOVING a
   * factor and refused for adding one — see `reauthVerify` — so a challenge that did
   * not know the intent would have to either over-advertise or under-advertise.
   */
  intent: intentSchema.optional(),
});

const reauthVerifySchema = z.object({
  action: z.literal('reauth-verify'),
  intent: intentSchema,
  /** One of these, depending on what this account has and what the intent is. The
   *  service decides which is acceptable — see `TwoFactorService.reauthVerify`. */
  totpCode: codeSchema.optional(),
  password: z.string().min(1).max(1024).optional(),
  passkey: webauthnResponseSchema.optional(),
  /**
   * A recovery code, accepted ONLY for `account.mfa.remove`.
   *
   * This is what unsticks the lost-factor case. Without it a user whose only
   * authenticator was lost could sign in with a recovery code but never remove or
   * replace the factor: `hasFactor` was still true, so re-authentication demanded the
   * very TOTP code or passkey they no longer had, and every management action needs a
   * ticket. There was no support path either.
   */
  recoveryCode: z.string().min(1).max(64).optional(),
  /**
   * The emailed code, required alongside the factor proof for factor changes.
   *
   * Product scope asks for Email OTP on adding a passkey, enabling an authenticator
   * and disabling either — none of which sent or checked one. Obtain it with
   * `action: 'credential-otp'` first.
   *
   * Deliberately NOT required when a recovery code is the proof: the scope lists a
   * backup code on its own as sufficient for disabling a factor, and demanding a
   * mailbox round trip as well would re-close the lost-factor path this release
   * opened.
   */
  emailCode: codeSchema.optional(),
});

/**
 * Send the caller an emailed code for a pending credential change.
 *
 * Takes no intent: the code proves the mailbox, which is the same fact whichever
 * credential is about to change, and a per-intent code would mean a user who
 * changed their mind mid-flow had to request another.
 */
const credentialOtpSchema = z.object({ action: z.literal('credential-otp') });

const totpAddSchema = z.object({
  action: z.literal('totp-add'),
  label: labelSchema.optional(),
});

const totpConfirmSchema = z.object({
  action: z.literal('totp-confirm'),
  code: z.string().length(TOTP.DIGITS).regex(/^\d+$/),
});

const passkeyAddChallengeSchema = z.object({ action: z.literal('passkey-add-challenge') });

const passkeyAddVerifySchema = z.object({
  action: z.literal('passkey-add-verify'),
  passkey: webauthnResponseSchema,
  label: labelSchema.optional(),
});

const recoveryRegenerateSchema = z.object({ action: z.literal('recovery-regenerate') });

/** `kind` names which table the id lives in. Sent by the client rather than
 *  discovered, so one id lookup runs instead of two. */
const factorKindSchema = z.enum(['TOTP', 'PASSKEY']);

const removeSchema = z.object({
  action: z.literal('remove'),
  kind: factorKindSchema,
  id: z.string().uuid(),
});

const renameSchema = z.object({
  action: z.literal('rename'),
  kind: factorKindSchema,
  id: z.string().uuid(),
  label: labelSchema,
});

export const twoFactorRequestSchema = z.discriminatedUnion('action', [
  reauthChallengeSchema,
  reauthVerifySchema,
  credentialOtpSchema,
  totpAddSchema,
  totpConfirmSchema,
  passkeyAddChallengeSchema,
  passkeyAddVerifySchema,
  recoveryRegenerateSchema,
  removeSchema,
  renameSchema,
]);

export type TwoFactorRequest = z.infer<typeof twoFactorRequestSchema>;
export type ReauthVerifyRequest = z.infer<typeof reauthVerifySchema>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface FactorPayload {
  readonly id: string;
  readonly kind: 'TOTP' | 'PASSKEY';
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface FactorListPayload {
  readonly factors: readonly FactorPayload[];
  /**
   * How many single-use codes are left.
   *
   * A count and not the codes: they are hashed the moment they are issued, so
   * nothing here could return them even if it wanted to. The number is what a
   * client needs to nudge someone at two remaining.
   */
  readonly recoveryCodesRemaining: number;
}

/**
 * Everything `POST /auth/2fa` can answer with.
 *
 * A union rather than one wide optional-everything object, so a client switching on
 * the action it sent gets a shape that matches, and so a reviewer can see which
 * actions return a secret. Exactly two do — `totp-add` and anything issuing
 * recovery codes — and both return it exactly once.
 */
export type TwoFactorPayload =
  | FactorListPayload
  /** The methods this account can re-prove, plus WebAuthn options when it has a
   *  passkey. `options` is null when it does not. */
  | {
      readonly outcome: 'reauth_challenge';
      readonly methods: readonly string[];
      readonly options: Record<string, unknown> | null;
    }
  /** A single-use permit for ONE write of `action`. Present it in the
   *  `x-elevation-ticket` header. */
  | {
      readonly outcome: 'elevated';
      readonly ticket: string;
      readonly expiresInSeconds: number;
      readonly action: string;
    }
  /**
   * The TOTP secret, in the only response that will ever carry it.
   *
   * `secret` is the base32 for manual entry and `uri` is what a QR code encodes.
   * Both are the same value; apps and users disagree about which they want.
   */
  | { readonly outcome: 'totp_enrollment'; readonly secret: string; readonly uri: string }
  /** Recovery codes, shown once and never again. Empty when the account already
   *  had a set — confirming a second factor must not invalidate written-down codes. */
  | { readonly outcome: 'recovery_codes'; readonly recoveryCodes: readonly string[] }
  /** WebAuthn creation options for a new passkey. */
  | { readonly outcome: 'passkey_challenge'; readonly options: Record<string, unknown> }
  | { readonly outcome: 'factor'; readonly factor: FactorPayload }
  /**
   * A newly enrolled factor AND the recovery codes it earned, shown once.
   *
   * The shape `passkey-add-verify` needed and did not have. Enrolling a first passkey
   * mints recovery codes exactly as confirming a first TOTP factor does, but the union
   * offered only `factor` (no codes) or `recovery_codes` (no factor) — two disjoint
   * members, neither able to express the actual outcome. So the codes were generated,
   * hashed and discarded, and the account was left believing it had ten it had never
   * seen.
   *
   * `recoveryCodes` is empty when the account already had a set, which is how a client
   * tells "here are your codes, write them down" from "you already have codes".
   */
  | {
      readonly outcome: 'factor_with_recovery_codes';
      readonly factor: FactorPayload;
      readonly recoveryCodes: readonly string[];
    }
  | { readonly outcome: 'ok' };
