import type { OauthProvider } from '@prisma/client';
import type { ElevationAction } from '../../2fa/elevation';

/**
 * Domain types for Settings → Social accounts.
 *
 * ─── What this module is, and what it deliberately does not own ─────────────
 *
 * `src/settings/link-accounts/` is where a signed-in user attaches a social provider
 * to the account they already have, so they can sign in with it later. It owns the
 * PRODUCT POLICY around that: what a user must present before the ceremony starts,
 * which providers a screen may offer, and what the screen is allowed to say about a
 * link that already exists.
 *
 * It owns no OAuth. The provider round trip, the single-use `state`, the PKCE
 * verifier, the nonce, the identity verification and the link write all live in
 * `auth/services/oauth.service.ts`, reached through `startLink` / `completeLink`.
 * This module holds no crypto, no Prisma and no WebAuthn import — the same
 * constraint `SettingsService` keeps against `src/2fa/`.
 *
 * It owns no second factor either. `TwoFactorService` exposes exactly the narrow
 * provers this needs — `provePasskeyAssertion` and `proveTotpCode` are public
 * precisely so a settings surface can insist on ONE named factor rather than "any
 * factor the account has" — and `consumeCredentialOtp` is public for the same
 * reason. Composing them is what `SettingsService.disable` already does.
 *
 * ─── Unlinking, and why it is not a delete ──────────────────────────────────
 *
 * `POST …/social-accounts/unlink` does not remove anything. It stamps a deadline
 * seven days out and emails the owner, and the link stays live and usable for
 * sign-in for the whole period — see `SOCIAL_UNLINK.DELAY_DAYS`. `OauthLink.deletedAt`
 * is written later, by `SocialUnlinkSweeper`, and never by a request.
 *
 * That is why the request path owes no session sweep and no `clearRecoveryCodes`-style
 * tidying: nothing has been taken away yet, so there is no state to reconcile.
 */

// ─── the verification policy ────────────────────────────────────────────────

/**
 * The ticket a link ceremony is started with.
 *
 * Written once, here, because three places name it — the route's
 * `@RequiresElevation`, the service's `elevation.issue`, and the challenge that
 * tells a client which methods will be accepted — and a typo in any of them would be
 * a ticket that silently never matches.
 *
 * NOT `account.oauth.link`. That action belongs to `POST /auth/link`, whose proof
 * policy is different in both directions: it demands no emailed code, and it falls
 * back to the account password when nothing is enrolled. See the note on the union
 * in `src/2fa/elevation.ts`.
 */
export const LINK_ELEVATION_ACTION: ElevationAction = 'account.social.link';

/**
 * The ticket an unlink request is spent against.
 *
 * Its own action, and that is the entire authorization isolation: `ElevationService.spend`
 * refuses a grant whose action is not the one the route names, so a ticket proved for
 * the link cannot schedule an unlink and vice versa. Both are earned from the SAME
 * `/verify` route under the same proof policy — the client says which it wants — so the
 * separation costs one enum member and no second ceremony.
 */
export const UNLINK_ELEVATION_ACTION: ElevationAction = 'account.social.unlink';

/**
 * ═══ THE PROOF POLICY FOR ATTACHING A PROVIDER ══════════════════════════════
 *
 * An emailed code, ALWAYS, plus one enrolled factor when the account has one:
 *
 *   authenticator only  →  email code + TOTP
 *   passkey only        →  email code + passkey assertion
 *   both                →  email code + EITHER, the caller's choice
 *   neither             →  email code alone
 *
 * ─── Why "either" rather than a preferred factor ───────────────────────────
 *
 * Because the question a re-proof answers is "is the person at the keyboard still
 * the account holder", and any enrolled factor answers it. The caller names which
 * one by which field they send, and sending neither is a refusal rather than a
 * fallback — see `resolveLinkProof`.
 *
 * ─── Why the emailed code alone is enough when nothing is enrolled ─────────
 *
 * Because demanding more than an account possesses is a lockout rather than a
 * defence. The alternative — the account password, which is what `reauthVerify`
 * does — is not available to every account here: an account created through a
 * provider has no credential row at all, so that path would make linking a second
 * provider impossible for exactly the users most likely to want it.
 *
 * What remains is still two things: a live session and the mailbox. That is the
 * same posture `SettingsService` documents for ENABLING a factor through this
 * module, which also costs the emailed code and nothing else, and it is bounded by
 * `CREDENTIAL.OTP_BY_ACCOUNT` and `MFA.REAUTH_FAIL_BY_SESSION`.
 *
 * ─── Why a recovery code is never accepted ─────────────────────────────────
 *
 * A printed sheet may take a lost factor OFF an account and must never attach a
 * credential to one, or "I found your printout" and "I own this account" become the
 * same event. `TwoFactorService.recoveryCodeAllowedFor` draws the same line for
 * every intent except removal; this module simply has no field to put one in.
 */
export type LinkProofMethod = 'totp' | 'passkey' | 'none';

/** The proofs a caller may present alongside the emailed code. */
export interface LinkProofs {
  readonly totpCode?: string;
  readonly passkey?: unknown;
}

// ─── what the screen renders ────────────────────────────────────────────────

/**
 * One linked provider, as the settings screen shows it.
 *
 * ─── What is deliberately absent ───────────────────────────────────────────
 *
 * `subject`. It is the provider's own identifier for the person, it authorises
 * nothing on its own, the screen has no use for it, and a client that echoed it into
 * a DOM attribute would be the first place it leaked. `LinkPreviewPayload` withholds
 * it for the same reason.
 *
 * Every other field is nullable because the providers genuinely differ, and the
 * nulls are load-bearing rather than defensive: Apple publishes no display name and
 * no avatar, X and Telegram never supply an address, and Facebook withholds one when
 * the user declines the scope. A screen renders what it has.
 */
export interface LinkedSocialAccount {
  readonly provider: OauthProvider;
  /** The provider's display name at link time. Null for Apple, and for links made
   *  before the column existed — fall back to `email`, then the provider name. */
  readonly displayName: string | null;
  readonly email: string | null;
  readonly emailVerifiedByProvider: boolean;
  readonly imageUrl: string | null;
  readonly linkedAt: string;
  readonly lastLoginAt: string | null;
  /**
   * When this link is scheduled to be removed, or null if it is not.
   *
   * Non-null is the WHOLE of "an unlink is pending" — there is no companion boolean,
   * because two fields that encode one fact are two fields that can disagree.
   *
   * The account is still fully linked while this is set: it appears in `accounts`, it
   * signs the owner in, and the provider stays OUT of `availableProviders` because the
   * slot is still occupied. A client that wants to offer the way back — re-linking this
   * same provider account cancels the removal — drives that from this field, not from
   * `availableProviders`.
   */
  readonly unlinkAt: string | null;
}

/** The whole screen, in one read. */
export interface SocialAccountsStatus {
  readonly accounts: readonly LinkedSocialAccount[];
  /**
   * Providers this deployment offers AND this account has not linked.
   *
   * Both halves matter. Configuration decides which providers are offered at all —
   * staging can hold Apple credentials and production not — and the one-per-provider
   * rule decides which of those are still free. A client that filtered on only one
   * would offer a button that cannot work.
   */
  readonly availableProviders: readonly OauthProvider[];
}

/**
 * Why a ceremony was refused, as one sentence per cause.
 *
 * Hoisted so the two callers that need each string cannot phrase one fact two ways —
 * the same argument `UNAVAILABLE` in settings.types.ts makes. None of these leaks
 * anything: every one describes the caller's own account.
 */
export const LINK_ACCOUNTS_UNAVAILABLE = {
  NO_PROOF: 'Send the code from your authenticator app, or a passkey assertion.',
  TOTP_NOT_ENROLLED: 'No authenticator app is set up on this account.',
  PASSKEY_NOT_ENROLLED: 'Biometric sign-in is not enabled on this account.',
  TOO_MANY_PROOFS: 'Send exactly one factor: an authenticator code or a passkey.',
} as const;
