import { z } from 'zod';
import type { FactorSettingStatus } from './settings.types';
import { resolveDisablePath } from './settings.utility';

/**
 * Wire shapes for `settings`.
 *
 * The private schemas mirror `src/2fa/2fa.dto.ts` field for field where the two
 * describe the same thing — a code as typed, a WebAuthn response, an authenticator
 * label — and the reasoning for each is in that file. Repeated here rather than
 * imported because they are that module's private vocabulary, and exporting them to
 * be shared would make a change to one route's validation a change to another's.
 */

/**
 * A code as typed: TOTP, backup, or emailed.
 *
 * Loose on purpose — `min(1).max(64)` rather than a digit count. A format rule at
 * the door tells a caller which guesses were well-formed before any comparison ran,
 * and it would reject a backup code the moment its format changed. The real bound is
 * `SECURITY_SETTINGS.DISABLE_BY_ACCOUNT`. Same argument as `codeSchema` in 2fa.dto.ts.
 */
const codeSchema = z.string().min(1).max(64);

/** The WebAuthn response, passed through to `@simplewebauthn/server`, which owns
 *  this shape and verifies every field cryptographically. */
const webauthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough();

const labelSchema = z.string().trim().min(1).max(64);

/** Opaque to this service — see `KycEvidence`. Bounded, not parsed. */
const kycEvidenceSchema = z.object({ reference: z.string().min(1).max(512) });

// ─── POST /settings/security/passkeys ───────────────────────────────────────

const enableChallengeSchema = z.object({
  action: z.literal('enable-challenge'),
  /**
   * The emailed code. Required — it is the entire authorisation for turning
   * biometrics on, so unlike the 2FA enrollment path there is no second proof for it
   * to be optional against. See the header of settings.service.ts.
   */
  emailCode: codeSchema,
  label: labelSchema.optional(),
});

const enableVerifySchema = z.object({
  action: z.literal('enable-verify'),
  passkey: webauthnResponseSchema,
  label: labelSchema.optional(),
});

export const biometricsRequestSchema = z.discriminatedUnion('action', [
  enableChallengeSchema,
  enableVerifySchema,
]);

export type BiometricsRequest = z.infer<typeof biometricsRequestSchema>;

// ─── POST /settings/security/authenticator ──────────────────────────────────

/**
 * Step one of turning the authenticator on.
 *
 * The same two-action shape as the biometrics union above, and the same emailed code
 * as its entire authorisation. `label` names the authenticator in the account's
 * factor list; `TwoFactorService.totpAdd` defaults it to `'Authenticator'`.
 */
const authenticatorEnableChallengeSchema = z.object({
  action: z.literal('enable-challenge'),
  emailCode: codeSchema,
  label: labelSchema.optional(),
});

/**
 * Step two: the six digits the authenticator now shows.
 *
 * `totpCode` rather than `code` — the field is named for the credential in every
 * other shape in this module (`totpCode`, `backupCode`, `emailCode`), and a bare
 * `code` on a screen that also has an `emailCode` is the one ambiguity worth
 * spending a longer name to avoid.
 */
const authenticatorEnableVerifySchema = z.object({
  action: z.literal('enable-verify'),
  totpCode: codeSchema,
});

export const authenticatorRequestSchema = z.discriminatedUnion('action', [
  authenticatorEnableChallengeSchema,
  authenticatorEnableVerifySchema,
]);

export type AuthenticatorRequest = z.infer<typeof authenticatorRequestSchema>;

// ─── POST /settings/security/{passkeys,authenticator}/disable ───────────────

/**
 * One atomic request carrying exactly one path's proofs.
 *
 * Every field is independently optional in the shape, because which combination is
 * legal is not something a discriminated union can express — there is no
 * discriminant, the path IS the combination. `superRefine` therefore delegates to
 * `resolveDisablePath`, the same pure function the service uses, so the schema and
 * the policy cannot disagree.
 *
 * ─── One schema for both disable routes ─────────────────────────────────────
 *
 * The body is identical because the policy is: four paths, one proof each, and the
 * emailed code on all but `backup-code`. What differs between the two routes is only
 * which path is ORDINARY and which are available on a given account, and neither of
 * those is a wire-shape question — the first is `disablePathsFor`, the second is
 * checked against the account before any proof is consumed. Two copies of this
 * `superRefine` would be two places for the ambiguity rule to drift.
 *
 * ─── Why the assertion path still needs a prior call ────────────────────────
 *
 * WebAuthn requires a server-minted challenge before the client can sign anything,
 * so `passkey+otp` callers first ask for options with
 * `POST /auth/2fa {"action":"reauth-challenge","intent":"account.mfa.remove"}`. That
 * is inherent to the ceremony rather than a policy step: the disable itself is still
 * one request that either fully succeeds or changes nothing.
 */
export const disableProofsSchema = z
  .object({
    emailCode: codeSchema.optional(),
    passkey: webauthnResponseSchema.optional(),
    totpCode: codeSchema.optional(),
    backupCode: codeSchema.optional(),
    kyc: kycEvidenceSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const resolved = resolveDisablePath(value as Parameters<typeof resolveDisablePath>[0]);
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

export type DisableProofsRequest = z.infer<typeof disableProofsSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface BiometricsStatusPayload extends FactorSettingStatus {
  readonly outcome: 'biometrics_status';
  /**
   * The passkey count, under its original name.
   *
   * Identical to `factorCount`, which is what the generalised shape calls it now
   * that the authenticator screen returns the same payload. Kept because this route
   * shipped with `passkeyCount` and a live client reads it
   * (`Auth/user-settings/app.js`); dropping it would be a silent break for the sake
   * of tidiness. Prefer `factorCount` in new clients, and delete this once nothing
   * reads it.
   */
  readonly passkeyCount: number;
}

export interface PasskeyChallengePayload {
  readonly outcome: 'passkey_challenge';
  readonly options: Record<string, unknown>;
}

/**
 * A newly enrolled passkey, with the backup codes if this enrollment minted them.
 *
 * `backupCodes` is non-empty ONLY on the enrollment that takes the account from no
 * factors to one, and this response is the only place they are ever visible. Empty
 * on every subsequent passkey, which is the honest answer rather than an omission —
 * a client can render "keep these safe" exactly when there is something to keep.
 */
export interface PasskeyEnabledPayload {
  readonly outcome: 'passkey_enabled';
  readonly factor: {
    readonly id: string;
    readonly label: string;
    readonly createdAt: string;
  };
  readonly backupCodes: readonly string[];
}

export interface BiometricsDisabledPayload {
  readonly outcome: 'biometrics_disabled';
  /** How many credentials were retired. Zero when the setting was already off. */
  readonly removed: number;
  /** Which of the four paths authorised this. Echoed so a client can show it and an
   *  audit trail has it without re-deriving it from the request. */
  readonly path: string;
  /** Whether other sessions were signed out. Always true in practice; explicit so
   *  the client can say so without assuming. */
  readonly otherSessionsRevoked: boolean;
}

export interface AuthenticatorStatusPayload extends FactorSettingStatus {
  readonly outcome: 'authenticator_status';
}

/**
 * The enrollment secret, returned exactly once.
 *
 * ─── This response IS the secret ────────────────────────────────────────────
 *
 * Both fields carry the shared secret in the clear — `uri` is the `otpauth://` form
 * of the same bytes, for a QR code — and that is the entire purpose of the step: the
 * user has to get it into their authenticator, and this is the only moment it exists
 * in plaintext outside its AES envelope. `TwoFactorService.totpAdd` seals it before
 * storing it, and nothing can show it again.
 *
 * So a client must not log this, cache it, or put it in a URL. It is no more exposed
 * than the identical payload `POST /auth/2fa {"action":"totp-add"}` already returns,
 * which is where the shape comes from.
 */
export interface AuthenticatorSecretPayload {
  readonly outcome: 'authenticator_secret';
  /** Base32, for a user typing it in by hand. */
  readonly secret: string;
  /** `otpauth://totp/...`, for a QR code. */
  readonly uri: string;
}

/**
 * The authenticator is on, with the backup codes if this enrollment minted them.
 *
 * `backupCodes` is non-empty ONLY when the account had no set already — the same
 * rule `PasskeyEnabledPayload` documents, and the reason is the same: confirming a
 * second factor must not silently invalidate the codes a user already wrote down.
 * Empty is therefore the honest answer rather than an omission.
 */
export interface AuthenticatorEnabledPayload {
  readonly outcome: 'authenticator_enabled';
  readonly backupCodes: readonly string[];
}

export interface AuthenticatorDisabledPayload {
  readonly outcome: 'authenticator_disabled';
  /**
   * How many authenticator rows were retired.
   *
   * Counts an abandoned, unconfirmed enrollment as well as the confirmed factor, so
   * this can be `1` on an account whose setting read as off. That is deliberate and
   * not a miscount — see `softDeleteAllTotpFactors` for why a pending row must not
   * survive a disable.
   */
  readonly removed: number;
  readonly path: string;
  readonly otherSessionsRevoked: boolean;
}

export type SettingsPayload =
  | BiometricsStatusPayload
  | PasskeyChallengePayload
  | PasskeyEnabledPayload
  | BiometricsDisabledPayload
  | AuthenticatorStatusPayload
  | AuthenticatorSecretPayload
  | AuthenticatorEnabledPayload
  | AuthenticatorDisabledPayload;
