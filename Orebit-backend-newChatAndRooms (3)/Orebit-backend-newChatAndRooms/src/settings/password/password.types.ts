import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

/**
 * Domain types for the account password, as a setting its owner controls.
 *
 * ─── What this sub-module is, and why it sits under src/settings/ ───────────
 *
 * Product policy layered over mechanisms that already exist — the emailed code
 * (`ChallengeDbOperation` / `TwoFactorService`), argon2 (`CredentialService`), the
 * authenticator and the passkey (`TwoFactorService`), the session sweep
 * (`SessionService`), the security freeze (`RecentSecurityChangePolicy`) — and it owns
 * none of them. The same relationship `paymentPin/payment-pin.types.ts` describes,
 * which is why this lives beside it rather than in `auth/`.
 *
 * ─── Why it is a folder rather than more files in src/settings/ ─────────────
 *
 * It has its own policy: three operations distinguished by WHAT THE CALLER CAN PROVE,
 * a factor requirement that applies to exactly one of them and only when the account
 * has a factor, and a session sweep on all three. None of that folds into
 * `DisablePath` (four paths over a factor, no create operation) or into
 * `PaymentPinOperation` (a verify-then-act challenge, no session sweep).
 *
 * ─── What lives OUTSIDE this folder, and why ────────────────────────────────
 *
 * `auth/services/credential.service.ts`   argon2 and the password policy. Shared with
 *                                         registration and login; a second copy would
 *                                         be a second answer to "what is a valid
 *                                         password".
 * `auth/persistence/user.dboperation.ts`  `createPasswordIfAbsent` / `replacePassword`.
 *                                         The `credentials` table is read by
 *                                         registration and every login path, so this
 *                                         folder must not become a second access layer
 *                                         for it — the rule `settings.module.ts` states.
 * `src/2fa/2fa.service.ts`                the emailed code and both factor proofs.
 * `auth/services/session.service.ts`      the sweep.
 */

// ─── the three operations ───────────────────────────────────────────────────

/**
 * ═══ THE POLICY TABLE, AND THE ONE THING THAT DISTINGUISHES THE THREE ═══════
 *
 * The split is by WHAT THE CALLER CAN PROVE, not by what the account has. That is the
 * distinction `auth/dto/password.dto.ts` drew when the public forgot/reset pair was
 * retired, and it is kept because the alternative locks people out: a user who has
 * forgotten their password HAS one, so an operation gated on "no password exists"
 * does not apply to them, and one gated on "prove the current password" demands the
 * very thing they cannot supply.
 *
 *   `set`     No password exists. Authorised by the emailed code alone.
 *
 *             Weaker than the other two, and bounded by what it can do: it CREATES a
 *             credential where there was none, so there is nothing to overwrite and
 *             nothing to lose that the mailbox does not already guard. The write
 *             itself refuses if that precondition has gone stale — see
 *             `UserDbOperation.createPasswordIfAbsent`. The same argument, and the
 *             same bound, as `PaymentPinService.enable`.
 *
 *             This is the path for an account created through a provider and for one
 *             that skipped the password at registration. Nothing about OAuth is
 *             special-cased: "has no password credential" is the whole condition, and
 *             a provider-created account satisfies it for the same reason a
 *             password-skipping signup does.
 *
 *   `reset`   A password exists and the caller knows it. Emailed code AND the current
 *             password.
 *
 *             Both, not either. Accepting one OR the other would make the weaker of
 *             them the only one that matters, which is the argument
 *             `auth/dto/password.dto.ts` makes against offering a code as an
 *             alternative to the current password. Demanding both is strictly
 *             stronger than either alone, so it does not reopen what that argument
 *             closed.
 *
 *   `forgot`  A password exists and the caller cannot supply it. Emailed code, AND an
 *             enabled factor if the account has one.
 *
 *             The factor requirement is the whole of why this operation is separate
 *             from `set` rather than being served by it. Without it, an account with
 *             a passkey could have its password replaced by anyone holding a session
 *             and the mailbox — which is precisely the downgrade the second factor
 *             exists to prevent.
 */
export type PasswordOperation = 'set' | 'reset' | 'forgot';

export const PASSWORD_OPERATIONS = [
  'set',
  'reset',
  'forgot',
] as const satisfies readonly PasswordOperation[];

// ─── the additional factor on `forgot` ──────────────────────────────────────

/**
 * The factors that satisfy `forgot`'s additional-verification requirement.
 *
 * `authenticator` and `passkey` rather than one `2fa`, for the reason
 * `PaymentPinVerificationMethod` gives: they are separate mechanisms with separate
 * enrollment state, and a client told "2fa is available" cannot render the right
 * prompt — one needs six digits typed from a phone, the other needs
 * `navigator.credentials.get()`.
 *
 * ─── What is deliberately NOT here: the recovery code ───────────────────────
 *
 * `TwoFactorService.proveBackupCode` exists and is offered by the two factor-disable
 * paths, and it is not offered here. Those paths exist for someone whose FACTOR IS
 * GONE — a printed sheet is the last way out, and refusing it would strand them. This
 * path has a different shape: an account that has lost its factor still reaches
 * `forgot` through the no-factor branch below the moment that factor is removed, so a
 * recovery code is never the last way to a new password.
 *
 * Accepting it would instead mean a found printout is enough to replace the account
 * password — the takeover `reauthVerify` scopes recovery codes to `account.mfa.remove`
 * specifically to prevent. The user's own route is: spend the code to disable the
 * factor, then use `forgot` with no factor required.
 */
export type PasswordFactorMethod = 'authenticator' | 'passkey';

/**
 * Both, in the order a screen should offer them.
 *
 * `passkey` first: it is one gesture rather than six typed digits, so it should not
 * be second in a list on an account that has both.
 */
export const PASSWORD_FACTOR_METHODS = [
  'passkey',
  'authenticator',
] as const satisfies readonly PasswordFactorMethod[];

/** Which proof field each method names. The resolver reads this and nothing else. */
export const PROOF_FIELD_BY_FACTOR = {
  passkey: 'passkey',
  authenticator: 'totpCode',
} as const satisfies Readonly<Record<PasswordFactorMethod, keyof PasswordFactorProofs>>;

export type PasswordProofField = (typeof PROOF_FIELD_BY_FACTOR)[PasswordFactorMethod];

/** In the order errors should mention them. */
export const PASSWORD_PROOF_FIELDS = PASSWORD_FACTOR_METHODS.map(
  (method) => PROOF_FIELD_BY_FACTOR[method],
) as readonly PasswordProofField[];

/**
 * The optional factor proofs a `forgot` request may carry.
 *
 * Both optional in the shape, because whether either is REQUIRED is a fact about the
 * account that the wire schema cannot see. The DTO enforces "at most one" — an
 * ambiguity rule, which is a shape question — and the service enforces "at least one
 * when a factor exists", which is not. That division is the whole reason the frontend
 * cannot bypass the requirement: the only place the answer is computed is against
 * `MfaService.availableMethods`, and no field in this interface can influence it.
 */
export interface PasswordFactorProofs {
  readonly totpCode?: string;
  /** A WebAuthn assertion against the challenge `reauthChallenge` minted. */
  readonly passkey?: AuthenticationResponseJSON;
}

// ─── the account facts every policy question is a function of ───────────────

/**
 * A snapshot of the account, read once per request.
 *
 * The same arrangement, and the same reason, as `PaymentPinAccount` and
 * `AccountFactors`: it keeps the availability engine synchronous and testable, and
 * stops one status render from asking the same question twice.
 *
 * `passwordSet` is derived from the presence of a live `PASSWORD` credential row and
 * from nothing else. There is no `User.passwordSet` column to disagree with it — the
 * flag of that name in the registration payload is computed the same way.
 */
export interface PasswordAccount {
  readonly passwordSet: boolean;
  readonly passkeyEnabled: boolean;
  readonly totpEnrolled: boolean;
}

/** Whether this account has any factor that `forgot` must demand. CONFIRMED
 *  credentials only — `MfaService.availableMethods` is the arbiter, so an abandoned
 *  enrollment never makes a user prove something they cannot. */
export function hasEnabledFactor(account: PasswordAccount): boolean {
  return account.passkeyEnabled || account.totpEnrolled;
}

// ─── what the setting screen is told ────────────────────────────────────────

/**
 * One operation's availability, as the client renders it.
 *
 * `available: false` carries a `reason` for `PaymentPinOperationStatus`'s reason: a
 * greyed-out control with no explanation is what a support ticket is about. Every
 * reason describes the caller's own account and leaks nothing — reaching this needs
 * that account's session.
 */
export interface PasswordOperationStatus {
  readonly available: boolean;
  /** Present only when unavailable. A short, user-facing sentence from
   *  `PASSWORD_UNAVAILABLE`. */
  readonly reason?: string;
}

/**
 * `forgot` additionally reports which factors it will demand.
 *
 * `factorRequired` is the field that makes the client simple: it asks one question
 * and renders either "email code + new password" or "email code + new password +
 * your passkey", without ever deciding the rule itself. `methods` is empty exactly
 * when `factorRequired` is false.
 */
export interface PasswordForgotStatus extends PasswordOperationStatus {
  readonly factorRequired: boolean;
  readonly methods: readonly PasswordFactorMethod[];
}

/**
 * What the password setting screen renders.
 *
 * One question, one answer. The client never works out whether a password exists,
 * whether a passkey is enrolled, or which operation is legal — all three are policy,
 * decided here, and a client that re-derived them would be a second copy of
 * `password.utility.ts` in TypeScript that nobody updates.
 *
 * ─── Why this does not report the remaining attempt budget ──────────────────
 *
 * `PaymentPinUpdateStatus` reports `remaining`, because "three PIN changes a day" is
 * a product frequency cap a user is entitled to see. `PASSWORD.UPDATE_BY_ACCOUNT` is
 * an anti-guessing bound, not a product allowance, and publishing how many attempts
 * are left tells a caller grinding the current password exactly when to pause.
 */
export interface PasswordStatus {
  /** Whether a password credential exists. */
  readonly passwordSet: boolean;
  readonly set: PasswordOperationStatus;
  readonly reset: PasswordOperationStatus;
  readonly forgot: PasswordForgotStatus;
}

/**
 * Why an operation is closed, as one sentence per cause.
 *
 * Hoisted to constants because two callers need the identical answer — the status
 * screen renders it and the pre-consumption check returns it as a refusal — and a
 * user shown two phrasings of one fact is being shown a seam. The same drift
 * `PAYMENT_PIN_UNAVAILABLE` and `UNAVAILABLE` were written to stop.
 */
export const PASSWORD_UNAVAILABLE = {
  ALREADY_SET: 'A password is already set on this account.',
  NOT_SET: 'No password is set on this account yet.',
  FACTOR_REQUIRED:
    'This account has an additional verification enabled. ' +
    'Confirm with your passkey or authenticator app to reset your password.',
  NO_TOTP: 'No authenticator app is set up on this account.',
  NO_PASSKEY: 'Biometric sign-in is not enabled on this account.',
} as const;
