import type { AdminLoginAttempt } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { MFA } from '../auth.constants';
import { STEP_REQUIRES, type LoginStep } from '../auth.types';

/**
 * ═══ THE ENFORCEMENT POINT FOR THE SIGN-IN CEREMONY ══════════════════════════
 *
 * The whole admin sign-in surface is one route, so there is no per-route guard
 * separating "you have proven your password" from "you have proven your second
 * factor". This file is what does that job instead, and `STEP_REQUIRES` in
 * auth.types.ts is the table it reads.
 *
 * Everything here is a pure function over a loaded attempt row. That is
 * deliberate: the checks are the security boundary, so they are directly
 * testable without a database, a Redis, or an HTTP layer — see
 * tests/auth/stepup.spec.ts, which table-drives every (step, state) pair.
 *
 * ─── Why a function taking the row, and not a service ──────────────────────
 *
 * An `@Injectable() StepUpService` would be the reflex and it would be worse: the
 * callers already inject the dboperation that loads the row, so a service would
 * either give them two collaborators for one table or make these checks reachable
 * only through DI — which is exactly what makes a security boundary hard to test
 * exhaustively.
 */

/**
 * Reject an attempt that is no longer live.
 *
 * Order matters. Expiry is checked BEFORE state, so an attempt that ran out of
 * time answers `step_up_expired` — the client should restart the ceremony — rather
 * than `step_up_step_invalid`, which would tell it to try a different step against
 * a row that can never accept one.
 */
export function assertLive(attempt: AdminLoginAttempt): void {
  // A terminal row is not a credential. `COMPLETED` is checked explicitly rather
  // than left to the state table because its secret has been nulled, so reaching
  // here with one at all means something unexpected — and answering "invalid"
  // rather than "wrong step" is the accurate description.
  if (attempt.completedAt !== null || attempt.state === 'COMPLETED') {
    throw new ProblemException({ type: ERR.STEP_UP_INVALID });
  }

  if (attempt.state === 'EXPIRED' || attempt.expiresAt.getTime() <= Date.now()) {
    throw new ProblemException({ type: ERR.STEP_UP_EXPIRED });
  }
}

/**
 * Reject a step that is not legal from this attempt's current state.
 *
 * This single function is what makes the ceremony unskippable. `STEP_REQUIRES`
 * lists nothing but the two email-OTP steps as legal from `PASSWORD_VERIFIED`, so
 * an attacker holding a step-up secret minted by a stolen password cannot reach
 * any factor step, cannot reach enrollment, and therefore cannot reach a session.
 *
 * A step absent from the table throws rather than passing. That direction is the
 * point: adding a step to the union and forgetting to declare its prerequisites
 * makes it unreachable, which is a bug that reports itself on the first call. The
 * inverse default — unknown steps allowed — would silently publish it.
 */
export function assertStep(attempt: AdminLoginAttempt, step: LoginStep): void {
  assertLive(attempt);

  const allowed = STEP_REQUIRES[step];
  if (allowed === undefined || !allowed.includes(attempt.state)) {
    throw new ProblemException({
      type: ERR.STEP_UP_STEP_INVALID,
      detail: `Step "${step}" is not available from the current state.`,
      // The state is disclosed on purpose: the caller already holds this
      // attempt's secret, so it is their own progress, and a client that
      // desynchronised (a refresh, a duplicated tab) needs it to recover.
      extra: { state: attempt.state },
    });
  }
}

/**
 * Charge a wrong second-factor guess against the attempt.
 *
 * Called with the count ALREADY incremented, so the caller has to have written
 * the increment before asking whether it was fatal — that ordering is what stops
 * a caller from racing the check by abandoning requests mid-flight.
 *
 * The cap is on the attempt rather than only in Redis so it survives a cache
 * flush, matching the reasoning behind `AdminCredential.failedAttempts`.
 */
export function assertMfaAttemptsRemain(attempts: number): void {
  if (attempts >= MFA.MAX_ATTEMPTS) {
    throw new ProblemException({ type: ERR.MFA_ATTEMPTS_EXHAUSTED });
  }
}

/** How many guesses are left, for the `extra` on a wrong-code response. */
export function mfaAttemptsRemaining(attempts: number): number {
  return Math.max(0, MFA.MAX_ATTEMPTS - attempts);
}
