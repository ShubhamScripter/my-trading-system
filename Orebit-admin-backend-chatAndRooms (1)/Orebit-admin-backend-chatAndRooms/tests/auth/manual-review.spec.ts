import { describe, expect, it, vi } from 'vitest';
import { LoginService } from '../../auth/services/login.service';
import { ERR, PROBLEM_CATALOGUE } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin, makeAttempt, makeCredential } from '../harness';

/**
 * ═══ A SUSPENDED ACCOUNT IS SUSPENDED EVERYWHERE ═══════════════════════════
 *
 * Opening a manual review takes an account out of service. The question this file
 * answers is whether that holds on every door, or only on the front one.
 *
 * It has to hold everywhere, because a review can open MID-CEREMONY. An attacker who
 * has already proven a password holds a live step-up secret; ten more wrong passwords
 * from anywhere — including a second, concurrent sign-in attempt — suspends the
 * account, and the secret they are holding must stop working. Checking only at the
 * password step would leave the OTP step, the second factor and the refresh rotation
 * all reachable with credentials minted before the suspension.
 *
 * ─── Why this is cheap to enforce, and why that mattered ───────────────────
 *
 * The review columns live on `Admin` rather than on `AdminCredential`, and this file
 * is the argument for that choice. `LoginService.resolve` and `SessionService.rotate`
 * both already load an admin row and nothing else, so the check costs no extra read
 * and there is no second query for a future step to forget. On the credential, each of
 * these paths would have needed a join added by hand — which is exactly the shape of
 * check that gets added to two of three places.
 */

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

function makeCache() {
  return {
    consume: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    startCooldown: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    take: vi.fn().mockResolvedValue(null),
    flag: vi.fn().mockResolvedValue(false),
    setFlag: vi.fn().mockResolvedValue(undefined),
  };
}

/** An account the ladder has suspended: PENDING review, and DISABLED with it. That
 *  pairing is the only combination the state machine ever writes. */
const suspended = () =>
  makeAdmin({
    status: 'DISABLED',
    loginReviewStatus: 'PENDING',
    loginDisabledAt: new Date(),
    loginDisabledReason: 'REPEATED_PASSWORD_LOCKOUT',
  });

function build(admin = suspended()) {
  const attempts = {
    open: vi.fn().mockResolvedValue(makeAttempt()),
    findBySecretHash: vi.fn().mockResolvedValue(makeAttempt()),
    advanceState: vi.fn().mockResolvedValue(true),
    recordOtpSent: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 1 })),
    expire: vi.fn().mockResolvedValue(undefined),
  };

  const service = new LoginService(
    {
      findById: vi.fn().mockResolvedValue(admin),
      findByEmailWithCredential: vi
        .fn()
        .mockResolvedValue({ admin, credential: makeCredential() }),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
    } as never,
    attempts as never,
    { issue: vi.fn().mockResolvedValue({ id: 'c1' }) } as never,
    {
      checkPassword: vi.fn().mockResolvedValue({ valid: true, priorFailures: 0 }),
      verifyDummy: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      enrollmentState: vi.fn().mockResolvedValue({ needsEnrollment: false, methods: ['TOTP'] }),
    } as never,
    makeCache() as never,
    { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
  );

  return { service, attempts };
}

async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

const CREDS = { email: 'admin@orebit.io', password: 'CorrectHorse!2026' };
/** One browser, for the per-device failure bucket. Its own behaviour lives in
 *  device-limits.spec.ts and password-limits.spec.ts. */
const DEVICE_ID = 'PZ7yq1Xk3mQ0aB9cD2eF4gH6jK8lM1nO3pQ5rS7tU9v';

describe('the password step', () => {
  it('refuses a suspended account', async () => {
    const { service } = build();
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
  });

  /**
   * Even with the CORRECT password. That is the whole distinction from a rate limit:
   * a suspension is not "you are guessing too fast", it is "this account is out of
   * service", and knowing the password does not change it.
   */
  it('refuses even when the password is right', async () => {
    const { service } = build();
    // The double's checkPassword returns valid: true, so reaching the refusal at all
    // proves the check runs ahead of the verification.
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
  });

  it('opens no attempt', async () => {
    const { service, attempts } = build();

    await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(attempts.open).not.toHaveBeenCalled();
  });
});

/**
 * ═══ EVERY STEP AFTER THE PASSWORD ═════════════════════════════════════════
 *
 * `resolve` is the single gate for `resend-otp`, `verify-email`, `state` and every
 * action on `POST /2fa` — all of them resolve their attempt through it. So one check
 * there covers a surface that would otherwise need five, and this block drives the
 * gate rather than each of the five call sites.
 */
describe('resolve — the gate for every later step', () => {
  it('refuses a step-up secret belonging to a suspended account', async () => {
    const { service } = build();
    expect(await slugOf(() => service.resolve('a-live-secret', ctx()))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
  });

  /**
   * And RETIRES the attempt as it refuses. A half-authenticated caller holding a live
   * step-up secret is precisely the credential a suspension needs to invalidate —
   * leaving the row live would mean the secret kept resolving to something, and only
   * this one check would stand between it and the second factor.
   */
  it('retires the in-flight attempt', async () => {
    const { service, attempts } = build();

    await slugOf(() => service.resolve('a-live-secret', ctx()));

    expect(attempts.expire).toHaveBeenCalledWith(makeAttempt().id);
  });

  /**
   * === THE SPECIFIC SLUG WINS OVER THE GENERIC ONE ==========================
   *
   * Opening a review sets `status = 'DISABLED'` as well as the review state, so
   * checking status first would mask `admin_login_manual_review` behind
   * `account_disabled` on every suspended account — and the two mean different things
   * to whoever reads the screen. A disabled account was turned off by a person and the
   * remedy is to ask them; a suspended one was taken out by the system and has a review
   * queued against it.
   */
  it('reports the review rather than the disabled status it also sets', async () => {
    const { service } = build();
    const slug = await slugOf(() => service.resolve('a-live-secret', ctx()));

    expect(slug).toBe(ERR.ADMIN_LOGIN_MANUAL_REVIEW);
    expect(slug).not.toBe(ERR.ACCOUNT_DISABLED);
  });

  /** A plainly disabled account — no review — still answers the generic slug, so the
   *  ordering above narrows rather than replaces. */
  it('still answers account_disabled for an ordinary disabled account', async () => {
    const { service } = build(makeAdmin({ status: 'DISABLED' }));
    expect(await slugOf(() => service.resolve('a-live-secret', ctx()))).toBe(ERR.ACCOUNT_DISABLED);
  });

  /** And an ACTIVE account resolves normally, so the gate is not refusing everybody. */
  it('lets a healthy account through', async () => {
    const { service } = build(makeAdmin());
    const resolved = await service.resolve('a-live-secret', ctx());
    expect(resolved.admin.status).toBe('ACTIVE');
  });

  /**
   * A RESOLVED review is not a live one. An account a super admin has put back must
   * sign in normally — otherwise ENABLE would restore the row without restoring
   * access, which is the decision silently not taking effect.
   */
  it('lets a resolved review through', async () => {
    const { service } = build(makeAdmin({ loginReviewStatus: 'RESOLVED' }));
    const resolved = await service.resolve('a-live-secret', ctx());
    expect(resolved.admin.id).toBe(makeAdmin().id);
  });

  /**
   * A REJECTED review leaves the account disabled, so it is refused — by the status
   * check rather than the review check, which is correct: the super admin's decision
   * is recorded in `loginReviewStatus`, and what keeps the account out of service is
   * `status`.
   */
  it('keeps a rejected review out via the status it left behind', async () => {
    const { service } = build(
      makeAdmin({ status: 'DISABLED', loginReviewStatus: 'REJECTED' }),
    );
    expect(await slugOf(() => service.resolve('a-live-secret', ctx()))).toBe(ERR.ACCOUNT_DISABLED);
  });
});

describe('the catalogue entry', () => {
  /** 403, and no `Retry-After`. The client must not render a countdown for a refusal
   *  that time does not lift. */
  it('answers 403 with no wait attached', () => {
    expect(PROBLEM_CATALOGUE[ERR.ADMIN_LOGIN_MANUAL_REVIEW].status).toBe(403);
  });

  /** Distinct from both neighbours it could be confused with. */
  it('is its own slug, not a reuse of locked or disabled', () => {
    expect(ERR.ADMIN_LOGIN_MANUAL_REVIEW).not.toBe(ERR.ACCOUNT_LOCKED);
    expect(ERR.ADMIN_LOGIN_MANUAL_REVIEW).not.toBe(ERR.ACCOUNT_DISABLED);
  });
});
