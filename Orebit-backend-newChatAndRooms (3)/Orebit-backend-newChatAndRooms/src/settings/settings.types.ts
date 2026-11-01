import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

/**
 * Domain types for the user-settings surface.
 *
 * ─── What this module is, and what it deliberately does not own ─────────────
 *
 * `src/settings/` is where a signed-in user changes how their own account behaves.
 * It owns two surfaces — biometrics (passkey sign-in as a switch) and the
 * authenticator app — and the reason those live here rather than in `src/2fa/` is
 * that the two answer different questions. `src/2fa/` owns the MECHANISM: WebAuthn,
 * RFC 6238, the four tables, the sign-in ceremony. This module owns the PRODUCT
 * POLICY around those mechanisms: what a user must present to change the setting,
 * what else changes when they do, and what the setting screen is allowed to tell them.
 *
 * Keeping them apart is what stops `src/2fa/` from growing a second, policy-shaped
 * copy of itself. This module holds no crypto, no Prisma and no WebAuthn import; it
 * composes `TwoFactorService` and `SessionService`.
 *
 * ─── Why the two surfaces share one policy table ────────────────────────────
 *
 * Because they have the same policy. Turning off a passkey and turning off an
 * authenticator are both "remove the account's second factor of kind X", authorised
 * by the same four alternatives, with the same effects. The only thing that differs
 * is which of the four is the ORDINARY path — the one where the user still holds the
 * thing they are switching off — and that difference is a `DisableSubject`, not a
 * second table. A second table is how the two would drift.
 */

// ─── the four disable paths ─────────────────────────────────────────────────

/**
 * ═══ THE POLICY TABLE FOR DISABLING A SECOND FACTOR ═════════════════════════
 *
 * Any ONE of these turns the subject factor off. They are alternatives, not steps,
 * and the whole point of there being four is that losing one credential must not
 * strand a user with a setting they cannot change.
 *
 *  - `passkey+otp`  — re-verify with a passkey, plus an emailed code. The ordinary
 *                     path on the BIOMETRICS surface; the cross-factor path on the
 *                     authenticator surface, available only when a passkey exists.
 *  - `totp+otp`     — a TOTP code, plus an emailed code. The ordinary path on the
 *                     AUTHENTICATOR surface; on the biometrics surface it is offered
 *                     only when an authenticator is enrolled, because otherwise
 *                     there is nothing to prove.
 *  - `backup-code`  — a backup code, alone. Deliberately sufficient on its own: it
 *                     is the path for someone whose FACTOR IS GONE, and demanding a
 *                     mailbox round trip as well would re-close it for a user who
 *                     has lost the phone that holds both. Single-use, and spending
 *                     it is a CAS.
 *  - `kyc+otp`      — an emailed code plus a KYC image reverification. The last
 *                     resort, for a user who has lost every credential but can still
 *                     prove they are the person on the account's KYC record. Capped
 *                     hard rather than rate-limited — see `SECURITY_SETTINGS` in
 *                     auth/limits.ts.
 *
 * Note that `passkey+otp` and `totp+otp` swap roles between the two surfaces rather
 * than one being privileged: whichever factor is being removed is the ordinary way
 * to authorise removing it, and the other factor is the fallback.
 *
 * ─── Why these are enforced strictly ────────────────────────────────────────
 *
 * A caller names one path by which proofs they send, and only that path runs.
 * The generic `POST /auth/2fa { action: 'remove' }` was permissive by contrast — it
 * tried a passkey assertion, fell back to TOTP, and accepted whichever answered — so
 * on that route a TOTP code could delete a passkey and the four paths above would be
 * documentation rather than a rule. That action now refuses BOTH kinds and points
 * here; see `TwoFactorService.remove`. Strictness is also what makes the audit log
 * meaningful: "which path disabled this" has an answer.
 */
export type DisablePath = 'passkey+otp' | 'totp+otp' | 'backup-code' | 'kyc+otp';

/**
 * Every path, for iteration and for exhaustiveness tests.
 *
 * NOT the order a screen should offer them in — that depends on which factor is
 * being disabled, and is `disablePathsFor(subject)` below.
 */
export const DISABLE_PATHS = [
  'passkey+otp',
  'totp+otp',
  'backup-code',
  'kyc+otp',
] as const satisfies readonly DisablePath[];

/**
 * Does this path additionally require the emailed code?
 *
 * The one place that decides, and the shape mirrors
 * `TwoFactorService.emailCodeRequiredFor` next door so the two read as the same kind
 * of rule. `backup-code` is the single exception, for the reason given above.
 */
export function emailCodeRequiredForPath(path: DisablePath): boolean {
  return path !== 'backup-code';
}

// ─── which factor a screen is about ─────────────────────────────────────────

/** The factors `src/settings/` exposes as switches. */
export type FactorKindSetting = 'passkey' | 'totp';

/**
 * Which factor a settings screen is about.
 *
 * Three fields, because three things is all that differs between the two surfaces:
 * which factor is being removed, which of the four paths therefore counts as the
 * ordinary one, and what to say when the setting is already off. Everything else —
 * the paths, their availability rules, the order of consumption, the effects — is
 * shared, and lives in one implementation that takes this as an argument.
 *
 * Deliberately NOT a place to hang the write itself or the revoke reason. Those are
 * behaviour rather than description, they belong to the service that performs them,
 * and putting them here would turn a small descriptor into a strategy object whose
 * two instances are the only two callers.
 */
export interface DisableSubject {
  readonly kind: FactorKindSetting;
  /**
   * The path that proves the subject factor itself, and the one a screen offers
   * first. Available exactly when the setting is on, since it IS the setting.
   */
  readonly selfPath: DisablePath;
  /**
   * Why no path is offered at all when the setting is already off — a screen where
   * the switch cannot move should say so rather than render four live options.
   */
  readonly offReason: string;
}

export const PASSKEY_SUBJECT: DisableSubject = {
  kind: 'passkey',
  selfPath: 'passkey+otp',
  offReason: 'Biometric sign-in is not enabled on this account.',
};

export const AUTHENTICATOR_SUBJECT: DisableSubject = {
  kind: 'totp',
  selfPath: 'totp+otp',
  offReason: 'No authenticator app is set up on this account.',
};

/**
 * The paths for this subject, in the order the setting screen should offer them.
 *
 * Self path first — the user disabling a factor usually still holds it, so the
 * ordinary path should not be third in a list. Then the other factor, then the
 * backup code, then the last resort. `DISABLE_PATHS` cannot express this because the
 * order is not a property of the paths; it is a property of the subject.
 */
export function disablePathsFor(subject: DisableSubject): readonly DisablePath[] {
  const rest = DISABLE_PATHS.filter((path) => path !== subject.selfPath);
  return [subject.selfPath, ...rest];
}

/**
 * Why a path is closed on this account, as one sentence per cause.
 *
 * Hoisted to constants because two callers need the identical answer:
 * `pathStatus` renders it on the setting screen and `assertPathAvailable` returns it
 * as a refusal, and a user told "No unused backup codes remain." by one and "No
 * unused backup codes remain on this account." by the other is being shown a seam.
 * Those two strings had already drifted apart when this was two copies.
 *
 * None of these leaks anything: every one describes the caller's own account.
 */
export const UNAVAILABLE = {
  NO_PASSKEY: 'Biometric sign-in is not enabled on this account.',
  NO_TOTP: 'No authenticator app is set up on this account.',
  NO_BACKUP_CODES: 'No unused backup codes remain on this account.',
  NO_KYC: 'Identity verification has not been completed on this account.',
} as const;

/** The proofs a caller may present. Exactly one path's worth — see `resolveDisablePath`. */
export interface DisableProofs {
  /** The emailed code, required by every path except `backup-code`. */
  readonly emailCode?: string;
  /** A WebAuthn assertion against the challenge `reauthChallenge` minted. */
  readonly passkey?: AuthenticationResponseJSON;
  readonly totpCode?: string;
  readonly backupCode?: string;
  readonly kyc?: KycEvidence;
}

/**
 * Which proof field names a path. The resolver reads this and nothing else, so
 * adding a path is one row here plus one row in the union above.
 */
export const PATH_BY_PROOF_FIELD = {
  passkey: 'passkey+otp',
  totpCode: 'totp+otp',
  backupCode: 'backup-code',
  kyc: 'kyc+otp',
} as const satisfies Readonly<Record<string, DisablePath>>;

export type ProofField = keyof typeof PATH_BY_PROOF_FIELD;

// ─── the KYC port ───────────────────────────────────────────────────────────

/**
 * What the user submits for an image reverification.
 *
 * Opaque on purpose. Whichever provider eventually backs this owns the format — a
 * signed session handle from a hosted flow, a base64 selfie, a document reference —
 * and mirroring one provider's shape here would have to be rewritten for the next.
 * Bounded as a string by the DTO, and interpreted only by the implementation.
 */
export interface KycEvidence {
  /** The provider-specific handle or payload identifying this reverification. */
  readonly reference: string;
}

/**
 * The KYC port.
 *
 * ─── Why this is a port with a null implementation ──────────────────────────
 *
 * There is no KYC anywhere in this service yet: no status on `User`, no upload
 * surface, no provider. The `kyc+otp` path is nonetheless built, tested and wired,
 * because the alternative — leaving one of four documented paths out — means
 * retrofitting a branch into the policy table later, and the policy table is exactly
 * the thing that should not grow branches after the fact.
 *
 * So the shape ships and the capability does not. `NullKycProvider` reports every
 * account unverified, which makes `isVerified` the single gate: `GET` never offers
 * the path, and `disable` refuses it. No fabricated KYC state exists anywhere.
 *
 * Same arrangement as `GeoResolver`/`NullGeoResolver` in src/geo, for the same
 * reason. When a real provider lands it becomes its own module and only the binding
 * in settings.module.ts changes.
 */
export interface KycStatusPort {
  /**
   * Has this account completed KYC?
   *
   * Never throws — a provider outage must read as "this path is unavailable right
   * now", not as a failure of the setting screen, because three other paths still
   * work and the screen has to render.
   */
  isVerified(userId: string): Promise<boolean>;

  /**
   * Check a submitted image against the account's KYC record.
   *
   * Returns `false` for a genuine mismatch. THROWS for a provider failure, and the
   * distinction is load-bearing: a mismatch is the user's answer and costs them one
   * of their few attempts, whereas an outage is not their fault and the quota is
   * refunded. See `SettingsService.proveKyc`.
   */
  reverify(userId: string, evidence: KycEvidence): Promise<boolean>;
}

export const KYC_PORT = Symbol('KYC_PORT');

// ─── what the setting screen is told ────────────────────────────────────────

/**
 * One disable path's availability, as the client renders it.
 *
 * `available: false` carries a `reason` because a greyed-out option with no
 * explanation is the thing a support ticket is about. These reasons describe the
 * ACCOUNT's state — which factors exist, whether KYC is done — and none of them
 * leaks anything the caller does not already know about their own account.
 */
export interface DisablePathStatus {
  readonly path: DisablePath;
  readonly available: boolean;
  /** Present only when unavailable. A short, user-facing sentence from `UNAVAILABLE`. */
  readonly reason?: string;
  /** Whether this path also needs an emailed code. Constant per path, sent so the
   *  client does not hard-code the table. */
  readonly emailCodeRequired: boolean;
}

/**
 * What one factor's setting screen renders.
 *
 * One shape for both surfaces, with `factorCount`/`remainingSlots` reading as "how
 * many of this factor are enrolled" and "how many more may be". For passkeys that is
 * up to `policy().MFA.PASSKEYS_PER_ACCOUNT`; for the authenticator it is one, because
 * `TwoFactorService.totpAdd` enforces one per account as a product rule.
 */
export interface FactorSettingStatus {
  /** Which factor this describes, so a client rendering both can tell them apart. */
  readonly factor: FactorKindSetting;
  /** Whether the setting is on — i.e. at least one live, CONFIRMED credential exists. */
  readonly enabled: boolean;
  readonly factorCount: number;
  readonly remainingSlots: number;
  readonly backupCodesRemaining: number;
  /** In the order the screen should offer them — see `disablePathsFor`. */
  readonly disablePaths: readonly DisablePathStatus[];
}

/**
 * The account's factor inventory, read once and asked four questions.
 *
 * A snapshot rather than four awaits inside the availability engine: every path's
 * availability is a pure function of these four facts, so reading them together keeps
 * the engine synchronous and testable, and stops a status render from issuing the
 * same query twice for two different paths.
 */
export interface AccountFactors {
  readonly passkeyEnabled: boolean;
  readonly totpEnrolled: boolean;
  readonly backupCodesRemaining: number;
  readonly kycVerified: boolean;
}
