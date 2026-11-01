import { describe, expect, it } from 'vitest';
import { SECURITY_COOLDOWN } from '../../../auth/auth.constants';
import {
  assertNotInSecurityCooldown,
  securityCooldownRemainingSeconds,
} from '../../../auth/security/security-cooldown';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';

/**
 * The cooldown arithmetic and the refusal it produces.
 *
 * Everything that enforces the freeze — the injectable policy the five services call,
 * and the row-locked guard the persistence layer runs inside each mutation — routes
 * through these two functions. So this file is where the BOUNDARY is pinned down, and
 * the surface specs are free to be about whether each surface asks at all.
 *
 * The window is read from the constant rather than restated as `86400`. A spec that
 * hardcodes the number it is testing passes forever after somebody changes the policy
 * and forgets a caller.
 */

const WINDOW_MS = SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS * 1000;
const NOW = new Date('2026-01-15T10:00:00.000Z').getTime();

function changedMsAgo(ms: number): Date {
  return new Date(NOW - ms);
}

describe('securityCooldownRemainingSeconds — where the window closes', () => {
  it('reports no cooldown for an account whose address has never moved', () => {
    // Null is the ordinary state of almost every account, so it is a value rather than
    // a special case every caller has to remember to handle.
    expect(securityCooldownRemainingSeconds(null, NOW)).toBe(0);
    expect(securityCooldownRemainingSeconds(undefined, NOW)).toBe(0);
  });

  it('reports the whole window immediately after a change', () => {
    expect(securityCooldownRemainingSeconds(changedMsAgo(0), NOW)).toBe(
      SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS,
    );
  });

  it('is still frozen one second before expiry', () => {
    expect(securityCooldownRemainingSeconds(changedMsAgo(WINDOW_MS - 1000), NOW)).toBe(1);
  });

  it('is clear at the exact instant of expiry, so the boundary belongs to the user', () => {
    // `<= 0` rather than `< 0` in the implementation. A user told to wait 24 hours who
    // returns at 24 hours must be let through, not told to wait again.
    expect(securityCooldownRemainingSeconds(changedMsAgo(WINDOW_MS), NOW)).toBe(0);
  });

  it('is clear after expiry', () => {
    expect(securityCooldownRemainingSeconds(changedMsAgo(WINDOW_MS + 60_000), NOW)).toBe(0);
  });

  it('rounds the remainder UP, so a client retrying on the number is not refused again', () => {
    // 1.5s left. Rounding down would tell the client "1", and a client that waits
    // exactly one second is refused a second time — the retry loop that a rounded-down
    // deadline always produces.
    expect(securityCooldownRemainingSeconds(changedMsAgo(WINDOW_MS - 1500), NOW)).toBe(2);
  });

  it('treats a timestamp in the future as frozen rather than as clear', () => {
    // Not reachable through the application — the column is written with the server's
    // own clock — but a value that arrived from a clock skew or a restore must fail
    // CLOSED. An implementation using `Math.abs` or an early `return 0` would open it.
    expect(securityCooldownRemainingSeconds(new Date(NOW + 60_000), NOW)).toBeGreaterThan(
      SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS,
    );
  });
});

describe('assertNotInSecurityCooldown — the refusal', () => {
  it('returns silently when the account is clear', () => {
    expect(() => assertNotInSecurityCooldown(null, NOW)).not.toThrow();
    expect(() => assertNotInSecurityCooldown(changedMsAgo(WINDOW_MS), NOW)).not.toThrow();
  });

  it('throws the dedicated slug rather than forbidden or rate_limited', () => {
    // Its own slug because the sentence on screen is different from every other
    // refusal: nothing the caller can prove will help, and the only remedy is to wait.
    try {
      assertNotInSecurityCooldown(changedMsAgo(0), NOW);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      expect((err as ProblemException).type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    }
  });

  it('tells the client WHEN, so it never has to do the arithmetic itself', () => {
    const halfWay = changedMsAgo(WINDOW_MS / 2);

    try {
      assertNotInSecurityCooldown(halfWay, NOW);
      throw new Error('expected a refusal');
    } catch (err) {
      const problem = err as ProblemException;

      // Populates `Retry-After` through ProblemException's existing contract.
      expect(problem.retryAfterSeconds).toBe(SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS / 2);
      expect(problem.extra?.availableAt).toBe(
        new Date(halfWay.getTime() + WINDOW_MS).toISOString(),
      );
    }
  });

  it('does NOT disclose when the address moved', () => {
    // The client needs to know when it may act, which `availableAt` gives it. It does
    // not need `emailChangedAt`, and handing it over would invite a client to re-derive
    // the window — a second copy of the policy that drifts from this one.
    try {
      assertNotInSecurityCooldown(changedMsAgo(0), NOW);
      throw new Error('expected a refusal');
    } catch (err) {
      const problem = err as ProblemException;
      expect(Object.keys(problem.extra ?? {})).toEqual(['availableAt']);
      expect(JSON.stringify(problem.extra)).not.toContain(new Date(NOW).toISOString());
    }
  });

  it('points the user at the recovery link rather than at support', () => {
    // The freeze is only half the defence. The other half is the recovery ticket mailed
    // to the released address, and a user who is told "locked" without being told where
    // the way back is has been given the cost of the control and none of its benefit.
    try {
      assertNotInSecurityCooldown(changedMsAgo(0), NOW);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as ProblemException).detail).toContain('recovery link');
    }
  });
});
