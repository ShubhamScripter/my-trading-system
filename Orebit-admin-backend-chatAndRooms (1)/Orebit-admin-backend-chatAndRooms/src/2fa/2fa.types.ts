import type { AdminLoginAttempt, AdminLoginState, AdminMfaMethod } from '@prisma/client';
import { ERR } from '../contracts';
import { ProblemException } from '../http';

/**
 * Domain types for the ONE second-factor surface.
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * Every second factor in the product passes through `POST /2fa`. There are three
 * groups of actions and they differ in the credential they demand, which is the
 * entire reason the table below exists:
 *
 *  1. SIGN-IN — the caller is half-authenticated. `POST /auth/login` proved their
 *     password and their emailed code and stopped at `EMAIL_VERIFIED`; the
 *     `loginId` it returned carries them here, and proving a factor is what mints
 *     the session. These four actions moved verbatim off `/auth/login`.
 *  2. RE-AUTH — the caller is signed in and is proving a factor again in order to
 *     be allowed to write. Yields a single-use elevation ticket.
 *  3. MANAGEMENT — the caller is signed in AND has just re-proved a factor, and is
 *     changing which factors exist.
 *
 * ─── Why one route rather than three ────────────────────────────────────────
 *
 * The same four verbs (enroll, confirm, challenge, verify) appear in all three
 * groups against the same two tables. Split across routes, "what counts as a
 * confirmed factor" would have three answers. Here it has one, and the thing that
 * varies — who may ask — is a table a reviewer can read in one screen.
 */

export type FactorKind = AdminMfaMethod;

/** Every action on `POST /2fa`. */
export type TwoFactorAction =
  // ─── sign-in: step-up cookie, EMAIL_VERIFIED ───
  | 'totp-enroll'
  | 'totp-verify'
  | 'passkey-challenge'
  | 'passkey-verify'
  // ─── re-auth: a live session, proving a factor to earn a ticket ───
  | 'reauth-challenge'
  | 'reauth-verify'
  // ─── management: a live session plus a spent ticket ───
  | 'totp-add'
  | 'totp-confirm'
  | 'passkey-add-challenge'
  | 'passkey-add-verify'
  | 'remove'
  | 'rename';

/**
 * What a caller must present.
 *
 *  - `step-up`      — a `loginId` in the request body, plus the attempt state named
 *                     in `TWO_FACTOR_STATE_REQUIRES`. No access token; there is
 *                     not one yet. (The tag keeps its name: it describes the
 *                     half-authenticated CALLER, not the transport that got them
 *                     here, and that has not changed.)
 *  - `bearer`       — a valid access token and nothing more.
 *  - `bearer+ticket`— a valid access token AND a single-use elevation ticket in
 *                     `X-Elevation-Ticket`.
 */
export type TwoFactorCredential = 'step-up' | 'bearer' | 'bearer+ticket';

/**
 * ═══ THE ACCESS-CONTROL TABLE FOR THIS ROUTE ═══════════════════════════════
 *
 * The sibling of `STEP_REQUIRES` (auth/auth.types.ts). Read both to answer "what
 * can a half-authenticated caller do".
 *
 * ─── Why `totp-confirm` and `passkey-add-verify` need no ticket ─────────────
 *
 * Each is the second half of a two-step flow whose FIRST half already spent one.
 * `totp-confirm` is gated by possession of a pending enrollment row, and
 * `passkey-add-verify` by a single-use challenge in Redis — both created by a
 * request that was itself elevated. Demanding a second ticket would mean two
 * passkey taps for one logical action without adding a second barrier.
 *
 * ─── Why `reauth-*` needs only a bearer ─────────────────────────────────────
 *
 * It is the action that GRANTS elevation. Requiring elevation to obtain elevation
 * is the deadlock, not the defence.
 *
 * ─── The bootstrap, stated so it does not look like a bug ───────────────────
 *
 * `passkey-add-challenge` requires a ticket, and tickets are meant to come from a
 * passkey assertion — so an admin who has only TOTP could never enroll their
 * first passkey. `reauth-verify` therefore accepts a TOTP code as well as an
 * assertion. TOTP is bounded by `claimTotpStep` to one use per 30-second step, so
 * it is a usable escape hatch and a poor way to do bulk writes, which is exactly
 * the shape this needs.
 */
export const TWO_FACTOR_REQUIRES: Readonly<Record<TwoFactorAction, TwoFactorCredential>> = {
  'totp-enroll': 'step-up',
  'totp-verify': 'step-up',
  'passkey-challenge': 'step-up',
  'passkey-verify': 'step-up',

  'reauth-challenge': 'bearer',
  'reauth-verify': 'bearer',

  'totp-add': 'bearer+ticket',
  'totp-confirm': 'bearer',
  'passkey-add-challenge': 'bearer+ticket',
  'passkey-add-verify': 'bearer',
  remove: 'bearer+ticket',
  rename: 'bearer+ticket',
};

/**
 * The attempt states each SIGN-IN action is legal from.
 *
 * These are the rows lifted out of `STEP_REQUIRES` when the four factor steps
 * moved here, unchanged: all four still demand `EMAIL_VERIFIED`. That is the line
 * that makes the email factor unskippable — a `loginId` minted by a stolen
 * password sits at `PASSWORD_VERIFIED` and matches nothing here.
 */
export const TWO_FACTOR_STATE_REQUIRES: Readonly<Record<string, readonly AdminLoginState[]>> = {
  'totp-enroll': ['EMAIL_VERIFIED'],
  'totp-verify': ['EMAIL_VERIFIED'],
  'passkey-challenge': ['EMAIL_VERIFIED'],
  'passkey-verify': ['EMAIL_VERIFIED'],
};

/**
 * Reject a sign-in action that is not legal from this attempt's state.
 *
 * Deliberately a mirror of `assertStep` rather than a call into it: that function
 * reads `STEP_REQUIRES`, and these actions are no longer in it. An action absent
 * from the table throws rather than passing — adding one and forgetting to declare
 * its prerequisites makes it unreachable, a bug that reports itself on the first
 * call, where the inverse default would silently publish it.
 *
 * The caller has already been resolved from their `loginId` by the time this runs,
 * so the attempt in hand is live and belongs to them; what is left to decide is
 * whether the action they asked for is legal from the state it is in.
 */
export function assertTwoFactorState(
  attempt: AdminLoginAttempt,
  action: TwoFactorAction,
): void {
  const allowed = TWO_FACTOR_STATE_REQUIRES[action];
  if (allowed === undefined || !allowed.includes(attempt.state)) {
    throw new ProblemException({
      type: ERR.STEP_UP_STEP_INVALID,
      detail: `Action "${action}" is not available from the current state.`,
      // Disclosed on purpose: the caller already holds this attempt's secret, so
      // it is their own progress, and a desynchronised client needs it to recover.
      extra: { state: attempt.state },
    });
  }
}

/**
 * One enrolled factor, flattened across the two tables.
 *
 * `id` is the row id in whichever table `kind` names. It is not a secret: it
 * authorises nothing on its own, and every mutation re-checks that the row belongs
 * to the calling admin.
 */
export interface EnrolledFactor {
  readonly id: string;
  readonly kind: FactorKind;
  readonly label: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** A freshly generated TOTP secret, returned exactly once. */
export interface TotpEnrollment {
  readonly secret: string;
  readonly uri: string;
}

/**
 * `replacing` drives the ROTATION path: `ix_admin_totp_confirmed_unique` permits
 * exactly one confirmed TOTP factor per admin, so a second cannot simply be added.
 * The new factor is created PENDING alongside the old, and confirming it retires
 * the old in the same transaction — so there is never an instant with zero factors.
 */
export interface TotpEnrollmentStart extends TotpEnrollment {
  readonly replacing: boolean;
}
