import type { ElevationAction } from '../../2fa/elevation';

/**
 * Domain types for Settings → Delete account.
 *
 * ─── What this module is, and what it deliberately does not own ─────────────
 *
 * `src/settings/delete-account/` is where an owner ends their own account. It owns the
 * PRODUCT POLICY around that: what must be proved first, how long the account stays
 * recoverable, what the screen may say about the state, and what a purge destroys.
 *
 * It owns no mechanism. The proof comes from `TwoFactorService`'s narrow provers and
 * `ElevationService`; the session sweep is `SessionService.revokeAllForUser`; every
 * row it writes belongs to `UserDbOperation`. This module holds no Prisma import, no
 * crypto and no WebAuthn — the same constraint `LinkAccountsService` keeps.
 *
 * ═══ DELETED IS NOT HARD DELETED ════════════════════════════════════════════
 *
 * Two states, and only one of them has a row:
 *
 *     DELETED          status=DELETED, deletedAt NULL, purgeAt in the future.
 *     (locked,         The account is locked: every authentication path refuses it and
 *      recoverable)    every session it had is revoked. Nothing has been destroyed.
 *                      The row still HOLDS its email and username, because the partial
 *                      unique indexes are scoped `WHERE deleted_at IS NULL` — and that
 *                      reservation is the only reason reactivation can be promised.
 *
 *     HARD DELETED     There is no row. `AccountPurgeSweeper` issues a real DELETE at
 *                      the deadline, which cascades to every child table; the two
 *                      records a foreign key cannot reach are scrubbed first. There is
 *                      no tombstone and no terminal status — the ABSENCE of the row is
 *                      the state. Reactivation is impossible rather than refused, the
 *                      credentials are gone rather than disabled, and the identifiers
 *                      are free because nothing holds them.
 *
 * A surviving row with `deletedAt` set is NOT the purged state and never appears: that
 * column is written only transiently, inside the purge transaction, as the claim that
 * locks the row before deleting it.
 *
 * ─── Deleting is immediate in effect and delayed in destruction ─────────────
 *
 * This is the one thing that differs from the delayed social unlink, which this
 * feature otherwise copies. An unlink leaves the link FULLY LIVE for its seven days,
 * because nothing has been taken away yet and the delay is a notice period. A deletion
 * takes effect at once — `status` moves and every session is revoked in the same
 * request — because an owner who asks for their account to stop working is entitled to
 * have it stop working. What waits is the destruction of the data, not the loss of
 * access.
 *
 * The consequence is worth stating: a deletion nobody asked for locks the real owner
 * out immediately. That is why the ceremony demands an emailed code on every path, and
 * why the window is thirty days rather than seven.
 */

// ─── the verification policy ────────────────────────────────────────────────

/**
 * The ticket a deletion is spent against.
 *
 * Written once, here, because three places name it — the route's
 * `@RequiresElevation`, the service's `elevation.issue`, and the challenge that tells
 * a client which methods will be accepted. A typo in any of them is a ticket that
 * silently never matches.
 *
 * Its own action rather than reusing `account.mfa.remove`, which is the nearest thing
 * by blast radius: `ElevationService.spend` compares the action, so this constant is
 * the whole of the isolation between "remove a factor" and "end the account".
 */
export const DELETE_ELEVATION_ACTION: ElevationAction = 'account.delete';

/**
 * Why a ceremony was refused, as one sentence per cause.
 *
 * Hoisted so callers cannot phrase one fact two ways — the argument
 * `LINK_ACCOUNTS_UNAVAILABLE` makes. None of these leaks anything: every one describes
 * the caller's own account.
 */
export const DELETE_ACCOUNT_UNAVAILABLE = {
  NO_PROOF: 'Send the code from your authenticator app, or a passkey assertion.',
  TOTP_NOT_ENROLLED: 'No authenticator app is set up on this account.',
  PASSKEY_NOT_ENROLLED: 'Biometric sign-in is not enabled on this account.',
  TOO_MANY_PROOFS: 'Send exactly one factor: an authenticator code or a passkey.',
} as const;

// ─── the withdrawal boundary ────────────────────────────────────────────────

/**
 * What a withdrawal subsystem says about one account's funds.
 *
 * ═══ WHY THIS IS NOT A BOOLEAN ══════════════════════════════════════════════
 *
 * Because `false` would have to mean two different things: "a provider looked and the
 * balance is empty" and "there is no provider". Those are not interchangeable. The
 * first is a fact about the user; the second is a fact about this deployment, and
 * reporting it as the first would have the delete screen telling somebody it is safe
 * to destroy an account that might hold money.
 *
 * No withdrawal subsystem exists in this repository — `src/wallet/` and `src/ledger/`
 * are zero-byte placeholders — so `unavailable` is the only state ever returned today.
 * See withdrawals.service.ts.
 */
export type PendingWithdrawalsState =
  /**
   * No withdrawal subsystem is bound.
   *
   * NOT a statement about this user's funds, and must never be rendered or logged as
   * one. Does not block a deletion.
   */
  | { readonly state: 'unavailable' }
  /** A real provider looked and found nothing withdrawable. */
  | { readonly state: 'none' }
  /** A real provider found funds the owner should be prompted about before deleting. */
  | { readonly state: 'pending' };

/**
 * The seam the future Withdraw Funds API plugs into.
 *
 * One method, deliberately: this feature needs to know whether to PROMPT, and nothing
 * else. It does not need a balance, a currency, an address or a way to move money, and
 * giving it any of those would be building the withdrawal system by increments inside
 * the deletion feature. When the real API lands it implements this and rebinds the
 * token; nothing in `DeleteAccountService` changes.
 */
export interface PendingWithdrawalsPort {
  /** Never throws — the contract `KycStatusPort.isVerified` sets. */
  check(userId: string): Promise<PendingWithdrawalsState>;
}

export const PENDING_WITHDRAWALS_PORT = Symbol('PENDING_WITHDRAWALS_PORT');

// ─── what the settings screen is told ───────────────────────────────────────

/**
 * The account's deletion state, as the client renders it.
 *
 * Only two values are reachable from an authenticated request: an account that is
 * `active`, or one that is `deleted` and inside its window. A purged account cannot
 * reach this route at all — it has no sessions and no longer resolves in any lookup.
 */
export type DeletionStatus = 'active' | 'deleted';
