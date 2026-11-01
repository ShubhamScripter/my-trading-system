import type { ChallengePurpose, VerificationChallenge } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { safeEqual } from '../../src/utils/public.utils';
import { OTP } from '../auth.constants';
import { pepperedHash } from '../auth.utility';
import type { ChallengeDbOperation } from '../persistence/challenge.dboperation';

/**
 * The one-time-code protocol, in one place.
 *
 * Two flows present an emailed code — passwordless login and password reset — and
 * both must run the identical seven steps to do it safely: find the live
 * challenge, reject an expired one, reject a spent counter, increment BEFORE
 * comparing, compare in constant time, escalate when the last guess is wrong, and
 * spend the code under a compare-and-swap. It lived twice, once per service, and
 * the copies had already begun to diverge cosmetically.
 *
 * ─── Why a function taking the dboperation, and not a service ───────────────
 *
 * An `@Injectable()` ChallengeService would be the reflex, and it would be worse
 * here. Both callers already inject `ChallengeDbOperation`; adding a service
 * either gives them two collaborators for one table, or changes both constructors
 * — and the tests that exist specifically to prove this extraction changed
 * nothing would then have to be rewritten to accommodate it. A test you edit to
 * make a refactor pass has stopped being evidence. Passing the dboperation as an
 * argument keeps the injection graph, and therefore the evidence, untouched.
 *
 * ─── Why verify and spend are separate ─────────────────────────────────────
 *
 * The obvious extraction — one function that verifies AND consumes — would
 * silently break password reset. That flow runs its password-policy check
 * *between* the two, so a weak new password does not burn the user's code and
 * force another email. Fusing the steps removes the seam that behaviour needs, so
 * the seam is the interface.
 */

/**
 * Prove the caller holds the live code for `(userId, purpose)`.
 *
 * Returns the challenge **unspent** — the caller decides when to spend it, and
 * what happens in between. Every failure mode throws a `ProblemException`, so a
 * returned value always means "this code was correct and is still live".
 */
export async function verifyChallengeCode(
  challenges: ChallengeDbOperation,
  userId: string,
  purpose: ChallengePurpose,
  code: string,
  /**
   * The address this code must have been mailed to, normalised.
   *
   * Optional, and omitting it is the right call for every purpose that mails the
   * account's own address: there is one possible recipient, so there is nothing to
   * bind. The three original call sites pass nothing and are unchanged.
   *
   * The email-change purposes DO pass it, and must. This function otherwise finds the
   * live row for `(userId, purpose)` and asks only whether the digits match — so
   * without a target, a code the user legitimately received at their CURRENT inbox
   * would satisfy the proof for an address they have not demonstrated any control
   * over, and the ceremony would prove nothing about the address being claimed.
   */
  targetEmailLower?: string,
): Promise<VerificationChallenge> {
  const challenge = await challenges.findLive(userId, purpose);
  if (challenge === null) {
    throw new ProblemException({ type: ERR.OTP_EXPIRED });
  }

  // Before the clock and before the counter, because a mismatch here is not a wrong
  // guess — it means the live code for this purpose was minted for a different address
  // than the one now being claimed, which can only happen if the ceremony was restarted
  // against another address. Charging an attempt for it would punish the caller for the
  // stale half of their own flow, and the code they hold is still legitimately theirs.
  if (targetEmailLower !== undefined && challenge.targetEmailLower !== targetEmailLower) {
    throw new ProblemException({ type: ERR.OTP_EXPIRED });
  }

  // Expiry before the counter, deliberately: an expired code must not cost an
  // attempt, or a slow user loses their remaining guesses to the clock.
  if (challenge.expiresAt.getTime() <= Date.now()) {
    await challenges.invalidate(challenge.id);
    throw new ProblemException({ type: ERR.OTP_EXPIRED });
  }

  // Already dead from earlier wrong guesses. Retired rather than re-tested, so
  // the next request is told to request a new code instead of probing one that
  // can no longer succeed.
  if (challenge.attempts >= OTP.MAX_ATTEMPTS) {
    await challenges.invalidate(challenge.id);
    throw new ProblemException({ type: ERR.OTP_ATTEMPTS_EXHAUSTED });
  }

  // Incremented before the comparison, so a wrong guess costs an attempt even if
  // the request is abandoned mid-flight and a caller cannot get unlimited guesses
  // by racing.
  const attempts = await challenges.incrementAttempts(challenge.id);

  if (!safeEqual(pepperedHash(code, 'otp'), challenge.codeHash)) {
    if (attempts >= OTP.MAX_ATTEMPTS) {
      await challenges.invalidate(challenge.id);
      throw new ProblemException({ type: ERR.OTP_ATTEMPTS_EXHAUSTED });
    }
    throw new ProblemException({
      type: ERR.OTP_INVALID,
      extra: { attemptsRemaining: Math.max(0, OTP.MAX_ATTEMPTS - attempts) },
    });
  }

  return challenge;
}

/**
 * Spend a verified challenge, or fail the verification.
 *
 * The compare-and-swap lives in the dboperation; what matters here is that a
 * caller which loses it is treated as having failed, not as having succeeded
 * quietly. A loser presented a correct code that something else already spent —
 * for login that would be a second session from one code, for reset a second
 * password.
 */
export async function spendChallenge(
  challenges: ChallengeDbOperation,
  challengeId: string,
): Promise<void> {
  if (!(await challenges.consume(challengeId))) {
    throw new ProblemException({ type: ERR.OTP_INVALID });
  }
}
