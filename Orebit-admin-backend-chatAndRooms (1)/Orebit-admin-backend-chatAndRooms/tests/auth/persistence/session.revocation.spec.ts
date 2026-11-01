import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { dropAdmin, liveGenerations, prismaFor, seedLogin, type Login } from '../../db/pg';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SessionService } from '../../../auth/services/session.service';
import { CacheService } from '../../../redis/cache';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { makeAdmin } from '../../harness';
import { AuthGuard } from '../../../auth/security/guards';
import { BffSessionService } from '../../../auth/security/bff.session';
import { LockService } from '../../../redis/lock';
import { signAccessToken } from '../../../auth/security/jwt';
import { toPublicAdmin } from '../../../auth/auth.utility';
import { SESSION } from '../../../auth/auth.constants';
import type { ExecutionContext } from '@nestjs/common';
import type { ClientContext } from '../../../auth/auth.types';

const CLIENT: ClientContext = {
  ip: '203.0.113.9',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'f'.repeat(64),
  userAgent: 'vitest',
};

/**
 * ═══ POSTGRESQL IS THE AUTHORITY; REDIS IS AN OPTIMISATION (F02) ═════════════
 *
 * The two halves of the authority model, proved against a real database rather than
 * argued from doubles:
 *
 *   1. A revocation that COMMITTED stays committed and stays effective, no matter
 *      what Redis does afterwards. A deny-flag that never lands costs a query, not a
 *      security property.
 *   2. A session revoked while Redis is unreachable is STILL refused, because the
 *      liveness check falls through to PostgreSQL rather than reading an unanswered
 *      cache as consent.
 *
 * The second is the invariant that matters most in this phase: **Redis being
 * unavailable must never make a revoked session usable again.** If the cache were
 * ever allowed to grant rather than only to deny, an outage would silently reinstate
 * every session anyone had logged out of.
 *
 * A real database because the claim is about durability. A double that returned
 * "revoked" would be asserting the conclusion.
 */

const APP = 'orebit_pg_revocation';

/** An ioredis stand-in whose every command can be made to reject. Wrapped in the REAL
 *  `CacheService`, so the swallowing and the three-valued `flag` are production code. */
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
  };
}

function kill(redis: ReturnType<typeof makeRedis>): void {
  const down = () => Promise.reject(new Error('ECONNREFUSED'));
  for (const cmd of ['get', 'set', 'del', 'exists', 'getdel'] as const) {
    redis[cmd].mockImplementation(down as never);
  }
}

const available = inject('pgAvailable');
const url = inject('pgUrl');

describe.skipIf(!available)('durable revocation versus Redis', () => {
  let prisma: PrismaClient;
  let ops: SessionDbOperation;
  const cleanup: string[] = [];

  beforeAll(async () => {
    prisma = prismaFor(url, APP);
    await prisma.$connect();
    ops = new SessionDbOperation(prisma as never);
  });

  afterEach(async () => {
    for (const adminId of cleanup.splice(0)) await dropAdmin(prisma, adminId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function login(): Promise<Login> {
    const l = await seedLogin(prisma);
    cleanup.push(l.adminId);
    return l;
  }

  /** A real service over the real database, with a controllable Redis beneath it. */
  function service(redis: ReturnType<typeof makeRedis>) {
    const admins = {
      findById: vi.fn(async () => makeAdmin()),
      touchLastSeen: vi.fn(async () => undefined),
    };
    return new SessionService(ops as never, admins as never, new CacheService(redis as never));
  }

  // ── Test 2 ────────────────────────────────────────────────────────────────
  /**
   * The deny-flag write fails after PostgreSQL has already committed. `setFlag`
   * swallows precisely so this cannot turn a finished logout into a 500 — there is
   * nothing left to roll back, and the revocation is already durable.
   */
  it('commits the revocation even when the deny-flag write fails', async () => {
    const l = await login();
    const redis = makeRedis();
    const sessions = service(redis);
    const principal = { adminId: l.adminId, sessionId: l.sessionId, familyId: l.familyId, role: 'ADMIN' as const };

    kill(redis);

    await expect(sessions.logout(principal, undefined)).resolves.toBeUndefined();

    const family = await prisma.adminSessionFamily.findUniqueOrThrow({ where: { id: l.familyId } });
    expect(family.revokedAt).not.toBeNull();
    expect(family.revokedReason).toBe('LOGOUT');
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
  });

  it('commits a logout-all even when no revocation can be cached', async () => {
    const l = await login();
    const redis = makeRedis();
    const sessions = service(redis);
    const principal = { adminId: l.adminId, sessionId: l.sessionId, familyId: l.familyId, role: 'ADMIN' as const };

    kill(redis);

    await expect(sessions.logoutAll(principal, undefined)).resolves.toBeUndefined();

    const family = await prisma.adminSessionFamily.findUniqueOrThrow({ where: { id: l.familyId } });
    expect(family.revokedReason).toBe('LOGOUT_ALL');
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  /**
   * ═══ THE ONE THAT MATTERS ════════════════════════════════════════════════
   *
   * Log out, then take Redis away, then try to use the session. The deny-flag is
   * gone and `flag` cannot answer — and the session is still refused, because
   * `assertLive` treats "no answer" exactly like "no flag" and asks PostgreSQL.
   *
   * The inverse — reading an unreachable cache as permission — would mean a Redis
   * outage silently reinstated every logged-out session in the system.
   */
  it('still refuses a revoked session when Redis cannot answer', async () => {
    const l = await login();
    const redis = makeRedis();
    const sessions = service(redis);
    const principal = { adminId: l.adminId, sessionId: l.sessionId, familyId: l.familyId, role: 'ADMIN' as const };

    await sessions.logout(principal, undefined);
    kill(redis);

    const err = await sessions.assertLive(l.sessionId).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.SESSION_REVOKED);
  });

  /** And a session that was never revoked is still ACCEPTED with Redis down — the
   *  cache is deny-only in both directions, so an outage must not lock anybody out
   *  either. */
  it('still accepts a live session when Redis cannot answer', async () => {
    const l = await login();
    const redis = makeRedis();
    const sessions = service(redis);

    kill(redis);

    await expect(sessions.assertLive(l.sessionId)).resolves.toEqual({
      lastActiveAt: expect.any(Date),
      familyId: l.familyId,
    });
  });

  /**
   * ═══ GATE 3: A REFRESH RESULT IS NOT SELF-AUTHORISING (F04) ════════════════
   *
   * The bounded wait added for F04 hands a waiting request whatever token the lock
   * holder published, on the strength of `accessExpiresAt > now`. That freshness
   * check decides only WHICH token to present — it is emphatically not an
   * authorisation decision, and this test is what stops it being mistaken for one.
   *
   * Here the record holds a genuinely live, correctly-signed access token — exactly
   * what a waiter would have been handed — and the family is revoked in PostgreSQL
   * underneath it. The request must still be refused, and refused by `assertLive`
   * reading the authoritative row, not by anything in the BFF.
   *
   * Driven through the REAL guard so the ordering under test is the production one:
   * resolve() → verifyAccessToken → assertLive → PostgreSQL.
   */
  it('refuses a request whose token is live but whose family has been revoked', async () => {
    const l = await login();
    const redis = makeRedis();
    const cache = new CacheService(redis as never);
    const sessions = service(redis);
    const bff = new BffSessionService(sessions as never, cache, new LockService(redis as never));

    const generation = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    const access = signAccessToken({
      adminId: l.adminId,
      sessionId: l.sessionId,
      role: 'ADMIN',
      ceilingAt: generation.reauthenticateAt,
    });
    const handle = await bff.create({
      sessionId: l.sessionId,
      accessToken: access.token,
      refreshToken: 'unused-here',
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: generation.expiresAt,
      reauthenticateAt: generation.reauthenticateAt,
      admin: toPublicAdmin(makeAdmin({ id: l.adminId })),
    });

    // The session ends while that token is still perfectly valid.
    await ops.revokeFamily(l.familyId, 'LOGOUT');

    const req = {
      cookies: { [SESSION.COOKIE_NAME]: handle } as Record<string, string>,
      headers: {} as Record<string, string>,
      method: 'GET',
      url: '/auth/me',
      ip: '203.0.113.9',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    const guard = new AuthGuard(sessions as never, bff, {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    } as never);

    // The BFF would happily serve this token; PostgreSQL is what refuses.
    await expect(bff.resolve(handle, CLIENT)).resolves.toBe(access.token);
    const err = await guard.canActivate(context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.SESSION_REVOKED);
  });

  // ── Test 5b ───────────────────────────────────────────────────────────────
  /**
   * Durable idempotency. A second logout finds nothing live, returns no ids, and —
   * critically — does not overwrite the reason the first one recorded. `LOGOUT_ALL`
   * must not degrade to `LOGOUT`, because that is what tells an admin whether one
   * device or all of them were signed out.
   */
  it('is idempotent, and a repeat does not rewrite the original reason', async () => {
    const l = await login();

    await expect(ops.revokeAllForAdmin(l.adminId, 'LOGOUT_ALL')).resolves.toEqual([l.sessionId]);
    await expect(ops.revokeFamily(l.familyId, 'LOGOUT')).resolves.toEqual([]);

    const family = await prisma.adminSessionFamily.findUniqueOrThrow({ where: { id: l.familyId } });
    expect(family.revokedReason).toBe('LOGOUT_ALL');
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
  });
});
