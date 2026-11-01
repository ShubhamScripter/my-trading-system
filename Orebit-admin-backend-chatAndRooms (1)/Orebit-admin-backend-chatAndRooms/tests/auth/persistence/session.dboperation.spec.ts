import { describe, expect, it, vi } from 'vitest';
import type { AdminSession, Prisma } from '@prisma/client';
import {
  SessionDbOperation,
  SessionFamilyRevoked,
} from '../../../auth/persistence/session.dboperation';
import { SESSION } from '../../../auth/auth.constants';
import type { ClientContext } from '../../../auth/auth.types';
import { makeSession } from '../../harness';

/**
 * ═══ THE CEILING IS ONLY IMMUTABLE IF THIS LAYER COPIES IT ══════════════════════
 *
 * `SessionService` computes the child's idle expiry and hands it down, but it never
 * touches `reauthenticateAt` on a rotation — the copy happens here, in one line of
 * `rotate`'s `create` call. Every service-level test of the ceiling runs against a
 * DOUBLE of this class that copies it because the double was written to, so those
 * tests would keep passing if this line were deleted. This file is the one that
 * would fail, which makes it the only real check that the requirement holds.
 *
 * The double here is a fake Prisma client rather than a live database: what is being
 * asserted is the SHAPE of the write, and a fake records that exactly. The atomicity
 * `$transaction` provides is Postgres's job and not something a unit test can prove.
 */

const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
const FAMILY_ID = '01920000-0000-7000-8000-00000000000f';
const PARENT_ID = '01920000-0000-7000-8000-00000000000b';

const CLIENT: ClientContext = {
  ip: '203.0.113.195',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'c'.repeat(32),
  userAgent: 'vitest-child',
};

/**
 * A Prisma stand-in that runs the callback inline and records what was written.
 *
 * `updateMany` returns a count of 1 by default — the compare-and-swap succeeding —
 * so a test that wants the conflict path sets it to 0 explicitly.
 *
 * ═══ THE TRANSACTION DOUBLE RECORDS ORDER, NOT JUST CONTENT ══════════════════
 *
 * Every statement appends to one shared `ops` log, in call order, so a test can
 * assert that the family lock was taken BEFORE the generation was touched. That
 * ordering is the whole of the concurrency fix, and it is the one property a fake
 * can still check: whether Postgres then serialises correctly is the database's job
 * and is proven against a real one in session.concurrency.spec.ts.
 *
 * `familyRevokedAt` drives what the locking SELECT reports, so a test can exercise
 * the revoked-family branch without a database.
 */
/** What the CAS answers when a test names neither a parent nor an override. Only
 *  reached by tests that do not look at the child's clocks. */
const CAS_FALLBACK = {
  lastActiveAt: new Date('2026-06-15T11:00:00.000Z'),
  expiresAt: new Date('2026-06-15T11:30:00.000Z'),
};

function fakePrisma(
  options: {
    stampedCount?: number;
    familyRevokedAt?: Date;
    familyMissing?: boolean;
    /**
     * The parent fixture, so the CAS's `RETURNING` answers as its ROW would. This is
     * the UNCONTENDED case — nothing committed between the caller's read and the
     * lock, so the row and the object agree.
     */
    parent?: AdminSession;
    /**
     * What the parent ROW says, when that differs from the `parent` OBJECT the
     * caller passed in. This is the lost-update case: a `touch` committed underneath
     * the rotation, so the row has moved on. A child built from the argument would
     * miss it.
     */
    casReturns?: { lastActiveAt: Date; expiresAt: Date };
  } = {},
) {
  const CAS_DEFAULT = options.casReturns ?? {
    lastActiveAt: options.parent?.lastActiveAt ?? CAS_FALLBACK.lastActiveAt,
    expiresAt: options.parent?.expiresAt ?? CAS_FALLBACK.expiresAt,
  };
  const created: Prisma.AdminSessionCreateArgs['data'][] = [];
  const updated: unknown[] = [];
  /** Every statement the transaction issued, in order. */
  const ops: string[] = [];
  /** Prisma's tagged-template form: the SQL fragments, then the bound values. */
  const raw: { sql: string; values: unknown[] }[] = [];

  const adminSession = {
    create: vi.fn(async (args: Prisma.AdminSessionCreateArgs) => {
      ops.push('session.create');
      created.push(args.data);
      return makeSession(args.data as Partial<AdminSession>);
    }),
    updateMany: vi.fn(async (args: unknown) => {
      ops.push('session.updateMany');
      updated.push(args);
      return { count: options.stampedCount ?? 1 };
    }),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  };

  /** Family rows land in their own list: every generation assertion indexes
   *  `created`, and mixing the two would silently shift those indices. */
  const families: Record<string, unknown>[] = [];
  const adminSessionFamily = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      ops.push('family.create');
      families.push(args.data);
      return args.data;
    }),
  };

  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    raw.push({ sql, values });

    if (sql.includes('FOR UPDATE')) {
      ops.push(sql.includes('admin_session_families') ? 'family.lock' : 'lock');
      if (options.familyMissing === true) return [];
      return [{ revoked_at: options.familyRevokedAt ?? null, revoked_reason: 'LOGOUT' }];
    }
    if (sql.includes('RETURNING id')) {
      ops.push('sessions.revoke');
      return [{ id: PARENT_ID }];
    }
    // ═══ THE ROTATION CAS ══════════════════════════════════════════════════
    //
    // `rotate` stamps the parent with `UPDATE ... RETURNING last_active_at,
    // expires_at` and builds the child from what comes back, rather than from the
    // `parent` object it was handed — that is what makes a `touch` committed
    // underneath it inherited rather than lost.
    //
    // So this double has to answer as the ROW would, and `casReturns` is how a test
    // says what the row said. It defaults to the parent fixture's own values, which
    // is the uncontended case; a test reproducing the lost update sets it to
    // something different and asserts the child took THAT.
    //
    // Zero rows is the CAS losing: already rotated, or revoked in flight.
    if (sql.includes('SET rotated_at')) {
      ops.push('session.updateMany');
      updated.push({ sql, values });
      if ((options.stampedCount ?? 1) === 0) return [];
      return [
        { last_active_at: CAS_DEFAULT.lastActiveAt, expires_at: CAS_DEFAULT.expiresAt },
      ];
    }
    return [];
  });

  const $executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    raw.push({ sql, values });
    if (sql.includes('lock_timeout')) ops.push('lock_timeout');
    else if (sql.includes('admin_session_families')) ops.push('family.revoke');
    return 1;
  });

  const tx = { adminSession, adminSessionFamily, $queryRaw, $executeRaw };

  return {
    prisma: {
      adminSession,
      adminSessionFamily,
      $transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
      $queryRaw,
      $executeRaw,
    },
    created,
    families,
    updated,
    raw,
    ops,
    adminSession,
    adminSessionFamily,
  };
}

describe('rotate', () => {
  /** ═══ ACCEPTANCE: "COPY IT UNCHANGED TO CHILDREN" ═══════════════════════════ */
  it('copies the parent reauthenticateAt into the child byte for byte', async () => {
    const ceiling = new Date('2026-06-15T12:00:00.000Z');
    const parent = makeSession({
      id: PARENT_ID,
      adminId: ADMIN_ID,
      familyId: FAMILY_ID,
      mfaMethod: 'TOTP',
      expiresAt: new Date('2026-06-15T03:00:00.000Z'),
      reauthenticateAt: ceiling,
    });

    const f = fakePrisma({ parent });
    const ops = new SessionDbOperation(f.prisma as never);

    await ops.rotate(parent, CLIENT);

    expect(f.created).toHaveLength(1);
    const child = f.created[0]!;

    // The ceiling is the parent's, to the millisecond, and NOT recomputed from the
    // idle window or from now.
    expect(child.reauthenticateAt).toEqual(ceiling);
    expect((child.reauthenticateAt as Date).getTime()).toBe(ceiling.getTime());
    // The idle deadline is the PARENT ROW's, read under the family lock by the CAS
    // rather than passed in by the caller. There is no longer a parameter for a
    // caller to get wrong.
    expect(child.expiresAt).toEqual(parent.expiresAt);
    // And the family identity carries over, since a family is one sign-in.
    expect(child.familyId).toBe(FAMILY_ID);
    expect(child.parentId).toBe(PARENT_ID);
    expect(child.mfaMethod).toBe('TOTP');
  });

  /**
   * The interesting direction: a ceiling ALREADY in the past must be inherited as
   * it is, not quietly refreshed. `SessionService.rotate` refuses such a session
   * before reaching this method, so the value here is that no fallback exists to
   * paper over a caller that did not — the child is born dead, which is correct.
   */
  it('inherits a ceiling that has already passed rather than renewing it', async () => {
    const pastCeiling = new Date('2020-01-01T00:00:00.000Z');
    const parent = makeSession({
      id: PARENT_ID,
      familyId: FAMILY_ID,
      reauthenticateAt: pastCeiling,
    });

    const f = fakePrisma({ parent });
    const ops = new SessionDbOperation(f.prisma as never);
    await ops.rotate(parent, CLIENT);

    expect(f.created[0]!.reauthenticateAt).toEqual(pastCeiling);
  });

  /**
   * ═══ AUTOMATIC REFRESH IS NOT ACTIVITY ════════════════════════════════════
   *
   * The single most important assertion about this column. A rotation INSERTS a row,
   * and under the BFF it happens on its own schedule, mid-request, with no person
   * involved. A child that took `now()` for its activity instant would make every
   * background refresh look like the admin doing something, and an abandoned tab
   * would hold an admin session open for as long as the ceiling allowed — the exact
   * failure the two-clock design exists to prevent.
   *
   * `created_at` is no substitute for the check: a rotation stamps it with the
   * rotation's own time, which is why the assertion below pins the difference between
   * the two rather than only the copy.
   *
   * The parent here was last active two hours ago. If this test ever fails with a
   * value close to `now()`, refresh has started counting as activity.
   */
  it('copies the parent last_active_at, so a refresh is not activity', async () => {
    const lastReallyActive = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const parent = makeSession({
      id: PARENT_ID,
      familyId: FAMILY_ID,
      lastActiveAt: lastReallyActive,
    });

    const f = fakePrisma({ parent });
    const ops = new SessionDbOperation(f.prisma as never);
    const before = Date.now();
    await ops.rotate(parent, CLIENT);

    const child = f.created[0]!;
    expect(child.lastActiveAt).toEqual(lastReallyActive);
    // Not "now", stated separately so a failure says WHICH way it went wrong.
    expect((child.lastActiveAt as Date).getTime()).toBeLessThan(before);
  });

  it('does not create a child when the parent could not be claimed', async () => {
    const f = fakePrisma({ stampedCount: 0 });
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(
      ops.rotate(makeSession({ id: PARENT_ID }), CLIENT),
    ).rejects.toThrow(/could not be rotated/);

    expect(f.created).toHaveLength(0);
  });

  /**
   * ═══ F07 — THE CHILD'S CLOCKS COME FROM THE ROW, NOT FROM THE ARGUMENT ═════
   *
   * The lost update, made visible without a database: the `parent` OBJECT and the
   * parent ROW are given deliberately different activity values, which is exactly
   * the state a `touch` committing between the caller's read and this transaction
   * produces. A child built from the argument inherits the stale pair and the
   * session's activity clock rolls backwards.
   *
   * The real interleaving — proving the CAS actually BLOCKS on the touch's row lock
   * and then re-reads — needs Postgres, and is
   * session.activity.concurrency.spec.ts's "inherits the POST-touch activity" case.
   * This one pins the plumbing: that `RETURNING` is what feeds the `create`.
   */
  it('takes both activity clocks from the CAS, not from the parent argument', async () => {
    const stale = makeSession({
      id: PARENT_ID,
      familyId: FAMILY_ID,
      lastActiveAt: new Date('2026-06-15T10:00:00.000Z'),
      expiresAt: new Date('2026-06-15T10:30:00.000Z'),
    });
    // What the row says once a concurrent touch has committed.
    const fresh = {
      lastActiveAt: new Date('2026-06-15T10:20:00.000Z'),
      expiresAt: new Date('2026-06-15T10:50:00.000Z'),
    };

    const f = fakePrisma({ casReturns: fresh });
    const ops = new SessionDbOperation(f.prisma as never);
    await ops.rotate(stale, CLIENT);

    const child = f.created[0]!;
    expect(child.lastActiveAt).toEqual(fresh.lastActiveAt);
    expect(child.expiresAt).toEqual(fresh.expiresAt);
    // Stated as the negative too, so a failure says which side it took.
    expect(child.lastActiveAt).not.toEqual(stale.lastActiveAt);
    expect(child.expiresAt).not.toEqual(stale.expiresAt);
  });

  it('claims the parent with a RETURNING CAS, still qualified on both flags', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);
    await ops.rotate(makeSession({ id: PARENT_ID, familyId: FAMILY_ID }), CLIENT);

    const cas = f.raw.find((r) => r.sql.includes('SET rotated_at'))!;
    // The compare-and-swap predicate is unchanged — that is what keeps two
    // concurrent refreshes of one token from both winning, and it is the property
    // F01's suite exercises. Only the RETURNING is new.
    expect(cas.sql).toContain('rotated_at IS NULL');
    expect(cas.sql).toContain('revoked_at IS NULL');
    expect(cas.sql).toContain('RETURNING last_active_at, expires_at');
    expect(cas.values).toEqual([PARENT_ID]);
  });
});

/**
 * ═══ THE LOCK ORDER IS THE FIX ═══════════════════════════════════════════════
 *
 * These assert the ORDER of statements, not their effect, and that is the most a
 * fake can honestly prove. Whether Postgres then serialises two transactions
 * correctly is the database's job, and is proven against a real one in
 * session.concurrency.spec.ts.
 *
 * What order buys is everything else: a family lock taken AFTER the parent has been
 * stamped, or after the child has been inserted, is not a lock at all — the window
 * it was meant to close has already passed. So a refactor that keeps every statement
 * but reorders two of them would still be the original defect, and this is the file
 * that would notice.
 */
describe('the family lock', () => {
  function parent(overrides: Partial<AdminSession> = {}) {
    return makeSession({ id: PARENT_ID, familyId: FAMILY_ID, ...overrides });
  }

  it('rotate locks the family FIRST, then stamps the parent, then writes the child', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await ops.rotate(parent(), CLIENT);

    expect(f.ops).toEqual([
      'lock_timeout',
      'family.lock',
      'session.updateMany',
      'session.create',
    ]);
  });

  it('rotate locks on the PRIMARY KEY only, so a blocked lock cannot silently skip the row', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await ops.rotate(parent(), CLIENT);

    const lock = f.raw.find((r) => r.sql.includes('FOR UPDATE'))!;
    expect(lock.sql).toContain('admin_session_families');
    expect(lock.values).toEqual([FAMILY_ID]);
    // A `revoked_at IS NULL` qual here would make a concurrently-revoked family come
    // back as ZERO rows — indistinguishable from a family that does not exist, and
    // with `revoked_reason` discarded. See the comment on the statement itself.
    expect(lock.sql).not.toContain('revoked_at IS NULL');
    // Both columns must come back: the refusal below is built from them.
    expect(lock.sql).toContain('revoked_at');
    expect(lock.sql).toContain('revoked_reason');
  });

  it('rotate refuses a revoked family with SessionFamilyRevoked, and writes nothing', async () => {
    const f = fakePrisma({ familyRevokedAt: new Date('2026-06-15T11:00:00.000Z') });
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(ops.rotate(parent(), CLIENT)).rejects.toThrow(
      SessionFamilyRevoked,
    );

    // Not a rotation conflict: the caller turns THAT into "reuse detected", revokes
    // the family and logs a security warning. A logout is not credential theft.
    expect(f.created).toHaveLength(0);
    expect(f.adminSession.updateMany).not.toHaveBeenCalled();
    expect(f.ops).toEqual(['lock_timeout', 'family.lock']);
  });

  it('rotate carries the family revokedReason out, so the refusal can name the scope', async () => {
    const f = fakePrisma({ familyRevokedAt: new Date() });
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(
      ops.rotate(parent(), CLIENT),
    ).rejects.toMatchObject({ familyId: FAMILY_ID, revokedReason: 'LOGOUT' });
  });

  /**
   * A generation written by an application instance from before the family table
   * existed has no family row to lock. It must NOT be read as revoked — that would
   * sign out every such session the moment this code deploys — so the generation CAS
   * remains what governs, exactly as it did before.
   */
  it('rotate proceeds when the family row is absent, falling back to the generation CAS', async () => {
    const f = fakePrisma({ familyMissing: true });
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(
      ops.rotate(parent(), CLIENT),
    ).resolves.toBeDefined();
    expect(f.ops).toEqual(['lock_timeout', 'family.lock', 'session.updateMany', 'session.create']);
  });

  it('revokeFamily locks the family, revokes it, then revokes its generations', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(ops.revokeFamily(FAMILY_ID, 'LOGOUT')).resolves.toEqual([PARENT_ID]);
    expect(f.ops).toEqual(['lock_timeout', 'family.lock', 'family.revoke', 'sessions.revoke']);
  });

  /**
   * The ids must come from the statement that CHANGED the rows, not from a read
   * taken before it. A read-then-write returns the set as it was BEFORE the write,
   * which omits any generation created in between — and that generation is exactly
   * the one a concurrent refresh produces. It would be revoked in Postgres and never
   * flagged in the cache.
   */
  it('revokeFamily returns the rows it actually changed, via RETURNING', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await ops.revokeFamily(FAMILY_ID, 'LOGOUT');

    const update = f.raw.find((r) => r.sql.includes('admin.admin_sessions'))!;
    expect(update.sql).toContain('RETURNING id');
    expect(f.adminSession.findMany).not.toHaveBeenCalled();
  });

  it('revokeAllForAdmin locks every live family in id order, and never SKIP LOCKED', async () => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await expect(ops.revokeAllForAdmin(ADMIN_ID, 'LOGOUT_ALL')).resolves.toEqual([PARENT_ID]);
    expect(f.ops).toEqual(['lock_timeout', 'family.lock', 'family.revoke', 'sessions.revoke']);

    const lock = f.raw.find((r) => r.sql.includes('FOR UPDATE'))!;
    expect(lock.sql).toContain('ORDER BY id');
    // SKIP LOCKED here would skip precisely the family that is mid-rotation — the
    // one most in need of revoking — which is the original defect in a new shape.
    expect(lock.sql).not.toContain('SKIP LOCKED');
    expect(lock.sql).not.toContain('NOWAIT');
  });

  /** Every path that can create or destroy a usable generation bounds its wait in
   *  the DATABASE, so the error is a classifiable `55P03` rather than Prisma's
   *  opaque five-second `P2028`. */
  it.each([
    ['rotate', async (o: SessionDbOperation) => o.rotate(parent(), CLIENT)],
    ['revokeFamily', async (o: SessionDbOperation) => void (await o.revokeFamily(FAMILY_ID, 'LOGOUT'))],
    ['revokeAllForAdmin', async (o: SessionDbOperation) => void (await o.revokeAllForAdmin(ADMIN_ID, 'LOGOUT_ALL'))],
  ])('%s sets a lock_timeout before taking any lock', async (_name, run) => {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);

    await run(ops);

    expect(f.ops[0]).toBe('lock_timeout');
    expect(f.raw[0]!.sql).toContain('lock_timeout');
  });
});

describe('createFirstGeneration', () => {
  const LOGIN_AT = new Date('2026-06-15T01:30:00.000Z');

  function created() {
    const expiresAt = new Date('2026-06-15T02:00:00.000Z');
    const reauthenticateAt = new Date('2026-06-15T12:00:00.000Z');

    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);
    return { f, ops, expiresAt, reauthenticateAt };
  }

  it('writes both clocks and hangs the generation off a NEW family row', async () => {
    const { f, ops, expiresAt, reauthenticateAt } = created();
    await ops.createFirstGeneration({
      adminId: ADMIN_ID,
      mfaMethod: 'TOTP',
      client: CLIENT,
      lastActiveAt: LOGIN_AT,
      expiresAt,
      reauthenticateAt,
    });

    const row = f.created[0]!;
    expect(row.expiresAt).toEqual(expiresAt);
    expect(row.reauthenticateAt).toEqual(reauthenticateAt);
    expect(row.parentId).toBeNull();

    // ═══ THE FAMILY IS A ROW NOW, AND IT IS NOT THE GENERATION ════════════════
    //
    // This used to assert `familyId === id` — the old scheme, where a family had no
    // record and borrowed its first generation's id for want of anywhere else to
    // live. Asserting it today would pin the very coupling this change removes, so
    // the assertion is inverted rather than deleted: the two ids must DIFFER, and
    // the generation must point at the family that was just created.
    const family = f.families[0]!;
    expect(row.familyId).toBe(family['id']);
    expect(row.familyId).not.toBe(row.id);
    expect(family['adminId']).toBe(ADMIN_ID);
  });

  /**
   * The family must exist before anything references it — that is what makes a
   * generation revocable from the moment it is written, and it is the reason both
   * writes share one transaction.
   */
  it('creates the family BEFORE the generation, in one transaction', async () => {
    const { f, ops, expiresAt, reauthenticateAt } = created();
    await ops.createFirstGeneration({
      adminId: ADMIN_ID,
      mfaMethod: 'TOTP',
      client: CLIENT,
      lastActiveAt: LOGIN_AT,
      expiresAt,
      reauthenticateAt,
    });

    expect(f.ops).toEqual(['family.create', 'session.create']);
  });

  /**
   * ═══ THE LOGIN INSTANT IS THE FIRST ACTIVITY ═══════════════════════════════
   *
   * The requirement states it directly: an admin who signs in at 10:00 has
   * `last_active_at = 10:00`, so a sign-in followed by silence is idle from the
   * sign-in rather than from whenever their first API call happens to land.
   *
   * Asserted on the value the CALLER passed, not on `now()`, because that is what
   * makes the column a record of an event rather than of a write.
   */
  it('seeds last_active_at from the sign-in instant', async () => {
    const { f, ops, expiresAt, reauthenticateAt } = created();
    await ops.createFirstGeneration({
      adminId: ADMIN_ID,
      mfaMethod: 'TOTP',
      client: CLIENT,
      lastActiveAt: LOGIN_AT,
      expiresAt,
      reauthenticateAt,
    });

    expect(f.created[0]!.lastActiveAt).toEqual(LOGIN_AT);
  });
});

describe('readLiveness', () => {
  function opsReturning(row: unknown) {
    const f = fakePrisma();
    f.adminSession.findUnique.mockResolvedValue(row);
    return { ops: new SessionDbOperation(f.prisma as never), findUnique: f.adminSession.findUnique };
  }

  const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
  const PAST = new Date(Date.now() - 60 * 60 * 1000);
  const ACTIVE_AT = new Date('2026-09-08T10:05:00.000Z');

  /** The row shape the real query selects, so a fixture cannot drift from it. */
  function row(overrides: Record<string, unknown> = {}) {
    return {
      revokedAt: null,
      revokedReason: null,
      lastActiveAt: ACTIVE_AT,
      expiresAt: FUTURE,
      reauthenticateAt: FUTURE,
      familyId: FAMILY_ID,
      ...overrides,
    };
  }

  it('gives no reason when both clocks are in the future and nothing is revoked', async () => {
    const { ops, findUnique } = opsReturning(row());
    await expect(ops.readLiveness(PARENT_ID)).resolves.toEqual({
      reason: null,
      lastActiveAt: ACTIVE_AT,
      familyId: FAMILY_ID,
    });
    // Both the ceiling and the activity instant have to be SELECTed, or the check
    // below cannot fire and `GET /auth/session` has nothing to report.
    expect(findUnique.mock.calls[0]![0].select).toMatchObject({
      reauthenticateAt: true,
      lastActiveAt: true,
    });
  });

  /**
   * ═══ THE ROW SHAPE THE MIGRATION LEAVES BEHIND ═════════════════════════════
   *
   * `expires_at` in the future, `reauthenticate_at` in the past. Impossible for any
   * row this service writes — `expiresAt` is always `min(lastActiveAt + timeout,
   * ceiling)` — but it is exactly what a session that had been sliding for days looks
   * like once the ceiling is backfilled from its true start. Checking only
   * `expiresAt` here would let those sessions keep working.
   */
  it('reports expired when the ceiling has passed even though expiresAt has not', async () => {
    const { ops } = opsReturning(row({ reauthenticateAt: PAST }));
    // 'expired' rather than a third slug: reaching the ceiling is also "over with
    // nobody ending it".
    await expect(ops.readLiveness(PARENT_ID)).resolves.toMatchObject({ reason: 'expired' });
  });

  /** ═══ THE IDLE TIMEOUT REPORTS ITSELF AS A TIMEOUT ═════════════════════════ */
  it('reports expired when the idle window has passed', async () => {
    const { ops } = opsReturning(row({ expiresAt: PAST }));
    // This is what becomes `401 session_expired` rather than `session_revoked`. An
    // admin who was idle was not revoked by anybody, and telling them otherwise reads
    // as a security event on someone else's action.
    await expect(ops.readLiveness(PARENT_ID)).resolves.toMatchObject({ reason: 'expired' });
  });

  /**
   * ═══ AN EXPIRED SESSION STILL REPORTS WHEN IT WAS LAST ACTIVE ══════════════
   *
   * The requirement asks for it explicitly: the panel showing "you were logged out
   * due to inactivity" is exactly where "last active at 10:05" belongs. The row is
   * still here, so the value is still knowable — it is the STORED instant, never
   * `now()`, which would claim activity that never happened.
   */
  it('still reports lastActiveAt for a session that has timed out', async () => {
    const { ops } = opsReturning(row({ expiresAt: PAST }));
    await expect(ops.readLiveness(PARENT_ID)).resolves.toEqual({
      reason: 'expired',
      lastActiveAt: ACTIVE_AT,
      familyId: FAMILY_ID,
    });
  });

  it('reports revoked when revoked, and when absent', async () => {
    const revoked = opsReturning(row({ revokedAt: new Date() }));
    await expect(revoked.ops.readLiveness(PARENT_ID)).resolves.toEqual({
      reason: 'revoked',
      lastActiveAt: ACTIVE_AT,
      familyId: FAMILY_ID,
    });

    // An absent row was not idle — there is nothing to have expired — and 'revoked'
    // is the slug that does not invite a retry. It is also the ONE case with no
    // activity instant and no stable id to report: there is no row to read either
    // from, which is exactly what makes both fields nullable.
    const absent = opsReturning(null);
    await expect(absent.ops.readLiveness(PARENT_ID)).resolves.toEqual({
      reason: 'revoked',
      lastActiveAt: null,
      familyId: null,
    });
  });

  /**
   * ═══ THE SCOPE OF A REVOCATION, OFF THE EXISTING COLUMN ════════════════════
   *
   * `revokedReason` already records whether one family or every family was ended,
   * because each member of the reason set has exactly one writer — `revokeFamily`
   * writes LOGOUT and REUSE_DETECTED, `revokeAllForAdmin` writes LOGOUT_ALL and
   * PASSWORD_CHANGED. So no new column or flag was needed to tell
   * `SESSION_REVOKED` from `SESSION_REVOKED_ALL`.
   *
   * Both still become `401 session_revoked`; only the MESSAGE differs.
   */
  it.each([
    ['LOGOUT', 'revoked'],
    ['REUSE_DETECTED', 'revoked'],
    ['LOGOUT_ALL', 'revoked-all'],
    ['PASSWORD_CHANGED', 'revoked-all'],
  ])('reads a %s revocation as %s', async (revokedReason, expected) => {
    const { ops } = opsReturning(row({ revokedAt: new Date(), revokedReason }));
    await expect(ops.readLiveness(PARENT_ID)).resolves.toMatchObject({ reason: expected });
  });

  it('reads an unrecognised revoke reason as the narrower answer', async () => {
    // Safer of the two: telling an admin every session ended when only one did sends
    // them hunting a breach that did not happen.
    const { ops } = opsReturning(row({ revokedAt: new Date(), revokedReason: 'SOMETHING_NEW' }));
    await expect(ops.readLiveness(PARENT_ID)).resolves.toMatchObject({ reason: 'revoked' });
  });

  /**
   * Revocation wins over the clocks, and the ordering is deliberate: a session that
   * was revoked and has since drifted past its deadline is still a revocation.
   * Reporting the timeout would hide the deliberate act behind an incidental one.
   */
  it('prefers revoked over expired when both are true', async () => {
    const { ops } = opsReturning(
      row({ revokedAt: new Date(), expiresAt: PAST, reauthenticateAt: PAST }),
    );
    await expect(ops.readLiveness(PARENT_ID)).resolves.toMatchObject({ reason: 'revoked' });
  });
});

/**
 * ═══ WHAT `touch` HAS TO GET RIGHT, AND WHAT A UNIT TEST CAN SHOW ══════════
 *
 * `touch` is the only thing that advances the idle window now that a refresh no
 * longer does. It runs fire-and-forget from `AuthGuard`, so it overlaps the very
 * request that triggered it and every other request from the same admin.
 *
 * A fake Prisma cannot EXECUTE a predicate, so nothing here proves the five-minute
 * rule actually gates a write — that needs a real Postgres, and it is covered by the
 * live checks. What a double CAN prove is that the write is ONE statement whose
 * clauses encode the four invariants: the threshold is in the WHERE rather than in
 * application code, the deadline is derived from the same `now()`, the ceiling caps
 * it, and dead sessions are excluded.
 *
 * That distinction matters most for concurrency. Two overlapping requests are safe
 * because Postgres re-qualifies the second against the row the first committed — a
 * property of the statement's SHAPE, which is exactly what is asserted below.
 */
describe('touch', () => {
  function touched() {
    const f = fakePrisma();
    const ops = new SessionDbOperation(f.prisma as never);
    return { f, ops };
  }

  it('is a single statement, not a read followed by a write', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    expect(f.raw).toHaveLength(1);
    // Nothing was read first. A read-then-write would let two overlapping requests
    // both see a stale `last_active_at` and both write — the write-per-request
    // problem the threshold exists to solve.
    expect(f.adminSession.findUnique).not.toHaveBeenCalled();
    expect(f.adminSession.updateMany).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE FIVE-MINUTE RULE IS IN THE WHERE CLAUSE ═══════════════════════════
   *
   * This is the assertion that says the DATABASE adjudicates the interval. If the
   * predicate moved into TypeScript, this fails — and with it goes the guarantee
   * that concurrent requests produce one write rather than several.
   */
  it('gates the write on the interval, in the statement itself', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    expect(f.raw[0]!.sql).toContain('last_active_at <= now() - make_interval');
  });

  it('records the activity instant and derives the deadline from the same now()', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    const sql = f.raw[0]!.sql;
    expect(sql).toContain('SET last_active_at = now()');
    // One `now()` for both, so `expires_at` is exactly `last_active_at + timeout` and
    // the two columns cannot disagree about when this session dies.
    expect(sql).toMatch(/expires_at = LEAST\(\s*now\(\) \+ make_interval/);
    // LEAST against the ceiling: no amount of activity may outlive the sign-in that
    // created the session, which is the whole point of the two-clock design.
    expect(sql).toContain('reauthenticate_at)');
  });

  /**
   * There is deliberately no `GREATEST(expires_at, ...)` any more. It guarded against
   * dragging the deadline backwards, which mattered when a rotation could write a
   * longer-lived value. Nothing but this statement writes `expires_at` after creation
   * now, and it only fires once the row is at least the write interval stale, so the
   * new deadline is always at least the old one. Forward-only is a consequence of the
   * predicate rather than something the SET expression has to enforce.
   */
  it('no longer needs a forward-only guard, because the predicate is one', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    expect(f.raw[0]!.sql).not.toContain('GREATEST');
  });

  it('refuses to resurrect a session that died in the gap', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    const sql = f.raw[0]!.sql;
    // A revoked session must not have its own bookkeeping hand it another window.
    expect(sql).toContain('revoked_at IS NULL');
    // BOTH clocks, not just the idle one. A session past its ceiling is over.
    expect(sql).toContain('expires_at > now()');
    expect(sql).toContain('reauthenticate_at > now()');
  });

  it('binds the family id and both intervals rather than interpolating them', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    // Parameterised, so no value can be spliced into the SQL text. The order is the
    // order they appear in the template: the window, the FAMILY id, then the
    // threshold.
    expect(f.raw[0]!.values).toEqual([
      SESSION.INACTIVITY_TIMEOUT_SECONDS,
      FAMILY_ID,
      SESSION.ACTIVITY_WRITE_INTERVAL_SECONDS,
    ]);
  });

  /**
   * ═══ F07 — ACTIVITY IS KEYED ON THE LOGIN, AND ONLY ITS LIVE TIP ═══════════
   *
   * The two clauses that together make an obsolete generation unreachable. Asserted
   * as SQL TEXT because that is all a double can prove; that Postgres then selects
   * exactly one row, and re-qualifies correctly when it has to wait for a lock, is
   * proven against a real database in session.activity.concurrency.spec.ts.
   */
  it('targets the family, never a generation id', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    const sql = f.raw[0]!.sql;
    expect(sql).toContain('family_id = ');
    // The old spelling. A generation-keyed write could land on a row the session had
    // already rotated past, which is the whole of F07's first half.
    expect(sql).not.toMatch(/WHERE\s+id = /);
  });

  it('writes only the live tip, never a rotated generation', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    // Without this clause the statement would match every unrevoked generation in
    // the family — including the ones the session has finished with.
    expect(f.raw[0]!.sql).toContain('rotated_at IS NULL');
  });

  it('binds the policy constants, not literals that could drift from them', async () => {
    const { f, ops } = touched();
    await ops.touch(FAMILY_ID);

    // The assertion that catches "changed the constant but not the SQL". Spelled as
    // numbers on purpose, so a policy change has to be made deliberately here too.
    expect(f.raw[0]!.values[0]).toBe(30 * 60);
    expect(f.raw[0]!.values[2]).toBe(5 * 60);
  });
});

/**
 * ═══ THE INACTIVITY WINDOW: WRITTEN EVERY 5 MINUTES, EXPIRES AFTER 30 ══════
 *
 * ─── These worked examples REPLACE an earlier set ─────────────────────────
 *
 * This block used to encode the requirement's first reading: five minutes of grace
 * followed by a thirty-minute timer, which reduces to one sliding 35-minute window,
 * with `activity 10:24 → expires 10:59` among its cases. That reading is superseded.
 * The five minutes are now the DB-write interval and explicitly NOT grace, so the
 * deadline is `last_active_at + 30m` and activity at 10:24 — four minutes after the
 * 10:20 write — moves nothing at all.
 *
 * Both halves are modelled, because they are separate rules that interact:
 *
 *   shouldWrite    whether an eligible request updates the row. Mirrors the WHERE
 *                  clause's `last_active_at <= now() - interval`.
 *   deadlineFrom   what the deadline then is. Mirrors the SET expression.
 *
 * Arithmetic against a hand-written mirror, not against Postgres — the SQL's own
 * shape is pinned above, and the executable proof is the live check.
 */
describe('the inactivity window', () => {
  const at = (hhmmss: string): Date => new Date(`2026-09-08T${hhmmss}Z`);
  /** Far enough out that the ceiling is not the binding clock in these cases. */
  const NO_CEILING = at('23:00:00');

  /** Mirrors `AND last_active_at <= now() - make_interval(secs => interval)`. */
  function shouldWrite(now: Date, lastActiveAt: Date): boolean {
    return now.getTime() - lastActiveAt.getTime() >= SESSION.ACTIVITY_WRITE_INTERVAL_SECONDS * 1000;
  }

  /** Mirrors `LEAST(now() + make_interval(secs => timeout), reauthenticate_at)`. */
  function deadlineFrom(lastActiveAt: Date, ceiling: Date): Date {
    const idle = lastActiveAt.getTime() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000;
    return new Date(Math.min(idle, ceiling.getTime()));
  }

  /** ═══ THE FOUNDER'S WORKED EXAMPLES ═══════════════════════════════════════ */
  it.each([
    // Login at 10:00 writes 10:00. The next four minutes cost nothing.
    ['10:01 — one minute in', '10:00:00', '10:01:00', false],
    ['10:02', '10:00:00', '10:02:00', false],
    ['10:03', '10:00:00', '10:03:00', false],
    ['10:04', '10:00:00', '10:04:00', false],
    // Exactly five minutes: the boundary is inclusive, matching `<=` in the SQL.
    ['10:05 — the boundary', '10:00:00', '10:05:00', true],
    // And the cycle restarts from the value just written.
    ['10:06 after a 10:05 write', '10:05:00', '10:06:00', false],
    ['10:09 after a 10:05 write', '10:05:00', '10:09:00', false],
    ['10:10 after a 10:05 write', '10:05:00', '10:10:00', true],
  ])('%s', (_name, lastActiveAt, now, expected) => {
    expect(shouldWrite(at(now), at(lastActiveAt))).toBe(expected);
  });

  /**
   * The one case the superseded examples got wrong, kept as its own test so the
   * change of policy is visible rather than merely absent.
   */
  it('does NOT write at 10:24 when the row already says 10:20', () => {
    expect(shouldWrite(at('10:24:00'), at('10:20:00'))).toBe(false);
    // So the deadline stays where the 10:20 write put it — not 10:54.
    expect(deadlineFrom(at('10:20:00'), NO_CEILING)).toEqual(at('10:50:00'));
  });

  /** ═══ THE DEADLINE IS THE STORED VALUE PLUS THIRTY MINUTES ════════════════ */
  it.each([
    ['10:00:00', '10:30:00'],
    ['10:05:00', '10:35:00'],
    ['10:10:00', '10:40:00'],
  ])('last_active_at %s expires at %s', (lastActiveAt, expected) => {
    expect(deadlineFrom(at(lastActiveAt), NO_CEILING)).toEqual(at(expected));
  });

  /**
   * ═══ NOT 5 + 30 ═══════════════════════════════════════════════════════════
   *
   * The requirement says so twice, so it gets an assertion. The write interval is a
   * write optimisation; adding it to the timeout would restore the 35-minute window
   * this change removed.
   */
  it('does not add the write interval to the timeout', () => {
    const deadline = deadlineFrom(at('10:05:00'), NO_CEILING);
    expect(deadline).toEqual(at('10:35:00'));
    expect(deadline).not.toEqual(at('10:40:00'));
    expect(SESSION.INACTIVITY_TIMEOUT_SECONDS).toBe(30 * 60);
  });

  /**
   * ═══ THE INACTIVITY BOUNDARY ══════════════════════════════════════════════
   *
   * `last_active_at = 10:00` with a thirty-minute timeout: valid through 10:29:59,
   * over at 10:30. `readLiveness` reads `expires_at`, which IS this value, and
   * answers 'expired' at or after it.
   */
  it.each([
    ['10:29:59 is still inside the window', '10:29:59', false],
    ['10:30:00 is the moment it ends', '10:30:00', true],
    ['10:31:00 is past it', '10:31:00', true],
  ])('%s', (_name, now, expired) => {
    const deadline = deadlineFrom(at('10:00:00'), NO_CEILING);
    expect(at(now).getTime() >= deadline.getTime()).toBe(expired);
  });

  /**
   * ═══ THE CEILING WINS ═════════════════════════════════════════════════════
   *
   * Activity at 10:54 would reach 11:24, but the sign-in's absolute ceiling is
   * 11:00. No amount of activity may outlive the ceremony that created the session,
   * which is why the SET expression is a LEAST rather than a bare addition.
   */
  it('clamps to reauthenticateAt rather than granting a full window', () => {
    const ceiling = at('11:00:00');
    expect(deadlineFrom(at('10:54:00'), ceiling)).toEqual(ceiling);
  });

  it('cannot be pushed past the ceiling by any amount of activity', () => {
    const ceiling = at('11:00:00');
    for (const moment of ['10:40:00', '10:50:00', '10:59:59']) {
      expect(deadlineFrom(at(moment), ceiling).getTime()).toBeLessThanOrEqual(ceiling.getTime());
    }
  });

  /**
   * ═══ WHAT THE WRITE INTERVAL COSTS, STATED ════════════════════════════════
   *
   * A session can die up to five minutes before the admin's true last request: the
   * request at 10:09 wrote nothing, so if nothing follows it the row still says
   * 10:05 and the deadline is 10:35 rather than 10:39.
   *
   * Expiring EARLY is the safe direction, and it is the trade the requirement asks
   * for by refusing to let the interval become grace. Asserted rather than left as a
   * comment so nobody "fixes" it by widening the window.
   */
  it('expires up to the write interval early, never late', () => {
    const trueLastRequest = at('10:09:00');
    const stored = at('10:05:00');
    expect(shouldWrite(trueLastRequest, stored)).toBe(false);

    const actual = deadlineFrom(stored, NO_CEILING);
    expect(actual).toEqual(at('10:35:00'));
    expect(actual.getTime()).toBeLessThan(
      trueLastRequest.getTime() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000,
    );
  });
});
