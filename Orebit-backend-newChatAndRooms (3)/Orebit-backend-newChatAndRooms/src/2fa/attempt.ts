import type { LoginAttempt } from '@prisma/client';
import { policy } from '../../auth/limits';
import { ERR } from '../contracts';
import { ProblemException } from '../http';

/**
 * ═══ THE ENFORCEMENT POINT FOR THE SIGN-IN CEREMONY ═════════════════════════
 *
 * Between "first factor accepted" and "second factor proven" a caller is partially
 * authenticated. This file decides what such a caller may do, and it is the only
 * thing standing between a correct password and a session on an account that has
 * 2FA switched on.
 *
 * Ported from Orebit-admin-backend/auth/security/stepup.ts and simplified. The
 * admin ceremony has four states because it also enforces email verification and
 * forced enrollment; here 2FA is opt-in and the first factor is already complete
 * when the row is written, so there is exactly one state a factor may be proven
 * from and the state table collapses to the guard below.
 *
 * ─── Why pure functions over a loaded row, and not a service ────────────────
 *
 * Because these checks ARE the security boundary, and a boundary reachable only
 * through DI is a boundary that is hard to test exhaustively. Everything here takes
 * a row and returns or throws, so tests/2fa/attempt.spec.ts can table-drive every
 * (state, expiry, attempts) combination without a database, a Redis, or an HTTP
 * layer. The callers already inject the dboperation that loads the row, so a
 * service would only give them two collaborators for one table.
 */

/**
 * Reject a login flow that is no longer live.
 *
 * Stated as "not terminal, and not out of time" rather than as a list of live
 * states, which is why it needed no change when the flow grew STARTED and
 * OTP_SENT ahead of FACTOR_REQUIRED. A liveness test written the other way round
 * — enumerating what is allowed — would have silently rejected both new states on
 * the first request, and a test enumerating them would have to be revisited for
 * every state after that.
 *
 * It answers whether the flow is USABLE, not whether the caller may take the step
 * they are asking for. That second question is `LOGIN_STEP_REQUIRES` on the login
 * route and `requireAttempt`'s FACTOR_REQUIRED check on the 2FA route; keeping
 * them apart is what stops "the handle is alive" from being mistaken for "the
 * handle authorises this".
 *
 * Order matters. Spent is checked BEFORE expiry, so a completed flow answers
 * `mfa_token_invalid` rather than `mfa_expired` — it may well still be inside its
 * window, and "expired" would tell a client to restart when the accurate answer
 * is that this sign-in already finished. Then expiry, so a flow that ran out of
 * time says so rather than returning a generic invalid, which would send a client
 * to retry a code against a row that can never accept one.
 */
export function assertAttemptLive(attempt: LoginAttempt): void {
  // Terminal and spent. Reaching here with one means a replayed `loginId` — the
  // session it minted already exists, and it must not mint a second. In practice
  // the finder excludes these rows and completion nulls the hash, so this is the
  // second of two defences rather than the only one.
  if (attempt.completedAt !== null || attempt.state === 'COMPLETED') {
    throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
  }

  if (attempt.state === 'EXPIRED' || attempt.expiresAt.getTime() <= Date.now()) {
    throw new ProblemException({ type: ERR.MFA_EXPIRED });
  }
}

/**
 * Reject an attempt that has burned its guesses.
 *
 * Called with the count ALREADY incremented, so a caller has to have written the
 * increment before asking whether it was fatal. That ordering is what stops a
 * caller racing the check by abandoning requests mid-flight — the same discipline
 * `verifyChallengeCode` uses for email codes.
 *
 * The cap lives on the row rather than only in Redis so it survives a cache flush,
 * matching the reasoning behind `Credential.failedAttempts`.
 *
 * ─── Why `>` and not `>=`, which is the whole bug this once had ─────────────
 *
 * The count arrives post-increment, so on the Nth request it equals N. Refusing at
 * `>= MAX` therefore refused the MAX'th request BEFORE its code was ever compared:
 * a configured cap of five gave four usable guesses, and a correct fifth code
 * failed. Worse, the fourth response advertised `attemptsRemaining: 1`, promising a
 * guess that could never be evaluated.
 *
 * `> MAX` is the off-by-one corrected: counts 1..MAX are all compared, and request
 * MAX+1 is the first one refused unchecked. The cap now means what it says.
 */
export function assertAttemptsRemain(attempts: number): void {
  if (attempts > policy().MFA.PROOF_ATTEMPTS) {
    throw new ProblemException({ type: ERR.MFA_ATTEMPTS_EXHAUSTED });
  }
}

/**
 * Was that the last guess? Asked AFTER a comparison failed.
 *
 * Split from `assertAttemptsRemain` because the two questions are genuinely
 * different and conflating them is what produced dead code here before: the guard
 * above decides whether a code may be *compared*, this decides whether the attempt
 * is now spent and must be retired. The previous single-threshold version left the
 * retire branch unreachable — it sat behind a condition that could only be true when
 * the guard had already thrown — so an exhausted attempt was never retired and sat
 * as `FACTOR_REQUIRED` for its full TTL, exactly the dead row it meant to prevent.
 */
export function isLastAttempt(attempts: number): boolean {
  return attempts >= policy().MFA.PROOF_ATTEMPTS;
}

/** How many guesses are left, for the `extra` on a wrong-code response. */
export function attemptsRemaining(attempts: number): number {
  return Math.max(0, policy().MFA.PROOF_ATTEMPTS - attempts);
}
