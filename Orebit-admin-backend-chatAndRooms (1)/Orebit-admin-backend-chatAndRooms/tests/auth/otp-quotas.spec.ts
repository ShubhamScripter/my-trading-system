import { describe, expect, it, vi } from 'vitest';
import { LoginService } from '../../auth/services/login.service';
import { LIMITS, OTP, STEP_UP } from '../../auth/auth.constants';
import { ERR, PROBLEM_CATALOGUE } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KEYS } from '../../redis';
import { makeAdmin, makeAttempt, makeCredential } from '../harness';

/**
 * ═══ THREE BUDGETS ON SIGN-IN CODES, AND NONE REPLACES ANOTHER ═════════════
 *
 * `OTP.MAX_SENDS` is a Postgres counter on the ATTEMPT row. `LOGIN_OTP_SHORT` and
 * `LOGIN_OTP_DAILY` are Redis buckets on the ACCOUNT. They bound different things and
 * each is the others' blind spot:
 *
 *   per-attempt   caps one sign-in's resends. Trivially bypassed on its own — just
 *                 start a new attempt.
 *   short (5/15m) caps how fast attempts can be restarted to keep sending.
 *   daily (50/24h) caps the total. Ten full ceremonies; unreachable by use.
 *
 * The per-attempt counter is also the only DURABLE one. This service's cache runs
 * `--save "" --appendonly no`, so a restart wipes both buckets — without the durable
 * check, the send budget would reset to zero-used on every deploy while the API went
 * on reporting `otpSendsRemaining` from a counter nothing enforced.
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

function build(cache = makeCache(), challengeOverrides: Record<string, unknown> = {}) {
  const admin = makeAdmin();
  const challenges = {
    issue: vi.fn().mockResolvedValue({ id: 'challenge-1' }),
    findLive: vi.fn().mockResolvedValue(null),
    invalidate: vi.fn().mockResolvedValue(undefined),
    ...challengeOverrides,
  };
  const otpQueue = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const attempts = {
    open: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 0, lastOtpSentAt: null })),
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
    challenges as never,
    {
      checkPassword: vi.fn().mockResolvedValue({ valid: true, priorFailures: 0 }),
      verifyDummy: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      enrollmentState: vi.fn().mockResolvedValue({ needsEnrollment: false, methods: ['TOTP'] }),
    } as never,
    cache as never,
    otpQueue as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
  );

  return { service, cache, challenges, otpQueue, attempts, admin };
}

const CREDS = { email: 'admin@orebit.io', password: 'CorrectHorse!2026' };
/** One browser, for the per-device failure bucket. Its own behaviour lives in
 *  device-limits.spec.ts and password-limits.spec.ts. */
const DEVICE_ID = 'PZ7yq1Xk3mQ0aB9cD2eF4gH6jK8lM1nO3pQ5rS7tU9v';
const EMAIL = makeAdmin().emailLower;
const SHORT = KEYS.rate.loginOtpShort(EMAIL);
const DAILY = KEYS.rate.loginOtpDaily(EMAIL);
const COOLDOWN = KEYS.rate.loginOtpCooldown(EMAIL);

async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

describe('the quota shapes', () => {
  it('allows five in a quarter hour', () => {
    expect(LIMITS.LOGIN_OTP_SHORT).toEqual({ limit: 5, windowSeconds: 15 * 60 });
  });

  it('allows fifty in a day', () => {
    expect(LIMITS.LOGIN_OTP_DAILY).toEqual({ limit: 50, windowSeconds: 24 * 60 * 60 });
  });

  /**
   * The short quota must not be able to refuse a code inside an attempt that still has
   * budget. Five sends per attempt against five per fifteen minutes, with the attempt
   * itself expiring in ten — so the per-attempt budget is always the binding
   * constraint within one ceremony, and the short quota only bites across attempts.
   */
  it('cannot refuse a code inside an attempt that still has budget', () => {
    expect(LIMITS.LOGIN_OTP_SHORT.limit).toBeGreaterThanOrEqual(OTP.MAX_SENDS);
    expect(LIMITS.LOGIN_OTP_SHORT.windowSeconds).toBeGreaterThan(STEP_UP.TTL_SECONDS);
  });

  it('bounds the day above the burst', () => {
    expect(LIMITS.LOGIN_OTP_DAILY.limit).toBeGreaterThan(LIMITS.LOGIN_OTP_SHORT.limit);
  });
});

describe('charging', () => {
  it('charges both quotas on a send', async () => {
    const { service, cache } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const charged = cache.consume.mock.calls.map(([key]) => key as string);
    expect(charged).toContain(SHORT);
    expect(charged).toContain(DAILY);
  });

  /**
   * `deny`, not `allow`. This gates outbound email, and unlike the login limiters —
   * which sit in front of durable Postgres counters — nothing else keeps metering it
   * when Redis is unreachable. An unreadable limiter must not leave the sender
   * unmetered; a cache outage should degrade sign-in, not open an email relay.
   */
  it('fails closed on both', async () => {
    const { service, cache } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    for (const key of [SHORT, DAILY]) {
      const call = cache.consume.mock.calls.find(([k]) => k === key);
      expect(call?.[2]).toBe('deny');
    }
  });

  /** Refusing the short quota refuses the send, and the slug is the generic rate
   *  limit rather than an OTP-specific one — the caller's remedy is to wait. */
  it('refuses the send when the short quota is exhausted', async () => {
    const cache = makeCache();
    cache.consume.mockImplementation(async (key: string) => {
      if (key === SHORT) {
        throw new ProblemException({ type: ERR.RATE_LIMITED, retryAfterSeconds: 300 });
      }
    });
    const { service, otpQueue } = build(cache);

    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.RATE_LIMITED);
    expect(otpQueue.enqueue).not.toHaveBeenCalled();
  });

  it('refuses the send when the daily quota is exhausted', async () => {
    const cache = makeCache();
    cache.consume.mockImplementation(async (key: string) => {
      if (key === DAILY) {
        throw new ProblemException({ type: ERR.RATE_LIMITED, retryAfterSeconds: 3600 });
      }
    });
    const { service, otpQueue } = build(cache);

    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.RATE_LIMITED);
    expect(otpQueue.enqueue).not.toHaveBeenCalled();
  });

  /**
   * A quota that refuses must not have destroyed the live code on its way out. The
   * daily quota is charged AFTER the short one and BEFORE the challenge is issued, so
   * this pins that ordering: a refusal at either quota leaves the admin's existing
   * code intact.
   */
  it('destroys nothing when a quota refuses', async () => {
    const cache = makeCache();
    cache.consume.mockImplementation(async (key: string) => {
      if (key === DAILY) throw new ProblemException({ type: ERR.RATE_LIMITED });
    });
    const { service, challenges, attempts } = build(cache);

    await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(challenges.issue).not.toHaveBeenCalled();
    expect(attempts.recordOtpSent).not.toHaveBeenCalled();
  });
});

describe('the per-attempt budget', () => {
  it('refuses a resend once the attempt has spent five codes', async () => {
    const { service, admin } = build();
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });

    expect(await slugOf(() => service.resendOtp({ attempt: spent, admin }, ctx()))).toBe(
      ERR.OTP_SEND_LIMIT_REACHED,
    );
  });

  /**
   * Checked FIRST — above the cooldown and above both quotas. An exhausted attempt
   * should be told its budget is gone rather than told to wait sixty seconds for a
   * code that will never be sent, and it should not spend a quota slot finding out.
   */
  it('is checked before the cooldown and before either quota', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, admin } = build(cache);
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });

    await slugOf(() => service.resendOtp({ attempt: spent, admin }, ctx()));

    expect(cache.cooldownRemaining).not.toHaveBeenCalled();
    expect(cache.consume).not.toHaveBeenCalled();
  });

  /** And reports zero remaining, so the client can say "start again" rather than
   *  offering a resend button that cannot work. */
  it('reports zero remaining', async () => {
    const { service, admin } = build();
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });

    const err = await service
      .resendOtp({ attempt: spent, admin }, ctx())
      .then(() => null, (e: unknown) => e);

    expect((err as ProblemException).extra).toMatchObject({ otpSendsRemaining: 0 });
  });
});

describe('the sixty-second cooldown', () => {
  /**
   * ═══ IT HOLDS ACROSS ATTEMPTS NOW ══════════════════════════════════════════
   *
   * `withPassword` used to pass `force: true` to skip it, because otherwise signing in
   * twice inside sixty seconds stranded the second attempt with no usable code.
   *
   * The exemption is gone and the stranding is gone with it, for a structural reason
   * rather than a second special case — see the ordering block below.
   */
  it('suppresses a second code on a fresh password proof', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, otpQueue } = build(cache);

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(otpQueue.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses a resend', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, admin, otpQueue } = build(cache);

    await service.resendOtp({ attempt: makeAttempt(), admin }, ctx());

    expect(otpQueue.enqueue).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE ORDERING HAZARD ═══════════════════════════════════════════════════
   *
   * `ChallengeDbOperation.issue` supersedes the live code as it writes the new one —
   * that is what makes "resend" mean resend rather than "now two codes work".
   *
   * So checking the cooldown AFTER issuing would kill the code the admin is currently
   * holding, to make room for one that is then not sent. They would be left with no
   * usable code and a sixty-second wait before they could even ask for another: the
   * exact self-inflicted lockout this whole change exists to remove, reintroduced by
   * an ordering mistake that looks completely harmless.
   */
  it('destroys nothing while the cooldown is running', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, challenges, attempts } = build(cache);

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(challenges.issue).not.toHaveBeenCalled();
    expect(attempts.recordOtpSent).not.toHaveBeenCalled();
  });

  /** And spends no quota, so hammering during the wait is free. */
  it('spends no quota while the cooldown is running', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service } = build(cache);

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const charged = cache.consume.mock.calls.map(([key]) => key as string);
    expect(charged).not.toContain(SHORT);
    expect(charged).not.toContain(DAILY);
  });

  /** It reports the wait rather than refusing: the caller asked for something already
   *  on its way, and a countdown is more useful than an error. */
  it('reports the wait instead of throwing', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service } = build(cache);

    const { outcome } = await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(outcome.kind).toBe('email_otp_required');
    expect((outcome as { resendAvailableAt: Date | null }).resendAvailableAt).not.toBeNull();
  });

  /** Started only once a job is actually queued. */
  it('starts after the code is queued', async () => {
    const { service, cache } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(cache.startCooldown).toHaveBeenCalledWith(COOLDOWN, OTP.RESEND_COOLDOWN_SECONDS);
  });
});

describe('superseding the previous code', () => {
  /**
   * A resend invalidates its predecessor, which is what keeps the attempt cap meaning
   * five guesses per FLOW rather than five per code — otherwise five resends would buy
   * twenty-five guesses against a six-digit space.
   */
  it('issues through the superseding path', async () => {
    const { service, challenges } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(challenges.issue).toHaveBeenCalledOnce();
    expect(challenges.issue).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'LOGIN_EMAIL_OTP' }),
    );
  });

  /** Ten minutes, and the deadline travels to the queue so the worker can refuse to
   *  deliver a code that died waiting on a relay. */
  it('gives the new code a ten-minute life and tells the queue', async () => {
    const { service, challenges, otpQueue } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const issued = challenges.issue.mock.calls[0]?.[0] as { expiresAt: Date };
    const queued = otpQueue.enqueue.mock.calls[0]?.[0] as { validUntil: Date };

    const lifetimeSeconds = Math.round((issued.expiresAt.getTime() - Date.now()) / 1000);
    expect(lifetimeSeconds).toBeGreaterThan(OTP.TTL_SECONDS - 5);
    expect(lifetimeSeconds).toBeLessThanOrEqual(OTP.TTL_SECONDS);
    expect(queued.validUntil).toEqual(issued.expiresAt);
  });
});

describe('an expired code at verification', () => {
  /**
   * ═══ 400, AND NO AUTOMATIC RESEND ══════════════════════════════════════════
   *
   * Two properties, both easy to get wrong in the helpful direction.
   *
   * The status moved from 410 to 400 so the two "your code did not work" answers share
   * one status — a client handling them by status had to special-case one of two
   * outcomes of the same input box.
   *
   * And nothing is re-sent. An automatic resend on expiry would be a free email send
   * triggered by an unauthenticated-ish request, outside every quota, which is an open
   * relay reachable by anyone holding a step-up secret.
   */
  it('answers 400', () => {
    expect(PROBLEM_CATALOGUE[ERR.OTP_EXPIRED].status).toBe(400);
  });

  it('shares a status with an incorrect code', () => {
    expect(PROBLEM_CATALOGUE[ERR.OTP_EXPIRED].status).toBe(
      PROBLEM_CATALOGUE[ERR.OTP_INVALID].status,
    );
  });

  it('sends nothing when verification finds no live challenge', async () => {
    // The double's `findLive` returns null by default, which is what an expired or
    // already-spent code looks like to `verifyChallengeCode`.
    const { service, admin, otpQueue } = build();

    expect(
      await slugOf(() => service.verifyEmail({ attempt: makeAttempt(), admin }, '123456')),
    ).toBe(ERR.OTP_EXPIRED);
    expect(otpQueue.enqueue).not.toHaveBeenCalled();
  });
});
