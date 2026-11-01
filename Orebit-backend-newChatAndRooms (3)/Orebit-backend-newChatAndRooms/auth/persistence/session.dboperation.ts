import { Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { SESSION } from '../auth.constants';
import type { ClientContext, RefreshContext, RevokeReason } from '../auth.types';
import { revokedMessageCode } from '../security/session.message';

/** Persistence for `sessions` — one row per rotation generation. */

/**
 * Distinct calendar days this account has been observed with each signal, capped at
 * the caller's threshold. Only ever compared with `>=` — see `securityHistory`.
 *
 * ═══ NULL AND 0 MEAN DIFFERENT THINGS, AND CONFLATING THEM INVERTS A RULE ══
 *
 *   0     asked, and the value has never been seen  ->  unfamiliar. Real evidence.
 *   null  not asked, because there was nothing to ask about  ->  NO evidence.
 *
 * `countryDays: null` is the case that matters. It means this request carried no
 * country at all — Cloudflare is not trusted on this deployment, or the edge did not
 * report one. Treating that as 0 would make every request from an unknown country
 * look like a request from a country never seen before, so `isNewCountry` would be
 * true for everyone, permanently, on every deployment without Cloudflare. That single
 * confusion would turn the country term from "off" into "always on".
 *
 * `deviceDays: null` is the same shape for a request that carried no device key.
 */
export interface SecurityHistoryDays {
  readonly deviceDays: number | null;
  readonly ipDays: number;
  readonly countryDays: number | null;
}

/**
 * What `readLiveness` answers: why the session is unusable, or null, plus the two
 * facts the answer was computed from that a caller would otherwise re-query for.
 *
 * `reason` is deliberately not an error slug. `revoked` and `revoked-all` both become
 * `401 session_revoked` — the split is a MESSAGE distinction for `GET /auth/session`,
 * not a third slug for the catalogue, which would make every consumer's exhaustive
 * switch non-exhaustive.
 */
export interface SessionLiveness {
  readonly reason: 'revoked' | 'revoked-all' | 'expired' | null;
  /** Null ONLY when there is no row. */
  readonly lastUsedAt: Date | null;
  /**
   * The STABLE login this generation belongs to — constant across every rotation.
   *
   * Read here because this query has already loaded the row, and both the activity
   * write and every session-scoped quota key are keyed on it. Null only when there is
   * no row, like `lastUsedAt`.
   */
  readonly familyId: string | null;
}

@Injectable()
export class SessionDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The first generation of a family.
   *
   * `familyId` is set to the row's own id. Every rotation inherits it unchanged,
   * so the family is identifiable from any generation without walking `parentId`
   * back to the root — which matters because reuse detection has to revoke the
   * whole family in one statement, from whichever generation was replayed.
   */
  async createFirstGeneration(
    userId: string,
    client: ClientContext,
    expiresAt: Date,
    /** Set when the browser is already trusted by this user — see `SessionService.issue`. */
    trust: { rememberUntil: Date; trustedDeviceId: string } | null = null,
  ): Promise<Session> {
    const id = uuidv7();
    return this.prisma.session.create({
      data: {
        id,
        familyId: id,
        parentId: null,
        userId,
        deviceFingerprint: client.deviceKey,
        ipClass: client.ipClass,
        /** The first observation of this login's country — see `rotate` for why it is
         *  recorded per generation and never inherited. */
        country: client.country,
        userAgent: client.userAgent,
        expiresAt,
        ...(trust ?? {}),
      },
    });
  }

  /**
   * Rotate: stamp the parent and create its child, atomically.
   *
   * The atomicity is the entire point. If the child were created and the parent
   * left unstamped, the old refresh token would stay valid alongside the new one
   * and reuse detection would never fire. If the parent were stamped and the child
   * lost, the user would be logged out mid-refresh with no way back.
   *
   * The `rotatedAt: null` predicate makes this a compare-and-swap: two concurrent
   * refreshes with the same token cannot both succeed, because the second finds
   * zero rows to update and throws. The caller reads that as a replay.
   *
   * ─── What the child inherits, and why each one matters ─────────────────────
   *
   * `lastUsedAt` is copied from the parent rather than left to its `now()` default.
   * The default is what made the idle timeout unenforceable: every rotation handed
   * the child a fresh activity timestamp, so a session refreshed in the background
   * looked permanently active no matter how long ago a person last touched it.
   *
   * `trust` is passed in rather than read off the parent, because the caller is the
   * only one who can tell whether the trust still HOLDS on this request — see
   * `SessionService.honourTrust`. Copying the parent's columns blindly would honour
   * a trust whose device cookie is absent; omitting them, as this used to, threw the
   * trust away after one rotation. Neither is what the feature promises.
   *
   * `deviceFingerprint` falls back to the PARENT's when the request carried no device
   * cookie, and that fallback is load-bearing rather than defensive. Refresh runs
   * inside `AuthGuard` now, which reads the device cookie without issuing one, so
   * `client.deviceKey` is legitimately null on a browser that has cleared its cookies
   * — see `RefreshContext`. Writing that null would break the two things this column
   * exists for: device-scoped logout could no longer group the session with its
   * siblings, and `honourTrust` would refuse the trust on every subsequent rotation
   * because the fingerprint it compares against is gone. Carrying the parent's value
   * forward keeps the chain describing the browser it actually belongs to; a genuine
   * device CHANGE still overwrites it, because then there is a key to write.
   */
  async rotate(
    parent: Session,
    client: RefreshContext,
    expiresAt: Date,
    /** The trust window this rotation may claim, or null for the idle rule. */
    trust: { rememberUntil: Date; trustedDeviceId: string } | null = null,
  ): Promise<Session> {
    const childId = uuidv7();
    return this.prisma.$transaction(async (tx) => {
      const stamped = await tx.session.updateMany({
        where: { id: parent.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: new Date() },
      });

      // Either already rotated (a replay) or revoked while in flight. Both mean
      // this token must not produce a new generation.
      if (stamped.count === 0) {
        throw new SessionRotationConflict(parent.id);
      }

      return tx.session.create({
        data: {
          id: childId,
          familyId: parent.familyId,
          parentId: parent.id,
          userId: parent.userId,
          // The parent's when this request carried no device cookie — see the header.
          deviceFingerprint: client.deviceKey ?? parent.deviceFingerprint,
          ipClass: client.ipClass,
          // ─── Written per ROTATION, and never inherited ─────────────────────
          //
          // Deliberately NOT `client.country ?? parent.country`, even though
          // `deviceFingerprint` one line above does exactly that. The two nulls mean
          // different things and want opposite handling: a missing device key is a
          // cookie this request could not read, and inheriting keeps device-scoped
          // logout working — a functional need. A missing country is "nobody
          // established one for this request", and inheriting would manufacture an
          // observation that was never made, which is precisely the kind of invented
          // evidence the evaluator must not be fed.
          //
          // So each generation records what was actually seen, including null. Rows
          // with null simply contribute nothing to the country history.
          country: client.country,
          userAgent: client.userAgent,
          expiresAt,
          lastUsedAt: parent.lastUsedAt,
          ...(trust ?? {}),
        },
      });
    });
  }

  async findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /**
   * WHY this session cannot be used — or null when it can be — plus the family it
   * belongs to and the activity instant the answer was computed against.
   *
   * This is the authoritative liveness check; the revocation cache only rejects
   * known-revoked sessions early.
   *
   * ═══ WHY A REASON RATHER THAN A NULLABLE FAMILY ════════════════════════════
   *
   * This was `liveFamilyId`, returning the family or `null`, and the caller turned
   * every `null` into `session_revoked`. So a user whose session simply timed out was
   * told it had been REVOKED — which reads as somebody else's deliberate act on their
   * account rather than as an idle timeout, and is the one distinction a client would
   * want to surface differently. It is also the difference `GET /auth/session` exists
   * to report.
   *
   * Same single query and the same round trip: `revokedReason` and `lastUsedAt` are
   * scalars on a row this method was already reading, and were being discarded.
   *
   * ─── Which reason wins, and why that ordering ─────────────────────────────
   *
   *   absent    'revoked'. A row that is not there was not idle — there is nothing to
   *             have expired. It is also the safest answer for a state that should not
   *             happen: it does not invite a client to retry.
   *   revoked   'revoked' or 'revoked-all', checked BEFORE the clock. A session that
   *             was revoked and has since drifted past its deadline is still a
   *             revocation; reporting the timeout would hide the deliberate act.
   *   clock     'expired'. `expiresAt` IS the idle deadline here — `touch` moves it
   *             forward with `lastUsedAt` — so there is only one clock to check.
   *
   * ─── Why the revoked answer splits in two ─────────────────────────────────
   *
   * `revokedReason` already records the SCOPE of a revocation: the reason set is fixed
   * and each member has exactly one writer, so a reason only `revokeAllForUser` writes
   * means every session went. See `revokedMessageCode` in security/session.message.ts
   * for the mapping and the audit. Both halves still become `401 session_revoked`.
   *
   * ─── `null` for "not usable" is gone, and that is the point ───────────────
   *
   * The old shape let a caller that forgot to check liveness read a family id that
   * should not exist. This one cannot be misused that way for the opposite reason:
   * `reason === null` is the only shape that means usable, and the caller has to look
   * at it to get anywhere.
   */
  async readLiveness(id: string): Promise<SessionLiveness> {
    const session = await this.prisma.session.findUnique({
      where: { id },
      select: {
        revokedAt: true,
        revokedReason: true,
        lastUsedAt: true,
        expiresAt: true,
        familyId: true,
      },
    });
    if (session === null) return { reason: 'revoked', lastUsedAt: null, familyId: null };

    const { lastUsedAt, familyId } = session;

    if (session.revokedAt !== null) {
      const reason =
        revokedMessageCode(session.revokedReason) === 'SESSION_REVOKED_ALL'
          ? 'revoked-all'
          : 'revoked';
      return { reason, lastUsedAt, familyId };
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      return { reason: 'expired', lastUsedAt, familyId };
    }

    return { reason: null, lastUsedAt, familyId };
  }

  /**
   * ═══ WAS THIS GENERATION CONSUMED BY ITS OWN INTERRUPTED ROTATION? ═════════
   *
   * Returns the family's live tip when the presented generation is the parent of an
   * interrupted publication, or null when it is anything else — including a genuine
   * replay, which the caller then treats exactly as it always did.
   *
   * ─── What this exists for, and why it did not before ──────────────────────
   *
   * Refresh used to be something a client asked for, so two presentations of one
   * refresh token really were either a bug or theft. It is now automatic and
   * unprompted — the guard rotates in-request, behind a Redis lock — and that creates
   * two ways to reach a spent token that are nobody's fault:
   *
   *   F09  a rotation commits, then its publication to the Redis record fails. The
   *        next request opens the stale record and presents the parent's spent token.
   *   F10  the Redis refresh lock lapses mid-rotation, a second owner appears, and
   *        one of the two loses the generation CAS.
   *
   * In both, the truth is the same: the rotation this caller was trying to perform
   * ALREADY HAPPENED, and its child is sitting there as the family's tip. So the right
   * answer is not "your credentials were stolen and you are all logged out" — it is
   * "look at what committed". One dropped cache write used to cost a user their
   * session and put a security warning in the log.
   *
   * ═══ THIS IS A REPAIR PATH, NOT AN EXCEPTION TO REUSE DETECTION ════════════
   *
   * That distinction is the whole security argument, and every condition below exists
   * to keep it true. Reuse detection remains the DEFAULT: this must affirmatively
   * match, and anything it does not match still revokes the family.
   *
   *   parent unrevoked  a revoked generation is finished regardless of its children.
   *   parent rotated    the shape being repaired. An unrotated parent is an ordinary
   *                     rotation and never reaches here.
   *   ONE live tip      `rotatedAt: null, revokedAt: null` — the same predicate
   *                     `touch` uses. Two would mean the invariant that licenses this
   *                     is broken, so it refuses rather than guessing which.
   *   tip.parent = P    THE one-step bound. A replay from any earlier generation fails
   *                     here, because the legitimate client has rotated since and the
   *                     tip's parent has moved on.
   *   tip clock live    an idle-expired tip is authoritative, and a repair may not
   *                     resurrect it.
   *   within the window a replay arriving later fails, independently of the above.
   *
   * ─── Read-only, and that is what bounds the blast radius ──────────────────
   *
   * No INSERT, no UPDATE, nothing. The generation is not consumed a second time — it
   * was consumed once, and this finds the child that consumption produced. The CAS in
   * `rotate` remains the only path to a new generation and is not reached from here,
   * so the one-use guarantee is untouched.
   *
   * ─── What it does NOT do, unlike the admin service it is ported from ──────
   *
   * There is no family row to take `FOR UPDATE`, because this schema has no
   * `session_families` table — the family is just a column every generation carries.
   * So a logout committing *during* this transaction is not serialised against it, and
   * a repair could hand out tokens for a generation revoked microseconds earlier.
   *
   * That is bounded and it is not new: `assertLive` re-reads the row on every request
   * and `revokeFamily` seeds the revocation cache, so the very next request is
   * refused. It is the same one-request window every revocation in this service
   * already has, and closing it here specifically would mean a schema migration and a
   * lock hierarchy — a redesign of session storage rather than this change.
   *
   * Takes the parent's IDENTITY rather than its row, and re-reads the row: both
   * callers hold a `Session` object loaded BEFORE the event being repaired, so on the
   * CAS-conflict path it says `rotatedAt: null` where the truth is the opposite.
   */
  async findRecoverableRotation(input: {
    readonly parentId: string;
    readonly familyId: string;
    readonly windowSeconds: number;
  }): Promise<Session | null> {
    const { parentId, familyId, windowSeconds } = input;

    const parent = await this.prisma.session.findUnique({ where: { id: parentId } });
    if (parent === null || parent.familyId !== familyId) return null;
    if (parent.rotatedAt === null || parent.revokedAt !== null) return null;
    if (Date.now() - parent.rotatedAt.getTime() > windowSeconds * 1000) return null;

    // `take: 2` rather than `findFirst` so "more than one" is distinguishable from
    // "exactly one": the single-tip property is a code-enforced invariant, and a
    // reader that assumed it silently would repair against an arbitrary row if it
    // ever broke.
    const tips = await this.prisma.session.findMany({
      where: { familyId, rotatedAt: null, revokedAt: null },
      take: 2,
    });
    if (tips.length !== 1) return null;

    const tip = tips[0]!;
    if (tip.parentId !== parentId) return null;
    if (tip.expiresAt.getTime() <= Date.now()) return null;

    return tip;
  }

  /**
   * Record activity: stamp `lastUsedAt` AND push `expiresAt` out with it.
   * Throttled by the caller, not here.
   *
   * ─── Why this writes the expiry too ────────────────────────────────────────
   *
   * Because `expiresAt` is the idle deadline. `lastUsedAt` used to be written alone
   * and read by nothing, which left the idle window enforced by whatever `rotate`
   * last computed — i.e. renewed by refreshes and untouched by actual use, exactly
   * backwards. Moving both together is what makes "the window resets on activity"
   * true, and stops the two columns disagreeing about when this session dies.
   *
   * ─── Why raw SQL, and why GREATEST ─────────────────────────────────────────
   *
   * This was first written as a read of `rememberUntil` followed by an
   * `updateMany`, and that read-then-write is a race THIS METHOD LOSES. It runs
   * fire-and-forget from `AuthGuard`, so it overlaps the very request that
   * triggered it — and `POST /auth/device {action:'trust'}` is the case that bites:
   * the guard's touch reads `rememberUntil` as null, `applyTrustOnDevice` then
   * writes a seven-day window, and the touch lands afterwards with an expiry
   * computed from the null it read. The user clicks "remember this device", gets a
   * `remember_until` seven days out and an `expires_at` twenty-four hours out, and
   * is signed out in a day. Caught by curl, not by any unit test — both writes are
   * individually correct.
   *
   * One statement fixes it, and `GREATEST` is what makes it safe rather than merely
   * atomic: the expiry can only ever move FORWARD. That is the right rule
   * independent of the race — an idle window extends on use and never contracts —
   * and it means a concurrent writer that has already pushed the expiry further out
   * cannot be undone by a touch that read staler state.
   *
   * `remember_until` is read inside the same statement rather than passed in, so
   * there is no window between reading it and using it.
   *
   * `expires_at > now()` in the predicate: this runs AFTER the guard's liveness
   * check, so a session that expired in the gap must not be resurrected by its own
   * bookkeeping. Matching zero rows is a no-op rather than an error, which is also
   * what makes a session deleted mid-flight harmless — this must never be able to
   * fail an already-authorised request.
   *
   * ─── Why the FAMILY, and why `rotated_at IS NULL` comes with it ───────────
   *
   * This took a generation id, and that was correct while the client owned the refresh
   * cycle: the id in the caller's access token named the row it was using. Under the
   * BFF the backend rotates in-request, and the write here is fire-and-forget — so it
   * can land after a concurrent request has already rotated the generation the token
   * named, stamping activity onto a row the session has moved past. The family is the
   * one identifier a rotation preserves, and `readLiveness` has just resolved it from
   * the row, so it costs nothing.
   *
   * `rotated_at IS NULL` is what makes the family safe to key on. Without it this
   * would push the expiry out on every spent ancestor in the chain — rows that are
   * unrevoked and unexpired and therefore match everything else here — which would
   * keep a pile of dead generations looking live to any query that counts them.
   * Exactly one row in a family satisfies it: the tip.
   */
  async touch(familyId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE identity.sessions
         SET last_used_at = now(),
             expires_at = GREATEST(
               expires_at,
               now() + make_interval(secs => ${SESSION.IDLE_TIMEOUT_SECONDS}),
               COALESCE(remember_until, to_timestamp(0))
             )
       WHERE family_id = ${familyId}::uuid
         AND rotated_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
    `;
  }

  /**
   * Put every live session on one device under a trust window.
   *
   * All of them, not just the one that asked: the user trusted the *browser*, and
   * a second tab holding its own session would otherwise idle out while the first
   * survived the week — the same inconsistency device-scoped logout exists to fix,
   * in the other direction.
   */
  async applyTrustOnDevice(
    userId: string,
    deviceFingerprint: string,
    trustedDeviceId: string,
    rememberUntil: Date,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, deviceFingerprint, revokedAt: null },
      // `expiresAt` is pushed out here as well as stamped: a session that would
      // otherwise expire tonight has to actually reach the trust window, and only
      // a rotation would recompute it from `rememberUntil` otherwise.
      data: { trustedDeviceId, rememberUntil, expiresAt: rememberUntil },
    });
  }

  /**
   * Every live session for one user, newest first — the account-security list.
   *
   * Rotated generations are excluded. They are technically unrevoked, but a spent
   * generation is not a session a user has; showing them would present one browser
   * as a dozen mysterious entries that reappear after every refresh.
   */
  async listLiveForUser(userId: string): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, rotatedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Has this user ever had a session on this device?
   *
   * Revoked and expired rows count. "Have we seen this browser before" is a
   * question about history, not about live sessions — a user who signed out
   * yesterday and back in today has not acquired a new device.
   */
  async deviceSeenBefore(userId: string, deviceFingerprint: string): Promise<boolean> {
    const seen = await this.prisma.session.findFirst({
      where: { userId, deviceFingerprint },
      select: { id: true },
    });
    return seen !== null;
  }

  /**
   * ═══ HOW FAMILIAR IS THIS REQUEST'S NETWORK, DEVICE AND COUNTRY? ═══════════
   *
   * Three counts of DISTINCT CALENDAR DAYS on which this account has been observed
   * with each value, inside a bounded window, capped at the threshold. The security
   * restriction evaluator turns them into `isNewIp` / `isNewDevice` / `isNewCountry`.
   *
   * ─── Why distinct DAYS, and not sessions or rows ──────────────────────────
   *
   * Rows measure session DURATION, not familiarity: `rotate` inserts a generation
   * roughly every fourteen minutes of active use, so one long sitting on a
   * brand-new device would look like dozens of observations. Families measure
   * nothing useful either — `touch` pushes `expires_at` forward with GREATEST, so a
   * person who opens the app daily never starts a second family and their own laptop
   * would count as one. Calendar days are the only denominator that measures what
   * "commonly used" claims to.
   *
   * ─── Why the current session is excluded, and why only the session ────────
   *
   * The generation being classified must not vouch for itself; counting the row this
   * very request is authenticated by is circular.
   *
   * But only that row. Excluding the whole FAMILY was considered and is wrong: a
   * legitimate long-lived login accumulates its history inside one family, so
   * dropping the family would make a laptop used daily for a month read as brand new
   * on every sensitive action — the classifier firing hardest at the most habitual
   * users. Earlier generations of the same login are genuine prior observations.
   *
   * This is safe against self-certification because of the threshold rather than the
   * filter: a session created today contributes at most one distinct day, and one is
   * below `minDays`. A session that has spanned two calendar days has genuinely been
   * in use across two days, which is the evidence being asked for.
   *
   * ─── Why three queries and not one ────────────────────────────────────────
   *
   * Each signal has its own covering index — `ix_sessions_device_history`,
   * `ix_sessions_ip_history`, `ix_sessions_country_history` — and a single query
   * filtering on all three columns at once could use only one of them, turning the
   * other two into a scan of every session the account has. Three bounded index scans
   * beat one wide one. This is a fixed three, not an N+1: it does not grow with
   * anything.
   *
   * ─── Why LIMIT, and why the count is capped ───────────────────────────────
   *
   * The question is "at least `minDays`?", never "how many?". `ORDER BY` over an
   * index that is already in `created_at` order lets Postgres stop after `minDays`
   * groups, so a device used every day for a year costs the same two rows as one used
   * twice. The returned number is therefore `min(actualDays, minDays)` and must only
   * ever be compared with `>=`.
   *
   * ─── country ──────────────────────────────────────────────────────────────
   *
   * Skipped entirely when the current request has no country: there is nothing to
   * compare, and `null` is not a value to match on. The caller receives `null` for
   * `countryDays`, which is distinct from `0` — "not asked" rather than "asked and
   * never seen" — and the evaluator must not turn either into "new country".
   */
  async securityHistory(input: {
    readonly userId: string;
    readonly excludeSessionId: string;
    readonly deviceFingerprint: string | null;
    readonly ipClass: string;
    readonly country: string | null;
    readonly since: Date;
    readonly minDays: number;
  }): Promise<SecurityHistoryDays> {
    const { userId, excludeSessionId, deviceFingerprint, ipClass, country, since, minDays } = input;

    const days = async (column: 'device_fingerprint' | 'ip_class' | 'country', value: string) => {
      // The column is chosen from a closed union above, never interpolated from
      // caller input; every value is a bound parameter.
      const rows =
        column === 'device_fingerprint'
          ? await this.prisma.$queryRaw<Array<{ days: bigint }>>`
              SELECT count(*) AS days FROM (
                SELECT DISTINCT "created_at"::date AS d
                  FROM "identity"."sessions"
                 WHERE "user_id" = ${userId}::uuid
                   AND "device_fingerprint" = ${value}
                   AND "id" <> ${excludeSessionId}::uuid
                   AND "created_at" >= ${since}
                 ORDER BY d
                 LIMIT ${minDays}
              ) AS capped`
          : column === 'ip_class'
            ? await this.prisma.$queryRaw<Array<{ days: bigint }>>`
                SELECT count(*) AS days FROM (
                  SELECT DISTINCT "created_at"::date AS d
                    FROM "identity"."sessions"
                   WHERE "user_id" = ${userId}::uuid
                     AND "ip_class" = ${value}
                     AND "id" <> ${excludeSessionId}::uuid
                     AND "created_at" >= ${since}
                   ORDER BY d
                   LIMIT ${minDays}
                ) AS capped`
            : await this.prisma.$queryRaw<Array<{ days: bigint }>>`
                SELECT count(*) AS days FROM (
                  SELECT DISTINCT "created_at"::date AS d
                    FROM "identity"."sessions"
                   WHERE "user_id" = ${userId}::uuid
                     AND "country" = ${value}
                     AND "id" <> ${excludeSessionId}::uuid
                     AND "created_at" >= ${since}
                   ORDER BY d
                   LIMIT ${minDays}
                ) AS capped`;

      return Number(rows[0]?.days ?? 0n);
    };

    const [deviceDays, ipDays, countryDays] = await Promise.all([
      // A request with no device key has no device evidence to gather. Null, not 0 —
      // see `SecurityHistoryDays`.
      deviceFingerprint === null ? Promise.resolve(null) : days('device_fingerprint', deviceFingerprint),
      days('ip_class', ipClass),
      country === null ? Promise.resolve(null) : days('country', country),
    ]);

    return { deviceDays, ipDays, countryDays };
  }

  async revoke(id: string, reason: RevokeReason): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Every live session for one user on the same browser/device fingerprint. */
  async revokeAllForUserOnDevice(
    userId: string,
    deviceFingerprint: string,
    reason: RevokeReason,
  ): Promise<string[]> {
    const where = { userId, deviceFingerprint, revokedAt: null };
    const live = await this.prisma.session.findMany({
      where,
      select: { id: true },
    });
    await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return live.map((session) => session.id);
  }

  /**
   * Revoke every generation in a family.
   *
   * The reuse-detection response. A replayed refresh token means either the
   * client is buggy or the token was stolen, and there is no way to tell which
   * from here — so the safe action is to invalidate the whole chain and make the
   * user authenticate again.
   *
   * Returns the ids so the caller can seed the revocation cache; otherwise a
   * still-live access token from a revoked generation would keep working until it
   * expired.
   */
  async revokeFamily(familyId: string, reason: RevokeReason): Promise<string[]> {
    const live = await this.prisma.session.findMany({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return live.map((s) => s.id);
  }

  /**
   * Every live session for a user EXCEPT one — the password-change sweep.
   *
   * The exception is the caller's own session. Signing someone out of the tab they
   * are standing in as a reward for changing their password is hostile, and it
   * protects nothing: that session is the one we just authenticated to allow the
   * change at all.
   */
  async revokeAllForUserExcept(
    userId: string,
    keepSessionId: string,
    reason: RevokeReason,
  ): Promise<string[]> {
    // The caller's whole family, not just its current generation — its rotated
    // ancestors and any child are the same browser and must survive together.
    const keep = await this.prisma.session.findUnique({
      where: { id: keepSessionId },
      select: { familyId: true },
    });

    const where = {
      userId,
      revokedAt: null,
      ...(keep === null ? {} : { familyId: { not: keep.familyId } }),
    };

    const live = await this.prisma.session.findMany({ where, select: { id: true } });
    await this.prisma.session.updateMany({
      where,
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return live.map((session) => session.id);
  }

  /** Every live session for a user — logout-all, and the password-reset sweep. */
  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<string[]> {
    const live = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return live.map((s) => s.id);
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
