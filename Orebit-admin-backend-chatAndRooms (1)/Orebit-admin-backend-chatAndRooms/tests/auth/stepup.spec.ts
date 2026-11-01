import type { AdminLoginState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { MFA } from '../../auth/auth.constants';
import { LOGIN_STEPS, STEP_REQUIRES, type LoginStep } from '../../auth/auth.types';
import {
  assertTwoFactorState,
  TWO_FACTOR_REQUIRES,
  TWO_FACTOR_STATE_REQUIRES,
} from '../../src/2fa/2fa.types';
import {
  assertLive,
  assertMfaAttemptsRemain,
  assertStep,
  mfaAttemptsRemaining,
} from '../../auth/security/stepup';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { ALL_LOGIN_STATES, makeAttempt } from '../harness';

/**
 * ═══ THE TEST THAT PROVES THE CEREMONY CANNOT BE SHORT-CIRCUITED ═════════════
 *
 * The whole admin sign-in surface is ONE route, so there is no per-route guard
 * separating "password proven" from "second factor proven". `STEP_REQUIRES` plus
 * `assertStep` is what does that job instead.
 *
 * Because it is one table and one function, the (step, state) matrix is small
 * enough to assert EXHAUSTIVELY rather than sample — and that exhaustiveness is
 * the point. A spec that checked three interesting cases would pass while a fourth
 * combination silently let someone skip a factor.
 *
 * Read `expectedLegality` below as the specification. If a change to
 * `STEP_REQUIRES` makes a test here fail, the question to ask is not "how do I fix
 * the test" but "did I just make a factor optional".
 */

/** Pull the `type` slug off whatever a call threw. */
function slugOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

describe('STEP_REQUIRES — the table itself', () => {
  /**
   * `start` and `password` are anonymous: there is no attempt yet, so there is no
   * state to require. Their absence from the table is deliberate and load-bearing,
   * because `assertStep` throws for an unlisted step — which is precisely why
   * neither of them is ever passed to it.
   */
  it('declares no prerequisites for the two anonymous steps', () => {
    expect(STEP_REQUIRES['start']).toBeUndefined();
    expect(STEP_REQUIRES['password']).toBeUndefined();
  });

  /**
   * Every other step MUST be in the table. A step that is missing becomes
   * unreachable rather than unguarded — `assertStep` fails closed — but it is
   * still a bug, and this catches it at build time rather than on the first call.
   */
  it('declares prerequisites for every non-anonymous step', () => {
    const anonymous: readonly LoginStep[] = ['start', 'password'];
    for (const step of LOGIN_STEPS) {
      if (anonymous.includes(step)) continue;
      expect(STEP_REQUIRES[step], `${step} is missing from STEP_REQUIRES`).toBeDefined();
    }
  });

  /**
   * ═══ THE SINGLE MOST IMPORTANT ASSERTION IN THIS REPOSITORY ════════════════
   *
   * Nothing except the two email-OTP steps may run from `PASSWORD_VERIFIED`.
   *
   * That is what makes the email factor unskippable. An attacker holding a
   * step-up secret minted by a stolen password must not be able to reach any
   * factor step, any enrollment step, or therefore a session. If this ever fails,
   * a stolen password alone is enough to sign in.
   */
  it('permits NOTHING but the email steps from PASSWORD_VERIFIED', () => {
    const legalFromPasswordVerified = Object.entries(STEP_REQUIRES)
      .filter(([, states]) => states.includes('PASSWORD_VERIFIED'))
      .map(([step]) => step)
      .sort();

    expect(legalFromPasswordVerified).toEqual(['resend-otp', 'state', 'verify-email']);
  });

  /**
   * A terminal attempt is not a credential. `COMPLETED` and `EXPIRED` must appear
   * in no list at all, so a spent step-up secret buys nothing even if it somehow
   * still resolved to a row.
   */
  it.each(['COMPLETED', 'EXPIRED'] as const)('permits no step at all from %s', (state) => {
    for (const [step, states] of Object.entries(STEP_REQUIRES)) {
      expect(states, `${step} must not be legal from ${state}`).not.toContain(state);
    }
  });

  /**
   * The four factor steps MOVED to `POST /2fa` — they are deliberately absent here.
   *
   * Their prerequisites did not relax; they live in `TWO_FACTOR_STATE_REQUIRES` and
   * are asserted in the sibling describe below. This assertion exists so that
   * putting one back on this route without thinking is a test failure: the login
   * route must not be able to mint a session again.
   */
  it.each(['totp-enroll', 'totp-verify', 'passkey-challenge', 'passkey-verify'] as const)(
    '%s is NOT reachable from POST /auth/login any more',
    (step) => {
      expect(STEP_REQUIRES[step]).toBeUndefined();
      expect(LOGIN_STEPS as readonly string[]).not.toContain(step);
    },
  );

  /**
   * `EMAIL_VERIFIED` is now terminal for this route.
   *
   * Reaching it means the caller is done here and must continue at `/2fa`. If a
   * step ever becomes legal from it again, that step can run after the email factor
   * with no second factor in between — which is the hole this whole split closes.
   */
  it('permits nothing but the state read from EMAIL_VERIFIED', () => {
    const legal = Object.entries(STEP_REQUIRES)
      .filter(([, states]) => states.includes('EMAIL_VERIFIED'))
      .map(([step]) => step)
      .sort();

    expect(legal).toEqual(['state']);
  });
});

/**
 * ═══ THE OTHER HALF OF THE SAME MATRIX ═════════════════════════════════════
 *
 * The four factor actions on `POST /2fa`. These assertions were lifted out of the
 * describe above when the steps moved route, and they say the same thing they said
 * there: a second factor is legal from `EMAIL_VERIFIED` and from nowhere else.
 *
 * If this file and `TWO_FACTOR_REQUIRES` ever disagree, the ceremony has a hole.
 */
describe('TWO_FACTOR_STATE_REQUIRES — the factor actions, after the move', () => {
  const SIGN_IN_ACTIONS = [
    'totp-enroll',
    'totp-verify',
    'passkey-challenge',
    'passkey-verify',
  ] as const;

  it.each(SIGN_IN_ACTIONS)('%s requires EMAIL_VERIFIED and nothing else', (action) => {
    expect(TWO_FACTOR_STATE_REQUIRES[action]).toEqual(['EMAIL_VERIFIED']);
  });

  /**
   * The single most important assertion about this route: a step-up secret minted
   * by a stolen password sits at `PASSWORD_VERIFIED` and must reach no factor.
   */
  it('permits NOTHING from PASSWORD_VERIFIED', () => {
    for (const [action, states] of Object.entries(TWO_FACTOR_STATE_REQUIRES)) {
      expect(states, `${action} must not be legal from PASSWORD_VERIFIED`).not.toContain(
        'PASSWORD_VERIFIED',
      );
    }
  });

  it.each(['COMPLETED', 'EXPIRED'] as const)('permits no action at all from %s', (state) => {
    for (const [action, states] of Object.entries(TWO_FACTOR_STATE_REQUIRES)) {
      expect(states, `${action} must not be legal from ${state}`).not.toContain(state);
    }
  });

  /** Enforced, not merely declared — the exhaustive (action, state) matrix. */
  for (const action of SIGN_IN_ACTIONS) {
    for (const state of ALL_LOGIN_STATES) {
      const legal = TWO_FACTOR_STATE_REQUIRES[action]?.includes(state) ?? false;

      it(`${legal ? 'permits' : 'refuses'} "${action}" from ${state}`, () => {
        const attempt = makeAttempt({ state });

        if (legal) {
          expect(() => assertTwoFactorState(attempt, action)).not.toThrow();
          return;
        }
        expect(slugOf(() => assertTwoFactorState(attempt, action))).toBe(
          ERR.STEP_UP_STEP_INVALID,
        );
      });
    }
  }

  /**
   * An action absent from the table throws rather than passing. Adding one and
   * forgetting to declare its prerequisites makes it unreachable — a bug that
   * reports itself — where the inverse default would silently publish it.
   */
  it('refuses an action it does not know about', () => {
    const attempt = makeAttempt({ state: 'EMAIL_VERIFIED' });
    expect(
      slugOf(() => assertTwoFactorState(attempt, 'totp-add' as never)),
    ).toBe(ERR.STEP_UP_STEP_INVALID);
  });
});

/**
 * ═══ WHO MAY CALL WHAT ON POST /2fa ════════════════════════════════════════
 *
 * `TWO_FACTOR_REQUIRES` is the credential half of the same access control. These
 * assertions pin the three properties that make the route safe to share between a
 * half-authenticated caller and a signed-in one.
 */
describe('TWO_FACTOR_REQUIRES — the credential table', () => {
  it('declares a credential for every action', () => {
    for (const action of Object.keys(TWO_FACTOR_STATE_REQUIRES)) {
      expect(TWO_FACTOR_REQUIRES[action as keyof typeof TWO_FACTOR_REQUIRES]).toBeDefined();
    }
  });

  /** Exactly the four sign-in actions may be reached without an access token. */
  it('admits the step-up cookie for the four sign-in actions and nothing else', () => {
    const stepUp = Object.entries(TWO_FACTOR_REQUIRES)
      .filter(([, credential]) => credential === 'step-up')
      .map(([action]) => action)
      .sort();

    expect(stepUp).toEqual([
      'passkey-challenge',
      'passkey-verify',
      'totp-enroll',
      'totp-verify',
    ]);
  });

  /**
   * Every action that CHANGES the factor set costs a fresh proof.
   *
   * `totp-confirm` and `passkey-add-verify` are the deliberate exceptions — each is
   * the second half of a flow whose first half already spent a ticket, and each is
   * gated by a pending row or a single-use challenge. If a new mutating action
   * appears here without a ticket, a stolen access token can change the factor set.
   */
  it('requires a ticket for every action that changes the factor set', () => {
    const elevated = Object.entries(TWO_FACTOR_REQUIRES)
      .filter(([, credential]) => credential === 'bearer+ticket')
      .map(([action]) => action)
      .sort();

    expect(elevated).toEqual([
      'passkey-add-challenge',
      'remove',
      'rename',
      'totp-add',
    ]);
  });

  /** Requiring elevation to obtain elevation is a deadlock, not a defence. */
  it('does not require a ticket to earn one', () => {
    expect(TWO_FACTOR_REQUIRES['reauth-challenge']).toBe('bearer');
    expect(TWO_FACTOR_REQUIRES['reauth-verify']).toBe('bearer');
  });
});

describe('assertStep — the exhaustive (step, state) matrix', () => {
  /**
   * The specification, written out. Every step crossed with every state, and for
   * each pair whether it is permitted.
   *
   * Derived from `STEP_REQUIRES` deliberately — a hand-written copy would be a
   * second source of truth that drifts. What the tests below add is that the table
   * is actually ENFORCED, and that the two anonymous steps are refused if anyone
   * ever routes them through here.
   */
  function expectedLegality(step: LoginStep, state: AdminLoginState): boolean {
    return STEP_REQUIRES[step]?.includes(state) ?? false;
  }

  const anonymous: readonly LoginStep[] = ['start', 'password'];

  for (const step of LOGIN_STEPS) {
    for (const state of ALL_LOGIN_STATES) {
      const legal = expectedLegality(step, state);

      it(`${legal ? 'permits' : 'refuses'} "${step}" from ${state}`, () => {
        const attempt = makeAttempt({ state });

        if (legal) {
          expect(() => assertStep(attempt, step)).not.toThrow();
          return;
        }

        // A terminal state answers with its own slug; everything else is a
        // wrong-step refusal. Both are refusals — which one matters only for the
        // message the client shows.
        const expected =
          state === 'COMPLETED'
            ? ERR.STEP_UP_INVALID
            : state === 'EXPIRED'
              ? ERR.STEP_UP_EXPIRED
              : ERR.STEP_UP_STEP_INVALID;

        expect(slugOf(() => assertStep(attempt, step))).toBe(expected);
      });
    }
  }

  /** The two anonymous steps are never routed through `assertStep`, and if someone
   *  ever does, it fails closed rather than waving them past. */
  it.each(anonymous)('refuses the anonymous step "%s" if it is ever passed here', (step) => {
    expect(slugOf(() => assertStep(makeAttempt({ state: 'EMAIL_VERIFIED' }), step))).toBe(
      ERR.STEP_UP_STEP_INVALID,
    );
  });

  /**
   * An unknown step must fail closed.
   *
   * This is the direction that matters: adding a variant to the DTO union and
   * forgetting to declare its prerequisites makes it unreachable, which is a bug
   * that reports itself on the first call. The inverse default — unknown steps
   * allowed — would silently publish an unguarded step.
   */
  it('refuses a step that is not in the table at all', () => {
    expect(slugOf(() => assertStep(makeAttempt(), 'totally-made-up' as LoginStep))).toBe(
      ERR.STEP_UP_STEP_INVALID,
    );
  });
});

describe('assertLive — expiry and terminality', () => {
  it('passes a live attempt', () => {
    expect(() => assertLive(makeAttempt())).not.toThrow();
  });

  /**
   * Expiry is checked BEFORE state, so an attempt that ran out of time says so
   * rather than saying "wrong step". The distinction is not cosmetic: the client
   * restarts the ceremony on `step_up_expired` and tries a different step on
   * `step_up_step_invalid`, and getting them backwards means a stuck login screen.
   */
  it('reports an expiry as expired, not as a wrong step', () => {
    const attempt = makeAttempt({ expiresAt: new Date(Date.now() - 1000) });
    expect(slugOf(() => assertLive(attempt))).toBe(ERR.STEP_UP_EXPIRED);
    // And via assertStep, for a step that WOULD otherwise be legal.
    expect(slugOf(() => assertStep(attempt, 'verify-email'))).toBe(ERR.STEP_UP_EXPIRED);
  });

  /** Dead exactly ON the expiry instant, not one millisecond later. */
  it('treats the expiry instant itself as expired', () => {
    const now = Date.now();
    expect(slugOf(() => assertLive(makeAttempt({ expiresAt: new Date(now) })))).toBe(
      ERR.STEP_UP_EXPIRED,
    );
  });

  it('reports the EXPIRED state as expired', () => {
    expect(slugOf(() => assertLive(makeAttempt({ state: 'EXPIRED' })))).toBe(ERR.STEP_UP_EXPIRED);
  });

  /**
   * A completed attempt answers `step_up_invalid` rather than `step_up_expired`,
   * and the reasoning is in the code: its secret has been nulled, so resolving one
   * at all means something unexpected — "invalid" is the accurate description, and
   * "expired" would wrongly invite the client to think waiting caused it.
   */
  it('reports a completed attempt as invalid', () => {
    expect(slugOf(() => assertLive(makeAttempt({ state: 'COMPLETED' })))).toBe(
      ERR.STEP_UP_INVALID,
    );
  });

  /**
   * `completedAt` set while `state` still says otherwise — a row mid-write, or one
   * a migration touched. Checked independently of `state` so the two cannot
   * disagree in the permissive direction.
   */
  it('reports completedAt as invalid even when the state disagrees', () => {
    const attempt = makeAttempt({ state: 'EMAIL_VERIFIED', completedAt: new Date() });
    expect(slugOf(() => assertLive(attempt))).toBe(ERR.STEP_UP_INVALID);
    // And no step gets through it either. `verify-email` rather than the
    // `totp-verify` this once named: the four factor steps moved off /auth/login
    // to POST /2fa and are no longer members of `LoginStep`, so the old name had
    // stopped compiling. `verify-email` is the step that is legal from
    // EMAIL_VERIFIED's predecessor, which makes it the right thing to prove is
    // still refused when `completedAt` is set.
    expect(slugOf(() => assertStep(attempt, 'verify-email'))).toBe(ERR.STEP_UP_INVALID);
  });

  /**
   * Terminality is checked before expiry, so a completed attempt that has ALSO
   * outlived its window is still reported as invalid. Otherwise the answer would
   * depend on how long ago the sign-in finished, which tells a caller something
   * about timing for no benefit.
   */
  it('prefers "invalid" over "expired" for an attempt that is both', () => {
    const attempt = makeAttempt({
      state: 'COMPLETED',
      completedAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() - 5_000),
    });
    expect(slugOf(() => assertLive(attempt))).toBe(ERR.STEP_UP_INVALID);
  });
});

describe('MFA attempt cap', () => {
  it('permits guesses below the cap', () => {
    for (let used = 0; used < MFA.MAX_ATTEMPTS; used += 1) {
      expect(() => assertMfaAttemptsRemain(used)).not.toThrow();
    }
  });

  it('refuses once the cap is reached', () => {
    expect(slugOf(() => assertMfaAttemptsRemain(MFA.MAX_ATTEMPTS))).toBe(
      ERR.MFA_ATTEMPTS_EXHAUSTED,
    );
    expect(slugOf(() => assertMfaAttemptsRemain(MFA.MAX_ATTEMPTS + 1))).toBe(
      ERR.MFA_ATTEMPTS_EXHAUSTED,
    );
  });

  it('reports remaining guesses, floored at zero', () => {
    expect(mfaAttemptsRemaining(0)).toBe(MFA.MAX_ATTEMPTS);
    expect(mfaAttemptsRemaining(MFA.MAX_ATTEMPTS - 1)).toBe(1);
    expect(mfaAttemptsRemaining(MFA.MAX_ATTEMPTS)).toBe(0);
    // Never negative — this value is shown to a person.
    expect(mfaAttemptsRemaining(MFA.MAX_ATTEMPTS + 5)).toBe(0);
  });
});
