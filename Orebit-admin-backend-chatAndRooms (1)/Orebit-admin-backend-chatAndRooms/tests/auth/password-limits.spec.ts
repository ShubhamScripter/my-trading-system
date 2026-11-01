import { describe, expect, it, vi } from 'vitest';
import { LoginService } from '../../auth/services/login.service';
import { LIMITS, LOCKOUT } from '../../auth/auth.constants';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KEYS } from '../../redis';
import { makeAdmin, makeAttempt, makeCredential } from '../harness';

/**
 * ═══ FAILURES ARE METERED, SUCCESSES ARE NOT ═══════════════════════════════
 *
 * The change this file guards, and why it was worth making.
 *
 * `withPassword` used to charge `LOGIN_BY_DEVICE` (6/15m), `LOGIN_BY_EMAIL` (10/15m)
 * and `LOGIN_BY_IP` (20/15m) on EVERY password attempt. A legitimate admin signing in
 * normally spent from the same budgets an attacker did, and two bad things followed
 * from that one fact.
 *
 * The visible one: an admin working through a few sign-ins could be refused for
 * reasons that had nothing to do with anybody misbehaving.
 *
 * The one that actually mattered: to avoid that, the limits had to be set loose
 * enough to accommodate normal use — and that looseness was precisely the room an
 * attacker operated in. Twenty attempts per IP per quarter hour is a lot of guessing
 * when it costs a real admin nothing to leave it that high.
 *
 * Metering only failures decouples the two populations, which is what lets the
 * failure numbers be genuinely tight (8 and 6) while the success path pays only a
 * flood ceiling nobody reaches.
 */

function ctx(overrides: Partial<ReturnType<typeof baseCtx>> = {}) {
  return { ...baseCtx(), ...overrides };
}

function baseCtx() {
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

function build(options: { valid?: boolean; known?: boolean; cache?: ReturnType<typeof makeCache> } = {}) {
  const admin = makeAdmin();
  const cache = options.cache ?? makeCache();
  const known = options.known ?? true;

  const events = { record: vi.fn().mockResolvedValue(undefined) };
  const credentials = {
    checkPassword: vi
      .fn()
      .mockResolvedValue({ valid: options.valid ?? true, priorFailures: 0 }),
    verifyDummy: vi.fn().mockResolvedValue(undefined),
  };

  const service = new LoginService(
    {
      findById: vi.fn().mockResolvedValue(admin),
      findByEmailWithCredential: vi
        .fn()
        .mockResolvedValue(known ? { admin, credential: makeCredential() } : null),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      open: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 0, lastOtpSentAt: null })),
      recordOtpSent: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 1 })),
      expire: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      issue: vi.fn().mockResolvedValue({ id: 'challenge-1' }),
    } as never,
    credentials as never,
    {
      enrollmentState: vi.fn().mockResolvedValue({ needsEnrollment: false, methods: ['TOTP'] }),
    } as never,
    cache as never,
    { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
    events as never,
  );

  return { service, cache, credentials, events, admin };
}

const CREDS = { email: 'admin@orebit.io', password: 'CorrectHorse!2026' };

/** The keys `consume` was called with, in order. */
const charged = (cache: ReturnType<typeof makeCache>): string[] =>
  cache.consume.mock.calls.map(([key]) => key as string);

async function swallow(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ProblemException)) throw err;
  }
}

/**
 * One browser, as named by the `orebit_admin_device` cookie.
 *
 * NOT `ctx().deviceFingerprint`. The device bucket is deliberately keyed on a random
 * server-minted id rather than the user-agent-derived fingerprint on `ClientContext`,
 * because that fingerprint COLLIDES — every admin on the same browser build shares one
 * value, which would put a whole office in one bucket — and is forgeable by copying two
 * headers. `DEVICE` in auth/auth.constants.ts carries the full argument.
 */
const DEVICE_ID = 'PZ7yq1Xk3mQ0aB9cD2eF4gH6jK8lM1nO3pQ5rS7tU9v';
const OTHER_DEVICE_ID = 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c';

const FLOOD = KEYS.rate.loginFloodByIp(baseCtx().ip);
const FAIL_IP = KEYS.rate.loginFailureByIp(baseCtx().ip);
const FAIL_DEVICE = KEYS.rate.loginFailureByDevice(DEVICE_ID);

describe('what a SUCCESSFUL password costs', () => {
  /**
   * The flood ceiling, and nothing else. Sixty attempts per IP per fifteen minutes is
   * four a minute sustained — no human meets it, and it exists to bound how much
   * argon2 work one address can make this endpoint do, not to bound guessing.
   */
  it('charges the flood ceiling only', async () => {
    const { service, cache } = build({ valid: true });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(charged(cache)).toContain(FLOOD);
    expect(charged(cache)).not.toContain(FAIL_IP);
    expect(charged(cache)).not.toContain(FAIL_DEVICE);
  });

  /** `allow` on cache failure: the durable Postgres counters keep enforcing the
   *  lockout — including the escalation to manual review — with Redis fully down. */
  it('fails open on the flood ceiling', async () => {
    const { service, cache } = build({ valid: true });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const floodCall = cache.consume.mock.calls.find(([key]) => key === FLOOD);
    expect(floodCall?.[2]).toBe('allow');
  });

  /**
   * === THE DEVICE STREAK IS CLEARED, THE SHARED IP BUCKET IS NOT ============
   *
   * This asymmetry is the single most important line in the file.
   *
   * The device key is specific enough to one actor that a correct password is real
   * evidence the streak was that actor fumbling, so clearing it stops an admin who
   * mistyped five times from being refused later in the same window.
   *
   * The IP key is SHARED across every account behind that address. Clearing it on a
   * success would hand an attacker who holds one valid credential a reset lever:
   * guess against other accounts, sign in with the one they own, repeat forever,
   * never meeting the limit. That is the decoupling undone.
   */
  it('clears the device failure streak', async () => {
    const { service, cache } = build({ valid: true });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(cache.clear).toHaveBeenCalledWith(FAIL_DEVICE);
  });

  it('does NOT clear the shared IP failure bucket', async () => {
    const { service, cache } = build({ valid: true });

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const cleared = cache.clear.mock.calls.map(([key]) => key as string);
    expect(cleared).not.toContain(FAIL_IP);
  });
});

describe('what a FAILED password costs', () => {
  it('charges both failure buckets', async () => {
    const { service, cache } = build({ valid: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(charged(cache)).toContain(FAIL_IP);
    expect(charged(cache)).toContain(FAIL_DEVICE);
  });

  /** The flood ceiling is charged on every attempt regardless of outcome, so a
   *  failure pays it too — it is a resource bound, not a penalty. */
  it('still charges the flood ceiling', async () => {
    const { service, cache } = build({ valid: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(charged(cache)).toContain(FLOOD);
  });

  it('answers invalid_credentials', async () => {
    const { service } = build({ valid: false });

    await expect(service.withPassword(CREDS, ctx(), DEVICE_ID)).rejects.toMatchObject({
      type: ERR.INVALID_CREDENTIALS,
    });
  });

  /** The per-IP ceiling is 8 and the per-device ceiling is 6, and the ordering is
   *  load-bearing: one device must not be able to consume the whole IP's budget and
   *  lock out everyone else sharing that address. */
  it('bounds the device more tightly than the shared address', async () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.limit).toBeLessThan(LIMITS.LOGIN_FAILURE_BY_IP.limit);
    expect(LIMITS.LOGIN_FAILURE_BY_IP.limit).toBeLessThan(LIMITS.LOGIN_FLOOD_BY_IP.limit);
  });

  /** And the windows match, or the comparison above would be between different
   *  things and the ordering would not hold over time. */
  it('meters both failure buckets over the same window', () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.windowSeconds).toBe(
      LIMITS.LOGIN_FAILURE_BY_IP.windowSeconds,
    );
  });
});

describe('an unknown address costs exactly what a wrong password costs', () => {
  /**
   * === THE SECOND-ORDER DISCLOSURE ==========================================
   *
   * The timing mask makes the two paths take the same time and the two responses are
   * byte-identical. Neither helps if only one of them depletes a bucket: an attacker
   * sends eight guesses at a candidate address, then checks whether a known-good
   * address from the same IP is refused, and has their answer.
   */
  it('charges the same two failure buckets', async () => {
    const { service, cache } = build({ known: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(charged(cache)).toContain(FAIL_IP);
    expect(charged(cache)).toContain(FAIL_DEVICE);
  });

  it('charges them in the same order as a wrong password does', async () => {
    const unknown = makeCache();
    const wrong = makeCache();

    await swallow(() => build({ known: false, cache: unknown }).service.withPassword(CREDS, ctx(), DEVICE_ID));
    await swallow(() => build({ valid: false, cache: wrong }).service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(charged(unknown)).toEqual(charged(wrong));
  });

  it('burns the argon2 work', async () => {
    const { service, credentials } = build({ known: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(credentials.verifyDummy).toHaveBeenCalledWith(CREDS.password);
  });

  /** A real account never takes the dummy path — that would double the work of every
   *  legitimate sign-in for no benefit. */
  it('does not burn it for a known address', async () => {
    const { service, credentials } = build({ valid: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(credentials.verifyDummy).not.toHaveBeenCalled();
  });
});

describe('the device dimension', () => {
  /**
   * The bucket the IP ceiling cannot see. An attacker with a pool of addresses spends
   * one slot per address and never reaches the per-IP cap; the device tag is what
   * stays constant across that rotation.
   */
  it('keys on the device, so rotating IPs does not buy a fresh budget', async () => {
    const cache = makeCache();
    const { service } = build({ valid: false, cache });

    await swallow(() => service.withPassword(CREDS, ctx({ ip: '198.51.100.1' }), DEVICE_ID));
    await swallow(() => service.withPassword(CREDS, ctx({ ip: '198.51.100.2' }), DEVICE_ID));

    const deviceCharges = charged(cache).filter((key) => key === FAIL_DEVICE);
    expect(deviceCharges).toHaveLength(2);
  });

  /**
   * And conversely: two browsers behind one address share the IP bucket but not the
   * device one, so one person's fumbling does not spend the other's budget.
   *
   * This is the property the cookie id buys and the user-agent fingerprint could not:
   * two admins on the same browser build would have shared a single fingerprint, so
   * the "per device" bucket would have been per office all along.
   */
  it('keys separately per browser behind one address', async () => {
    const cache = makeCache();
    const { service } = build({ valid: false, cache });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));
    await swallow(() => service.withPassword(CREDS, ctx(), OTHER_DEVICE_ID));

    const ipCharges = charged(cache).filter((key) => key === FAIL_IP);
    expect(ipCharges).toHaveLength(2);
    expect(charged(cache)).toContain(KEYS.rate.loginFailureByDevice(OTHER_DEVICE_ID));
  });

  /**
   * === TIGHTEST FIRST, AND THE ORDER IS THE MECHANISM =======================
   *
   * The device bucket (6) is charged before the shared IP bucket (8). `consume` throws
   * at the cap, so a client that has spent its own six is refused WITHOUT also
   * spending a slot in the IP's eight — which is what stops one misbehaving browser
   * from draining a shared ceiling one refusal at a time and locking out the
   * colleagues behind that address.
   */
  it('charges the device bucket before the shared IP bucket', async () => {
    const cache = makeCache();
    const { service } = build({ valid: false, cache });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    const keys = charged(cache);
    expect(keys.indexOf(FAIL_DEVICE)).toBeLessThan(keys.indexOf(FAIL_IP));
  });

  /** And when the device bucket refuses, the shared one is never touched. */
  it('spends no IP slot when the device bucket refuses', async () => {
    const cache = makeCache();
    cache.consume.mockImplementation(async (key: string) => {
      if (key === FAIL_DEVICE) throw new ProblemException({ type: ERR.RATE_LIMITED });
    });
    const { service } = build({ valid: false, cache });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(charged(cache)).not.toContain(FAIL_IP);
  });

  /**
   * === THE BUCKET MUST STAY BELOW THE DURABLE LOCKOUT =======================
   *
   * The reason this dimension exists at all. `LOCKOUT.MAX_FAILED_ATTEMPTS` is ten
   * CONSECUTIVE failures, and the consequence is durable and escalating: ten costs an
   * hour, and a second lock inside the strike memory suspends the account until a
   * super admin rules on it.
   *
   * So a single browser looping on a stale saved password must be stopped before it
   * can walk an admin who did nothing wrong into a manual review. At six it is. At ten
   * it would be refused at the same moment as the lockout it exists to prevent, which
   * would be no protection at all.
   */
  it('bounds one browser strictly below the durable lockout', () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.limit).toBeLessThan(LOCKOUT.MAX_FAILED_ATTEMPTS);
  });
});

describe('the audit trail', () => {
  it('records a failure with the stage that produced it', async () => {
    const { service, events, admin } = build({ valid: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_LOGIN_PASSWORD_FAILURE',
        adminId: admin.id,
        failureStage: 'password',
      }),
    );
  });

  /** With no admin to attribute it to — which is what makes these rows the ones that
   *  show enumeration when a reviewer looks. */
  it('records an unknown address against no admin', async () => {
    const { service, events } = build({ known: false });

    await swallow(() => service.withPassword(CREDS, ctx(), DEVICE_ID));

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ADMIN_LOGIN_UNKNOWN_EMAIL', adminId: null }),
    );
  });
});

/**
 * The streak that ended in a success, recorded because `checkPassword` has just wiped
 * it. Without this row, "an admin fumbled four times and then remembered" and "a clean
 * sign-in" are indistinguishable afterwards - which is exactly the distinction a super
 * admin staring at a review needs to make.
 */
describe('a success that followed failures', () => {
  function withPriorFailures(priorFailures: number) {
    const built = build();
    built.credentials.checkPassword.mockResolvedValue({ valid: true, priorFailures });
    return built;
  }

  it('is recorded, with the streak it cleared', async () => {
    const { service, events, admin } = withPriorFailures(4);

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_LOGIN_PASSWORD_SUCCESS_AFTER_FAILURES',
        adminId: admin.id,
        metadata: { priorFailures: 4 },
      }),
    );
  });

  /** A clean sign-in writes nothing. Every successful sign-in producing an audit row
   *  would bury the interesting ones in the ordinary ones. */
  it('writes nothing when the sign-in was clean', async () => {
    const { service, events } = withPriorFailures(0);

    await service.withPassword(CREDS, ctx(), DEVICE_ID);

    const types = events.record.mock.calls.map(([arg]) => (arg as { eventType: string }).eventType);
    expect(types).not.toContain('ADMIN_LOGIN_PASSWORD_SUCCESS_AFTER_FAILURES');
  });
});
