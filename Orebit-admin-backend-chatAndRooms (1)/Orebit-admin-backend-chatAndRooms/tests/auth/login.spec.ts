import { describe, expect, it, vi } from 'vitest';
import { LoginService } from '../../auth/services/login.service';
import { OTP } from '../../auth/auth.constants';
import { pepperedHash } from '../../auth/auth.utility';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KEYS } from '../../redis';
import { makeAdmin, makeAttempt, makeCredential } from '../harness';

/**
 * LoginService, against doubled persistence.
 *
 * Doubles rather than a live database, because what these tests are about is
 * ORDERING and DISCLOSURE — which checks run before which, and what each failure
 * reveals about whether an account exists. Those are properties of this file's
 * control flow, and a real database would only make them slower to assert.
 *
 * The one thing a double cannot check is the compare-and-swap semantics that the
 * dboperations rely on. Those live in the WHERE clauses and are exercised by the
 * end-to-end run, not here.
 */

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

/** A cache that always succeeds and never limits, so a spec only sees the
 *  behaviour it is actually about. Specs that care override individual methods. */
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

interface Doubles {
  admins: Record<string, ReturnType<typeof vi.fn>>;
  attempts: Record<string, ReturnType<typeof vi.fn>>;
  challenges: Record<string, ReturnType<typeof vi.fn>>;
  credentials: Record<string, ReturnType<typeof vi.fn>>;
  mfa: Record<string, ReturnType<typeof vi.fn>>;
  cache: ReturnType<typeof makeCache>;
  otpQueue: Record<string, ReturnType<typeof vi.fn>>;
  events: Record<string, ReturnType<typeof vi.fn>>;
}

function build(overrides: Partial<Doubles> = {}) {
  const admin = makeAdmin();

  const doubles: Doubles = {
    admins: {
      findByEmailWithCredential: vi
        .fn()
        .mockResolvedValue({ admin, credential: makeCredential() }),
      findById: vi.fn().mockResolvedValue(admin),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
      touchLastSeen: vi.fn().mockResolvedValue(undefined),
      ...overrides.admins,
    },
    attempts: {
      open: vi.fn().mockResolvedValue(makeAttempt()),
      findBySecretHash: vi.fn().mockResolvedValue(makeAttempt()),
      advanceState: vi.fn().mockResolvedValue(true),
      recordOtpSent: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 1 })),
      expire: vi.fn().mockResolvedValue(undefined),
      ...overrides.attempts,
    },
    challenges: {
      issue: vi.fn().mockResolvedValue({ id: 'challenge-1' }),
      findLive: vi.fn().mockResolvedValue(null),
      incrementAttempts: vi.fn().mockResolvedValue(1),
      consume: vi.fn().mockResolvedValue(true),
      invalidate: vi.fn().mockResolvedValue(undefined),
      ...overrides.challenges,
    },
    credentials: {
      // The record shape, not a bare boolean. `priorFailures` is what drives the
      // ADMIN_LOGIN_PASSWORD_SUCCESS_AFTER_FAILURES event, and a double returning
      // `true` would make that branch unreachable rather than merely untested.
      checkPassword: vi.fn().mockResolvedValue({ valid: true, priorFailures: 0 }),
      // Present on every build, so a spec that asserts the timing mask was NOT taken
      // is asserting against a real spy rather than an absent method.
      verifyDummy: vi.fn().mockResolvedValue(undefined),
      ...overrides.credentials,
    },
    mfa: {
      enrollmentState: vi
        .fn()
        .mockResolvedValue({ needsEnrollment: false, methods: ['TOTP'] }),
      ...overrides.mfa,
    },
    cache: overrides.cache ?? makeCache(),
    otpQueue: {
      // The queue accepts the job and says nothing about delivery — which is the
      // whole point of the change these doubles reflect. `LoginService` no longer
      // learns whether a relay took the message, so there is no send outcome to
      // branch on here. What happens when delivery fails is `OtpQueueService`'s
      // business and is asserted in tests/mail/otp-queue.spec.ts.
      enqueue: vi.fn().mockResolvedValue('01920000-0000-7000-8000-0000000000ff'),
      ...overrides.otpQueue,
    },
    events: {
      record: vi.fn().mockResolvedValue(undefined),
      ...overrides.events,
    },
  };

  const service = new LoginService(
    doubles.admins as never,
    doubles.attempts as never,
    doubles.challenges as never,
    doubles.credentials as never,
    doubles.mfa as never,
    doubles.cache as never,
    doubles.otpQueue as never,
    doubles.events as never,
  );

  return { service, doubles, admin };
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

/** One browser, for the per-device login bucket. A fixed value so every spec here
 *  charges the same bucket; the bucket's own behaviour is in device-limits.spec.ts
 *  and its interaction with the failure/success split is in password-limits.spec.ts. */
const DEVICE_ID = 'PZ7yq1Xk3mQ0aB9cD2eF4gH6jK8lM1nO3pQ5rS7tU9v';

describe('withPassword — what it discloses', () => {
  /**
   * An unknown address and a wrong password answer identically. This endpoint is
   * unauthenticated, so a difference would make it an admin-existence oracle for
   * any address anyone cares to type.
   */
  it('answers invalid_credentials for an unknown address', async () => {
    const { service } = build({
      admins: { findByEmailWithCredential: vi.fn().mockResolvedValue(null) },
    });
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.INVALID_CREDENTIALS);
  });

  it('answers invalid_credentials for a wrong password', async () => {
    const { service } = build({
      credentials: {
        checkPassword: vi.fn().mockResolvedValue({ valid: false, priorFailures: 0 }),
      },
    });
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.INVALID_CREDENTIALS);
  });

  /**
   * === THE TIMING MASK ======================================================
   *
   * The two answers above are byte-identical, which was always true and was never
   * enough. This method used to return for an unknown address WITHOUT reaching
   * argon2 — and a comment here claimed there was "no timing tell worth chasing".
   * There was: argon2id at 19 MiB is ~50ms and is the dominant cost of the request,
   * so the unknown-email path was an order of magnitude faster and the clock
   * separated two responses the body could not.
   *
   * `verifyDummy` burns the same work against a real argon2 hash and throws the
   * answer away. Asserting it is CALLED is the only thing a unit test can do here —
   * whether the durations actually match is a property of argon2, not of this file.
   */
  it('burns the same argon2 work for an unknown address', async () => {
    const verifyDummy = vi.fn().mockResolvedValue(undefined);
    const { service } = build({
      admins: { findByEmailWithCredential: vi.fn().mockResolvedValue(null) },
      credentials: { verifyDummy },
    });

    await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(verifyDummy).toHaveBeenCalledOnce();
    expect(verifyDummy).toHaveBeenCalledWith(CREDS.password);
  });

  /**
   * The second-order version of the same leak, and the easier one to forget.
   *
   * If only real accounts charged the failure buckets, an attacker could tell an
   * unknown address from a wrong password by watching which bucket depletes — send
   * eight guesses at a candidate address, then check whether a known-good address
   * from the same IP is refused. The timing mask would be intact and the disclosure
   * would be back.
   */
  it('charges the failure buckets for an unknown address too', async () => {
    const cache = makeCache();
    const { service } = build({
      admins: { findByEmailWithCredential: vi.fn().mockResolvedValue(null) },
      cache,
    });

    await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    const charged = cache.consume.mock.calls.map(([key]) => key as string);
    expect(charged).toContain(KEYS.rate.loginFailureByIp(ctx().ip));
    expect(charged).toContain(KEYS.rate.loginFailureByDevice(DEVICE_ID));
  });

  /**
   * An account the lockout ladder has suspended answers its own slug, distinct from
   * `account_disabled` — the remedy differs, and a client that showed "contact an
   * administrator" for one and "your account is disabled" for the other is telling
   * the admin something useful rather than something generic.
   */
  it('answers admin_login_manual_review for a suspended account', async () => {
    const { service } = build({
      admins: {
        findByEmailWithCredential: vi.fn().mockResolvedValue({
          admin: makeAdmin({ status: 'DISABLED', loginReviewStatus: 'PENDING' }),
          credential: makeCredential(),
        }),
      },
    });
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
  });

  /**
   * And it wins over `account_disabled`, which is not cosmetic: opening a review
   * sets `status = 'DISABLED'` too, so checking status first would mask the specific
   * answer behind the generic one on every suspended account.
   */
  it('reports the review rather than the disabled status it also sets', async () => {
    const checkPassword = vi.fn().mockResolvedValue({ valid: true, priorFailures: 0 });
    const { service } = build({
      admins: {
        findByEmailWithCredential: vi.fn().mockResolvedValue({
          admin: makeAdmin({ status: 'DISABLED', loginReviewStatus: 'PENDING' }),
          credential: makeCredential(),
        }),
      },
      credentials: { checkPassword },
    });

    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
    // And without checking the password, for the same reason a disabled account is
    // refused without one: the answer does not depend on it.
    expect(checkPassword).not.toHaveBeenCalled();
  });

  /**
   * A missing credential row is an ANOMALY here, not a passwordless account.
   * Every admin is seeded with a password, so unlike the consumer backend there is
   * no `otp_required` branch to fall through to — and inventing one would be a way
   * in that bypasses the password entirely.
   */
  it('answers invalid_credentials when the account has no password row', async () => {
    const admin = makeAdmin();
    const { service } = build({
      admins: {
        // The account resolves; the PASSWORD row does not. One read now answers
        // both, so this is `credential: null` rather than a second empty lookup.
        findByEmailWithCredential: vi.fn().mockResolvedValue({ admin, credential: null }),
      },
    });
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.INVALID_CREDENTIALS);
  });

  /**
   * `account_disabled` DOES disclose that the account exists, deliberately —
   * someone being turned away needs to know they are being turned away rather than
   * retrying a password that was never the problem.
   */
  it('answers account_disabled for a disabled admin', async () => {
    const { service } = build({
      admins: {
        findByEmailWithCredential: vi.fn().mockResolvedValue({
          admin: makeAdmin({ status: 'DISABLED' }),
          credential: makeCredential(),
        }),
      },
    });
    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(ERR.ACCOUNT_DISABLED);
  });

  /** A disabled account must be refused BEFORE the password is even checked, so a
   *  disabled admin's password cannot be probed for validity. */
  it('refuses a disabled admin without checking the password', async () => {
    const checkPassword = vi.fn().mockResolvedValue(true);
    const { service } = build({
      admins: {
        findByEmailWithCredential: vi.fn().mockResolvedValue({
          admin: makeAdmin({ status: 'DISABLED' }),
          credential: makeCredential(),
        }),
      },
      credentials: { checkPassword },
    });
    await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID));
    expect(checkPassword).not.toHaveBeenCalled();
  });
});

describe('withPassword — what it does on success', () => {
  /**
   * The account and its password come from ONE read.
   *
   * This was two — resolve by email, then re-read the same row by id to reach the
   * credential — and the second read's `admin` was discarded, so the whole of what
   * it added was a round trip on the step an admin actually waits on. Asserted
   * rather than left to review, because the two-read shape is the one somebody
   * reintroduces by reaching for a "load the credential" helper.
   */
  it('reads the admin and credential exactly once', async () => {
    const { service, doubles } = build();
    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(doubles.admins['findByEmailWithCredential']).toHaveBeenCalledOnce();
    expect(doubles.admins['findByEmailWithCredential']).toHaveBeenCalledWith(
      CREDS.email.toLowerCase(),
    );
    // Nothing re-reads the account to reach the password.
    expect(doubles.admins['findById']).not.toHaveBeenCalled();
  });

  it('opens an attempt, sends a code, and returns a step-up secret', async () => {
    const { service, doubles } = build();
    const result = await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(result.outcome.kind).toBe('email_otp_required');
    expect(result.stepUpSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(doubles.attempts['open']).toHaveBeenCalledOnce();
    expect(doubles.otpQueue['enqueue']).toHaveBeenCalledOnce();
  });

  /**
   * Only the HASH of the step-up secret is stored. The plaintext goes to the
   * client and must never be recoverable from the database — same reason a
   * password is hashed.
   */
  it('stores only the hash of the step-up secret', async () => {
    const { service, doubles } = build();
    const { stepUpSecret } = await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const stored = doubles.attempts['open']?.mock.calls[0]?.[0] as {
      stepUpSecretHash: string;
    };
    expect(stored.stepUpSecretHash).not.toBe(stepUpSecret);
    expect(stored.stepUpSecretHash).toBe(pepperedHash(stepUpSecret, 'stepup'));
    expect(stored.stepUpSecretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  /** Never the plaintext code. A database leak must not hand over live codes. */
  it('stores only the hash of the emailed code', async () => {
    const { service, doubles } = build();
    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const issued = doubles.challenges['issue']?.mock.calls[0]?.[0] as { codeHash: string };
    // The queued job, not a mail call: the plaintext now travels to a worker rather
    // than to a relay, and this is the only place it exists outside the digest.
    const emailed = (doubles.otpQueue['enqueue']?.mock.calls[0]?.[0] as { code: string })
      .code;

    expect(emailed).toMatch(/^\d{6}$/);
    expect(issued.codeHash).toBe(pepperedHash(emailed, 'otp'));
    expect(issued.codeHash).not.toContain(emailed);
  });

  /**
   * ═══ THE INVARIANT THIS SERVICE EXISTS TO HOLD ═════════════════════════════
   *
   * Nothing on the password path produces a session. `LoginService` does not even
   * inject `SessionService`, so it could not mint one — this asserts the observable
   * half of that.
   */
  it('issues NO session, on any password-path outcome', async () => {
    const { service } = build();
    const result = await service.withPassword(CREDS, ctx(), DEVICE_ID);
    expect(result.outcome.kind).not.toBe('session');
    expect(JSON.stringify(result.outcome)).not.toContain('accessToken');
  });

  /**
   * === REVERSED, DELIBERATELY ================================================
   *
   * This used to assert the opposite: a fresh password proof bypassed the resend
   * cooldown, via `force: true`, because otherwise signing in twice inside sixty
   * seconds stranded the second attempt with no usable code.
   *
   * Policy is now that the cooldown holds across attempts, and the stranding is gone
   * for a structural reason rather than a second exception — the cooldown is checked
   * before the challenge is superseded, so the code already in the inbox survives and
   * the new attempt can verify it. The full argument, and the assertion that nothing
   * is destroyed on this path, is in 'handing the code to the queue' below.
   */
  it('does not queue a second code while a resend cooldown is running', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, doubles } = build({ cache });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);
    expect(doubles.otpQueue['enqueue']).not.toHaveBeenCalled();
  });
});

// --- delivery is the queue's problem now -------------------------------------

/**
 * === WHAT MOVED, AND WHY THESE TESTS LOOK SMALLER THAN THEY DID =============
 *
 * There used to be three describe blocks here — "a failed mail handover", "a
 * rejected recipient", and "the response shape does not depend on the send
 * outcome" — asserting that an SMTP failure did not spend the admin's budget.
 *
 * They are gone because the behaviour they guarded is no longer reachable from
 * this file. `LoginService` used to await `MailService.sendLoginOtp` inside the
 * request and branch on `'sent' | 'rejected' | 'unreachable'`. It now hands the
 * job to `OtpQueueService` and returns; delivery happens later, in a worker, and
 * the compensation for a failed delivery happens there too.
 *
 * The PROPERTY those tests protected is unchanged and still tested — an SMTP
 * outage must not become a self-inflicted lockout — it is just tested where it now
 * lives, in tests/mail/otp-queue.spec.ts. What belongs here is the half this file
 * still owns: that the charges happen in the right ORDER, and that nothing is
 * spent or destroyed on a path that will not enqueue.
 */
describe('handing the code to the queue', () => {
  it('enqueues the code rather than sending it inline', async () => {
    const { service, doubles } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(doubles.otpQueue['enqueue']).toHaveBeenCalledOnce();
  });

  /**
   * The job carries the plaintext code, and the challenge row carries only its
   * peppered digest. Both halves matter: the worker cannot email a hash, and a
   * database leak must not hand over live codes.
   */
  it('queues the plaintext code but stores only its hash', async () => {
    const { service, doubles } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const job = doubles.otpQueue['enqueue']?.mock.calls[0]?.[0] as { code: string };
    const issued = doubles.challenges['issue']?.mock.calls[0]?.[0] as { codeHash: string };

    expect(job.code).toMatch(/^\d{6}$/);
    expect(issued.codeHash).toBe(pepperedHash(job.code, 'otp'));
    expect(issued.codeHash).not.toContain(job.code);
  });

  /**
   * The worker needs every handle the compensation path will spend: the challenge
   * to invalidate, the attempt whose counter to give back, and the email the two
   * rolling quotas and the cooldown are keyed on. A job missing any of them is a
   * job whose failure cannot be undone.
   */
  it('queues the handles the compensation path will need', async () => {
    const { service, doubles, admin } = build();

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(doubles.otpQueue['enqueue']).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: admin.id,
        emailLower: admin.emailLower,
        to: admin.email,
      }),
    );
    const job = doubles.otpQueue['enqueue']?.mock.calls[0]?.[0] as {
      challengeId: unknown;
      attemptId: unknown;
      validUntil: Date;
    };
    expect(job.challengeId).toBeDefined();
    expect(job.attemptId).toBeDefined();
    // The worker refuses to deliver a code that died waiting on a relay, so the
    // deadline has to travel with the job rather than being recomputed later.
    expect(job.validUntil.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * === THE COOLDOWN NOW HOLDS ACROSS ATTEMPTS ================================
   *
   * This is a deliberate REVERSAL. `withPassword` used to pass `force: true` so a
   * fresh password proof always got a fresh code, on the reasoning that otherwise
   * signing in twice inside sixty seconds stranded the second attempt.
   *
   * Policy is now that the sixty seconds holds regardless, and the stranding it
   * avoided no longer happens — because the cooldown is checked BEFORE anything is
   * invalidated. The code already in the admin's inbox stays alive and stays
   * verifiable by the new attempt, since the challenge is keyed on the account.
   */
  it('does not send a second code inside the cooldown', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, doubles } = build({ cache });

    const result = await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(doubles.otpQueue['enqueue']).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ kind: 'email_otp_required' });
  });

  /**
   * === THE ORDERING HAZARD THIS ASSERTS AGAINST ==============================
   *
   * `ChallengeDbOperation.issue` supersedes the live code as it writes the new one.
   * So checking the cooldown AFTER issuing would kill the code the admin is holding
   * to make room for one that is never sent — leaving them with no usable code and
   * a sixty-second wait before they could even ask. That is the exact
   * self-inflicted lockout this whole change exists to remove, reintroduced by an
   * ordering mistake that looks harmless.
   */
  it('destroys nothing when the cooldown blocks the send', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service, doubles } = build({ cache });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(doubles.challenges['issue']).not.toHaveBeenCalled();
    expect(cache.consume).not.toHaveBeenCalledWith(
      KEYS.rate.loginOtpShort(makeAdmin().emailLower),
      expect.anything(),
      expect.anything(),
    );
    expect(doubles.attempts['recordOtpSent']).not.toHaveBeenCalled();
  });

  /** And it reports the wait, so the client can count down rather than guess. */
  it('reports the remaining wait instead of refusing', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const { service } = build({ cache });

    const result = await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(result.outcome).toMatchObject({ kind: 'email_otp_required' });
    const { resendAvailableAt } = result.outcome as { resendAvailableAt: Date | null };
    expect(resendAvailableAt).not.toBeNull();
  });

  /**
   * Charged before the job is queued, and both of them. A quota checked after the
   * enqueue is a quota that has already been exceeded.
   */
  it('charges both rolling quotas before enqueuing', async () => {
    const cache = makeCache();
    const { service, doubles } = build({ cache });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const charged = cache.consume.mock.calls.map(([key]) => key as string);
    expect(charged).toContain(KEYS.rate.loginOtpShort(makeAdmin().emailLower));
    expect(charged).toContain(KEYS.rate.loginOtpDaily(makeAdmin().emailLower));
    expect(doubles.otpQueue['enqueue']).toHaveBeenCalledOnce();
  });

  /**
   * `deny`, not `allow`. This gates outbound email and — unlike the login limiters,
   * which sit in front of durable Postgres counters — there is no second mechanism
   * that keeps metering it when Redis is unreachable. An unreadable limiter must
   * not leave the sender unmetered.
   */
  it('fails closed on both OTP quotas when the cache is unreachable', async () => {
    const cache = makeCache();
    const { service } = build({ cache });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const otpCalls = cache.consume.mock.calls.filter(([key]) =>
      [
        KEYS.rate.loginOtpShort(makeAdmin().emailLower),
        KEYS.rate.loginOtpDaily(makeAdmin().emailLower),
      ].includes(key as string),
    );
    expect(otpCalls).toHaveLength(2);
    for (const call of otpCalls) expect(call[2]).toBe('deny');
  });
});


// ─── B2: the durable send budget is enforced, not just displayed ─────────────

/**
 * ═══ A LIMIT THAT WAS ADVERTISED AND NEVER APPLIED ═════════════════════════
 *
 * `OTP.MAX_SENDS` is 5 and `AdminLoginAttempt.otpSentCount` was incremented on
 * every send — but the value was read in exactly ONE place, to compute the
 * `otpSendsRemaining` shown to the client. Nothing compared the two, so the API
 * counted down to zero and then kept sending.
 *
 * The only real cap was the Redis bucket, and this deployment makes that
 * insufficient rather than merely redundant: `docker-compose.yml` runs
 * `redis-cache` with `--save "" --appendonly no`, so every restart resets the
 * budget to zero-used while the durable counter keeps reporting 0 remaining.
 */
describe('the durable OTP send budget', () => {
  /** ═══ B2 ══════════════════════════════════════════════════════════════════ */
  it('refuses a send once the attempt has reached MAX_SENDS', async () => {
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    const { service, admin } = build();

    expect(await slugOf(() => service.resendOtp({ attempt: spent, admin }, ctx()))).toBe(
      ERR.OTP_SEND_LIMIT_REACHED,
    );
  });

  it('does not email anything once refused', async () => {
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    const { service, admin, doubles } = build();

    await slugOf(() => service.resendOtp({ attempt: spent, admin }, ctx()));

    expect(doubles.otpQueue['enqueue']).not.toHaveBeenCalled();
    expect(doubles.challenges['issue']).not.toHaveBeenCalled();
  });

  it('permits the send that reaches the cap but not the one after', async () => {
    const { service, admin, doubles } = build();

    const last = makeAttempt({ otpSentCount: OTP.MAX_SENDS - 1 });
    await service.resendOtp({ attempt: last, admin }, ctx());
    expect(doubles.otpQueue['enqueue']).toHaveBeenCalledOnce();

    const over = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    expect(await slugOf(() => service.resendOtp({ attempt: over, admin }, ctx()))).toBe(
      ERR.OTP_SEND_LIMIT_REACHED,
    );
  });

  /**
   * === THE BUDGET SITS ABOVE EVERYTHING ======================================
   *
   * `force` is gone, but the property it used to threaten is still worth pinning:
   * the per-attempt budget is checked FIRST, above the cooldown and above both
   * rolling quotas, so no path through `withPassword` can reach a send once the
   * attempt has spent its five codes.
   */
  it('is not skipped by the password path', async () => {
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    const { service, doubles } = build({
      attempts: { open: vi.fn().mockResolvedValue(spent) },
    });

    expect(await slugOf(() => service.withPassword(CREDS, ctx(), DEVICE_ID))).toBe(
      ERR.OTP_SEND_LIMIT_REACHED,
    );
    expect(doubles.otpQueue['enqueue']).not.toHaveBeenCalled();
  });

  /**
   * Checked BEFORE the cooldown, so an exhausted attempt reports the budget rather
   * than a wait — telling an admin to wait sixty seconds for a code that will never
   * be sent is the less useful of the two answers.
   */
  it('is checked before the cooldown', async () => {
    const cache = makeCache();
    cache.cooldownRemaining.mockResolvedValue(45);
    const spent = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    const { service, admin } = build({ cache });

    expect(await slugOf(() => service.resendOtp({ attempt: spent, admin }, ctx()))).toBe(
      ERR.OTP_SEND_LIMIT_REACHED,
    );
    expect(cache.cooldownRemaining).not.toHaveBeenCalled();
  });

  /**
   * The displayed number and the enforced number are the same number. They
   * disagreeing — `otpSendsRemaining: 0` alongside a send that works — is precisely
   * the state this finding described.
   */
  it('agrees with the otpSendsRemaining it reports', async () => {
    const { service, admin } = build();

    const nearly = makeAttempt({ otpSentCount: OTP.MAX_SENDS - 1 });
    const outcome = await service.resendOtp({ attempt: nearly, admin }, ctx());

    // The double's `recordOtpSent` returns otpSentCount: 1, so this asserts the
    // arithmetic rather than the double: remaining is computed from MAX_SENDS.
    expect(outcome).toMatchObject({ kind: 'email_otp_required' });

    const exhausted = makeAttempt({ otpSentCount: OTP.MAX_SENDS });
    const err = await service
      .resendOtp({ attempt: exhausted, admin }, ctx())
      .then(() => null, (e: unknown) => e);
    expect((err as ProblemException).extra).toMatchObject({ otpSendsRemaining: 0 });
  });
});

describe('resolve — the step-up secret', () => {
  it('matches by hash, never by plaintext', async () => {
    const { service, doubles } = build();
    await service.resolve('some-secret-value', ctx());
    expect(doubles.attempts['findBySecretHash']).toHaveBeenCalledWith(
      pepperedHash('some-secret-value', 'stepup'),
    );
  });

  /**
   * Forged, already spent, and belonging to a superseded attempt all answer
   * identically. Distinguishing them would tell a caller whether a secret was ever
   * valid.
   */
  it('answers step_up_invalid for a secret that matches nothing', async () => {
    const { service } = build({
      attempts: { findBySecretHash: vi.fn().mockResolvedValue(null) },
    });
    expect(await slugOf(() => service.resolve('nope', ctx()))).toBe(ERR.STEP_UP_INVALID);
  });

  it('answers step_up_expired for a timed-out attempt, and retires it', async () => {
    const expire = vi.fn().mockResolvedValue(undefined);
    const { service } = build({
      attempts: {
        findBySecretHash: vi
          .fn()
          .mockResolvedValue(makeAttempt({ expiresAt: new Date(Date.now() - 1000) })),
        expire,
      },
    });
    expect(await slugOf(() => service.resolve('x', ctx()))).toBe(ERR.STEP_UP_EXPIRED);
    // Retired as it is refused, so the stale row stops occupying the unique index.
    expect(expire).toHaveBeenCalledOnce();
  });

  /**
   * An in-flight sign-in must not outlive the account's right to sign in. An admin
   * disabled between the password step and the second factor is refused, and the
   * attempt is retired rather than left resumable.
   */
  it('refuses and retires the attempt when the admin was disabled mid-ceremony', async () => {
    const expire = vi.fn().mockResolvedValue(undefined);
    const { service } = build({
      admins: { findById: vi.fn().mockResolvedValue(makeAdmin({ status: 'DISABLED' })) },
      attempts: { findBySecretHash: vi.fn().mockResolvedValue(makeAttempt()), expire },
    });
    expect(await slugOf(() => service.resolve('x', ctx()))).toBe(ERR.ACCOUNT_DISABLED);
    expect(expire).toHaveBeenCalledOnce();
  });

  it('refuses and retires the attempt when the admin was deleted mid-ceremony', async () => {
    const expire = vi.fn().mockResolvedValue(undefined);
    const { service } = build({
      admins: { findById: vi.fn().mockResolvedValue(null) },
      attempts: { findBySecretHash: vi.fn().mockResolvedValue(makeAttempt()), expire },
    });
    expect(await slugOf(() => service.resolve('x', ctx()))).toBe(ERR.ACCOUNT_DISABLED);
    expect(expire).toHaveBeenCalledOnce();
  });
});

describe('verifyEmail', () => {
  const liveChallenge = {
    id: 'challenge-1',
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    codeHash: pepperedHash('123456', 'otp'),
  };

  function withLiveCode(overrides: Partial<Doubles> = {}) {
    return build({
      ...overrides,
      challenges: {
        findLive: vi.fn().mockResolvedValue(liveChallenge),
        incrementAttempts: vi.fn().mockResolvedValue(1),
        consume: vi.fn().mockResolvedValue(true),
        invalidate: vi.fn().mockResolvedValue(undefined),
        issue: vi.fn().mockResolvedValue(liveChallenge),
        ...overrides.challenges,
      },
    });
  }

  it('routes an admin with no factors to enrollment', async () => {
    const { service, admin } = withLiveCode({
      mfa: {
        enrollmentState: vi
          .fn()
          .mockResolvedValue({ needsEnrollment: true, methods: [] }),
      },
    });
    const outcome = await service.verifyEmail(
      { attempt: makeAttempt(), admin },
      '123456',
    );
    expect(outcome).toEqual({ kind: 'enrollment_required', methods: ['TOTP', 'PASSKEY'] });
  });

  it('routes an enrolled admin to authentication', async () => {
    const { service, admin } = withLiveCode({
      mfa: {
        enrollmentState: vi
          .fn()
          .mockResolvedValue({ needsEnrollment: false, methods: ['TOTP', 'PASSKEY'] }),
      },
    });
    const outcome = await service.verifyEmail({ attempt: makeAttempt(), admin }, '123456');
    expect(outcome).toEqual({ kind: 'mfa_required', methods: ['TOTP', 'PASSKEY'] });
  });

  /** The whole point of this service. A correct email code advances the state and
   *  returns a description — never tokens. */
  it('issues NO session on a correct code', async () => {
    const { service, admin } = withLiveCode();
    const outcome = await service.verifyEmail({ attempt: makeAttempt(), admin }, '123456');
    expect(outcome.kind).not.toBe('session');
    expect(JSON.stringify(outcome)).not.toContain('accessToken');
  });

  it('advances PASSWORD_VERIFIED → EMAIL_VERIFIED', async () => {
    const { service, doubles, admin } = withLiveCode();
    await service.verifyEmail({ attempt: makeAttempt(), admin }, '123456');
    expect(doubles.attempts['advanceState']).toHaveBeenCalledWith(
      expect.any(String),
      'PASSWORD_VERIFIED',
      'EMAIL_VERIFIED',
    );
  });

  /** Losing the compare-and-swap means something else already advanced this
   *  attempt — one emailed code must not advance it twice. */
  it('refuses when the state swap is lost', async () => {
    const { service, admin } = withLiveCode({
      attempts: { advanceState: vi.fn().mockResolvedValue(false) },
    });
    expect(
      await slugOf(() => service.verifyEmail({ attempt: makeAttempt(), admin }, '123456')),
    ).toBe(ERR.STEP_UP_STEP_INVALID);
  });

  it('spends the code, so it cannot be reused', async () => {
    const { service, doubles, admin } = withLiveCode();
    await service.verifyEmail({ attempt: makeAttempt(), admin }, '123456');
    expect(doubles.challenges['consume']).toHaveBeenCalledWith('challenge-1');
  });

  it('rejects a wrong code and reports the guesses remaining', async () => {
    const { service, admin } = withLiveCode();
    try {
      await service.verifyEmail({ attempt: makeAttempt(), admin }, '999999');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      const problem = err as ProblemException;
      expect(problem.type).toBe(ERR.OTP_INVALID);
      expect(problem.extra).toEqual({ attemptsRemaining: 4 });
    }
  });

  /** Stamps the first proof of the address, and only the first. */
  it('marks the email verified only when it was not already', async () => {
    const verified = withLiveCode();
    await verified.service.verifyEmail(
      { attempt: makeAttempt(), admin: makeAdmin({ emailVerifiedAt: new Date() }) },
      '123456',
    );
    expect(verified.doubles.admins['markEmailVerified']).not.toHaveBeenCalled();

    const unverified = withLiveCode();
    await unverified.service.verifyEmail(
      { attempt: makeAttempt(), admin: makeAdmin({ emailVerifiedAt: null }) },
      '123456',
    );
    expect(unverified.doubles.admins['markEmailVerified']).toHaveBeenCalledOnce();
  });
});
