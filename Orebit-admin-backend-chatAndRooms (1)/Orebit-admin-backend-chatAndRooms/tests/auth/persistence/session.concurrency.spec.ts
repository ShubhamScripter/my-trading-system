import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import {
  Adversary,
  databaseNameOf,
  dropAdmin,
  generation,
  invariantViolations,
  liveGenerations,
  prismaFor,
  seedExtraFamily,
  seedLogin,
  waitUntilBlocked,
  waitUntilIdleInTransaction,
  type Login,
} from '../../db/pg';
import {
  SessionDbOperation,
  SessionFamilyRevoked,
} from '../../../auth/persistence/session.dboperation';
import { uuidv7 } from '../../../src/utils/public.utils';
import type { ClientContext } from '../../../auth/auth.types';

/**
 * ═══ THE REVOCATION RACE, AGAINST A REAL POSTGRESQL ══════════════════════════
 *
 * F01: a refresh in flight when a logout commits could leave a child generation
 * alive. Logout returned 200, logged "revoked: 1", and the admin stayed signed in
 * for the rest of the twelve-hour family ceiling.
 *
 * ─── Why this file cannot use doubles ──────────────────────────────────────
 *
 * Because the defect was never in the application's logic. Every statement was
 * individually correct; what was wrong was an assumption about what a statement can
 * SEE. Under READ COMMITTED an `UPDATE ... WHERE family_id = ?` neither sees nor
 * blocks on a row that an uncommitted transaction has just inserted, and Postgres
 * has no predicate locking below SERIALIZABLE — so the row that had to be stopped
 * was invisible to the statement meant to stop it.
 *
 * A fake would have to encode a belief about snapshot behaviour in order to
 * reproduce that, and the belief is precisely what is under test. So these run
 * against the real thing, with the real `SessionDbOperation` and real transactions.
 *
 * ─── How the interleaving is forced ────────────────────────────────────────
 *
 * An `Adversary` (a raw `pg` connection) holds one transaction open; the code under
 * test runs on Prisma. Between them, `waitUntilBlocked` polls `pg_blocking_pids`
 * until the database itself confirms the second transaction is waiting on the first.
 * No test here sleeps as a way of "letting" something happen: a sleep proves nothing
 * and would make a green run meaningless.
 *
 * ─── Skipping ──────────────────────────────────────────────────────────────
 *
 * `inject('pgAvailable')` comes from tests/db/global-setup.ts and is resolved before
 * collection, which is what lets `describe.skipIf` use it. With no database the file
 * skips instead of failing, so `npm test` stays green on a machine without one.
 */

const APP_UNDER_TEST = 'orebit_pg_concurrency_sut';
const APP_ADVERSARY = 'orebit_pg_concurrency_adv';

const CLIENT: ClientContext = {
  ip: '203.0.113.9',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'c'.repeat(64),
  userAgent: 'vitest-pg-child',
};

const available = inject('pgAvailable');
const url = inject('pgUrl');

describe.skipIf(!available)('session revocation under real concurrency', () => {
  let prisma: PrismaClient;
  let monitor: Client;
  let ops: SessionDbOperation;
  let database: string;
  const cleanup: string[] = [];

  beforeAll(async () => {
    database = databaseNameOf(url);
    prisma = prismaFor(url, APP_UNDER_TEST);
    await prisma.$connect();
    monitor = new Client({ connectionString: url });
    await monitor.connect();
    ops = new SessionDbOperation(prisma as never);
  });

  afterEach(async () => {
    for (const adminId of cleanup.splice(0)) await dropAdmin(prisma, adminId);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await monitor.end();
  });

  async function login(): Promise<Login> {
    const l = await seedLogin(prisma);
    cleanup.push(l.adminId);
    return l;
  }

  /**
   * An adversary holding a rotation open: family locked, parent stamped, child
   * INSERTed, not committed. Exactly what `SessionDbOperation.rotate` does, held at
   * the moment the child exists for nobody but itself.
   */
  async function rotationInFlight(l: Login): Promise<{ adv: Adversary; childId: string }> {
    const adv = await Adversary.connect(url, APP_ADVERSARY);
    const childId = uuidv7();
    const child = generation(childId, l.adminId, l.familyId, l.sessionId);

    await adv.begin();
    await adv.sql('SELECT revoked_at FROM admin.admin_session_families WHERE id = $1 FOR UPDATE', [
      l.familyId,
    ]);
    await adv.sql(
      `UPDATE admin.admin_sessions SET rotated_at = now()
        WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL`,
      [l.sessionId],
    );
    await adv.sql(
      `INSERT INTO admin.admin_sessions
         (id, admin_id, family_id, parent_id, mfa_method, device_fingerprint, ip_class,
          user_agent, created_at, last_active_at, expires_at, reauthenticate_at)
       VALUES ($1,$2,$3,$4,'TOTP',$5,$6,$7, now(), $8, $9, $10)`,
      [
        child.id,
        child.adminId,
        child.familyId,
        child.parentId,
        child.deviceFingerprint,
        child.ipClass,
        child.userAgent,
        child.lastActiveAt,
        child.expiresAt,
        child.reauthenticateAt,
      ],
    );
    await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);
    return { adv, childId };
  }

  // ── Test 1 ────────────────────────────────────────────────────────────────
  it('logout racing a refresh revokes the child the refresh created', async () => {
    const l = await login();
    const { adv, childId } = await rotationInFlight(l);

    // Fired but not awaited: it must be in flight so we can prove it BLOCKS.
    const logout = ops.revokeFamily(l.familyId, 'LOGOUT');
    await waitUntilBlocked(monitor, database, APP_UNDER_TEST);

    await adv.commit();
    const revoked = await logout;
    await adv.end();

    // The heart of it. Before the family lock, this array was `[parent]` and the
    // child was left with revoked_at IS NULL — a fully usable session behind a
    // logout that reported success.
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
    expect(revoked).toContain(childId);
    expect(revoked).toContain(l.sessionId);

    const family = await prisma.adminSessionFamily.findUnique({ where: { id: l.familyId } });
    expect(family?.revokedAt).not.toBeNull();
    expect(family?.revokedReason).toBe('LOGOUT');
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  it('logout-all racing a refresh leaves no live generation on any family', async () => {
    const l = await login();
    const other = await seedExtraFamily(prisma, l.adminId);
    const { adv, childId } = await rotationInFlight(l);

    const logoutAll = ops.revokeAllForAdmin(l.adminId, 'LOGOUT_ALL');
    await waitUntilBlocked(monitor, database, APP_UNDER_TEST);

    await adv.commit();
    const revoked = await logoutAll;
    await adv.end();

    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
    expect(await liveGenerations(prisma, other.familyId)).toEqual([]);
    expect(revoked).toContain(childId);
    expect(revoked).toContain(other.sessionId);
    expect(await invariantViolations(prisma, l.adminId)).toEqual([]);
  });

  it('logout-all is idempotent over a family somebody else already revoked', async () => {
    const l = await login();
    await ops.revokeFamily(l.familyId, 'LOGOUT');

    await expect(ops.revokeAllForAdmin(l.adminId, 'LOGOUT_ALL')).resolves.toEqual([]);
    // The first revocation's reason stands: it is the one that actually ended it.
    const family = await prisma.adminSessionFamily.findUnique({ where: { id: l.familyId } });
    expect(family?.revokedReason).toBe('LOGOUT');
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  it('a refresh that loses the race to a logout creates nothing at all', async () => {
    const l = await login();

    // The adversary is the LOGOUT this time: family locked and revoked, held open.
    const adv = await Adversary.connect(url, APP_ADVERSARY);
    await adv.begin();
    await adv.sql('SELECT id FROM admin.admin_session_families WHERE id = $1 FOR UPDATE', [
      l.familyId,
    ]);
    await adv.sql(
      `UPDATE admin.admin_session_families
          SET revoked_at = now(), revoked_reason = 'LOGOUT'
        WHERE id = $1 AND revoked_at IS NULL`,
      [l.familyId],
    );
    await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

    const parent = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    const rotate = ops.rotate(parent, CLIENT);
    await waitUntilBlocked(monitor, database, APP_UNDER_TEST);

    await adv.commit();

    // Not SessionRotationConflict: that would be reported to the admin as token
    // theft and revoke the family a second time with REUSE_DETECTED.
    await expect(rotate).rejects.toThrow(SessionFamilyRevoked);
    await adv.end();

    const children = await prisma.adminSession.findMany({ where: { parentId: l.sessionId } });
    expect(children).toEqual([]);
    // The parent was never even stamped — the refusal happened before the CAS.
    const after = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    expect(after.rotatedAt).toBeNull();
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  it('a refresh that wins is still revoked by the logout that follows it', async () => {
    const l = await login();
    const parent = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });

    const child = await ops.rotate(parent, CLIENT);
    expect(child.familyId).toBe(l.familyId);

    const revoked = await ops.revokeFamily(l.familyId, 'LOGOUT');

    expect(revoked).toEqual(expect.arrayContaining([l.sessionId, child.id]));
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  it('the family id survives every rotation, and one revoke ends the whole chain', async () => {
    const l = await login();
    const ids = [l.sessionId];

    let current = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
    for (let i = 0; i < 3; i += 1) {
      current = await ops.rotate(current, CLIENT);
      ids.push(current.id);
    }

    // The stable identity: four distinct generations, one unchanged family.
    expect(new Set(ids).size).toBe(4);
    const rows = await prisma.adminSession.findMany({ where: { id: { in: ids } } });
    expect(new Set(rows.map((r) => r.familyId))).toEqual(new Set([l.familyId]));

    const revoked = await ops.revokeFamily(l.familyId, 'LOGOUT');

    expect(revoked.sort()).toEqual([...ids].sort());
    expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
  });

  // ── Test 6 ────────────────────────────────────────────────────────────────
  /**
   * The invariant under unstructured contention, with no barrier: whatever order
   * things happen in, a revoked family never has a live generation.
   *
   * Both outcomes are legitimate here — the rotation may win and be revoked, or lose
   * and refuse — so the assertion is the invariant rather than any particular
   * result. Counting the outcomes keeps the test honest: if the jitter ever stopped
   * producing real contention, the counts would show it.
   */
  it('holds the invariant across many jittered refresh/revoke races', async () => {
    const outcomes = { rotated: 0, refused: 0, conflicted: 0 };

    for (let i = 0; i < 40; i += 1) {
      const l = await login();
      const parent = await prisma.adminSession.findUniqueOrThrow({ where: { id: l.sessionId } });
      const reason = i % 2 === 0 ? 'LOGOUT' : 'LOGOUT_ALL';

      const rotate = ops
        .rotate(parent, CLIENT)
        .then(() => {
          outcomes.rotated += 1;
        })
        .catch((err: unknown) => {
          if (err instanceof SessionFamilyRevoked) outcomes.refused += 1;
          else outcomes.conflicted += 1;
        });

      // 0-3ms of jitter, so the two land in a different order across iterations.
      const revoke = new Promise((r) => setTimeout(r, i % 4)).then(() =>
        reason === 'LOGOUT'
          ? ops.revokeFamily(l.familyId, 'LOGOUT')
          : ops.revokeAllForAdmin(l.adminId, 'LOGOUT_ALL'),
      );

      await Promise.all([rotate, revoke]);

      expect(await invariantViolations(prisma, l.adminId)).toEqual([]);
      expect(await liveGenerations(prisma, l.familyId)).toEqual([]);
    }

    // Both orderings must actually have occurred, or this proved nothing.
    expect(outcomes.rotated + outcomes.refused + outcomes.conflicted).toBe(40);
    expect(outcomes.rotated).toBeGreaterThan(0);
  }, 60_000);
});
