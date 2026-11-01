import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { BffSessionService } from '../../../auth/security/bff.session';
import { AdminDbOperation } from '../../../auth/persistence/admin.dboperation';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SessionService } from '../../../auth/services/session.service';
import { REVOKE_REASON } from '../../../auth/auth.types';
import type { ClientContext } from '../../../auth/auth.types';
import { signAccessToken, signRefreshToken } from '../../../auth/security/jwt';
import { CacheService } from '../../../redis/cache';
import { LockService } from '../../../redis/lock';
import { KEYS } from '../../../redis/keys';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { dropAdmin, prismaFor, seedLogin, type Login } from '../../db/pg';
import { makeRedisDouble, type RedisDouble } from '../../redis/double';

/**
 * ═══ F09 — A LOST REDIS WRITE MUST NOT LOOK LIKE CREDENTIAL THEFT ════════════
 *
 * `BffSessionService.refresh` commits a rotation in PostgreSQL and THEN publishes the
 * resulting token pair to Redis. Nothing spans the two. When the publish fails, the
 * durable store has moved on and the cache has not:
 *
 *   PostgreSQL   parent P is stamped `rotated_at`; child T exists and is the tip
 *   Redis        still holds the record naming P, sealed around P's refresh token
 *
 * That record is a POISON PILL. On the next request it is opened, P's already-spent
 * refresh token is presented, and `rotate` reads a second presentation of one token
 * as theft — so it revokes the whole family and logs a credential-theft warning. A
 * single dropped cache write costs the admin their session and the operator a false
 * security alert.
 *
 * ─── Why almost nothing here is doubled ────────────────────────────────────
 *
 * Real `BffSessionService`, real `CacheService`, real `LockService`, real
 * `SessionService`, real `SessionDbOperation`, real `AdminDbOperation`, real
 * PostgreSQL, real JWT signing and verification. The ONLY double is Redis itself,
 * and only so its `SET` can be made to fail for one key.
 *
 * That matters more than usual for this defect. The failure is a disagreement
 * BETWEEN the two stores, so a test that doubled the rotation would be asserting
 * against its own model of the thing that disagrees. Here the rotation really
 * commits, the publish really fails, and the retry really presents a spent token.
 *
 * ─── The fault is scoped to the record key, deliberately ───────────────────
 *
 * `faults.set` is a predicate, not a flag. If the LOCK write failed too this would be
 * a lock-acquire failure — a different case, with a different and already-correct
 * answer (503, `rotate` never called, covered by F04). F09 is specifically the
 * post-commit publish, so only that key fails.
 */

const CLIENT: ClientContext = {
  ip: '203.0.113.21',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'e'.repeat(64),
  userAgent: 'vitest-f09',
};

const available = inject('pgAvailable');
const url = inject('pgUrl');

describe.skipIf(!available)('F09 — interrupted publication of a committed rotation', () => {
  let prisma: PrismaClient;
  const cleanup: string[] = [];

  beforeAll(async () => {
    prisma = prismaFor(url, 'orebit_pg_f09');
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const adminId of cleanup.splice(0)) await dropAdmin(prisma, adminId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A full stack over one Redis double, with only that double's SET faultable. */
  function build(faultRecordWrite: () => boolean) {
    const redis: RedisDouble = makeRedisDouble({
      // Only the record key, and only while the flag says so.
      set: (key) => key.startsWith('bff:session:') && faultRecordWrite(),
    });
    const cache = new CacheService(redis as never);
    const locks = new LockService(redis as never);
    const sessions = new SessionService(
      new SessionDbOperation(prisma as never),
      new AdminDbOperation(prisma as never),
      cache,
    );
    const rotateSpy = vi.spyOn(sessions, 'rotate');
    const bff = new BffSessionService(sessions, cache, locks);
    return { redis, cache, locks, sessions, bff, rotateSpy };
  }

  async function login(): Promise<Login> {
    const l = await seedLogin(prisma);
    cleanup.push(l.adminId);
    return l;
  }

  /**
   * A live login whose BFF record is already due for refresh.
   *
   * `issue` is not used: it would mint a SECOND family. The row seeded by `seedLogin`
   * is the one under test, so the record is built from that generation directly —
   * with an access token already expired, which is the case that has no stale token
   * to fall back on and therefore must rotate.
   */
  async function handleFor(l: Login, bff: BffSessionService): Promise<string> {
    const row = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: l.adminId } });
    // `mint` is private; going through `issue` would create a new family. So the
    // record is created from a hand-built IssuedSession naming the SEEDED generation,
    // using the same signing helpers production uses.
    const access = signAccessToken({
      adminId: admin.id,
      sessionId: row.id,
      role: admin.role,
      ceilingAt: row.reauthenticateAt,
    });
    const refresh = signRefreshToken({
      adminId: admin.id,
      sessionId: row.id,
      familyId: row.familyId,
      ceilingAt: row.reauthenticateAt,
    });
    return bff.create({
      sessionId: row.id,
      accessToken: access.token,
      refreshToken: refresh.token,
      // Already expired, so `isDueForRefresh` is true and there is no fallback.
      accessExpiresAt: new Date(Date.now() - 1000),
      refreshExpiresAt: row.expiresAt,
      reauthenticateAt: row.reauthenticateAt,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } as never,
    });
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

  async function generations(familyId: string): Promise<number> {
    return prisma.adminSession.count({ where: { familyId } });
  }

  async function tipOf(familyId: string) {
    return prisma.adminSession.findFirst({
      where: { familyId, rotatedAt: null, revokedAt: null },
    });
  }

  // ── 1 ─────────────────────────────────────────────────────────────────────

  it('publishes the new pair and returns the new token when Redis is healthy', async () => {
    const l = await login();
    const t = build(() => false);
    const handle = await handleFor(l, t.bff);

    const token = await t.bff.resolve(handle, CLIENT);

    expect(token).not.toBeNull();
    expect(await generations(l.familyId)).toBe(2);
    const tip = await tipOf(l.familyId);
    expect(tip?.parentId).toBe(l.sessionId);
    // The record now names the child, not the parent.
    const raw = t.redis.raw(KEYS.bff.session(handle));
    expect(raw).toContain(tip!.id);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────

  it('refuses with session_store_unavailable when the publish fails', async () => {
    // NOT 429 `rate_limited`. The caller was not rate limited — the session store was
    // briefly unreachable, which is a different condition with a different remedy,
    // and 503 is the slug the other two refresh-path Redis failures already use.
    const l = await login();
    // Healthy while the record is seeded — the fault must land on the REFRESH
    // publish, not on the setup write.
    let failing = false;
    const t = build(() => failing);
    const handle = await handleFor(l, t.bff);
    failing = true;

    const slug = await slugOf(() => t.bff.resolve(handle, CLIENT));

    expect(slug).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    // The rotation DID commit — that is the whole problem.
    expect(await generations(l.familyId)).toBe(2);
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────

  it('recovers on the retry instead of reporting reuse', async () => {
    // ═══ THE REPRODUCTION ════════════════════════════════════════════════════
    //
    // Pre-fix this is a family revocation: the retry opens the poison record, presents
    // P's spent refresh token, and `rotate` calls `handleReuse`. The admin is signed
    // out of a session that was never in any danger, and the logs claim theft.
    const l = await login();
    let failing = false;
    const t = build(() => failing);
    const handle = await handleFor(l, t.bff);
    failing = true;

    // The publish fails; the rotation commits. Which slug that refusal carries is
    // asserted by the previous test — this one is about what the RETRY does, so it
    // deliberately does not depend on the slug fix landing first.
    await slugOf(() => t.bff.resolve(handle, CLIENT));
    const tip = await tipOf(l.familyId);
    expect(tip).not.toBeNull();

    // Redis comes back. The client retries.
    failing = false;
    const token = await t.bff.resolve(handle, CLIENT);

    expect(token).not.toBeNull();
    // No second rotation: the child that already exists is the one served.
    expect(await generations(l.familyId)).toBe(2);
    // And nothing was revoked.
    const family = await prisma.adminSessionFamily.findUnique({ where: { id: l.familyId } });
    expect(family?.revokedAt).toBeNull();
    expect(family?.revokedReason).toBeNull();
    expect((await tipOf(l.familyId))?.id).toBe(tip!.id);
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────

  it('serves the published record when the write actually landed', async () => {
    // The UNKNOWN-result case, from the other side. If the SET was applied and only
    // its acknowledgement was lost, the retry finds a record that is no longer due for
    // refresh and simply uses it — recovery is never reached, and no probe was needed
    // to work out which of the two happened.
    const l = await login();
    const t = build(() => false);
    const handle = await handleFor(l, t.bff);

    await t.bff.resolve(handle, CLIENT);
    t.rotateSpy.mockClear();

    const token = await t.bff.resolve(handle, CLIENT);

    expect(token).not.toBeNull();
    expect(t.rotateSpy).not.toHaveBeenCalled();
    expect(await generations(l.familyId)).toBe(2);
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────

  it('leaves nothing consumed when the rotation itself fails', async () => {
    // A revoked family is the rollback case: the rotation aborts under the family
    // lock, so no generation is consumed and no child is born. The answer is the
    // session's real state, not a store problem.
    const l = await login();
    const t = build(() => false);
    const handle = await handleFor(l, t.bff);
    await t.sessions.revokeAllForAdmin(l.adminId, REVOKE_REASON.LOGOUT_ALL);

    const slug = await slugOf(() => t.bff.resolve(handle, CLIENT));

    expect(slug).toBe(ERR.SESSION_REVOKED);
    expect(await generations(l.familyId)).toBe(1);
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────

  it('cannot be recovered into a usable session once the family is revoked', async () => {
    // The publish fails, THEN the family is revoked. Recovery must refuse: the tip is
    // no longer live, and a cache repair must never outrank a durable revocation.
    const l = await login();
    let failing = false;
    const t = build(() => failing);
    const handle = await handleFor(l, t.bff);
    failing = true;

    expect(await slugOf(() => t.bff.resolve(handle, CLIENT))).toBe(
      ERR.SESSION_STORE_UNAVAILABLE,
    );
    await t.sessions.revokeAllForAdmin(l.adminId, REVOKE_REASON.LOGOUT_ALL);
    failing = false;

    expect(await slugOf(() => t.bff.resolve(handle, CLIENT))).toBe(ERR.SESSION_REVOKED);
    expect(await generations(l.familyId)).toBe(2);
    expect(await tipOf(l.familyId)).toBeNull();
  });

  // ── 7a / 7b — the Redis-state boundary ────────────────────────────────────

  it('does not reach recovery for a malformed record', async () => {
    // A corrupt cache entry is NOT evidence that a rotation occurred. Recovery is
    // reachable only from the known failure shape — a record that exists, parses and
    // authenticates — so a damaged one must fail closed rather than invite a guess
    // about durable history.
    const l = await login();
    const t = build(() => false);
    const handle = await handleFor(l, t.bff);
    await t.redis.set(KEYS.bff.session(handle), 'not-json-at-all', 'EX', 60);
    t.rotateSpy.mockClear();

    await expect(t.bff.resolve(handle, CLIENT)).resolves.toBeNull();
    expect(t.rotateSpy).not.toHaveBeenCalled();
    expect(await generations(l.familyId)).toBe(1);
  });

  it('does not reach recovery for an absent record', async () => {
    const l = await login();
    const t = build(() => false);
    const handle = await handleFor(l, t.bff);
    t.redis.expire(KEYS.bff.session(handle));
    t.rotateSpy.mockClear();

    await expect(t.bff.resolve(handle, CLIENT)).resolves.toBeNull();
    expect(t.rotateSpy).not.toHaveBeenCalled();
    expect(await generations(l.familyId)).toBe(1);
  });

  it('does not reach recovery for a record that will not open under this handle', async () => {
    // The AAD binding: an envelope copied from another handle fails authentication, so
    // no refresh token is ever presented and no rotation is attempted.
    const l = await login();
    const t = build(() => false);
    const mine = await handleFor(l, t.bff);
    const other = await login();
    const theirs = await handleFor(other, t.bff);
    await t.redis.set(
      KEYS.bff.session(mine),
      t.redis.raw(KEYS.bff.session(theirs))!,
      'EX',
      60,
    );
    t.rotateSpy.mockClear();

    await expect(t.bff.resolve(mine, CLIENT)).resolves.toBeNull();
    expect(t.rotateSpy).not.toHaveBeenCalled();
    expect(await generations(l.familyId)).toBe(1);
  });
});
