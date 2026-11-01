import { afterEach, describe, expect, it } from 'vitest';
import { applyPolicyOverrides, policy, resetPolicy, type Policy } from '../../auth/limits';
import {
  OTP,
  REGISTRATION,
  SESSION as SESSION_CONSTANTS,
  TOTP,
} from '../../auth/auth.constants';

/**
 * The seam, and the bounds that make it safe to have one.
 *
 * A settings engine that can change a rate limit under a running process can also
 * set it to zero and lock every user out of the product, or to a million and switch
 * the quota off with nobody noticing. `applyPolicyOverrides` is the one place that
 * can happen, so it is the one place that has to refuse.
 */

afterEach(() => {
  resetPolicy();
});

/** A deep copy, so a test mutating a value cannot reach the frozen defaults. */
function draft(): Policy {
  return structuredClone(policy()) as Policy;
}

/**
 * ═══ THE APPROVED TABLE, LINE BY LINE ═══════════════════════════════════════
 *
 * Every row of the founder-approved rate-limit policy, transcribed. Spot-checks were
 * what this used to be, and spot-checks are why a second contradicting copy of the
 * table could sit in `auth/auth.constants.ts` for as long as it did without a red
 * suite: nothing asserted the lines nobody had recently argued about.
 *
 * The GLOBAL safety net is deliberately absent — it is applied globally rather than
 * per endpoint and is explicitly out of scope for this table.
 *
 * When the founder changes a number, this block and `DEFAULTS` change together. If
 * only one of them changes, that is exactly what should fail.
 */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the shipped defaults', () => {
  it('match the approved policy document — registration', () => {
    const { REGISTRATION } = policy();

    expect(REGISTRATION.START_BY_EMAIL).toEqual([
      { limit: 4, windowSeconds: HOUR },
      { limit: 10, windowSeconds: DAY },
    ]);
    expect(REGISTRATION.START_BY_IP).toEqual([
      { limit: 4, windowSeconds: HOUR },
      { limit: 10, windowSeconds: DAY },
    ]);
    expect(REGISTRATION.START_BY_DEVICE).toEqual([
      { limit: 10, windowSeconds: HOUR },
      { limit: 24, windowSeconds: DAY },
    ]);
    expect(REGISTRATION.OTP_MAIL_BY_RECIPIENT).toEqual([
      { limit: 5, windowSeconds: HOUR },
      { limit: 20, windowSeconds: DAY },
    ]);
  });

  it('match the approved policy document — password login', () => {
    const { PASSWORD_LOGIN, LOCKOUT } = policy();

    expect(PASSWORD_LOGIN.FAIL_BY_ACCOUNT).toEqual({ limit: 5, windowSeconds: 10 * MINUTE });
    expect(PASSWORD_LOGIN.FAIL_BY_IP).toEqual({ limit: 24, windowSeconds: 10 * MINUTE });
    expect(PASSWORD_LOGIN.UNKNOWN_BY_IP).toEqual({ limit: 30, windowSeconds: 15 * MINUTE });
    expect(PASSWORD_LOGIN.FLOOD_BY_IP).toEqual({ limit: 60, windowSeconds: 15 * MINUTE });

    expect(LOCKOUT.MAX_FAILED_ATTEMPTS).toBe(10);
    // 15 minutes, then 1 hour, then 24 hours. A flat penalty is the defect this fixes.
    expect(LOCKOUT.LADDER_SECONDS).toEqual([15 * MINUTE, HOUR, DAY]);
  });

  it('match the approved policy document — login email OTP', () => {
    const { LOGIN_OTP } = policy();

    expect(LOGIN_OTP.REQUEST_BY_IDENTIFIER).toEqual({ limit: 5, windowSeconds: 15 * MINUTE });
    expect(LOGIN_OTP.REQUEST_BY_IP).toEqual({ limit: 20, windowSeconds: 15 * MINUTE });
    expect(LOGIN_OTP.REQUEST_BY_DEVICE).toEqual({ limit: 8, windowSeconds: 15 * MINUTE });
    expect(LOGIN_OTP.MAIL_BY_ACCOUNT).toEqual([
      { limit: 5, windowSeconds: 15 * MINUTE },
      { limit: 25, windowSeconds: DAY },
    ]);
  });

  it('match the approved policy document — MFA and passkeys', () => {
    const { MFA } = policy();

    expect(MFA.CEREMONY_TTL_SECONDS).toBe(15 * MINUTE);
    expect(MFA.PROOF_ATTEMPTS).toBe(5);
    expect(MFA.PASSKEYS_PER_ACCOUNT).toBe(5);
    expect(MFA.PASSKEY_CHALLENGES_PER_CEREMONY).toBe(6);
    expect(MFA.PASSKEY_CHALLENGE_TTL_SECONDS).toBe(2 * MINUTE);
    expect(MFA.REAUTH_FAIL_BY_SESSION).toEqual({ limit: 5, windowSeconds: 15 * MINUTE });
    expect(MFA.ELEVATION_ISSUED_BY_SESSION).toEqual({ limit: 20, windowSeconds: HOUR });
    expect(MFA.ELEVATION_TICKET_TTL_SECONDS).toBe(60);
    expect(MFA.RECOVERY_CODE_COUNT).toBe(10);
  });

  it('match the approved policy document — second factors as settings', () => {
    const { SECURITY_SETTINGS } = policy();

    // One budget for BOTH settings surfaces, passkeys and the authenticator. See
    // SECURITY_SETTINGS in auth/limits.ts: the cheapest path on either guesses the
    // same account-scoped backup code, so a per-surface bucket would double the
    // guess budget while both limits still read as five.
    expect(SECURITY_SETTINGS.DISABLE_BY_ACCOUNT).toEqual({
      limit: 5,
      windowSeconds: 15 * MINUTE,
    });

    // "x times every y days", as the product scope words it. Admin-tunable through
    // the same versioned seam as everything else here, which is the whole reason it
    // lives in DEFAULTS rather than in auth.constants.ts.
    expect(SECURITY_SETTINGS.KYC_REVERIFY_BY_ACCOUNT).toEqual([
      { limit: 1, windowSeconds: DAY },
      { limit: 2, windowSeconds: 30 * DAY },
    ]);

    // At the ceiling a sliding log can express. A longer cooldown is not a
    // configuration change but a different mechanism — see BOUNDS.
    expect(SECURITY_SETTINGS.KYC_REVERIFY_BY_ACCOUNT[1]?.windowSeconds).toBe(30 * DAY);
  });

  it('match the approved policy document — the anti-phishing code', () => {
    const { ANTI_PHISHING, CREDENTIAL } = policy();

    // One bucket for `set`, `change` and `replace` together. A per-action key would
    // hand a caller thirty attempts an hour while this number still read ten, and the
    // action a flooder picks is `replace` — the one needing no current code — whatever
    // the other two are keyed on. See ANTI_PHISHING in auth/limits.ts.
    expect(ANTI_PHISHING.UPDATE_BY_ACCOUNT).toEqual({ limit: 10, windowSeconds: HOUR });

    // Deliberately LOOSER than the emailed-code budget, which is the ceiling that
    // actually binds: every operation on this setting needs a code that
    // CREDENTIAL.OTP_BY_ACCOUNT has to have sent first. The same arrangement
    // PASSWORD.UPDATE_BY_ACCOUNT has, and the reason this bucket can be a plain flood
    // ceiling rather than an anti-guessing one — there is no secret here to guess.
    expect(ANTI_PHISHING.UPDATE_BY_ACCOUNT.limit).toBeGreaterThan(
      CREDENTIAL.OTP_BY_ACCOUNT.limit,
    );
  });

  it('match the approved policy document — OAuth', () => {
    const { OAUTH } = policy();

    expect(OAUTH.START_BY_IP).toEqual({ limit: 30, windowSeconds: 15 * MINUTE });
    expect(OAUTH.START_BY_DEVICE).toEqual({ limit: 20, windowSeconds: 15 * MINUTE });
    expect(OAUTH.CALLBACK_BY_IP).toEqual({ limit: 10, windowSeconds: 15 * MINUTE });
    expect(OAUTH.LINK_BY_ACCOUNT).toEqual({ limit: 15, windowSeconds: HOUR });
    expect(OAUTH.STATE_TTL_SECONDS).toBe(10 * MINUTE);
    expect(OAUTH.PENDING_TTL_SECONDS).toBe(30 * MINUTE);
  });

  it('match the approved policy document — CAPTCHA', () => {
    const { CAPTCHA } = policy();

    expect(CAPTCHA.FAILURES_BY_IP).toEqual({ limit: 10, windowSeconds: 5 * MINUTE });
    expect(CAPTCHA.BLOCK_LADDER_SECONDS).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR]);
    // From the NEWEST strike. Anchoring to the first let a campaign wait the window out
    // and start again at rung one.
    expect(CAPTCHA.STRIKE_TTL_SECONDS).toBe(12 * HOUR);
  });

  it('match the approved policy document — sessions', () => {
    const { SESSION } = policy();

    expect(SESSION.REFRESH_SHORT).toEqual({ limit: 10, windowSeconds: 10 * MINUTE });
    expect(SESSION.REFRESH_HOURLY).toEqual({ limit: 30, windowSeconds: HOUR });
    expect(SESSION.ADMIN_BY_FAMILY).toEqual({ limit: 10, windowSeconds: MINUTE });
  });

  /**
   * The rows of the approved table that are LIFETIMES rather than rate limits. They
   * live in `auth/auth.constants.ts` because they are read directly rather than through
   * the policy accessor — but the founder approved them in the same document, so they
   * are pinned in the same place. If one of them ever moves into `DEFAULTS`, this test
   * is what makes the move visible instead of silent.
   */
  it('match the approved policy document — lifetimes', () => {
    expect(OTP.TTL_SECONDS).toBe(10 * MINUTE);
    expect(OTP.RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(OTP.MAX_ATTEMPTS).toBe(5);
    expect(REGISTRATION.TTL_SECONDS).toBe(30 * MINUTE);

    expect(SESSION_CONSTANTS.ACCESS_TTL_SECONDS).toBe(15 * MINUTE);
    expect(SESSION_CONSTANTS.IDLE_TIMEOUT_SECONDS).toBe(24 * HOUR);
    expect(SESSION_CONSTANTS.REMEMBER_ME_SECONDS).toBe(7 * DAY);

    // "Current 30-second step plus/minus 1".
    expect(TOTP.STEP_SECONDS).toBe(30);
    expect(TOTP.WINDOW).toBe(1);
  });

  it('escalates the lockout ladder strictly upward', () => {
    // A ladder with a flat or descending rung is not an escalation, and the bug would
    // be invisible in production — the third offence would simply cost no more than
    // the first.
    const ladder = policy().LOCKOUT.LADDER_SECONDS;

    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i] as number).toBeGreaterThan(ladder[i - 1] as number);
    }
  });

  it('remembers a lockout strike for longer than the longest rung', () => {
    // Otherwise the memory expires between penalties and every lock is the first one
    // again — exactly the defect the CAPTCHA strike counter had.
    const { LADDER_SECONDS, STRIKE_TTL_SECONDS } = policy().LOCKOUT;

    expect(STRIKE_TTL_SECONDS).toBeGreaterThan(Math.max(...LADDER_SECONDS));
  });

  it('remembers a captcha strike for longer than the longest block', () => {
    const { BLOCK_LADDER_SECONDS, STRIKE_TTL_SECONDS } = policy().CAPTCHA;

    expect(STRIKE_TTL_SECONDS).toBeGreaterThan(Math.max(...BLOCK_LADDER_SECONDS));
  });

  it('pairs every daily quota with a stricter short window', () => {
    // A set whose daily allowance is smaller than its hourly one has a dead rule in
    // it, and a reviewer reading either line alone would not see it.
    const sets = [
      policy().REGISTRATION.START_BY_IP,
      policy().REGISTRATION.START_BY_EMAIL,
      policy().REGISTRATION.START_BY_DEVICE,
      policy().REGISTRATION.OTP_MAIL_BY_RECIPIENT,
      policy().LOGIN_OTP.MAIL_BY_ACCOUNT,
    ];

    for (const [short, daily] of sets) {
      expect((daily as { windowSeconds: number }).windowSeconds).toBeGreaterThan(
        (short as { windowSeconds: number }).windowSeconds,
      );
      expect((daily as { limit: number }).limit).toBeGreaterThanOrEqual(
        (short as { limit: number }).limit,
      );
    }
  });
});

describe('applyPolicyOverrides', () => {
  it('accepts a change within bounds and serves it immediately', () => {
    const next = draft();
    next.PASSWORD_LOGIN.FLOOD_BY_IP = { limit: 120, windowSeconds: 900 };

    expect(applyPolicyOverrides(next)).toEqual([]);
    expect(policy().PASSWORD_LOGIN.FLOOD_BY_IP.limit).toBe(120);
  });

  it('refuses a limit of zero, which would lock everyone out', () => {
    const next = draft();
    next.PASSWORD_LOGIN.FLOOD_BY_IP = { limit: 0, windowSeconds: 900 };

    expect(applyPolicyOverrides(next)).not.toEqual([]);
    // The previous value has to still be live — a refused change must not leave the
    // service running on a half-applied policy.
    expect(policy().PASSWORD_LOGIN.FLOOD_BY_IP.limit).toBe(60);
  });

  it('refuses an absurdly high limit, which would silently disable the quota', () => {
    const next = draft();
    next.LOGIN_OTP.REQUEST_BY_IP = { limit: 10_000_000, windowSeconds: 900 };

    expect(applyPolicyOverrides(next)).not.toEqual([]);
    expect(policy().LOGIN_OTP.REQUEST_BY_IP.limit).toBe(20);
  });

  it('refuses a window longer than a month, because that is a ban', () => {
    const next = draft();
    next.LOGIN_OTP.REQUEST_BY_IP = { limit: 5, windowSeconds: 90 * 24 * 60 * 60 };

    expect(applyPolicyOverrides(next)).not.toEqual([]);
  });

  it('validates limits nested inside a set, not just top-level ones', () => {
    // The daily half of a pair is one level deeper than the plain rules, and a
    // validator that only walked objects would skip every array and miss half the
    // policy.
    const next = draft();
    next.REGISTRATION.START_BY_IP[1] = { limit: 0, windowSeconds: 86_400 };

    expect(applyPolicyOverrides(next)).not.toEqual([]);
  });

  it('applies nothing at all when one value in the batch is bad', () => {
    const next = draft();
    next.PASSWORD_LOGIN.FLOOD_BY_IP = { limit: 120, windowSeconds: 900 };
    next.LOGIN_OTP.REQUEST_BY_IP = { limit: 0, windowSeconds: 900 };

    expect(applyPolicyOverrides(next)).not.toEqual([]);
    // The good half of a rejected batch must not leak through: a half-applied policy
    // is a configuration nobody wrote and nobody reviewed.
    expect(policy().PASSWORD_LOGIN.FLOOD_BY_IP.limit).toBe(60);
  });

  it('reports every problem, not just the first', () => {
    const next = draft();
    next.PASSWORD_LOGIN.FLOOD_BY_IP = { limit: 0, windowSeconds: 900 };
    next.LOGIN_OTP.REQUEST_BY_IP = { limit: 5, windowSeconds: 0 };

    expect(applyPolicyOverrides(next).length).toBeGreaterThanOrEqual(2);
  });
});

describe('resetPolicy', () => {
  it('backs out a bad configuration without a deploy', () => {
    const next = draft();
    next.PASSWORD_LOGIN.FLOOD_BY_IP = { limit: 1, windowSeconds: 900 };
    applyPolicyOverrides(next);

    resetPolicy();

    expect(policy().PASSWORD_LOGIN.FLOOD_BY_IP.limit).toBe(60);
  });
});
