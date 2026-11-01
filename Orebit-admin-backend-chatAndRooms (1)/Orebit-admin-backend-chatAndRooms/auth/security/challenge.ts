import type { AdminChallenge, AdminChallengePurpose } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { safeEqual } from '../../src/utils/public.utils';
import { OTP } from '../auth.constants';
import { pepperedHash } from '../auth.utility';
import type { ChallengeDbOperation } from '../persistence/challenge.dboperation';

/**
 * The one-time-code protocol, in one place.
 *
 * The sign-in email step runs the identical seven steps to verify a code safely:
 * find the live challenge, reject an expired one, reject a spent counter,
 * increment BEFORE comparing, compare in constant time, escalate when the last
 * guess is wrong, and spend the code under a compare-and-swap.
 *
 * ─── Why a function taking the dboperation, and not a service ───────────────
 *
 * An `@Injectable()` ChallengeService would be the reflex, and it would be worse
 * here. Both callers already inject `ChallengeDbOperation`; adding a service
 * either gives them two collaborators for one table, or makes this protocol
 * reachable only through DI — and this is the code whose every branch a test
 * should be able to drive directly.
 *
 * ─── Why verify and spend are separate ─────────────────────────────────────
 *
 * The obvious extraction — one function that verifies AND consumes — would
 * remove the seam a caller needs to run validation between the two. Keeping
 * them separate means a future flow can check a policy between verification
 * and consumption without burning the code on a validation failure.
 */

/**
 * Prove the caller holds the live code for `(adminId, purpose)`.
 *
 * Returns the challenge **unspent** — the caller decides when to spend it, and
 * what happens in between. Every failure mode throws a `ProblemException`, so a
 * returned value always means "this code was correct and is still live".
 */
export async function verifyChallengeCode(
  challenges: ChallengeDbOperation,
  adminId: string,
  purpose: AdminChallengePurpose,
  code: string,
): Promise<AdminChallenge> {
  const challenge = await challenges.findLive(adminId, purpose);
  if (challenge === null) {
    throw new ProblemException({ type: ERR.OTP_EXPIRED });
  }

  // Expiry before the counter, deliberately: an expired code must not cost an
  // attempt, or a slow admin loses their remaining guesses to the clock.
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
 * for a sign-in that would be two attempts advanced by one code, for a reset a
 * second password.
 */
export async function spendChallenge(
  challenges: ChallengeDbOperation,
  challengeId: string,
): Promise<void> {
  if (!(await challenges.consume(challengeId))) {
    throw new ProblemException({ type: ERR.OTP_INVALID });
  }
}
