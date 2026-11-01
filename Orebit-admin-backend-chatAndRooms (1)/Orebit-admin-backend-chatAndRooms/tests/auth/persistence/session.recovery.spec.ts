import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client } from 'pg';
import type { AdminSession, PrismaClient } from '@prisma/client';
import {
  Adversary,
  databaseNameOf,
  dropAdmin,
  prismaFor,
  seedLogin,
  waitUntilBlocked,
  waitUntilIdleInTransaction,
  type Login,
} from '../../db/pg';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SESSION } from '../../../auth/auth.constants';
import { REVOKE_REASON } from '../../../auth/auth.types';
import type { ClientContext } from '../../../auth/auth.types';

/**
 * ═══ THE RECOVERY PREDICATE, AGAINST REAL ROWS ═══════════════════════════════
 *
 * `findRecoverableRotation` decides whether an already-consumed generation was
 * consumed by its OWN interrupted rotation — repairable — or by something else, in
 * which case the caller revokes the family exactly as it always did.
 *
 * That decision is the security boundary for both F09 and F10, so it is asserted
 * here against a real database rather than against a model of one. Two of the eight
 * conditions cannot be tested any other way: the family `FOR UPDATE` (a revocation
 * committing while recovery waits on the lock) and the single-tip requirement (which
 * is a property of what the CAS actually produced).
 *
 * ─── What every case checks, whatever else it checks ───────────────────────
 *
 * The generation COUNT. Recovery performs no INSERT and no UPDATE, so a repair that
 * created a row would be the one failure that matters most, and the row count is the
 * form the one-use guarantee actually takes. Never token equality — two repairs mint
 * two different token pairs for one generation, and that is expected.
 */

const APP_UNDER_TEST = 'orebit_pg_recovery_sut';
const APP_ADVERSARY = 'orebit_pg_recovery_adv';

const CLIENT: ClientContext = {
  ip: '203.0.113.31',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'a'.repeat(64),
  userAgent: 'vitest-pg-recovery',
};

const WINDOW = SESSION.ROTATION_RECOVERY_WINDOW_SECONDS;

const available = inject('pgAvailable');
const url = inject('pgUrl');

describe.skipIf(!available)('F09/F10 — the recovery predicate', () => {
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

  /** A rotated parent and its live child, the shape a repair is for. */
  async function rotated(l: Login): Promise<{ parent: AdminSession; tip: AdminSession }> {
    const parent = await ops.findById(l.sessionId);
    const tip = await ops.rotate(parent!, CLIENT);
    // Re-read: `rotate` stamped `rotated_at` on the row, not on the object.
    return { parent: (await ops.findById(l.sessionId))!, tip };
  }

  async function generations(familyId: string): Promise<number> {
    return prisma.adminSession.count({ where: { familyId } });
  }

  /**
   * Identity in, verdict out.
   *
   * The predicate deliberately takes ids rather than a row: both production callers
   * hold an `AdminSession` loaded BEFORE the rotation being repaired, so its
   * `rotatedAt` is stale on exactly the path that matters. Passing ids here keeps the
   * tests honest about that — a helper that forwarded a row would let a test pass
   * against a freshness the real callers do not have.
   */
  function recover(parent: AdminSession, windowSeconds = WINDOW) {
    return ops.findRecoverableRotation({
      parentId: parent.id,
      familyId: parent.familyId,
      windowSeconds,
    });
  }

  // ── 8 ─────────────────────────────────────────────────────────────────────

  it('recovers the parent of a live tip, creating no generation', async () => {
    const l = await login();
    const { parent, tip } = await rotated(l);
    const before = await generations(l.familyId);

    const found = await recover(parent);

    expect(found?.id).toBe(tip.id);
    // THE assertion: a repair is a read. Nothing was inserted, nothing consumed.
    expect(await generations(l.familyId)).toBe(before);
  });

  // ── 9 ─────────────────────────────────────────────────────────────────────

  it('refuses a revoked family', async () => {
    const l = await login();
    const { parent } = await rotated(l);
    await ops.revokeFamily(l.familyId, REVOKE_REASON.LOGOUT);

    expect(await recover(parent)).toBeNull();
  });

  it('sees a revocation that commits while it waits on the family lock', async () => {
    // The reason this takes `FOR UPDATE` at all. A logout in flight must either be
    // seen or be made to wait — a cache repair must never outrank a durable
    // revocation just because it read first.
    const l = await login();
    const { parent } = await rotated(l);

    const adv = await Adversary.connect(url, APP_ADVERSARY);
    try {
      await adv.begin();
      await adv.sql(
        'SELECT revoked_at FROM admin.admin_session_families WHERE id = $1::uuid FOR UPDATE',
        [l.familyId],
      );
      await adv.sql(
        `UPDATE admin.admin_session_families
            SET revoked_at = now(), revoked_reason = 'LOGOUT' WHERE id = $1::uuid`,
        [l.familyId],
      );
      await waitUntilIdleInTransaction(monitor, APP_ADVERSARY);

      // Recovery starts and must BLOCK on the family row the adversary holds.
      const recovering = recover(parent);
      await waitUntilBlocked(monitor, database, APP_UNDER_TEST);
      await adv.commit();

      // Granted the lock, it re-reads the latest committed version and sees the
      // revocation. Refusing is the only correct answer.
      expect(await recovering).toBeNull();
    } finally {
      await adv.end();
    }
  }, 15_000);

  // ── 10, 11 ────────────────────────────────────────────────────────────────

  it('refuses an idle-expired tip', async () => {
    const l = await login();
    const { parent, tip } = await rotated(l);
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions SET expires_at = now() - interval '1 second'
       WHERE id = ${tip.id}::uuid`;

    expect(await recover(parent)).toBeNull();
  });

  it('refuses a tip past its absolute ceiling', async () => {
    const l = await login();
    const { parent, tip } = await rotated(l);
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions SET reauthenticate_at = now() - interval '1 second'
       WHERE id = ${tip.id}::uuid`;

    expect(await recover(parent)).toBeNull();
  });

  // ── 12 ────────────────────────────────────────────────────────────────────

  it('refuses a generation more than one step behind the tip', async () => {
    // ═══ THE ONE-STEP BOUND, WHICH IS WHAT KEEPS THIS A REPAIR PATH ══════════
    //
    // A genuine replay is a token the legitimate client has already rotated PAST. So
    // after one more rotation the old generation is no longer the tip's parent, and
    // it stops being repairable — permanently, and regardless of the time window.
    // This is the condition that separates "interrupted publication" from "reusable
    // parent".
    const l = await login();
    const { parent, tip } = await rotated(l);
    await ops.rotate(tip, CLIENT);

    expect(await recover(parent)).toBeNull();
    // ...while the NEW parent, one step back, still is.
    expect(await recover((await ops.findById(tip.id))!)).not.toBeNull();
  });

  it('refuses a generation that was never rotated', async () => {
    const l = await login();
    const parent = await ops.findById(l.sessionId);

    expect(await recover(parent!)).toBeNull();
  });

  it('refuses a revoked parent even when the tip is live', async () => {
    const l = await login();
    const { parent } = await rotated(l);
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions SET revoked_at = now(), revoked_reason = 'LOGOUT'
       WHERE id = ${parent.id}::uuid`;

    expect(await recover((await ops.findById(parent.id))!)).toBeNull();
  });

  // ── 13 ────────────────────────────────────────────────────────────────────

  it('refuses a rotation older than the window', async () => {
    const l = await login();
    const { parent } = await rotated(l);
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions
         SET rotated_at = now() - make_interval(secs => ${WINDOW + 60})
       WHERE id = ${parent.id}::uuid`;

    expect(await recover((await ops.findById(parent.id))!)).toBeNull();
  });

  it('still recovers a rotation just inside the window', async () => {
    // The boundary, from the other side, so the bound is pinned rather than assumed.
    const l = await login();
    const { parent } = await rotated(l);
    await prisma.$executeRaw`
      UPDATE admin.admin_sessions
         SET rotated_at = now() - make_interval(secs => ${WINDOW - 10})
       WHERE id = ${parent.id}::uuid`;

    expect(await recover((await ops.findById(parent.id))!)).not.toBeNull();
  });

  // ── 14 ────────────────────────────────────────────────────────────────────

  it('leaves exactly one live tip after a repair', async () => {
    const l = await login();
    const { parent } = await rotated(l);

    await recover(parent);

    const tips = await prisma.adminSession.findMany({
      where: { familyId: l.familyId, rotatedAt: null, revokedAt: null },
    });
    expect(tips).toHaveLength(1);
    expect(await generations(l.familyId)).toBe(2);
  });

  it('refuses rather than guessing when the single-tip invariant is broken', async () => {
    // Unreachable through the CAS, which is exactly why it is worth pinning: the
    // predicate names "the" tip, and a reader that assumed uniqueness would silently
    // repair against whichever row came back first. A second tip is forced here by
    // hand to prove the refusal is real.
    const l = await login();
    const { parent, tip } = await rotated(l);
    await prisma.$executeRaw`
      INSERT INTO admin.admin_sessions
        (id, admin_id, family_id, parent_id, mfa_method, device_fingerprint, ip_class,
         user_agent, created_at, last_active_at, expires_at, reauthenticate_at)
      SELECT gen_random_uuid(), admin_id, family_id, parent_id, mfa_method,
             device_fingerprint, ip_class, user_agent, now(), last_active_at,
             expires_at, reauthenticate_at
        FROM admin.admin_sessions WHERE id = ${tip.id}::uuid`;

    expect(await recover(parent)).toBeNull();
  });

  // ── 16 ────────────────────────────────────────────────────────────────────

  it('reaches the same verdict when run twice, and still creates nothing', async () => {
    // The DECISION is read-only and repeatable. That is a claim about rows, not about
    // tokens: a caller repairing twice mints two different pairs for one generation,
    // which is why nothing here compares token strings.
    const l = await login();
    const { parent, tip } = await rotated(l);
    const before = await generations(l.familyId);

    const first = await recover(parent);
    const second = await recover(parent);

    expect(first?.id).toBe(tip.id);
    expect(second?.id).toBe(tip.id);
    expect(await generations(l.familyId)).toBe(before);
  });
});
