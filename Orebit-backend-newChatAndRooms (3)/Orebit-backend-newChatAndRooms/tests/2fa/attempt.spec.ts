import { describe, expect, it } from 'vitest';
import type { LoginAttempt } from '@prisma/client';
import {
  assertAttemptLive,
  assertAttemptsRemain,
  attemptsRemaining,
  isLastAttempt,
} from '../../src/2fa/attempt';
import { policy } from '../../auth/limits';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The enforcement point for the sign-in ceremony, table-driven.
 *
 * These are pure functions over a loaded row precisely so this file can exist:
 * they ARE the boundary between a correct password and a session on an account
 * with 2FA switched on, and a boundary reachable only through DI is a boundary
 * nobody tests exhaustively.
 */

function attempt(overrides: Partial<LoginAttempt> = {}): LoginAttempt {
  return {
    id: 'attempt-1',
    userId: 'user-1',
    tokenHash: 'hash',
    state: 'FACTOR_REQUIRED',
    attempts: 0,
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'a'.repeat(64),
    userAgent: 'vitest',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    completedAt: null,
    ...overrides,
  } as LoginAttempt;
}

function thrownBy(fn: () => void): ProblemException {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected a throw, but the call returned');
}

describe('assertAttemptLive', () => {
  it('passes a live attempt', () => {
    expect(() => assertAttemptLive(attempt())).not.toThrow();
  });

  it('refuses a COMPLETED attempt as invalid, not expired', () => {
    // A spent ceremony may well still be inside its ten minutes, so "expired" would
    // be a lie — and reaching here with one means a replayed `mfaToken`, whose
    // session already exists and must not be minted twice.
    expect(thrownBy(() => assertAttemptLive(attempt({ state: 'COMPLETED' }))).type).toBe(
      ERR.MFA_TOKEN_INVALID,
    );
  });

  it('refuses one that carries a completedAt even if the state disagrees', () => {
    // Belt and braces on the terminal marker: the two are written together, and if
    // they ever disagree the safe reading is "already used".
    expect(
      thrownBy(() => assertAttemptLive(attempt({ completedAt: new Date() }))).type,
    ).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('refuses an attempt past its expiry', () => {
    expect(
      thrownBy(() => assertAttemptLive(attempt({ expiresAt: new Date(Date.now() - 1) }))).type,
    ).toBe(ERR.MFA_EXPIRED);
  });

  it('refuses an attempt marked EXPIRED even while its clock says otherwise', () => {
    // Superseded by a newer sign-in. The row is dead before its `expiresAt`.
    expect(thrownBy(() => assertAttemptLive(attempt({ state: 'EXPIRED' }))).type).toBe(
      ERR.MFA_EXPIRED,
    );
  });

  it('checks COMPLETED before expiry, so a spent ceremony never reads as expired', () => {
    // Ordering, asserted rather than assumed: the two remedies a client would take
    // are the same, but the message a user reads is not.
    const spent = attempt({ state: 'COMPLETED', expiresAt: new Date(Date.now() - 1) });
    expect(thrownBy(() => assertAttemptLive(spent)).type).toBe(ERR.MFA_TOKEN_INVALID);
  });
});

describe('assertAttemptsRemain', () => {
  /**
   * ═══ THE OFF-BY-ONE THIS FILE NOW PINS ══════════════════════════════════════
   *
   * The count arrives POST-increment, so on the Nth request it equals N. The guard
   * used to refuse at `>= MAX`, which refused request MAX before its code was ever
   * compared: a configured cap of five gave four usable guesses, and a correct fifth
   * code failed while the fourth response advertised `attemptsRemaining: 1`.
   *
   * The old version of this suite passed throughout, because it only ever tested the
   * guard in isolation against the same threshold the implementation used. It never
   * asked the question that matters — how many codes actually get compared — so the
   * assertions below are phrased in those terms instead.
   */

  it('compares every guess up to and including the cap', () => {
    // n is the post-increment count, so n = policy().MFA.PROOF_ATTEMPTS is the LAST allowed
    // guess, not the first refused one.
    for (let n = 1; n <= policy().MFA.PROOF_ATTEMPTS; n += 1) {
      expect(() => assertAttemptsRemain(n)).not.toThrow();
    }
  });

  it('refuses only once the cap is exceeded', () => {
    expect(thrownBy(() => assertAttemptsRemain(policy().MFA.PROOF_ATTEMPTS + 1)).type).toBe(
      ERR.MFA_ATTEMPTS_EXHAUSTED,
    );
    expect(thrownBy(() => assertAttemptsRemain(policy().MFA.PROOF_ATTEMPTS + 5)).type).toBe(
      ERR.MFA_ATTEMPTS_EXHAUSTED,
    );
  });

  it('yields exactly policy().MFA.PROOF_ATTEMPTS usable guesses', () => {
    // The whole point, stated as a count rather than as a threshold — this is the
    // assertion the previous suite was missing.
    let compared = 0;
    for (let n = 1; n <= policy().MFA.PROOF_ATTEMPTS + 3; n += 1) {
      try {
        assertAttemptsRemain(n);
        compared += 1;
      } catch {
        break;
      }
    }
    expect(compared).toBe(policy().MFA.PROOF_ATTEMPTS);
  });

  it('is called with the count ALREADY incremented', () => {
    // Documented by the arithmetic: passing 1 must mean one guess has been spent, so
    // the caller has to write the increment before asking whether it was fatal. That
    // ordering is what stops a caller racing the cap by abandoning requests.
    expect(attemptsRemaining(1)).toBe(policy().MFA.PROOF_ATTEMPTS - 1);
  });
});

describe('isLastAttempt', () => {
  /**
   * Split from `assertAttemptsRemain` because conflating the two thresholds is what
   * left the retire branch unreachable. `assertAttemptsRemain` decides whether a code
   * may be COMPARED; this decides whether the attempt is now spent.
   */

  it('is false while guesses remain', () => {
    for (let n = 1; n < policy().MFA.PROOF_ATTEMPTS; n += 1) {
      expect(isLastAttempt(n)).toBe(false);
    }
  });

  it('is true on the final allowed guess', () => {
    // The guess that `assertAttemptsRemain` still permits. Both must agree on this
    // number, or an attempt is either retired early or never retired at all — the
    // latter is precisely what happened before.
    expect(() => assertAttemptsRemain(policy().MFA.PROOF_ATTEMPTS)).not.toThrow();
    expect(isLastAttempt(policy().MFA.PROOF_ATTEMPTS)).toBe(true);
  });

  it('reports no guesses remaining once it is true', () => {
    expect(attemptsRemaining(policy().MFA.PROOF_ATTEMPTS)).toBe(0);
  });
});

describe('attemptsRemaining', () => {
  it('counts down from the cap', () => {
    expect(attemptsRemaining(0)).toBe(policy().MFA.PROOF_ATTEMPTS);
    expect(attemptsRemaining(policy().MFA.PROOF_ATTEMPTS - 1)).toBe(1);
  });

  it('never goes negative, so the wire never carries a nonsense number', () => {
    expect(attemptsRemaining(policy().MFA.PROOF_ATTEMPTS + 5)).toBe(0);
  });
});
