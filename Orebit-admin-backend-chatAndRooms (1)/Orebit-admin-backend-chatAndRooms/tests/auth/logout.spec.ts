import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthController } from '../../auth/auth.controller';
import { OptionalAuthGuard, optionalPrincipal } from '../../auth/security/guards';
import { BffSessionService } from '../../auth/security/bff.session';
import { SessionService } from '../../auth/services/session.service';
import { CacheService } from '../../redis/cache';
import { LockService } from '../../redis/lock';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { SESSION_ACTION_MESSAGES } from '../../auth/security/session.message';
import { generateCsrfToken } from '../../auth/auth.utility';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin, makeSession } from '../harness';

/**
 * ═══ LOGOUT MUST NOT CLAIM A REVOCATION IT DID NOT PERFORM (F02) ═════════════
 *
 * The invariant: a successful logout response means PostgreSQL durably committed the
 * revocation. Redis may be down; it may never decide whether the server says "logged
 * out".
 *
 * ─── Why this file builds the REAL chain ───────────────────────────────────
 *
 * The obvious way to test the bug is to call the controller with `principal = null`
 * and assert it refuses. That test would pass against broken code and prove nothing,
 * because it ASSUMES the thing under test: that a Redis outage yields a null
 * principal. The defect was never "the controller mishandles null" — it was that a
 * dead Redis silently MANUFACTURES a null that is indistinguishable from "already
 * logged out", four layers below the controller.
 *
 * So the failure is injected at the bottom, in ioredis, and everything above it is
 * real:
 *
 *     ioredis double, `get` rejects
 *        → real CacheService        the swallow happens in production code
 *        → real BffSessionService   resolve() returns null for the real reason
 *        → real OptionalAuthGuard   authenticate() returns false the real way
 *        → real optionalPrincipal   the null is DERIVED, never asserted
 *        → real AuthController.session
 *
 * Only the database operation and the cookie port are doubled — the first so a test
 * can assert that no revocation was attempted, the second to observe `clear()`.
 *
 * ─── The distinction this file exists to protect ───────────────────────────
 *
 *   Redis says "nothing there"   an honest success. There is no session left to
 *                                revoke, and a repeat logout must keep working.
 *   Redis says nothing at all    a refusal. We cannot tell WHICH family to revoke,
 *                                so claiming to have revoked it is a lie.
 *
 * Collapsing those two is F02. Several tests below exist only to keep them apart.
 */

const ADMIN_ID = '01920000-0000-7000-8000-0000000000a1';
const FAMILY_ID = '01920000-0000-7000-8000-0000000000f1';
const SESSION_ID = '01920000-0000-7000-8000-0000000000b1';
/**
 * What every successful logout answers with.
 *
 * Named once because it is the assertion in eight cases below, and because what most
 * of them are really pinning is that it does not VARY: a repeat logout, a logout with
 * no cookie at all, and a logout of a session that was already revoked elsewhere all
 * answer exactly this.
 *
 * It replaced `{ ok: true }` — a boolean that is `true` on every response it can
 * appear on tells a client nothing the 2xx did not already say. A message the panel
 * can render does.
 */
const LOGGED_OUT_BODY = { data: { message: SESSION_ACTION_MESSAGES.LOGGED_OUT } };

const HANDLE = 'a-handle-that-names-a-live-session';

/** A minimal ioredis stand-in. Every command can be made to reject, which is how an
 *  outage is expressed — the swallowing then happens inside the real CacheService. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    getdel: vi.fn(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    }),
    eval: vi.fn(async () => 1),
  };
}

interface Options {
  /** What the database revoke does. Defaults to revoking the one generation.
   *  An outage is applied afterwards with `killRedis`, not declared here. */
  readonly revokeFamily?: ReturnType<typeof vi.fn>;
  readonly revokeAllForAdmin?: ReturnType<typeof vi.fn>;
}

function build(options: Options = {}) {
  const redis = makeRedis();

  const sessionsDb = {
    findById: vi.fn(async () => makeSession({ id: SESSION_ID, familyId: FAMILY_ID, adminId: ADMIN_ID })),
    revokeFamily: options.revokeFamily ?? vi.fn(async () => [SESSION_ID]),
    revokeAllForAdmin: options.revokeAllForAdmin ?? vi.fn(async () => [SESSION_ID]),
    readLiveness: vi.fn(async () => ({ reason: null, lastActiveAt: new Date(), familyId: FAMILY_ID })),
    touch: vi.fn(async () => undefined),
  };
  const adminsDb = {
    findById: vi.fn(async () => makeAdmin({ id: ADMIN_ID })),
    touchLastSeen: vi.fn(async () => undefined),
  };

  // Real, over the doubled ioredis — so `get` swallowing its error is production code.
  const cache = new CacheService(redis as never);
  const locks = new LockService(redis as never);
  const sessions = new SessionService(sessionsDb as never, adminsDb as never, cache);
  const bff = new BffSessionService(sessions, cache, locks);
  const guard = new OptionalAuthGuard(sessions, bff);
  const controller = new AuthController(
    {} as never, // logins — unreachable from `session()`
    sessions,
    adminsDb as never,
    bff,
    {} as never, // captcha — unreachable from `session()`
  );

  const csrfToken = generateCsrfToken(HANDLE);
  const req = {
    cookies: {
      [SESSION.COOKIE_NAME]: HANDLE,
      [CSRF.COOKIE_NAME]: csrfToken,
    } as Record<string, string>,
    headers: { [CSRF.HEADER_NAME]: csrfToken } as Record<string, string>,
    method: 'POST',
    url: '/auth/session',
    ip: '203.0.113.9',
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  const cookies = {
    issue: vi.fn(() => 'csrf'),
    read: vi.fn(() => (req.cookies[SESSION.COOKIE_NAME] ?? null) as string | null),
    clear: vi.fn(),
  };

  return { redis, cache, sessions, sessionsDb, adminsDb, bff, guard, controller, req, context, cookies };
}

/** Drive the real guard, then hand the controller whatever principal it produced. */
async function logout(t: ReturnType<typeof build>, action: 'logout' | 'logout-all' = 'logout') {
  await t.guard.canActivate(t.context);
  return t.controller.session({ action }, optionalPrincipal(t.req as never), t.cookies as never);
}

/** Every Redis command starts rejecting, exactly as an unreachable server behaves. */
function killRedis(t: ReturnType<typeof build>): void {
  const down = () => Promise.reject(new Error('ECONNREFUSED'));
  t.redis.get.mockImplementation(down as never);
  t.redis.set.mockImplementation(down as never);
  t.redis.del.mockImplementation(down as never);
  t.redis.exists.mockImplementation(down as never);
  t.redis.getdel.mockImplementation(down as never);
  t.redis.eval.mockImplementation(down as never);
}

function slugOf(err: unknown): string | undefined {
  return err instanceof ProblemException ? err.type : undefined;
}

describe('F02 — logout during a Redis outage', () => {
  /**
   * ═══ THE REGRESSION TEST ═════════════════════════════════════════════════
   *
   * Before the fix this resolved `{ ok: true }` having called nothing on the
   * database — the browser was told it was signed out while the session family sat
   * in PostgreSQL with `revoked_at IS NULL`, ready to work again the moment Redis
   * came back.
   *
   * Two assertions, and the second is the one that matters. A refusal alone could be
   * satisfied by any thrown error; what makes this F02 rather than a generic 503 is
   * that no durable revocation was attempted and the cookie was kept, so the client
   * still holds the only value that can identify the session on a retry.
   */
  it('refuses rather than reporting a revocation it never performed', async () => {
    const t = build();
    killRedis(t);

    const err = await logout(t).catch((e: unknown) => e);

    expect(slugOf(err)).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    expect(t.sessionsDb.revokeFamily).not.toHaveBeenCalled();
    expect(t.sessionsDb.revokeAllForAdmin).not.toHaveBeenCalled();
    // The cookie is the ONLY thing that still names this session. Clearing it would
    // strand a live family that nobody could ever revoke.
    expect(t.cookies.clear).not.toHaveBeenCalled();
  });

  it('answers 503, so a client can tell a dependency outage from a bad request', async () => {
    const t = build();
    killRedis(t);

    const err = await logout(t).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).status).toBe(503);
  });

  /**
   * The mirror of the test above, and the reason the union has three members rather
   * than two. Redis is UP and answering "no such record" — an ordinary repeat logout,
   * or one from a browser whose record already expired. That must still succeed.
   *
   * A fix that refused whenever the principal was null would pass the regression test
   * above and break every second logout in production.
   */
  it("succeeds when Redis answers 'absent' — a repeat logout is not an outage", async () => {
    const t = build();
    // Redis is healthy; the store simply holds no record for this handle.

    await expect(logout(t)).resolves.toEqual(LOGGED_OUT_BODY);
    expect(t.cookies.clear).toHaveBeenCalled();
  });

  /**
   * `'present'` with no principal is a session that was revoked elsewhere — a
   * logout-all from another device, say — whose BFF record has not yet aged out.
   * Idempotency requires a success here too.
   */
  it("succeeds when Redis answers 'present' but the session is already over", async () => {
    const t = build();
    t.redis.store.set(`bff:session:${HANDLE}`, JSON.stringify({ sessionId: SESSION_ID }));
    // A malformed-but-present record: `resolve` yields no token, so no principal.

    await expect(logout(t)).resolves.toEqual(LOGGED_OUT_BODY);
  });

  /** No cookie at all: nothing was presented, so there is nothing to be unsure about. */
  it('succeeds with no cookie, even with Redis down', async () => {
    const t = build();
    delete t.req.cookies[SESSION.COOKIE_NAME];
    delete t.req.cookies[CSRF.COOKIE_NAME];
    delete t.req.headers[CSRF.HEADER_NAME];
    killRedis(t);

    await expect(logout(t)).resolves.toEqual(LOGGED_OUT_BODY);
    expect(t.sessionsDb.revokeFamily).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE THREE STATES MUST STAY THREE ═════════════════════════════════════
   *
   * A direct test of the mapping, because the whole defect is one collapse away: if
   * `recordState` ever returned `boolean | null` again, or if a caller wrote
   * `if (!state)`, "Redis is down" would silently become "nothing to revoke" and F02
   * would be back with every test above still green.
   */
  it('maps a dead Redis to "unknown", never to "absent"', async () => {
    const t = build();
    killRedis(t);

    await expect(t.bff.recordState(HANDLE)).resolves.toBe('unknown');
  });

  it('distinguishes all three states', async () => {
    const t = build();
    await expect(t.bff.recordState(HANDLE)).resolves.toBe('absent');

    t.redis.store.set(`bff:session:${HANDLE}`, '{}');
    await expect(t.bff.recordState(HANDLE)).resolves.toBe('present');

    killRedis(t);
    await expect(t.bff.recordState(HANDLE)).resolves.toBe('unknown');
  });
});

describe('F02 — a durable revocation is never reported as a failure', () => {
  /** A live session, so the guard produces a real principal and the DB is reached. */
  function withLiveSession() {
    const t = build();
    const record = {
      sessionId: SESSION_ID,
      accessToken: 'unused',
      accessExpiresAt: Date.now() + 10 * 60 * 1000,
      refreshSealed: 'unused',
      reauthenticateAt: Date.now() + 12 * 60 * 60 * 1000,
    };
    t.redis.store.set(`bff:session:${HANDLE}`, JSON.stringify(record));
    return t;
  }

  /**
   * PostgreSQL committed; Redis then failed to record the deny-flag. That is not a
   * failed logout — the authoritative revocation exists, and `assertLive` re-checks
   * PostgreSQL on every request precisely so a lost flag costs a query rather than a
   * security hole.
   */
  it('still succeeds when the deny-flag write fails after the commit', async () => {
    const t = withLiveSession();
    const principal = { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const };
    // Redis dies AFTER the database has committed.
    t.sessionsDb.revokeFamily.mockImplementation(async () => {
      killRedis(t);
      return [SESSION_ID];
    });

    await expect(
      t.controller.session({ action: 'logout' }, principal, t.cookies as never),
    ).resolves.toEqual(LOGGED_OUT_BODY);
    expect(t.sessionsDb.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, 'LOGOUT');
  });

  /** The same for logout-all, whose deny-flag fan-out is wider but no more decisive. */
  it('still succeeds when logout-all cannot cache its revocations', async () => {
    const t = withLiveSession();
    const principal = { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const };
    t.sessionsDb.revokeAllForAdmin.mockImplementation(async () => {
      killRedis(t);
      return [SESSION_ID, '01920000-0000-7000-8000-0000000000b2'];
    });

    await expect(
      t.controller.session({ action: 'logout-all' }, principal, t.cookies as never),
    ).resolves.toEqual(LOGGED_OUT_BODY);
    expect(t.sessionsDb.revokeAllForAdmin).toHaveBeenCalledWith(ADMIN_ID, 'LOGOUT_ALL');
  });

  /** `destroy` is a courtesy. It must never be able to fail a committed logout. */
  it('still succeeds when the BFF record cannot be dropped', async () => {
    const t = withLiveSession();
    const principal = { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const };
    t.redis.del.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      t.controller.session({ action: 'logout' }, principal, t.cookies as never),
    ).resolves.toEqual(LOGGED_OUT_BODY);
    expect(t.cookies.clear).toHaveBeenCalled();
  });
});

describe('F02 — a failed revocation is never reported as success', () => {
  function withPrincipal() {
    const t = build();
    return {
      t,
      principal: { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const },
    };
  }

  /**
   * The database is the authority, so its failure is the operation's failure. This is
   * the one place a broad `catch` would be catastrophic, and there is deliberately
   * none: `revokeFamily` rejects, `logout` does not catch, the controller does not
   * catch, and the client learns the truth.
   */
  it('propagates a database failure instead of answering ok', async () => {
    const { t, principal } = withPrincipal();
    t.sessionsDb.revokeFamily.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      t.controller.session({ action: 'logout' }, principal, t.cookies as never),
    ).rejects.toThrow('deadlock detected');
    // The cookie survives, so the client can retry against a session that is still live.
    expect(t.cookies.clear).not.toHaveBeenCalled();
  });

  it('propagates a lock timeout from logout-all', async () => {
    const { t, principal } = withPrincipal();
    t.sessionsDb.revokeAllForAdmin.mockRejectedValue(new Error('canceling statement due to lock timeout'));

    await expect(
      t.controller.session({ action: 'logout-all' }, principal, t.cookies as never),
    ).rejects.toThrow(/lock timeout/);
    expect(t.cookies.clear).not.toHaveBeenCalled();
  });

  /**
   * An already-revoked family returns no ids — that is the idempotent path, not a
   * failure — and must not be mistaken for one, nor routed through reuse detection.
   */
  it('treats an already-revoked family as success, not as a replay', async () => {
    const { t, principal } = withPrincipal();
    t.sessionsDb.revokeFamily.mockResolvedValue([]);

    await expect(
      t.controller.session({ action: 'logout' }, principal, t.cookies as never),
    ).resolves.toEqual(LOGGED_OUT_BODY);
  });

  /**
   * The retry the 503 exists to make possible: the outage refusal keeps the cookie,
   * so once Redis returns the same browser can log out for real. Exactly one durable
   * revocation happens across both attempts, and no session is resurrected.
   */
  it('lets the client retry successfully once Redis returns', async () => {
    const t = build();
    killRedis(t);

    await expect(logout(t)).rejects.toBeInstanceOf(ProblemException);
    expect(t.sessionsDb.revokeFamily).not.toHaveBeenCalled();
    expect(t.cookies.clear).not.toHaveBeenCalled();

    // Redis comes back, and the browser still holds its handle.
    const healthy = build();
    const principal = { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const };
    await expect(
      healthy.controller.session({ action: 'logout' }, principal, healthy.cookies as never),
    ).resolves.toEqual(LOGGED_OUT_BODY);
    expect(healthy.sessionsDb.revokeFamily).toHaveBeenCalledTimes(1);
  });
});
