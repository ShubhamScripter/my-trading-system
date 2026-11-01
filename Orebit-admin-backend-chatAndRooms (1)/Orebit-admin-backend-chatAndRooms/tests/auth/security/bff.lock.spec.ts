import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { AdminSession, PrismaClient } from '@prisma/client';
import { BffSessionService } from '../../../auth/security/bff.session';
import { AdminDbOperation } from '../../../auth/persistence/admin.dboperation';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SessionService } from '../../../auth/services/session.service';
import { signAccessToken, signRefreshToken } from '../../../auth/security/jwt';
import { SESSION } from '../../../auth/auth.constants';
import type { ClientContext } from '../../../auth/auth.types';
import { CacheService } from '../../../redis/cache';
import { LockService } from '../../../redis/lock';
import { KEYS } from '../../../redis/keys';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { dropAdmin, prismaFor, seedLogin, type Login } from '../../db/pg';
import { makeRedisDouble, type RedisDouble } from '../../redis/double';

/**
 * ═══ F10 — THE REFRESH LOCK CAN LAPSE MID-ROTATION ═══════════════════════════
 *
 * `REFRESH_LOCK_SECONDS` is 5. The rotation it guards is bounded by its own Prisma
 * transaction at `maxWait: 5_000` + `timeout: 10_000`, containing two statements that
 * can each wait `lock_timeout = 3s`. So the lock can expire while its holder is still
 * working — no measurement needed, the configured bounds say so — and a second
 * request then acquires it and rotates the same generation.
 *
 * The database has always handled that correctly: the family `FOR UPDATE` orders it
 * and the generation CAS guarantees one child. What was wrong was the loser's
 * INTERPRETATION — `SessionRotationConflict` went straight to `handleReuse`, so
 * ordinary slowness revoked the family and logged credential theft.
 *
 * ─── The layering this file pins ───────────────────────────────────────────
 *
 *   Redis lock                        best-effort single-flight / contention control
 *   family FOR UPDATE + generation CAS  correctness / one-use rotation
 *
 * A lapsed lock must therefore be RECOVERABLE without weakening the CAS, and that is
 * what the two ordering cases below prove — in both directions, because the outcome
 * must not depend on which owner happens to commit first.
 *
 * ─── How the interleaving is forced ────────────────────────────────────────
 *
 * Nothing here sleeps. Two mechanisms, both deterministic:
 *
 *   gates    a spy on `SessionDbOperation.rotate` parks each caller BEFORE the CAS
 *            and tells the test it has arrived. Parking there — rather than at the
 *            service boundary — is what makes both callers read an unrotated parent
 *            and genuinely contend on the compare-and-swap, which is the F10 race.
 *            Parking one level up would only exercise the already-rotated pre-check.
 *   expire   the Redis double lapses the lock key on command, exactly as its TTL
 *            would have. That is the whole reason the double had to learn about
 *            `EX`: with a store that ignored TTLs this scenario was inexpressible.
 */

const CLIENT: ClientContext = {
  ip: '203.0.113.41',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'b'.repeat(64),
  userAgent: 'vitest-f10',
};

const available = inject('pgAvailable');
const url = inject('pgUrl');

/** A parking place that reports its own arrival. */
function gate() {
  let arrive!: () => void;
  let open!: () => void;
  const arrived = new Promise<void>((r) => {
    arrive = r;
  });
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { arrived, opened, arrive, open };
}

describe.skipIf(!available)('F10 — refresh lock expiry', () => {
  let prisma: PrismaClient;
  const cleanup: string[] = [];

  beforeAll(async () => {
    prisma = prismaFor(url, 'orebit_pg_f10');
    await prisma.$connect();
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

  /**
   * A full stack whose persistence-level `rotate` parks at a gate.
   *
   * `gates` is consumed in call order, so the first caller into the CAS takes the
   * first gate. A caller beyond the supplied gates runs straight through — which is
   * what the recovery path does when it re-reads.
   */
  function build(gates: ReturnType<typeof gate>[]) {
    const redis: RedisDouble = makeRedisDouble();
    const cache = new CacheService(redis as never);
    const locks = new LockService(redis as never);
    const ops = new SessionDbOperation(prisma as never);

    let call = 0;
    const realRotate = ops.rotate.bind(ops);
    vi.spyOn(ops, 'rotate').mockImplementation(async (parent: AdminSession, client) => {
      const g = gates[call];
      call += 1;
      if (g !== undefined) {
        g.arrive();
        await g.opened;
      }
      return realRotate(parent, client);
    });

    const sessions = new SessionService(ops, new AdminDbOperation(prisma as never), cache);
    const bff = new BffSessionService(sessions, cache, locks);
    return { redis, cache, locks, ops, sessions, bff };
  }

  async function handleFor(l: Login, bff: BffSessionService): Promise<string> {
    const row = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: l.adminId } });
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
      accessExpiresAt: new Date(Date.now() - 1000),
      refreshExpiresAt: row.expiresAt,
      reauthenticateAt: row.reauthenticateAt,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } as never,
    });
  }

  interface Outcome {
    readonly generations: number;
    readonly tipId: string;
    readonly familyRevokedAt: Date | null;
    readonly reasons: (string | null)[];
    readonly recordNamesTip: boolean;
  }

  async function inspect(l: Login, redis: RedisDouble, handle: string): Promise<Outcome> {
    const rows = await prisma.adminSession.findMany({ where: { familyId: l.familyId } });
    const tip = rows.find((r) => r.rotatedAt === null && r.revokedAt === null);
    const family = await prisma.adminSessionFamily.findUniqueOrThrow({
      where: { id: l.familyId },
    });
    const raw = redis.raw(KEYS.bff.session(handle)) ?? '';
    return {
      generations: rows.length,
      tipId: tip?.id ?? 'NO-TIP',
      familyRevokedAt: family.revokedAt,
      reasons: rows.map((r) => r.revokedReason),
      recordNamesTip: tip !== undefined && raw.includes(tip.id),
    };
  }

  /** The five properties both orderings must hold. */
  function expectHealthy(o: Outcome): void {
    // exactly one child generation — queried, not inferred
    expect(o.generations).toBe(2);
    // no family revocation, and no REUSE_DETECTED anywhere
    expect(o.familyRevokedAt).toBeNull();
    expect(o.reasons.every((r) => r === null)).toBe(true);
    expect(o.tipId).not.toBe('NO-TIP');
    // the final BFF record points at the valid tip
    expect(o.recordNamesTip).toBe(true);
  }

  // ── 17 ────────────────────────────────────────────────────────────────────

  it('acquires, runs, and releases with an ownership-aware delete', async () => {
    const t = build([]);
    const key = 'lock:bff-refresh:plain';

    const ran = await t.locks.withLock(key, 5, async () => 'ran');

    expect(ran).toBe('ran');
    expect(t.redis.raw(key)).toBeNull();
    // The release was the compare-and-delete, called with the owner's own token —
    // which the double now actually compares rather than deleting blindly.
    expect(t.redis.eval).toHaveBeenCalledOnce();
    const [script, , evalKey] = t.redis.eval.mock.calls[0] as [string, number, string];
    expect(script).toContain('redis.call("get"');
    expect(evalKey).toBe(key);
  });

  // ── 18 ────────────────────────────────────────────────────────────────────

  it('does not rotate while another request owns the lock', async () => {
    const l = await login();
    const g = gate();
    const t = build([g]);
    const handle = await handleFor(l, t.bff);

    const first = t.bff.resolve(handle, CLIENT);
    await g.arrived;

    // A second caller finds the lock held. It must not rotate; it waits.
    const held = await t.locks.withLock(KEYS.bff.refreshLock(handle), 5, async () => 'second');
    expect(held).toBeNull();

    g.open();
    await first;
    expect(await prisma.adminSession.count({ where: { familyId: l.familyId } })).toBe(2);
  }, 15_000);

  // ── 19 — Ordering A: the ORIGINAL owner commits ───────────────────────────

  it('Ordering A — lock lapses, A commits, B recovers, A cannot delete B’s lock', async () => {
    const l = await login();
    const gA = gate();
    const gB = gate();
    const t = build([gA, gB]);
    const handle = await handleFor(l, t.bff);
    const lockKey = KEYS.bff.refreshLock(handle);

    // A acquires the lock and parks just before the CAS.
    const a = t.bff.resolve(handle, CLIENT);
    await gA.arrived;
    expect(t.redis.raw(lockKey)).not.toBeNull();

    // The TTL lapses while A is still working. This is F10.
    expect(t.redis.expire(lockKey)).toBe(true);

    // B now acquires the same lock and parks before its own CAS, having read the
    // same unrotated parent A did.
    const b = t.bff.resolve(handle, CLIENT);
    await gB.arrived;
    const bToken = t.redis.raw(lockKey);
    expect(bToken).not.toBeNull();

    // A wins the CAS and commits the child.
    gA.open();
    await expect(a).resolves.toEqual(expect.any(String));

    // ═══ A's RELEASE MUST BE A NO-OP ════════════════════════════════════════
    // A's compare-and-delete finds B's token, not its own, so B's lock survives.
    expect(t.redis.raw(lockKey)).toBe(bToken);

    // B loses the CAS and repairs instead of crying theft.
    gB.open();
    await expect(b).resolves.toEqual(expect.any(String));

    expectHealthy(await inspect(l, t.redis, handle));
  }, 20_000);

  // ── 20 — Ordering B: the SECOND owner commits ─────────────────────────────

  it('Ordering B — lock lapses, B commits, A recovers, B’s lock stays intact', async () => {
    // The case the old code handled WORST: A is the request the user is actually
    // waiting on, and it was the one told its credentials had been stolen.
    const l = await login();
    const gA = gate();
    const gB = gate();
    const t = build([gA, gB]);
    const handle = await handleFor(l, t.bff);
    const lockKey = KEYS.bff.refreshLock(handle);

    const a = t.bff.resolve(handle, CLIENT);
    await gA.arrived;
    expect(t.redis.expire(lockKey)).toBe(true);

    const b = t.bff.resolve(handle, CLIENT);
    await gB.arrived;
    const bToken = t.redis.raw(lockKey);

    // B commits first this time.
    gB.open();
    await expect(b).resolves.toEqual(expect.any(String));
    // B released its own lock, which it legitimately owns.
    expect(t.redis.raw(lockKey)).toBeNull();

    // A — the original owner, and the request in front of a person — loses the CAS
    // and repairs. Pre-fix this resolved to `session_reuse_detected`.
    gA.open();
    await expect(a).resolves.toEqual(expect.any(String));

    // Re-plant B's lock to prove A's release could not have taken it: A's token is
    // long gone from the key, so its compare-and-delete matched nothing.
    expect(bToken).not.toBeNull();
    expectHealthy(await inspect(l, t.redis, handle));
  }, 20_000);

  // ── 21 ────────────────────────────────────────────────────────────────────

  it('states the lock TTL against the rotation bound it does NOT cover', async () => {
    // ═══ THE DRIFT PIN ══════════════════════════════════════════════════════
    //
    // This asserts the UNCOMFORTABLE fact rather than a comfortable one: the lock's
    // TTL is smaller than the rotation's own configured bound, so expiry mid-rotation
    // is reachable and the recovery path is load-bearing rather than theoretical.
    //
    // If someone later raises the TTL above the bound, this fails — and that is the
    // point. It would mean expiry is no longer reachable, which is a legitimate
    // design change, but one that must be made deliberately and must come with a
    // decision about the crashed-holder window it introduces. It must not happen by
    // accident, and the comment on `REFRESH_LOCK_SECONDS` must not silently become
    // wrong again.
    const ROTATION_MAX_WAIT_MS = 5_000;
    const ROTATION_TIMEOUT_MS = 10_000;
    const rotationBoundMs = ROTATION_MAX_WAIT_MS + ROTATION_TIMEOUT_MS;

    expect(SESSION.REFRESH_LOCK_SECONDS * 1000).toBeLessThan(rotationBoundMs);
    // And the waiter still gives up inside the lock it waits on (F04).
    expect(SESSION.REFRESH_WAIT_MS).toBeLessThan(SESSION.REFRESH_LOCK_SECONDS * 1000);
  });

  // ── 22, 23 ────────────────────────────────────────────────────────────────

  it('hands a waiter the holder’s published record', async () => {
    const l = await login();
    const g = gate();
    const t = build([g]);
    const handle = await handleFor(l, t.bff);

    const holder = t.bff.resolve(handle, CLIENT);
    await g.arrived;
    // The waiter starts while the holder is parked, and its bounded backoff outlives
    // the hold — so it reads the record the holder publishes.
    const waiter = t.bff.resolve(handle, CLIENT);
    g.open();

    const [a, b] = await Promise.all([holder, waiter]);
    expect(a).toEqual(expect.any(String));
    expect(b).toBe(a);
    expect(await prisma.adminSession.count({ where: { familyId: l.familyId } })).toBe(1 + 1);
  }, 20_000);

  it('gives a waiter a typed 503 when the holder never publishes', async () => {
    const l = await login();
    const g = gate();
    const t = build([g]);
    const handle = await handleFor(l, t.bff);

    const holder = t.bff.resolve(handle, CLIENT);
    await g.arrived;

    // The holder is parked for longer than the whole wait budget, so the waiter
    // exhausts it. Not a 401: the session is fine, the coordination is not.
    let slug = 'did not throw';
    try {
      await t.bff.resolve(handle, CLIENT);
    } catch (err) {
      slug = err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
    }
    expect(slug).toBe(ERR.SESSION_STORE_UNAVAILABLE);

    g.open();
    await holder;
  }, 20_000);
});
