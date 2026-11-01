import { Injectable } from '@nestjs/common';
import type { AdminMfaMethod, AdminSession } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { SESSION } from '../auth.constants';
import type { ClientContext, RevokeReason } from '../auth.types';
import { revokedMessageCode } from '../security/session.message';

/**
 * What `readLiveness` answers: why the session is unusable, or null, and the
 * activity instant the answer was computed against.
 *
 * `reason` is deliberately not an error slug. `revoked` and `revoked-all` both become
 * `401 session_revoked` — the split is a MESSAGE distinction for `GET /auth/session`,
 * not a third slug for the catalogue, which would make every consumer's exhaustive
 * switch non-exhaustive.
 */
export interface SessionLiveness {
  readonly reason: 'revoked' | 'revoked-all' | 'expired' | null;
  /** Null ONLY when there is no row. */
  readonly lastActiveAt: Date | null;
  /**
   * The STABLE login this generation belongs to — constant across every rotation.
   *
   * Read here because this query has already loaded the row, and `GET /auth/me`
   * reports it. Null only when there is no row, like `lastActiveAt`.
   */
  readonly familyId: string | null;
}

/**
 * Persistence for `admin.admin_sessions` (one row per rotation generation) and
 * `admin.admin_session_families` (one row per authenticated login).
 *
 * ═══ THE LOCK HIERARCHY — READ THIS BEFORE ADDING A WRITER ═══════════════════
 *
 *     family row(s)  FIRST, in ascending `id` order
 *          ↓
 *     generation rows  SECOND
 *
 * Never the reverse, and never a generation lock without its family lock. Every
 * method below that can CREATE or DESTROY a usable generation opens a transaction
 * and takes `SELECT ... FOR UPDATE` on the family before touching anything else.
 *
 * ─── Why a family row exists to be locked at all ───────────────────────────
 *
 * Because a rotation and a revocation had nothing in common to contend on. `rotate`
 * INSERTs the child generation inside a transaction, so under READ COMMITTED a
 * concurrent `UPDATE ... WHERE family_id = ?` can neither SEE that row nor BLOCK on
 * it — it is not in the statement's snapshot, and Postgres has no predicate locking
 * below SERIALIZABLE. EvalPlanQual re-checks the rows a scan already found; it does
 * not re-run the scan. So logout revoked the parent, reported success, and the child
 * stayed usable for the rest of the twelve-hour ceiling.
 *
 * Wrapping the revoke in a transaction does not fix it: the problem is visibility,
 * not atomicity. The fix is a row that exists BEFORE either operation starts.
 *
 * ─── The two orderings, and why each is safe ───────────────────────────────
 *
 *   revoke first   `rotate`'s FOR UPDATE blocks. When granted, READ COMMITTED
 *                  re-fetches the LATEST COMMITTED row version, so `revoked_at` is
 *                  visible and rotation aborts before the CAS. No child is born.
 *   rotate first   the revoke blocks on the family row. When granted, its NEXT
 *                  statement takes a fresh snapshot that postdates the rotation's
 *                  commit — so the child is visible and is revoked with the rest.
 *
 * ─── Deadlock ──────────────────────────────────────────────────────────────
 *
 * No cycle is constructible: whoever waits on a family row holds no generation lock
 * the other needs. `touch` takes a bare generation lock and wants nothing else, so
 * it is a sink — it now SELECTS that row via `family_id` plus the tip predicate
 * rather than by primary key, but it still locks exactly one generation row, still
 * in one autocommitted statement, and still takes no family lock, so its position in
 * the hierarchy is unchanged. `createFirstGeneration` inserts a brand-new family and
 * contends with nothing. `ORDER BY id` in `revokeAllForAdmin` is what keeps two
 * concurrent sweeps for one admin from taking two families in opposite orders.
 *
 * ─── `SET LOCAL lock_timeout` ──────────────────────────────────────────────
 *
 * Neither `lock_timeout` nor `statement_timeout` is set on this database, so a
 * blocked backend would otherwise wait forever and the only bound would be Prisma's
 * interactive-transaction `timeout` — which defaults to five seconds and aborts with
 * an unclassified `P2028` that surfaces as a 500. A local `lock_timeout` well inside
 * a raised client timeout means the DATABASE raises the error, deterministically and
 * with a code the caller can act on.
 *
 * ─── Every statement must use `tx` ─────────────────────────────────────────
 *
 * Inside `$transaction(async (tx) => ...)`, a call on `this.prisma` goes to a
 * DIFFERENT pooled connection and is not in the transaction — so it would neither
 * hold the lock nor roll back. If a statement below is ever moved, it moves with its
 * `tx`.
 */
@Injectable()
export class SessionDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A new login: the family row, then its first generation.
   *
   * ═══ THE FAMILY GETS ITS OWN ID ════════════════════════════════════════════
   *
   * `familyId` used to be set to the first generation's own id, because the family
   * had no row of its own and needed *some* durable value to name it. It has a row
   * now, so it gets a real identifier and the two are no longer the same number.
   *
   * That is worth stating because rows written before this change still satisfy
   * `id = family_id`, and a reader who noticed the coincidence could easily assume
   * it is guaranteed. It is not, in either direction: a family id names a family,
   * a generation id names a generation, and only `family_id` relates them.
   *
   * Both writes are in one transaction, so a generation can never exist without the
   * family row that makes it revocable.
   */
  async createFirstGeneration(input: {
    readonly adminId: string;
    readonly mfaMethod: AdminMfaMethod;
    readonly client: ClientContext;
    readonly lastActiveAt: Date;
    readonly expiresAt: Date;
    readonly reauthenticateAt: Date;
  }): Promise<AdminSession> {
    const familyId = uuidv7();
    const id = uuidv7();

    // One transaction, family first — the same order every other writer uses, even
    // though nothing can be contending for a family whose id does not exist yet.
    // The ordering is kept because a reader checking the hierarchy holds should not
    // have to make an exception for this method.
    return this.prisma.$transaction(async (tx) => {
      await tx.adminSessionFamily.create({
        data: { id: familyId, adminId: input.adminId },
      });

      return tx.adminSession.create({
        data: {
          id,
          familyId,
          parentId: null,
          adminId: input.adminId,
          mfaMethod: input.mfaMethod,
          deviceFingerprint: input.client.deviceFingerprint,
          ipClass: input.client.ipClass,
          userAgent: input.client.userAgent,
          // The sign-in instant IS the first activity, which is what the requirement
          // asks for: an admin who logs in at 10:00 and does nothing else is idle from
          // 10:00, not from whenever their first API call lands.
          lastActiveAt: input.lastActiveAt,
          expiresAt: input.expiresAt,
          reauthenticateAt: input.reauthenticateAt,
        },
      });
    });
  }

  /**
   * Rotate: stamp the parent and create its child, atomically.
   *
   * The atomicity is the entire point. If the child were created and the parent
   * left unstamped, the old refresh token would stay valid alongside the new one
   * and reuse detection would never fire. If the parent were stamped and the child
   * lost, the admin would be logged out mid-refresh with no way back.
   *
   * The `rotatedAt: null` predicate makes this a compare-and-swap: two concurrent
   * refreshes with the same token cannot both succeed, because the second finds
   * zero rows to update and throws. The caller reads that as a replay.
   *
   * ═══ THE CAS IS NOT ENOUGH ON ITS OWN, AND THAT IS WHY THE LOCK IS FIRST ════
   *
   * The compare-and-swap is sound against another ROTATION, because both contend on
   * a row that already exists — the parent. It is useless against a concurrent
   * REVOCATION, because the row that has to be stopped is the child, and the child
   * does not exist yet for anyone but this transaction.
   *
   * That asymmetry is exactly why the defect survived review for so long: "logout
   * committed first" already worked (the CAS re-qualifies against `revoked_at` and
   * matches nothing), so only the opposite ordering leaked. Locking the family row
   * before the CAS is what makes both orderings safe. See the file header.
   *
   * `mfaMethod` and `reauthenticateAt` are carried forward from the parent rather
   * than re-derived. A refresh does not re-present a second factor or start a new
   * authentication lifecycle — the child inherits the immutable family ceiling.
   *
   * ═══ `lastActiveAt` IS INHERITED, AND THAT IS LOAD-BEARING ═════════════════
   *
   * Refresh is automatic and unprompted — the backend does it mid-request on the
   * browser's behalf — so it is emphatically not the admin doing something. A child
   * that took `now()` for its activity instant would make every background rotation
   * count as activity and hold an abandoned session open indefinitely, which is the
   * exact failure the two-clock split was introduced to fix.
   *
   * `created_at` is no help here for the same reason: a rotation stamps it with the
   * rotation's own time, so it is not a proxy for activity on any row that has ever
   * been refreshed. Only inheriting it preserves the truth.
   *
   * The column has no database default precisely so that omitting it cannot compile.
   *
   * ─── Inherited from the ROW, not from the argument ────────────────────────
   *
   * Both activity columns come off the CAS's `RETURNING`, under the family lock,
   * rather than off the `parent` object the caller read beforehand. That is what
   * closes the lost update described on the CAS below, and it is why this method no
   * longer takes an `expiresAt` parameter: the caller used to pass
   * `parent.expiresAt` back in, which was the stale value by definition. There is
   * now exactly one place the child's clocks can come from.
   */
  async rotate(parent: AdminSession, client: ClientContext): Promise<AdminSession> {
    const childId = uuidv7();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;

        // ═══ THE LOCK. EVERYTHING ELSE HERE DEPENDS ON IT ════════════════════
        //
        // Qualified on the PRIMARY KEY ONLY — deliberately not
        // `AND revoked_at IS NULL`, which is the spelling that looks more careful
        // and is wrong.
        //
        // When a `FOR UPDATE` blocks and is then granted, Postgres re-evaluates the
        // WHERE clause against the newly committed row version. With a mutable
        // predicate the re-check FAILS and the row is silently skipped: zero rows,
        // indistinguishable from a family that does not exist, and `revoked_reason`
        // — which the refusal below needs — is thrown away with it.
        //
        // An immutable primary-key qual always returns exactly one row, guaranteed
        // to be the LATEST COMMITTED version. So the branch is made in TypeScript,
        // on values that cannot be stale.
        const [family] = await tx.$queryRaw<
          { revoked_at: Date | null; revoked_reason: string | null }[]
        >`
          SELECT revoked_at, revoked_reason
            FROM admin.admin_session_families
           WHERE id = ${parent.familyId}::uuid
             FOR UPDATE
        `;

        // THIS read decides, not the one `SessionService.rotate` made before calling
        // here. That one is a pre-emptive courtesy check and it races; this one holds
        // the lock and cannot. A revoke that committed while we waited is visible in
        // exactly these two values.
        //
        // `family === undefined` is a generation whose family row predates the
        // expand migration's rollout — an old application instance created it. It is
        // not evidence of revocation, so it does not refuse here; the generation CAS
        // below still governs, exactly as it did before this change.
        if (family !== undefined && family.revoked_at !== null) {
          throw new SessionFamilyRevoked(parent.familyId, family.revoked_reason);
        }

        // ═══ THE CAS, AND THE READ THAT MAKES INHERITANCE CORRECT ════════════
        //
        // `RETURNING` rather than a bare `updateMany`, because this statement is the
        // only place in the rotation that observes the parent under the family lock.
        // The `parent` ARGUMENT was read outside the transaction by the caller, and
        // between that read and here a `touch` may have committed — so building the
        // child from the argument silently discarded a write that had already
        // landed, and rolled the session's activity clock backwards. That was the
        // second half of F07.
        //
        // In READ COMMITTED a blocked UPDATE re-reads the LATEST COMMITTED row
        // version and re-qualifies against it. `touch` does not write `rotated_at`,
        // so the predicate still holds and the statement proceeds — against the
        // touched row. `RETURNING` then yields the version this statement wrote,
        // which carries that `touch`'s `last_active_at` and `expires_at`. So any
        // activity committed before the CAS is granted its lock is inherited by
        // construction rather than by timing.
        const [claimed] = await tx.$queryRaw<
          { last_active_at: Date; expires_at: Date }[]
        >`
          UPDATE admin.admin_sessions
             SET rotated_at = now()
           WHERE id = ${parent.id}::uuid
             AND rotated_at IS NULL
             AND revoked_at IS NULL
          RETURNING last_active_at, expires_at
        `;

        // Either already rotated (a replay) or revoked while in flight. Both mean
        // this token must not produce a new generation.
        if (claimed === undefined) {
          throw new SessionRotationConflict(parent.id);
        }

        return tx.adminSession.create({
          data: {
            id: childId,
            familyId: parent.familyId,
            parentId: parent.id,
            adminId: parent.adminId,
            mfaMethod: parent.mfaMethod,
            deviceFingerprint: client.deviceFingerprint,
            ipClass: client.ipClass,
            userAgent: client.userAgent,
            // Both clocks off the row this transaction just claimed, NOT off the
            // `parent` argument. See the note on the CAS above.
            lastActiveAt: claimed.last_active_at,
            expiresAt: claimed.expires_at,
            reauthenticateAt: parent.reauthenticateAt,
          },
        });
      },
      // Comfortably above the 3s `lock_timeout` above, so that when this waits too
      // long it is Postgres that says so — `55P03`, which the caller can classify —
      // rather than Prisma's five-second default aborting with an opaque `P2028`.
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  async findById(id: string): Promise<AdminSession | null> {
    return this.prisma.adminSession.findUnique({ where: { id } });
  }

  /**
   * ═══ WAS THIS GENERATION CONSUMED BY ITS OWN INTERRUPTED ROTATION? ═════════
   *
   * Returns the family's live tip when the presented generation is the parent of an
   * interrupted publication, or null when it is anything else — including a genuine
   * replay, which the caller then treats exactly as it always did.
   *
   * ─── What this exists for ─────────────────────────────────────────────────
   *
   * Two failures produce the same shape, and both used to end in a revoked family:
   *
   *   F09  a rotation commits, then its publication to the Redis record fails. The
   *        retry opens the stale record and presents the parent's spent token.
   *   F10  the Redis refresh lock lapses mid-rotation, a second owner appears, and
   *        one of the two loses the generation CAS.
   *
   * In both, the truth is the same: the rotation this caller was trying to perform
   * ALREADY HAPPENED, and its child is sitting there as the family's tip. So the
   * right answer is not "your credentials were stolen" — it is "look at what
   * committed".
   *
   * ═══ THIS IS A REPAIR PATH, NOT AN EXCEPTION TO REUSE DETECTION ════════════
   *
   * That distinction is the whole security argument, and every condition below
   * exists to keep it true. Reuse detection remains the DEFAULT: this method must
   * affirmatively match, and anything it does not match still revokes the family.
   *
   *   family live      under `FOR UPDATE`, so a logout committing while we wait is
   *                    seen rather than raced. A cache repair must never outrank a
   *                    durable revocation.
   *   parent unrevoked  a revoked generation is finished regardless of its children.
   *   parent rotated    the shape being repaired. An unrotated parent is an ordinary
   *                    rotation and never reaches here.
   *   ONE live tip      `rotated_at IS NULL AND revoked_at IS NULL` — the same
   *                    predicate `touch` uses. Two would mean the invariant that
   *                    licenses both is broken, so this refuses rather than guessing.
   *   tip.parent = P    THE one-step bound. A replay from any earlier generation
   *                    fails here, because the legitimate client has rotated since
   *                    and the tip's parent has moved on.
   *   tip clocks live   both of them. Idle expiry and the absolute ceiling are
   *                    authoritative, and a repair may not resurrect either.
   *   within the window a replay arriving later fails, independently of the above.
   *
   * ─── Read-only, and that is what bounds the blast radius ──────────────────
   *
   * No INSERT, no UPDATE, nothing. The generation is not consumed a second time —
   * it was consumed once, and this finds the child that consumption produced. So the
   * one-use guarantee is untouched: the CAS remains the only path to a new
   * generation, and it is not reached from here.
   *
   * Being read-only also makes the DECISION repeatable — run it twice and the same
   * rows give the same verdict, with no generation created either time. Note that is
   * a claim about the decision and about row state, NOT about what the caller then
   * mints: two repairs issue two different token pairs for one generation. The
   * invariant is the generation count.
   *
   * `FOR UPDATE` on the family and nothing else, so the lock hierarchy in this
   * file's header holds unchanged: family first, and this method takes no generation
   * lock at all.
   *
   * Takes the parent's IDENTITY rather than its row, and re-reads the row inside the
   * transaction — see the note at that read for why passing the object is actively
   * wrong here.
   */
  async findRecoverableRotation(input: {
    readonly parentId: string;
    readonly familyId: string;
    readonly windowSeconds: number;
  }): Promise<AdminSession | null> {
    const { parentId, familyId, windowSeconds } = input;

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;

        // The family lock, FIRST, exactly as `rotate` and `revokeFamily` take it.
        // Qualified on the primary key only, for the reason spelled out in `rotate`:
        // a mutable predicate would make a granted lock re-check and silently skip
        // the row, discarding the very state the branch below needs.
        const [family] = await tx.$queryRaw<{ revoked_at: Date | null }[]>`
          SELECT revoked_at
            FROM admin.admin_session_families
           WHERE id = ${familyId}::uuid
             FOR UPDATE
        `;

        // A revoked family is finished. `undefined` is a generation whose family row
        // predates the family table's rollout — not evidence of revocation, and the
        // tip conditions below still govern, matching `rotate`'s handling.
        if (family !== undefined && family.revoked_at !== null) return null;

        // ═══ THE PARENT IS RE-READ HERE, NOT TAKEN FROM THE CALLER ══════════
        //
        // This takes IDENTITY (`parentId`) and reads STATE under the lock, and the
        // distinction is the whole correctness of the method.
        //
        // Both callers hold an `AdminSession` object, and both read it before the
        // event being repaired: `SessionService.rotate` loads it at the top, and the
        // CAS-conflict caller reaches here precisely because someone else stamped
        // `rotated_at` AFTER that load. So the object says `rotatedAt: null` on the
        // exact path where the truth is the opposite — and an earlier version of this
        // method trusted it and refused every lock-expiry repair.
        //
        // Same lesson as `rotate`'s own `RETURNING`: on a path defined by concurrent
        // mutation, a value read outside the lock is not evidence of anything.
        const parent = await tx.adminSession.findUnique({ where: { id: parentId } });
        if (parent === null || parent.familyId !== familyId) return null;
        if (parent.rotatedAt === null || parent.revokedAt !== null) return null;
        if (Date.now() - parent.rotatedAt.getTime() > windowSeconds * 1000) return null;

        // The tip, under the lock. `take: 2` rather than `findFirst` so "more than
        // one" is distinguishable from "exactly one": the single-tip property is a
        // code-enforced invariant, and a reader that assumed it silently would repair
        // against an arbitrary row if it ever broke.
        const tips = await tx.adminSession.findMany({
          where: { familyId, rotatedAt: null, revokedAt: null },
          take: 2,
        });
        if (tips.length !== 1) return null;

        const tip = tips[0]!;
        if (tip.parentId !== parentId) return null;

        const now = Date.now();
        if (tip.expiresAt.getTime() <= now || tip.reauthenticateAt.getTime() <= now) return null;

        return tip;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
  /**
   * Record that the admin did something, at most once per write interval.
   *
   * ═══ WHY THIS EXISTS AT ALL ════════════════════════════════════════════════
   *
   * `expires_at` used to be moved only by `rotate`, which meant the thing keeping a
   * session alive was the client's refresh timer rather than the admin's use of it —
   * exactly backwards, and the OREBiT auth spec says so in as many words: background
   * polling and token refresh do not count as activity. Under the BFF that inversion
   * would have become total, because refresh is no longer something a person triggers
   * at all. So `rotate` carries the parent's deadline forward unchanged and this is
   * the only thing that advances it.
   *
   * ═══ THE FIVE-MINUTE RULE IS A WHERE CLAUSE ════════════════════════════════
   *
   * `last_active_at <= now() - interval` is the whole of the write optimisation, and
   * putting it in the statement rather than in the application is what makes it
   * correct under concurrency:
   *
   *   no extra read   The obvious shape is SELECT the timestamp, compare, then
   *                   UPDATE. Two overlapping requests both read the old value and
   *                   both write, which is the write-per-request problem it was
   *                   supposed to solve.
   *   one winner      In READ COMMITTED, a second UPDATE that finds this row locked
   *                   waits, then RE-QUALIFIES against the committed new version.
   *                   `last_active_at` is fresh by then, so the predicate is false
   *                   and it matches zero rows. Exactly one write per window, with no
   *                   lock of our own.
   *
   * It replaced a Redis cooldown that gated the same write. The cooldown was cheaper
   * — it spared the round trip entirely — but it could SUPPRESS a write the database
   * would have allowed, which made Redis rather than the row the authority on a
   * deadline. One non-matching primary-key UPDATE writes no row and no WAL, so the
   * cost of asking the row instead is small and the answer is always right.
   *
   * ═══ THE DEADLINE IS DERIVED, NOT SLID ════════════════════════════════════
   *
   * Both columns are written from ONE `now()`, so `expires_at` is exactly
   * `last_active_at + INACTIVITY_TIMEOUT_SECONDS` and the two can never disagree
   * about when this session dies.
   *
   * ─── What each clause is for ───────────────────────────────────────────────
   *
   *   LEAST      activity can never push past `reauthenticate_at`. That ceiling is
   *              the entire point of the two-clock design: no amount of use may
   *              extend a session beyond the sign-in that created it.
   *   WHERE      a session that died in the gap must not be resurrected by its own
   *              bookkeeping. Both clocks are checked, not just `expires_at`, for the
   *              same reason `rotate` checks both.
   *
   * There is deliberately no `GREATEST(expires_at, ...)` any more. It guarded against
   * dragging the deadline backwards, which mattered when a rotation could write a
   * longer-lived value. Nothing but this statement writes `expires_at` after creation
   * now, and this statement only fires when `now() >= last_active_at + write
   * interval` — so the new deadline (`now() + timeout`) is always at least the old one
   * (`last_active_at + timeout`). Forward-only is a consequence of the predicate
   * rather than something the SET expression has to enforce.
   *
   * ═══ IT TAKES A FAMILY ID, NOT A GENERATION ID ═════════════════════════════
   *
   * Activity belongs to the LOGIN. It used to be keyed on the generation the
   * request's access token happened to name, with no `rotated_at` filter, and that
   * was F07: a fire-and-forget `touch` could commit AFTER a rotation had replaced
   * that generation, so the obsolete row's clocks advanced while the live tip's did
   * not. One session, two activity states, and the one every liveness check reads
   * was the stale one.
   *
   * `family_id + rotated_at IS NULL + revoked_at IS NULL` names the family's TIP —
   * the single generation currently governing the session. So a request still
   * holding an older access token records its activity on the row that actually
   * matters, and an obsolete generation is not merely deprioritised but
   * *unreachable*: after this change nothing can ever advance its clocks again.
   *
   * ─── Why that predicate names at most one row ──────────────────────────────
   *
   * Three statements write these columns. `createFirstGeneration` inserts one tip
   * into a brand-new family. `rotate` runs under the family's `FOR UPDATE` lock and
   * its CAS demands `rotated_at IS NULL AND revoked_at IS NULL` on the parent, so it
   * can only ever consume the CURRENT tip and produce exactly one new one — two
   * concurrent rotations serialise on the family row and the loser matches nothing.
   * `revokeFamily`/`revokeAllForAdmin` empty the tip set entirely, also under that
   * lock. A chain with one unrotated end is the only shape reachable.
   *
   * That is a code-enforced invariant rather than a constraint, so it is asked of a
   * real database directly — see the one-live-tip case in
   * tests/auth/persistence/session.activity.concurrency.spec.ts.
   *
   * ═══ A TOUCH RACING A ROTATION IS DROPPED, AND THAT IS THE DESIGN ══════════
   *
   * If the scan finds the parent as the tip and a rotation then commits while this
   * statement waits on that row's lock, READ COMMITTED re-qualifies against the new
   * version, `rotated_at IS NOT NULL`, and the row is skipped. EvalPlanQual re-checks
   * rows the scan already FOUND — it does not re-run the scan — so the child is not
   * touched either and this request's activity is simply lost.
   *
   * That is deliberate, and it is worth being exact about rather than papering over:
   * the guarantee here is NOT "activity is never lost". It is that activity is never
   * written to an obsolete generation and never extends the session. The loss is
   * bounded because the next eligible request finds the child and writes to it, so a
   * session is at most one write interval stale — which is precisely the tolerance
   * this mechanism already had (see "expires up to the write interval early, never
   * late" in session.dboperation.spec.ts).
   *
   * No retry, for the same reason there is no read: `count === 0` is the ORDINARY
   * outcome here — four requests in five fall inside the write interval — so a retry
   * would double the write load to recover a loss already inside tolerance.
   */
  async touch(familyId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE admin.admin_sessions
         SET last_active_at = now(),
             expires_at = LEAST(
               now() + make_interval(secs => ${SESSION.INACTIVITY_TIMEOUT_SECONDS}),
               reauthenticate_at)
       WHERE family_id = ${familyId}::uuid
         AND rotated_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
         AND reauthenticate_at > now()
         AND last_active_at <= now() - make_interval(secs => ${SESSION.ACTIVITY_WRITE_INTERVAL_SECONDS})
    `;
  }

  /**
   * WHY this session cannot be used — or null when it can be — plus the activity
   * instant behind that answer. The database fallback behind the revocation cache,
   * and the check `AuthGuard` runs on every request.
   *
   * ═══ WHY IT ALSO RETURNS `lastActiveAt` ════════════════════════════════════
   *
   * Because it has already read the row. `GET /auth/session` reports `lastActiveAt`
   * on the 200 AND on the 401 it answers for an expired or revoked session, and the
   * alternative — a second `findUnique` from the controller — would be a second
   * primary-key lookup per poll for a value this query is already holding.
   *
   * Null only when the row is ABSENT. Every other answer carries the stored instant,
   * including the dead ones: an admin whose session timed out is told when they were
   * last seen, which is the whole point of surfacing it.
   *
   * ═══ WHY A REASON RATHER THAN A BOOLEAN ════════════════════════════════════
   *
   * It returned `true`/`false`, and the caller turned any `true` into
   * `session_revoked`. That told a timed-out admin their session had been revoked —
   * which reads as a security event on someone else's action rather than as an idle
   * timeout, and is the one thing a client would want to surface differently.
   *
   * Same single query and same `select`; the reason is information this method already
   * had and was discarding.
   *
   * ─── Which reason wins, and why that ordering ─────────────────────────────
   *
   *   absent    'revoked'. A row that is not there was not idle — there is nothing to
   *             have expired. It is also the safest slug for a state that should not
   *             happen: it does not invite a client to retry.
   *   revoked   'revoked' or 'revoked-all', checked BEFORE the clocks. A session that
   *             was revoked and has since drifted past its deadline is still a
   *             revocation; reporting the timeout would hide the deliberate act.
   *   clocks    'expired', for both the idle deadline and the absolute ceiling.
   *             Reaching the ceiling is also "this session is over with nobody ending
   *             it", and splitting it further would give the client a third slug it has
   *             no different response to.
   *
   * ─── Why the revoked answer splits in two ─────────────────────────────────
   *
   * `GET /auth/session` reports "your session was logged out from another device"
   * separately from "your sessions have been logged out", and the difference is the
   * SCOPE of the revocation. `revokedReason` already records it — the reason set is
   * fixed and each member has exactly one writer, so a reason only
   * `revokeAllForAdmin` writes means every family went — and the column is on the row
   * this query already reads. See `revokedMessageCode` in security/session.message.ts
   * for the mapping and the audit.
   *
   * Both halves still become `401 session_revoked`. The split is a MESSAGE
   * distinction, not a new error slug: a client's cleanup is identical either way,
   * and adding a slug to the catalogue would make every consumer's switch
   * non-exhaustive.
   */
  async readLiveness(id: string): Promise<SessionLiveness> {
    const session = await this.prisma.adminSession.findUnique({
      where: { id },
      select: {
        revokedAt: true,
        revokedReason: true,
        lastActiveAt: true,
        expiresAt: true,
        reauthenticateAt: true,
        // The stable login id, for `GET /auth/me`. A scalar on the row this query
        // already reads, so it costs nothing.
        //
        // Deliberately NOT a join onto the family to re-check its revocation state.
        // The two are revoked in one transaction under the family's row lock, so the
        // generation's own flag already carries the answer — and a fail-closed join
        // would wrongly refuse a generation written by an application instance from
        // before the family table existed, which has no family row to join to.
        familyId: true,
      },
    });
    if (session === null) return { reason: 'revoked', lastActiveAt: null, familyId: null };

    const lastActiveAt = session.lastActiveAt;
    const familyId = session.familyId;
    if (session.revokedAt !== null) {
      const reason =
        revokedMessageCode(session.revokedReason) === 'SESSION_REVOKED_ALL'
          ? 'revoked-all'
          : 'revoked';
      return { reason, lastActiveAt, familyId };
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.reauthenticateAt.getTime() <= now) {
      return { reason: 'expired', lastActiveAt, familyId };
    }
    return { reason: null, lastActiveAt, familyId };
  }

  // There is deliberately NO single-generation `revoke(id, reason)` here.
  //
  // It existed, `logout` was its only caller, and it was the reason logout could
  // report success while leaving the admin signed in: `{ id, revokedAt: null }` is
  // still satisfied by a generation that has been ROTATED away, so revoking the
  // generation a stale refresh token names kills a row that was already dead and
  // leaves the live one alone.
  //
  // Removed rather than left unused, because the next caller to reach for it would
  // hit the same trap. The unit that matters is the family — one family is one
  // sign-in — so `revokeFamily` is the only way to end one.

  /**
   * Revoke one family: the family row, then every live generation in it.
   *
   * The unit is the family because a family IS one sign-in — every generation in it
   * descends from one three-factor ceremony, so "log me out" can only mean all of
   * them. Reuse detection revokes the same unit, for the same reason.
   *
   * Returns the ids actually revoked, so the caller can seed the revocation cache;
   * otherwise a still-live access token from a revoked generation would keep working
   * until it expired.
   *
   * Idempotent: an already-revoked family updates nothing and returns an empty list.
   */
  async revokeFamily(familyId: string, reason: RevokeReason): Promise<string[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;

        // The lock, first, on a row that always exists. A rotation in flight for this
        // family is either already blocked behind us or still holding this lock — and
        // in the second case we WAIT here, which is precisely the point: the child it
        // is inserting becomes visible to our next statement.
        //
        // Zero rows is not an error. It means a generation written by an application
        // instance that predates the family table's rollout, and the generation sweep
        // below still ends that session. Returning early instead would make logout
        // silently succeed while leaving the admin signed in — the very failure this
        // whole change exists to remove.
        await tx.$queryRaw`
          SELECT id FROM admin.admin_session_families
           WHERE id = ${familyId}::uuid
             FOR UPDATE
        `;

        await tx.$executeRaw`
          UPDATE admin.admin_session_families
             SET revoked_at = now(), revoked_reason = ${reason}
           WHERE id = ${familyId}::uuid
             AND revoked_at IS NULL
        `;

        // ═══ `RETURNING id`, NOT A READ FOLLOWED BY A WRITE ══════════════════
        //
        // This used to be `findMany` then `updateMany`, and it returned the ids the
        // READ found. Those are not the same set, and the difference is a real hole:
        // a generation created between the two statements IS revoked by the update
        // (a fresh statement snapshot sees it) but never reached the caller, so no
        // revocation flag was ever cached for it. It also over-reported, counting
        // rows somebody else had already revoked as though this call had done it.
        //
        // `RETURNING` is the set of rows this statement actually changed. Exact by
        // construction, and one round trip instead of two.
        const revoked = await tx.$queryRaw<{ id: string }[]>`
          UPDATE admin.admin_sessions
             SET revoked_at = now(), revoked_reason = ${reason}
           WHERE family_id = ${familyId}::uuid
             AND revoked_at IS NULL
          RETURNING id
        `;

        return revoked.map((r) => r.id);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  /**
   * Every live session for one admin — logout-all, an administrative disable, and
   * the sweep that runs when a repeated lockout opens a manual review.
   *
   * ═══ WHY THIS LOCKS EVERY FAMILY RATHER THAN USING AN ACCOUNT EPOCH ════════
   *
   * Because it does not need one. A generation can only come into existence two
   * ways: a brand-new sign-in, or a rotation — and a rotation can only EXTEND an
   * existing family, which means it must first take that family's row lock. So
   * locking every live family for this admin already covers every refresh that
   * could be in flight, and an account-wide epoch would be a second revocation
   * authority for a question this table already answers.
   *
   * ─── `ORDER BY id` ────────────────────────────────────────────────────────
   *
   * Two of these can run concurrently for one admin — `logoutAll` racing an
   * administrative disable, for instance. Taking the families in a deterministic
   * order is what stops them acquiring two rows in opposite orders and deadlocking.
   * `ix_admin_session_families_live` carries that order so the plan has no Sort
   * node, which is what makes the ACQUISITION order match the stated one.
   *
   * ─── A concurrent NEW SIGN-IN survives this, deliberately ─────────────────
   *
   * A family created after this statement's snapshot is not locked and not revoked.
   * That is correct: it is a completed three-factor ceremony that postdates the
   * decision to revoke, and it is indistinguishable from a sign-in one millisecond
   * later. What must stop a sign-in during an account disable or a manual review is
   * the account's own `status` / `loginReviewStatus`, which the login and refresh
   * paths re-read — not a race in here.
   */
  async revokeAllForAdmin(adminId: string, reason: RevokeReason): Promise<string[]> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;

        // Here the mutable predicate is CORRECT, unlike in `rotate`. A family that
        // someone else revoked while we waited genuinely is finished, and skipping it
        // is idempotent rather than a silent miss. A family being REFRESHED is not
        // skipped — nothing releases that lock until the rotation commits, and then
        // we take it.
        //
        // Not `SKIP LOCKED`, which would do the opposite and skip exactly the family
        // mid-rotation: the one most in need of revoking.
        await tx.$queryRaw`
          SELECT id FROM admin.admin_session_families
           WHERE admin_id = ${adminId}::uuid
             AND revoked_at IS NULL
           ORDER BY id
             FOR UPDATE
        `;

        await tx.$executeRaw`
          UPDATE admin.admin_session_families
             SET revoked_at = now(), revoked_reason = ${reason}
           WHERE admin_id = ${adminId}::uuid
             AND revoked_at IS NULL
        `;

        // By `admin_id` rather than by the family ids just locked, so that a
        // generation whose family row does not exist — written by an instance from
        // before the rollout — is ended too.
        const revoked = await tx.$queryRaw<{ id: string }[]>`
          UPDATE admin.admin_sessions
             SET revoked_at = now(), revoked_reason = ${reason}
           WHERE admin_id = ${adminId}::uuid
             AND revoked_at IS NULL
          RETURNING id
        `;

        return revoked.map((r) => r.id);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
}

/**
 * Thrown by `rotate` when the family this generation belongs to has been revoked.
 *
 * ═══ WHY THIS IS NOT `SessionRotationConflict` ═════════════════════════════════
 *
 * Because of what the caller does with that one. `SessionService.rotate` routes a
 * rotation conflict to `handleReuse`, which revokes the entire family, answers
 * `session_reuse_detected` and logs "refresh token reuse detected" at WARN. That is
 * the right response to a replayed token.
 *
 * It is the wrong response to a logout. Under the BFF a refresh is automatic and
 * unprompted, so an admin clicking "log out" while a background rotation is in
 * flight is an ORDINARY event — and reusing the conflict class here would report
 * that routine race to them as credential theft, and write a security warning about
 * it every time. A distinct class lets the caller answer with the same
 * `session_revoked` it already gives a session it found revoked on the way in.
 *
 * Carries `revokedReason` because the row was just read under the lock and this is
 * the only place that value exists — it is what lets the refusal distinguish "you
 * were logged out" from "all your sessions were ended".
 */
export class SessionFamilyRevoked extends Error {
  constructor(
    readonly familyId: string,
    readonly revokedReason: string | null,
  ) {
    super(`session family ${familyId} is revoked`);
    this.name = 'SessionFamilyRevoked';
  }
}

/** Thrown by `rotate` when the parent generation could not be claimed. Its own
 *  class rather than a ProblemException because the caller has to decide what it
 *  means — a replay warrants revoking the family, which is policy, not
 *  persistence. */
export class SessionRotationConflict extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} could not be rotated`);
    this.name = 'SessionRotationConflict';
  }
}
