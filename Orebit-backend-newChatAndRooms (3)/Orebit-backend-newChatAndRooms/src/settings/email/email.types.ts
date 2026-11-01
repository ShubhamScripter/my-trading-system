import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { KycEvidence } from '../settings.types';

/**
 * Domain types for changing the account's email address.
 *
 * ─── Why this is the hardest surface in src/settings/ ───────────────────────
 *
 * The two factor screens and the Payment PIN all change something the account OWNS. This
 * changes what the account IS. The address is the primary identifier, one of the two
 * sign-in credentials, and the recovery path for the other — so a change here reaches
 * registration (the old address must not be re-registered while its owner might want it
 * back) and the session table (a session may have been established by proving the
 * mailbox that no longer belongs to this account).
 *
 * It also creates a takeover that no other setting does: whoever changes the address
 * away from its owner takes the account with it. The recovery flow below is the answer,
 * and it is a first-class part of the feature rather than a courtesy.
 *
 * ─── What this module owns and what it borrows ──────────────────────────────
 *
 * Owns: the policy — which proofs are required, what a released address may still do,
 * how often the identifier may move. Borrows everything that performs a proof:
 * `TwoFactorService` for the emailed codes, the authenticator and the passkey,
 * `CredentialService` for the password, `KycStatusPort` for reverification. No crypto,
 * no WebAuthn, no argon2 import belongs here.
 */

// ─── the security factor ────────────────────────────────────────────────────

/**
 * ═══ THE POLICY TABLE FOR AUTHORISING A CHANGE ══════════════════════════════
 *
 * Two emailed codes are required on every path — one to the address the account holds
 * now, one to the address being claimed — and this names the THIRD proof that goes with
 * them.
 *
 *  - `authenticator` — a TOTP code.
 *  - `passkey`       — a WebAuthn assertion.
 *  - `kyc`           — an identity reverification.
 *  - `password`      — the account's password. The FALLBACK, offered only when none of
 *                      the three above is available, because it is the weakest of the
 *                      four and would otherwise be chosen by clients as the easiest.
 *  - `none`          — no third proof. Only for an account that has no factor, no KYC
 *                      and no password, where demanding one would be a permanent
 *                      lockout rather than a defence.
 *
 * ─── Why `authenticator` and `passkey` rather than one `2fa` ────────────────
 *
 * Because they are separate mechanisms with separate enrollment state, and a client told
 * "2fa is available" cannot render the right prompt: one needs six digits typed from a
 * phone, the other needs `navigator.credentials.get()`. The same reason `DisablePath`
 * and the Payment PIN methods spell them out separately, and the terminology this
 * codebase uses throughout.
 *
 * ─── Why the weakest tiers are reachable at all ─────────────────────────────
 *
 * `password` and `none` look like holes and are the opposite. An account with no factor
 * and no password exists — signup can skip the password, and a provider signup never
 * sets one — and for that account the two emailed codes ARE the strongest proof
 * obtainable. Refusing the change would not make it safer; it would strand a user on an
 * address they may have lost access to, with no way to move.
 */
export type EmailChangeMethod = 'authenticator' | 'passkey' | 'kyc' | 'password' | 'none';

/**
 * Every method, strongest first.
 *
 * The order is the offer order AND the fallback order: `methodsFor` walks it and stops
 * at the first tier that is available, so a client is never offered the password when a
 * passkey exists. That is what makes the fallback a fallback rather than a choice.
 */
export const EMAIL_CHANGE_METHODS = [
  'authenticator',
  'passkey',
  'kyc',
  'password',
  'none',
] as const satisfies readonly EmailChangeMethod[];

export function isEmailChangeMethod(value: string): value is EmailChangeMethod {
  return (EMAIL_CHANGE_METHODS as readonly string[]).includes(value);
}

/** The methods that stand in for a retained address whose mailbox is unreachable. */
export const STRONG_METHODS = [
  'authenticator',
  'passkey',
  'kyc',
] as const satisfies readonly EmailChangeMethod[];

/**
 * May this method substitute for a still-retained address's emailed code?
 *
 * `password` and `none` deliberately cannot. The escape exists for the user who changed
 * away from a compromised mailbox and can no longer read it — and on an account whose
 * only proof is a password, an attacker who has the password would otherwise be able to
 * shed the very record that lets the real owner recover.
 */
export function canSkipRetained(method: EmailChangeMethod): boolean {
  return (STRONG_METHODS as readonly EmailChangeMethod[]).includes(method);
}

// ─── which mailboxes must answer ────────────────────────────────────────────

/**
 * The three roles an emailed code can play in one change.
 *
 * One role per `ChallengePurpose`, and that mapping is forced: `ux_challenges_live` is
 * unique on `(user_id, purpose)` among unconsumed rows, and `issue` supersedes the live
 * row for the pair before inserting — so two codes sharing a purpose is the first one
 * silently dying, not an error. Three roles therefore need three purposes.
 */
export type EmailProofTarget = 'current' | 'new' | 'retained';

export const PURPOSE_BY_TARGET = {
  current: 'EMAIL_CHANGE_CURRENT',
  new: 'EMAIL_CHANGE_NEW',
  retained: 'EMAIL_CHANGE_RETAINED',
} as const;

export type EmailProofPurpose = (typeof PURPOSE_BY_TARGET)[EmailProofTarget];

export function isEmailProofTarget(value: string): value is EmailProofTarget {
  return value === 'current' || value === 'new' || value === 'retained';
}

// ─── what an in-flight change records ───────────────────────────────────────

/**
 * The server's record of a change the user has started.
 *
 * ─── Why every field is here rather than in the request ────────────────────
 *
 * `newEmail`, so a caller cannot present a challenge minted for one address and complete
 * it against another. That substitution is the attack this shape exists to prevent: the
 * final mutation reads the address from HERE and never from the body.
 *
 * `method`, so the tier cannot be downgraded after the fact — a change started against a
 * passkey cannot be finished with a password.
 *
 * `userId` and `familyId`, so a challenge lifted from a log cannot be spent by another
 * account or from an unrelated login. `familyId` rather than `sessionId` because that is
 * constant across token rotation and this challenge lives half an hour; see
 * `KEYS.paymentPin.challenge` for the same argument at five minutes.
 *
 * `requiredTargets`, so the set of mailboxes that must answer is fixed when the codes are
 * sent rather than recomputed at verify time — otherwise a retention expiring mid-flow
 * would quietly drop a proof the ceremony had already demanded.
 */
export interface EmailChangeGrant {
  /** Compared with `safeEqual` against what the client presents. The Redis key is the
   *  user id, so this is what actually identifies the ceremony. */
  readonly challengeId: string;
  readonly userId: string;
  readonly familyId: string;
  /** As typed, for display in notifications. */
  readonly newEmail: string;
  /** Normalised. The value the mutation writes and every lookup matches. */
  readonly newEmailLower: string;
  readonly method: EmailChangeMethod;
  readonly requiredTargets: readonly EmailProofTarget[];
  /** The still-retained address that must also answer, normalised. Null when none is
   *  live, or when the caller took the escape. */
  readonly retainedEmailLower: string | null;
  /** The caller declared the retained mailbox unreachable and is standing on a strong
   *  factor instead. Completing the change expires that retention. */
  readonly skippedRetained: boolean;
}

// ─── the proofs a caller presents ───────────────────────────────────────────

/** Every proof field. Which one is legal is decided by the declared `method`. */
export interface EmailChangeProofs {
  readonly totpCode?: string;
  readonly passkey?: AuthenticationResponseJSON;
  readonly kyc?: KycEvidence;
  readonly password?: string;
}

/** Which proof field each method names. The resolver reads this and nothing else, so
 *  adding a tier is one row here plus one row in the union above. */
export const PROOF_FIELD_BY_METHOD = {
  authenticator: 'totpCode',
  passkey: 'passkey',
  kyc: 'kyc',
  password: 'password',
} as const satisfies Readonly<Record<string, keyof EmailChangeProofs>>;

export type EmailChangeProofField =
  (typeof PROOF_FIELD_BY_METHOD)[keyof typeof PROOF_FIELD_BY_METHOD];

export const EMAIL_CHANGE_PROOF_FIELDS = [
  'totpCode',
  'passkey',
  'kyc',
  'password',
] as const satisfies readonly EmailChangeProofField[];

// ─── recovery ───────────────────────────────────────────────────────────────

/**
 * What the holder of a released address may do with the ticket mailed to them.
 *
 *  - `restore` — put the account back on this address and drop the one that replaced it.
 *    Serves both "no, this wasn't me" and "yes, but I want to go back": the mutation is
 *    identical and only the notification differs, because the account state they are
 *    asking for is the same state.
 *  - `replace` — move the account to a third address instead. For the user who did make
 *    the change, then realised they typed it wrong.
 *
 * There is deliberately no third option. Every operation here can only ever point the
 * account at an address the ticket-holder has proved they control in the same request,
 * which is what keeps a recovery from being an escalation.
 */
export type RecoveryIntent = 'restore' | 'replace';

export function isRecoveryIntent(value: string): value is RecoveryIntent {
  return value === 'restore' || value === 'replace';
}

/** The server's record of a recovery the holder of a released address has started. */
export interface EmailRecoveryGrant {
  readonly challengeId: string;
  /** The `retained_emails` row this ticket belongs to. The subject of the per-account
   *  rate limit, since there is no session to key on. */
  readonly retainedEmailId: string;
  readonly userId: string;
  readonly intent: RecoveryIntent;
  /** The address being recovered TO — the retained address itself for `restore`, the
   *  third address for `replace`. Normalised. */
  readonly targetEmailLower: string;
  readonly targetEmail: string;
  /** Whether the holder said the previous change was not theirs. Changes the wording of
   *  the notifications and raises the log level; the mutation is the same. */
  readonly reportedCompromise: boolean;
}

// ─── what the setting screen is told ────────────────────────────────────────

/** One live retention, as the client renders it. */
export interface RetainedEmailStatus {
  readonly active: boolean;
  /** Masked. A client showing this to a signed-in user does not need the full address,
   *  and a screenshot should not carry one. */
  readonly email?: string;
  readonly expiresAt?: string;
  /** Whether this address must also answer the next change. False once the retention
   *  has lapsed. */
  readonly otpRequired?: boolean;
}

export interface EmailChangeAvailability {
  readonly available: boolean;
  /** Present only when unavailable. A short sentence written for a person. */
  readonly reason?: string;
  /**
   * The tiers this account could use, strongest first.
   *
   * Usually one entry: `methodsFor` stops at the strongest available tier, so the
   * password is not offered to an account that has a passkey. A client renders the list
   * rather than choosing, and the server re-checks whatever comes back.
   */
  readonly securityMethods: readonly EmailChangeMethod[];
  /** False only for the `none` tier, so a client knows whether to render a proof step
   *  at all rather than inferring it from an empty list. */
  readonly securityRequired: boolean;
  /** Changes left in the current window. Advisory — read without charging. */
  readonly remaining: number;
}

/** An in-flight change, for a client that reloaded the page mid-ceremony. */
export interface PendingChangeStatus {
  readonly active: boolean;
  readonly newEmail?: string;
  readonly method?: EmailChangeMethod;
  readonly requiredTargets?: readonly EmailProofTarget[];
}

/**
 * What the email setting screen renders.
 *
 * One question, and the client never has to work out whether the account has an
 * authenticator, whether KYC is configured, whether a password exists, or which
 * combination of those makes a change legal. Every one of those is policy, decided here.
 */
export interface EmailChangeStatus {
  /** Masked. The full address is already on `GET /auth/me`; there is no reason for a
   *  second copy of it here, and masking is what a settings screen should show. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly change: EmailChangeAvailability;
  readonly pending: PendingChangeStatus;
  readonly retainedEmail: RetainedEmailStatus;
  /** Whether a recovery ticket for the retained address is still spendable. Reported so
   *  a signed-in user can be told "you can still go back", not as authorisation — the
   *  ticket itself is what authorises, and it is only ever in the mailbox. */
  readonly recovery: { readonly available: boolean; readonly expiresAt?: string };
}

/**
 * The account facts every policy question here is a pure function of.
 *
 * A snapshot rather than repeated awaits inside the availability engine — the
 * arrangement `AccountFactors` uses next door, and for the same reason: it keeps the
 * engine synchronous and testable, and stops one status render asking the same question
 * twice.
 */
export interface EmailChangeAccount {
  readonly passkeyEnabled: boolean;
  readonly totpEnrolled: boolean;
  readonly kycVerified: boolean;
  readonly hasPassword: boolean;
}

/**
 * Why something is closed, as one sentence per cause.
 *
 * Hoisted because two callers need the identical answer — the status screen renders it
 * and the pre-consumption check returns it as a refusal — and a user shown two phrasings
 * of one fact is being shown a seam. The drift `UNAVAILABLE` in settings.types.ts was
 * written to stop.
 */
export const EMAIL_CHANGE_UNAVAILABLE = {
  SAME_ADDRESS: 'That is already the email address on this account.',
  NO_TOTP: 'No authenticator app is set up on this account.',
  NO_PASSKEY: 'Biometric sign-in is not enabled on this account.',
  NO_KYC: 'Identity verification has not been completed on this account.',
  NO_PASSWORD: 'This account has no password.',
  RETAINED_UNREACHABLE:
    'Your previous email address is still linked to this account and must confirm the change. ' +
    'To change without it, set up an authenticator app or biometric sign-in first.',
  TOO_MANY_RETAINED:
    'This account has more previous email addresses on hold than a change can verify. ' +
    'Please contact support.',
} as const;
