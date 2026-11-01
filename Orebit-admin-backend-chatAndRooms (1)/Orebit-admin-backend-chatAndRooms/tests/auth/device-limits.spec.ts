import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE, LIMITS, LOCKOUT } from '../../auth/auth.constants';
import { generateDeviceId, isDeviceId } from '../../auth/auth.utility';
import { deviceCookie } from '../../auth/security/device.cookie';
import { LoginService } from '../../auth/services/login.service';
import { KEYS } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin, makeAttempt, makeCredential } from '../harness';

/**
 * ═══ THE THIRD DIMENSION ON SIGN-IN ════════════════════════════════════════
 *
 * `withPassword` used to charge two buckets: one keyed on the email, one on the IP.
 * Both are SHARED, and neither can say which client spent them — which leaves two
 * failures that need no attacker at all:
 *
 *   the account   `LOGIN_BY_EMAIL` is 10 and `LOCKOUT.MAX_FAILED_ATTEMPTS` is also
 *                 10, so one browser replaying a stale saved password walks an admin
 *                 into a durable Postgres lockout on its own.
 *   the office    `LOGIN_BY_IP` is 20 across everyone behind one egress, so one
 *                 client burning it takes their colleagues down with them.
 *
 * The device bucket is the inner limit that bounds what a single client may take out
 * of either. It is the same composition `reauthBySession` has under the per-admin
 * bucket, and the tests below are the same three properties: that it is charged,
 * that it is charged FIRST, and that it is keyed per client.
 *
 * ─── What is deliberately NOT asserted ─────────────────────────────────────
 *
 * That this stops an attacker. It does not, and no test here pretends otherwise: a
 * cleared cookie is a fresh bucket. The email and IP ceilings are what bound someone
 * grinding passwords, and they are unchanged — the last test in the limits block
 * pins exactly that relationship.
 */

// ─── the cookie port ────────────────────────────────────────────────────────

function bind(cookies: Record<string, string | undefined> = {}) {
  const setCookie = vi.fn();
  const req = { cookies } as unknown as FastifyRequest;
  const reply = { setCookie } as unknown as FastifyReply;
  return { resolve: () => deviceCookie(req, reply), setCookie };
}

const KNOWN = generateDeviceId();

describe('the device cookie', () => {
  it('returns the id the browser presented, and sets nothing', () => {
    const { resolve, setCookie } = bind({ [DEVICE.COOKIE_NAME]: KNOWN });

    expect(resolve()).toBe(KNOWN);
    // A returning browser must keep the bucket it already has. Re-setting would be
    // harmless here but would hide a mint that should not be happening.
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('mints and sets one when the browser presents none', () => {
    const { resolve, setCookie } = bind();

    const id = resolve();

    expect(isDeviceId(id)).toBe(true);
    expect(setCookie).toHaveBeenCalledOnce();
    expect(setCookie.mock.calls[0]?.[1]).toBe(id);
  });

  /**
   * A first sign-in is metered from its FIRST attempt, not its second. Minting a
   * fresh id rather than skipping the bucket is what makes that true — the caller
   * always has something to charge.
   */
  it('never returns an empty id, so the limiter always has a bucket', () => {
    expect(bind().resolve()).not.toBe('');
    expect(bind({ [DEVICE.COOKIE_NAME]: '' }).resolve()).not.toBe('');
  });

  it.each([
    ['junk', 'not-a-device-id'],
    ['wrong length', 'PZ7yq1Xk3mQ0aB9cD2eF4gTOOLONG'],
    ['illegal characters', `${'A'.repeat(42)}!`],
    ['oversized', 'A'.repeat(4096)],
  ])('replaces a malformed value (%s) rather than keying on it', (_label, value) => {
    const { resolve, setCookie } = bind({ [DEVICE.COOKIE_NAME]: value });

    const id = resolve();

    // Not the value presented. Hashing arbitrary client input into a Redis key on
    // every request is unbounded key cardinality supplied by the caller.
    expect(id).not.toBe(value);
    expect(isDeviceId(id)).toBe(true);
    expect(setCookie).toHaveBeenCalledOnce();
  });

  it('sets it httpOnly, strict, and scoped to the login route', () => {
    const { resolve, setCookie } = bind();
    resolve();

    expect(setCookie.mock.calls[0]?.[2]).toMatchObject({
      httpOnly: true,
      sameSite: 'strict',
      path: DEVICE.COOKIE_PATH,
      maxAge: DEVICE.MAX_AGE_SECONDS,
    });
  });

  /**
   * The route resolves once and passes the value down, so one request cannot mint
   * two ids and charge two buckets for one attempt. Pinned here because the guard is
   * a convention rather than a mechanism — the plain-string signature this shares
   * with the consumer backend has no memo to lean on.
   */
  it('mints a NEW id per call, which is why the route resolves exactly once', () => {
    const { resolve } = bind();
    expect(resolve()).not.toBe(resolve());
  });
});

describe('the device id itself', () => {
  it('accepts what it generates', () => {
    for (let i = 0; i < 50; i += 1) expect(isDeviceId(generateDeviceId())).toBe(true);
  });

  /** Unguessable, so nobody can pin another browser to an exhausted bucket — the
   *  property `deviceFingerprintOf` cannot offer, since it collides across every
   *  client on the same browser build. */
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateDeviceId()));
    expect(ids.size).toBe(200);
  });
});

// ─── the limiter ────────────────────────────────────────────────────────────

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

function build() {
  const admin = makeAdmin();
  const cache = {
    consume: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    startCooldown: vi.fn().mockResolvedValue(true),
  };

  const credentials = {
    checkPassword: vi.fn().mockResolvedValue({ valid: false, priorFailures: 0 }),
    verifyDummy: vi.fn().mockResolvedValue(undefined),
  };
  const events = { record: vi.fn().mockResolvedValue(undefined) };

  const service = new LoginService(
    {
      findByEmailWithCredential: vi
        .fn()
        .mockResolvedValue({ admin, credential: makeCredential() }),
      markEmailVerified: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      open: vi.fn().mockResolvedValue(makeAttempt()),
      recordOtpSent: vi.fn().mockResolvedValue(makeAttempt({ otpSentCount: 1 })),
      expire: vi.fn().mockResolvedValue(undefined),
    } as never,
    { issue: vi.fn().mockResolvedValue({ id: 'challenge-1' }) } as never,
    credentials as never,
    {
      enrollmentState: vi.fn().mockResolvedValue({ needsEnrollment: false, methods: ['TOTP'] }),
    } as never,
    cache as never,
    { enqueue: vi.fn().mockResolvedValue('job-1') } as never,
    events as never,
  );

  return { service, cache, admin };
}

const CREDS = { email: 'admin@orebit.io', password: 'WrongPassword!2026' };

const chargedKeys = (cache: ReturnType<typeof build>['cache']): string[] =>
  cache.consume.mock.calls.map(([key]) => key as string);

describe('withPassword rate limiting for device', () => {
  it('charges the device failure bucket on password failure', async () => {
    const { service, cache } = build();

    await service.withPassword(CREDS, ctx(), KNOWN).catch(() => undefined);

    const keys = chargedKeys(cache);
    expect(keys).toContain(KEYS.rate.loginFailureByDevice(KNOWN));
    expect(keys).toContain(KEYS.rate.loginFailureByIp(ctx().ip));
  });

  it('charges the device failure bucket BEFORE the IP failure bucket', async () => {
    const { service, cache } = build();

    await service.withPassword(CREDS, ctx(), KNOWN).catch(() => undefined);

    const keys = chargedKeys(cache);
    // Flood ceiling is on entry, then device failure, then IP failure
    expect(keys[0]).toBe(KEYS.rate.loginFloodByIp(ctx().ip));
    expect(keys[1]).toBe(KEYS.rate.loginFailureByDevice(KNOWN));
    expect(keys[2]).toBe(KEYS.rate.loginFailureByIp(ctx().ip));
  });

  it('spends no IP failure slot when the device failure bucket refuses', async () => {
    const { service, cache } = build();
    // Allow flood ceiling, then reject on device failure bucket
    cache.consume
      .mockResolvedValueOnce(undefined) // flood
      .mockRejectedValueOnce(new ProblemException({ type: ERR.RATE_LIMITED })); // device

    await expect(service.withPassword(CREDS, ctx(), KNOWN)).rejects.toMatchObject({
      type: ERR.RATE_LIMITED,
    });

    expect(chargedKeys(cache)).toEqual([
      KEYS.rate.loginFloodByIp(ctx().ip),
      KEYS.rate.loginFailureByDevice(KNOWN),
    ]);
  });

  it('keys it per browser, so one client cannot spend another’s', async () => {
    const { service, cache } = build();
    const other = generateDeviceId();

    await service.withPassword(CREDS, ctx(), KNOWN).catch(() => undefined);
    await service.withPassword(CREDS, ctx(), other).catch(() => undefined);

    const keys = chargedKeys(cache);
    expect(keys).toContain(KEYS.rate.loginFailureByDevice(KNOWN));
    expect(keys).toContain(KEYS.rate.loginFailureByDevice(other));
    expect(KEYS.rate.loginFailureByDevice(KNOWN)).not.toBe(KEYS.rate.loginFailureByDevice(other));
  });
});

describe('the limits themselves', () => {
  it('bounds one browser below the durable password lockout', () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.limit).toBeLessThan(LOCKOUT.MAX_FAILED_ATTEMPTS);
  });

  it('bounds the device failure limit tighter than the IP failure limit', () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.limit).toBeLessThan(LIMITS.LOGIN_FAILURE_BY_IP.limit);
  });

  it('uses one window for both failure limits', () => {
    expect(LIMITS.LOGIN_FAILURE_BY_DEVICE.windowSeconds).toBe(
      LIMITS.LOGIN_FAILURE_BY_IP.windowSeconds,
    );
  });
});
