import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import {
  Adversary,
  databaseNameOf,
  dropAdmin,
  generation,
  prismaFor,
  seedExtraFamily,
  seedLogin,
  waitUntilBlocked,
  waitUntilIdleInTransaction,
  type Login,
} from '../../db/pg';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SESSION } from '../../../auth/auth.constants';
import { REVOKE_REASON } from '../../../auth/auth.types';
import type { ClientContext } from '../../../auth/auth.types';
import { uuidv7 } from '../../../src/utils/public.utils';

/**
 * ═══ F07 — ACTIVITY IS THE LOGIN'S, NOT THE GENERATION'S ═════════════════════
 *
 * Phase 1 made the FAMILY the stable identity of a login and left `lastActiveAt`
 * and `expiresAt` on the per-rotation generation. Two defects followed, and neither
 * could be reproduced without a real database.
 *
 *   D1  `touch` keyed on the generation id and did not exclude a ROTATED one, so a
 *       fire-and-forget activity write could land on a generation the session had
 *       already moved past. The obsolete row's clocks advanced; the live tip's did
 *       not. One session, two activity states, and the authoritative one was stale.
 *
 *   D2  `SessionService.rotate` read the parent with `findById` OUTSIDE the
 *       transaction and built the child from that object, so any `touch` committing
 *       between the read and the INSERT was silently discarded — the child's
 *       activity clock rolled BACKWARDS. The window spans the Redis refresh lock and
 *       the family `FOR UPDATE` wait, so it is far wider than it looks.
 *
 * ─── Why doubles cannot show either one ────────────────────────────────────
 *
 * Both are properties of what a statement SEES and when it is allowed to proceed.
 * D1 turns on READ COMMITTED re-qualification after a row lock is granted; D2 turns
 * on the gap between two statements on different connections. A fake reproducing
 * either would be a fake encoding the belief under test, which is the same argument
 * session.concurrency.spec.ts makes for F01.
 *
 * ─── How the interleavings are forced ──────────────────────────────────────
 *
 * An `Adversary` holds a transaction open; the code under test runs on Prisma;
 * `waitUntilBlocked` polls `pg_blocking_pids` until the DATABASE confirms the second
 * statement is waiting on the first. Nothing here sleeps to "let" something happen.
 * A sleep proves nothing, and a green run built on one would be worthless.
 *
 * ─── The invariant this file pins, stated precisely ────────────────────────
 *
 * NOT "activity is never lost" — that would be false, and case 4 exists to say so
 * out loud. The design deliberately allows a `touch` granted its row lock AFTER a
 * rotation commits to match zero rows. What is guaranteed is narrower and is what
 * actually protects the session:
 *
 *   activity may be dropped within the existing write-throttle tolerance, but it is
 *   never written to an obsolete generation, and it never extends the session
 *
 * Everything below is one of those two clauses, or one of the three authorities
 * (revocation, idle, absolute) that must survive them.
 */

const APP_UNDER_TEST = 'orebit_pg_activity_sut';
const APP_ADVERSARY = 'orebit_pg_activity_adv';

const CLIENT: ClientContext = {
  ip: '203.0.113.11',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'd'.repeat(64),
  userAgent: 'vitest-pg-activity',
};

/** Comfortably outside `ACTIVITY_WRITE_INTERVAL_SECONDS`, so a touch is due. */
const AGED = `${SESSION.ACTIVITY_WRITE_INTERVAL_SECONDS * 2} seconds`;

const available = inject('pgAvailable');
const url = inject('pgUrl');

interface Row {
  id: string;
  last_active_at: Date;
  expires_at: Date;
  reauthenticate_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

describe.skipIf(!available)('F07 — session activity under real concurrency', () => {
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

  /** One generation, read straight from the table. */
  async function row(id: string): Promise<Row> {
    const [r] = await prisma.$queryRaw<Row[]>`
      SELECT id, last_active_at, expires_at, reauthenticate_at, rotated_at, revoked_at
        FROM admin.admin_sessions WHERE id = ${id}::uuid`;
    if (r === undefined) throw new Error(`no generation ${id}`);
    return r;
  }

  /** Push a generation's activity instant into the past so a touch is due. */
  async function age(id: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE admin.admin_sessions SET last_active_at = now() - interval '${AGED}' WHERE id = $1::uuid`,
      id,
    );
  }

  /** THE invariant licensing `touch`'s WHERE clause, asked of the database. */
  async function multiTipFamilies(adminId: string): Promise<{ family_id: string }[]> {
    return prisma.$queryRaw<{ family_id: string }[]>`
      SELECT family_id
        FROM admin.admin_sessions
       WHERE admin_id = ${adminId}::uuid
         AND rotated_at IS NULL
         AND revoked_at IS NULL
       GROUP BY family_id
      HAVING count(*) > 1`;
  }

  // ── 1 ─────────────────────────────────────────────────────────────────────

  it('never touches an obsolete generation', async () => {
    // D1, stated as the thing that must not happen. After a rotation the parent is
    // finished: its clocks must be frozen at the moment it was replaced, forever.
    const l = await login();
    await age(l.sessionId);

    const parent = await ops.findById(l.sessionId);
    const child = await ops.rotate(parent!, CLIENT);
    const parentAtRotation = await row(l.sessionId);

    await ops.touch(l.familyId);

    const parentAfter = await row(l.sessionId);
    const childAfter = await row(child.id);

    // The obsolete generation did not move, at all.
    expect(parentAfter.last_active_at).toEqual(parentAtRotation.last_active_at);
    expect(parentAfter.expires_at).toEqual(parentAtRotation.expires_at);
    // The live tip did.
    expect(childAfter.last_active_at.getTime()).toBeGreaterThan(
      parentAtRotation.last_active_at.getTime(),
    );
  });

  it('writes nothing when handed a generation id instead of a family id', async () => {
    // The two are different values with different jobs and both are uuids, so a
    // caller passing the wrong one is a mistake the type system cannot catch. It
    // must fail closed — write nothing — rather than find some row by coincidence.
    const l = await login();
    await age(l.sessionId);
    const before = await row(l.sessionId);

    await ops.touch(l.sessionId);

    expect(await row(l.sessionId)).toEqual(before);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────

  it('never moves activity backwards across a rotation', async () => {
    // The anti-regression for D2, as a monotonicity property rather than as an
    // implementation detail: whatever the child ends up with, it is not older than
    // anything the parent ever held.
    const l = await login();
    await age(l.sessionId);
    const seeded = await row(l.sessionId);

    await ops.touch(l.familyId);
    const touched = await row(l.sessionId);
    expect(touched.last_active_at.getTime()).toBeGreaterThan(seeded.last_active_at.getTime());

    const parent = await ops.findById(l.sessionId);
    const child = await ops.rotate(parent!, CLIENT);

    expect(child.lastActiveAt.getTime()).toBeGreaterThanOrEqual(touched.last_active_at.getTime());
    expect(child.expiresAt.getTime()).toBeGreaterThanOrEqual(touched.expires_at.getTime());
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────

  it('inherits the POST-touch activity when a touch commits first', async () => {
    // ═══ D2, REPRODUCED ══════════════════════════════════════════════════════
    //
    // The parent object is read BEFORE the touch, exactly as `SessionService.rotate`
    // reads it — outside the transaction. Then a touch commits underneath. If the
    // child is built from the object rather than from the row, the committed write
    // is discarded and the session's activity clock rolls backwards.
    //
    // The barrier is what makes this deterministic: the rotation's CAS is PROVEN to
    // be waiting on the adversary's row lock before the adversary commits.
    const l = await login();
    await age(l.sessionId);

    const stale = await ops.findById(l.sessionId);

    const adv = await Adversary.connect(url, APP_ADVERSARY);
    try {
      await adv.begin();
      // The touch, held open: row locked, not yet visible to anyone else.
      await adv.sql(
        `UPDATE admin.admin_sessions
            SET last_active_at = now(),
                expires_at = LEAST(now() + interval '30 minutes', reauthenticate_at)
          WHERE id = $1::uuid`,
        [l.sessionId],
      );
      await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

      // Now rotate. Its CAS must contend for the row the adversary is holding.
      const rotating = ops.rotate(stale!, CLIENT);
      await waitUntilBlocked(monitor, database, APP_UNDER_TEST);
      await adv.commit();

      const child = await rotating;
      const parentAfter = await row(l.sessionId);

      // The child carries what the row said AFTER the touch — not what the object
      // read before it said. `RETURNING` yielded the post-update version.
      expect(child.lastActiveAt).toEqual(parentAfter.last_active_at);
      expect(child.expiresAt).toEqual(parentAfter.expires_at);
      expect(child.lastActiveAt.getTime()).toBeGreaterThan(stale!.lastActiveAt.getTime());
    } finally {
      await adv.end();
    }
  }, 15_000);

  // ── 4 ─────────────────────────────────────────────────────────────────────

  it('drops a touch that loses the race to a rotation, and recovers on the next one', async () => {
    // ═══ THE DOCUMENTED RESIDUAL, PINNED SO IT CANNOT WIDEN ══════════════════
    //
    // `touch`'s scan finds the parent as the tip; a rotation then commits while the
    // touch waits on that row's lock. READ COMMITTED re-qualifies against the new
    // version, `rotated_at IS NOT NULL`, and the row is skipped. EvalPlanQual
    // re-checks rows the scan already FOUND — it does not re-run the scan — so the
    // child is not touched either, and this request's activity is simply dropped.
    //
    // That is deliberate and it is strictly safer than what it replaced, which was
    // writing to the obsolete row. The loss is bounded because the very next
    // eligible request writes to the tip, which is the second half of this test.
    const l = await login();
    await age(l.sessionId);
    const parentBefore = await row(l.sessionId);

    const childId = uuidv7();
    const adv = await Adversary.connect(url, APP_ADVERSARY);
    try {
      const child = generation(childId, l.adminId, l.familyId, l.sessionId);
      await adv.begin();
      await adv.sql(
        'SELECT revoked_at FROM admin.admin_session_families WHERE id = $1::uuid FOR UPDATE',
        [l.familyId],
      );
      // The rotation's CAS: stamps the parent, taking its row lock.
      await adv.sql(
        `UPDATE admin.admin_sessions SET rotated_at = now()
          WHERE id = $1::uuid AND rotated_at IS NULL AND revoked_at IS NULL`,
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
          parentBefore.last_active_at,
          parentBefore.expires_at,
          parentBefore.reauthenticate_at,
        ],
      );
      await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

      // The touch starts against a snapshot in which the parent is still the tip.
      const touching = ops.touch(l.familyId);
      await waitUntilBlocked(monitor, database, APP_UNDER_TEST);
      await adv.commit();
      await touching;
    } finally {
      await adv.end();
    }

    // Nothing moved: not the obsolete parent, and not the child the scan never saw.
    expect(await row(l.sessionId)).toEqual({
      ...parentBefore,
      rotated_at: expect.any(Date) as unknown as Date,
    });
    const childAfterDrop = await row(childId);
    expect(childAfterDrop.last_active_at).toEqual(parentBefore.last_active_at);

    // ─── and the loss is transient ───────────────────────────────────────────
    // The next eligible request finds the child as the tip and writes to it, so the
    // session is at most one write interval stale rather than permanently behind.
    await ops.touch(l.familyId);
    const recovered = await row(childId);
    expect(recovered.last_active_at.getTime()).toBeGreaterThan(
      childAfterDrop.last_active_at.getTime(),
    );
  }, 15_000);

  // ── 5 ─────────────────────────────────────────────────────────────────────

  it('cannot resurrect a revoked family', async () => {
    const l = await login();
    await age(l.sessionId);
    await ops.revokeFamily(l.familyId, REVOKE_REASON.LOGOUT);
    const revoked = await row(l.sessionId);

    await ops.touch(l.familyId);

    // A revoked family has no tip, so there is nothing for the statement to match.
    expect(await row(l.sessionId)).toEqual(revoked);
  });

  it('cannot resurrect a family revoked while the touch was in flight', async () => {
    // The ordering that matters: the touch qualified the row BEFORE the revocation
    // committed. Re-qualification after the lock is granted is what refuses it.
    const l = await login();
    await age(l.sessionId);
    const before = await row(l.sessionId);

    const adv = await Adversary.connect(url, APP_ADVERSARY);
    try {
      await adv.begin();
      await adv.sql(
        `UPDATE admin.admin_sessions SET revoked_at = now(), revoked_reason = 'LOGOUT'
          WHERE id = $1::uuid AND revoked_at IS NULL`,
        [l.sessionId],
      );
      await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

      const touching = ops.touch(l.familyId);
      await waitUntilBlocked(monitor, database, APP_UNDER_TEST);
      await adv.commit();
      await touching;
    } finally {
      await adv.end();
    }

    const after = await row(l.sessionId);
    expect(after.revoked_at).not.toBeNull();
    expect(after.last_active_at).toEqual(before.last_active_at);
    expect(after.expires_at).toEqual(before.expires_at);
  }, 15_000);

  // ── 6 ─────────────────────────────────────────────────────────────────────

  it('cannot resurrect a session that idled out in the gap', async () => {
    const l = await login();
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions
         SET last_active_at = now() - interval '1 hour', expires_at = now() - interval '1 second'
       WHERE id = ${l.sessionId}::uuid`;
    const dead = await row(l.sessionId);

    await ops.touch(l.familyId);

    // `expires_at > now()` in the WHERE clause is what refuses this. Bookkeeping
    // must not revive a session that has already ended.
    expect(await row(l.sessionId)).toEqual(dead);
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────

  it('cannot push the idle deadline past the absolute ceiling', async () => {
    const l = await login();
    // A ceiling closer than a full idle window, so `LEAST` has to bite.
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions
         SET last_active_at = now() - interval '1 hour',
             expires_at = now() + interval '30 seconds',
             reauthenticate_at = now() + interval '60 seconds'
       WHERE id = ${l.sessionId}::uuid`;
    const before = await row(l.sessionId);

    await ops.touch(l.familyId);
    const after = await row(l.sessionId);

    // Clamped exactly to the ceiling, not to now + the full inactivity window...
    expect(after.expires_at).toEqual(after.reauthenticate_at);
    // ...and the ceiling itself is untouched. Nothing but `issue` ever writes it.
    expect(after.reauthenticate_at).toEqual(before.reauthenticate_at);
    expect(after.expires_at.getTime()).toBeLessThan(
      Date.now() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000,
    );
  });

  it('cannot extend the ceiling by any number of touches', async () => {
    const l = await login();
    const ceiling = (await row(l.sessionId)).reauthenticate_at;

    for (let i = 0; i < 5; i += 1) {
      await age(l.sessionId);
      await ops.touch(l.familyId);
    }

    expect((await row(l.sessionId)).reauthenticate_at).toEqual(ceiling);
  });

  // ── 8 ─────────────────────────────────────────────────────────────────────

  it('keeps exactly one live tip per family, through rotation and both revokes', async () => {
    // ═══ THE INVARIANT THAT LICENSES `touch`'s WHERE CLAUSE ══════════════════
    //
    // `family_id = ? AND rotated_at IS NULL AND revoked_at IS NULL` names the tip
    // only if it can never name two rows. That is guaranteed by `rotate`'s CAS under
    // the family lock — it can only consume the CURRENT tip and produce one new one
    // — but it is a code-enforced property rather than a constraint, so it is asked
    // of the database directly here.
    const l = await login();
    const extra = await seedExtraFamily(prisma, l.adminId);

    let parent = await ops.findById(l.sessionId);
    for (let i = 0; i < 4; i += 1) {
      const child = await ops.rotate(parent!, CLIENT);
      expect(await multiTipFamilies(l.adminId)).toEqual([]);
      parent = await ops.findById(child.id);
    }

    await ops.revokeFamily(l.familyId, REVOKE_REASON.LOGOUT);
    expect(await multiTipFamilies(l.adminId)).toEqual([]);

    await ops.revokeAllForAdmin(l.adminId, REVOKE_REASON.LOGOUT_ALL);
    expect(await multiTipFamilies(l.adminId)).toEqual([]);

    // And the second family went with it — no tip anywhere for this admin.
    const remaining = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM admin.admin_sessions
       WHERE admin_id = ${l.adminId}::uuid AND rotated_at IS NULL AND revoked_at IS NULL`;
    expect(Number(remaining[0]!.n)).toBe(0);
    expect(extra.familyId).toBeTruthy();
  });

  // ── supporting ────────────────────────────────────────────────────────────

  it('still writes exactly once per interval when two requests race', async () => {
    // The write-throttle property, which the rekey must not have broken. The second
    // UPDATE re-qualifies against the committed new `last_active_at`, finds the
    // interval predicate false, and matches nothing.
    const l = await login();
    await age(l.sessionId);

    const adv = await Adversary.connect(url, APP_ADVERSARY);
    try {
      await adv.begin();
      await adv.sql(
        `UPDATE admin.admin_sessions
            SET last_active_at = now(),
                expires_at = LEAST(now() + interval '30 minutes', reauthenticate_at)
          WHERE id = $1::uuid
            AND last_active_at <= now() - interval '${SESSION.ACTIVITY_WRITE_INTERVAL_SECONDS} seconds'`,
        [l.sessionId],
      );
      await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

      const touching = ops.touch(l.familyId);
      await waitUntilBlocked(monitor, database, APP_UNDER_TEST);
      await adv.commit();
      await touching;
    } finally {
      await adv.end();
    }

    const after = await row(l.sessionId);
    // One write happened — the adversary's. The loser wrote nothing, which is the
    // point: no lock of our own, and no read-then-write to lose.
    expect(after.last_active_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.rotated_at).toBeNull();
  }, 15_000);
});
