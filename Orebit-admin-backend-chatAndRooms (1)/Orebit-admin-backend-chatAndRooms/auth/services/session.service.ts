import { Injectable, Logger } from '@nestjs/common';
import type { Admin, AdminMfaMethod, AdminSession } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { CacheService, KEYS } from '../../redis';
import { SESSION } from '../auth.constants';
import type { ClientContext, IssuedSession, Principal, RevokeReason } from '../auth.types';
import { REVOKE_REASON } from '../auth.types';
import { toPublicAdmin } from '../auth.utility';
import { AdminDbOperation } from '../persistence/admin.dboperation';
import {
  SessionDbOperation,
  SessionFamilyRevoked,
  SessionRotationConflict,
} from '../persistence/session.dboperation';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../security/jwt';
import { SessionEndedException, revokedMessageCode } from '../security/session.message';

/**
 * What `assertLive` hands back: the two facts its query already read.
 *
 * A pair rather than a bare `lastActiveAt`, because the second reader arrived and
 * re-querying for it would be a second primary-key lookup per request for a value
 * this call is already holding. Both are null on the one path that reads no row.
 *
 * Deliberately NOT folded into `Principal`. A principal is what the CREDENTIAL
 * asserts — three values out of a verified JWT — and these are database facts with a
 * different lifetime. See the note on `ACTIVITY` in security/guards.ts.
 */
export interface LiveSession {
  readonly lastActiveAt: Date | null;
  /**
   * The stable login id — constant across every refresh rotation.
   *
   * NOT nullable, unlike `lastActiveAt`, and that asymmetry is load-bearing now that
   * per-action authorisation is keyed on it. `readLiveness` reads it from a NOT NULL
   * column and answers `reason: 'revoked'` when there is no row at all, so every
   * path that RETURNS a live session has one. `assertLive` turns the residual
   * type-level null into `UNAUTHENTICATED` rather than passing it on, so a consumer
   * can bind a security decision to it without a null check that would have no
   * correct branch. See `Principal.familyId`.
   */
  readonly familyId: string;
}

/**
 * Session lifecycle: mint, rotate, revoke, and answer "is this session live".
 *
 * The refresh design in one line: a session row per rotation *generation*, all
 * sharing a `familyId`, and presenting an already-rotated token revokes the whole
 * family. That is what turns a stolen refresh token from indefinite access into a
 * detectable event — the thief and the legitimate client cannot both keep
 * rotating, so whoever comes second trips the alarm and both are logged out.
 *
 * The stakes are higher here than in the consumer service: being logged out means
 * running the full three-factor ceremony again, which is precisely why the
 * refresh window is twelve hours rather than thirty days.
 *
 * Two clocks bound a family, and the distinction is the subject of most of the
 * comments below: `reauthenticateAt` is the absolute ceiling, written once by
 * `issue` and copied verbatim by every rotation, and `expiresAt` is the idle window
 * a refresh slides forward — but only ever up to that ceiling. See SESSION in
 * auth/auth.constants.ts for why it is two and not one.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger('SessionService');

  constructor(
    private readonly sessions: SessionDbOperation,
    private readonly admins: AdminDbOperation,
    private readonly cache: CacheService,
  ) {}

  /**
   * Mint the first generation of a new family.
   *
   * `mfaMethod` is required, not optional, and that is the type system carrying a
   * security invariant: there is no way to call this without naming a second
   * factor, so a code path that somehow skipped the MFA step could not issue a
   * session even by accident.
   *
   * This is the ONLY place `reauthenticateAt` is ever written, and that is what
   * makes it immutable in the sense the name claims — not a database constraint but
   * the absence of a second writer. `rotate` copies it; nothing recomputes it. So
   * the ceiling is stamped by the three-factor ceremony and can only be reset by
   * running that ceremony again, which is the property being bought.
   */
  async issue(
    admin: Admin,
    mfaMethod: AdminMfaMethod,
    client: ClientContext,
  ): Promise<IssuedSession> {
    const now = Date.now();
    const reauthenticateAt = new Date(now + SESSION.ABSOLUTE_TTL_SECONDS * 1000);
    // The login instant is the first activity, and the deadline is derived from it
    // by the same rule `touch` applies later — one formula, written in two places
    // that share the constant, so a session's first window is its every window.
    const lastActiveAt = new Date(now);
    const expiresAt = new Date(
      Math.min(
        lastActiveAt.getTime() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000,
        reauthenticateAt.getTime(),
      ),
    );
    const session = await this.sessions.createFirstGeneration({
      adminId: admin.id,
      mfaMethod,
      client,
      lastActiveAt,
      expiresAt,
      reauthenticateAt,
    });
    await this.admins.touchLastSeen(admin.id);
    return this.mint(session, admin);
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The order of checks is deliberate. The token's signature and type are verified
   * first (cheap, and rejects garbage without a query); then the session is
   * loaded; then the family is checked for revocation; and only then is rotation
   * attempted. The rotation itself is the compare-and-swap — see
   * `SessionDbOperation.rotate`.
   *
   * ═══ A REFRESH MOVES NEITHER CLOCK ═════════════════════════════════════════
   *
   * Both `reauthenticateAt` and `expiresAt` come off the PARENT row and are copied
   * into the child unchanged. Nothing in this method recomputes either one — and
   * `expiresAt` is no longer even passed down, because this method's copy of the row
   * is read outside the rotation's transaction and a `touch` can commit underneath
   * it. The persistence layer reads both activity columns from the row it locks. See
   * `SessionDbOperation.rotate`.
   *
   * The ceiling was always copied. The IDLE deadline used to be recomputed here as
   * `min(now + idle, ceiling)`, and that was wrong for the reason the spec states
   * directly: token refresh must not count as activity. It mattered less when a
   * client refreshed on its own timer and mattered completely once the BFF made
   * refresh automatic — a session nobody was using would have been held open forever
   * by the mechanism that exists to keep a session usable.
   *
   * What advances the idle window now is `touch`, called by `AuthGuard` for requests
   * that are not marked `@NotActivity()`. See `SessionDbOperation.touch`.
   */
  async rotate(refreshToken: string, client: ClientContext): Promise<IssuedSession> {
    const claims = verifyRefreshToken(refreshToken);
    const session = await this.sessions.findById(claims.sid);

    if (session === null || session.adminId !== claims.sub || session.familyId !== claims.fam) {
      throw new ProblemException({ type: ERR.TOKEN_INVALID });
    }

    if (session.revokedAt !== null) {
      // `SessionEndedException` rather than a bare `ProblemException`: the row that
      // was just read carries WHY, and this is the last place that fact exists. On
      // the wire it is the same `401 session_revoked` it always was — only
      // `GET /auth/session` looks at the code, and only because it asked to.
      throw new SessionEndedException(
        revokedMessageCode(session.revokedReason),
        ERR.SESSION_REVOKED,
      );
    }

    // Both clocks, not just `expiresAt`. For rows this service wrote the second
    // test is implied by the first — `expiresAt` is never set past the ceiling — but
    // rows that predate the ceiling carry an `expiresAt` the OLD sliding rule
    // produced, which can be up to twelve hours past a backfilled
    // `reauthenticateAt`. Checking only `expiresAt` would let exactly the sessions
    // this change exists to bound keep refreshing through the deploy.
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || session.reauthenticateAt.getTime() <= now) {
      throw new ProblemException({ type: ERR.TOKEN_EXPIRED });
    }

    // ═══ ALREADY ROTATED: EITHER A REPLAY, OR OUR OWN LOST PUBLICATION ══════
    //
    // A pre-emptive check for the already-rotated case, so the common replay returns
    // the accurate `session_reuse_detected` rather than a generic conflict. The
    // authoritative check is still the CAS inside `rotate` — this one races, that one
    // cannot.
    //
    // But "already rotated" has two causes and they are opposites. F09: this
    // rotation COMMITTED and only its publication to the Redis record failed, so the
    // retry is presenting a token the server itself spent moments ago. Revoking the
    // family for that told an admin their credentials were stolen because a cache
    // write was dropped.
    //
    // So the repair is attempted first and reuse detection is what happens when it
    // does not apply. `recoverRotation` returns null for everything that is not
    // exactly an interrupted publication — see `findRecoverableRotation`.
    if (session.rotatedAt !== null) {
      const repaired = await this.recoverRotation(session);
      if (repaired !== null) return repaired;
      await this.handleReuse(session);
    }

    // No deadline is passed. A refresh is not activity — see the note above — so
    // the child inherits whatever the last real request left behind, and it reads
    // that off the parent ROW under the family lock rather than off `session`, which
    // was loaded above and may already be stale. See `SessionDbOperation.rotate`.
    let child: AdminSession;
    try {
      child = await this.sessions.rotate(session, client);
    } catch (err) {
      // ═══ TWO WAYS TO LOSE, AND THEY MEAN OPPOSITE THINGS ══════════════════
      //
      // The family was revoked, under the lock, while this refresh was in flight —
      // a logout, a logout-all, or an administrative revoke that committed just now.
      // Ordinary, and not the token's fault: under the BFF a refresh is automatic
      // and unprompted, so an admin clicking "log out" mid-rotation reaches here as
      // a matter of course.
      //
      // So it answers exactly as the `revokedAt` branch above does, with the reason
      // the locked read returned. Routing it to `handleReuse` instead would tell that
      // admin their credentials had been stolen and log a security warning every
      // time somebody logs out at the wrong moment.
      if (err instanceof SessionFamilyRevoked) {
        throw new SessionEndedException(
          revokedMessageCode(err.revokedReason),
          ERR.SESSION_REVOKED,
        );
      }
      if (err instanceof SessionRotationConflict) {
        // ═══ LOST THE CAS: CONCURRENT USE, BUT BY WHOM? ═════════════════════
        //
        // Something else claimed this generation between our read and our write.
        // That is a concurrent use of one token — and for a client-driven refresh it
        // really is what reuse detection is for.
        //
        // Under the BFF it has a second, benign cause, and that is F10. The Redis
        // refresh lock is meant to make rotation single-flight, but its TTL is fixed
        // and shorter than the rotation's own bound (`maxWait` + `timeout` on the
        // transaction, with two statements that can each wait on `lock_timeout`). So
        // the lock can lapse mid-rotation, a second owner appears, and one of the two
        // loses this CAS — through no fault of either.
        //
        // The database is what actually guarantees one-use, and it did its job: there
        // is exactly one child. The loser's error was in its INTERPRETATION, not in
        // the outcome. So it looks at what committed, and only calls theft when the
        // repair does not apply.
        const repaired = await this.recoverRotation(session);
        if (repaired !== null) return repaired;
        await this.handleReuse(session);
      }
      throw err;
    }

    return this.completeFor(child);
  }

  /**
   * The account gates, then the token pair. Shared by rotation and by recovery.
   *
   * ═══ WHY THIS IS A SHARED HELPER AND NOT DUPLICATED ════════════════════════
   *
   * Recovery hands out a working session, so it has to clear exactly the same
   * account checks a rotation does. Writing them twice would mean two lists that
   * agree today, and the failure mode of them drifting is an admin under review
   * refreshing their way back in through the repair path. One function, two callers,
   * no opportunity to forget.
   */
  private async completeFor(generation: AdminSession): Promise<IssuedSession> {
    // Re-read rather than trusting the token's claims. An admin disabled or
    // soft-deleted since the session was minted must not be able to refresh their
    // way to another twelve hours.
    const admin = await this.admins.findById(generation.adminId);
    if (admin === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    // ═══ THE MANUAL-REVIEW GATE ON THE REFRESH PATH ═════════════════════════
    //
    // Opening a review revokes every session, so in the ordinary case this is
    // unreachable — the `revokedAt` check above already refused. It is here for the
    // case where that sweep did not land: the revocation write failed, or a session
    // was minted in the window between the lock and the sweep. A holder of a valid
    // refresh token must not be able to renew their way through a suspension.
    //
    // Before the `status` check, so the specific slug wins over the generic one — the
    // review sets `status = 'DISABLED'` too, and the reverse order would mask it.
    if (admin.loginReviewStatus === 'PENDING') {
      await this.revokeAllForAdmin(admin.id, REVOKE_REASON.LOGOUT_ALL);
      throw new ProblemException({
        type: ERR.ADMIN_LOGIN_MANUAL_REVIEW,
        detail:
          'This account is suspended pending review by a super administrator. ' +
          'Waiting will not restore access.',
      });
    }

    if (admin.status !== 'ACTIVE') {
      await this.revokeAllForAdmin(admin.id, REVOKE_REASON.LOGOUT_ALL);
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }

    return this.mint(generation, admin);
  }

  /**
   * Repair an interrupted rotation, or return null to leave the caller's own
   * refusal in place.
   *
   * ═══ THE ONE THING THIS MUST NOT BECOME ════════════════════════════════════
   *
   * A general exception to refresh-token reuse detection. It is a repair path for
   * ONE situation — a rotation that committed and whose publication did not — and
   * `findRecoverableRotation` is where that situation is defined. Every caller here
   * falls through to `handleReuse` when it answers null, so reuse detection stays
   * the default and this stays the exception that has to prove itself.
   *
   * No rotation happens. The generation the caller presented was already consumed,
   * once; this serves the child that consumption produced. The CAS is not reached,
   * so the one-use guarantee is not involved.
   *
   * ─── Logged distinctly, and that is operationally load-bearing ────────────
   *
   * Before this existed, a lapsed refresh lock and genuine token theft produced the
   * SAME observable: a `REUSE_DETECTED` family revocation. An operator could not tell
   * an unhealthy Redis from an attack. A sustained rate of this line means the store
   * or the database is slow; `handleReuse` continues to mean what it says.
   */
  private async recoverRotation(parent: AdminSession): Promise<IssuedSession | null> {
    // Identity, not the row. `parent` was loaded before the rotation this is
    // repairing, so its `rotatedAt` is stale by construction on the CAS-conflict
    // path — the predicate re-reads under the family lock instead.
    const tip = await this.sessions.findRecoverableRotation({
      parentId: parent.id,
      familyId: parent.familyId,
      windowSeconds: SESSION.ROTATION_RECOVERY_WINDOW_SECONDS,
    });
    if (tip === null) return null;

    this.logger.log(
      {
        adminId: parent.adminId,
        familyId: parent.familyId,
        parentId: parent.id,
        generationId: tip.id,
        // From the TIP's creation rather than the parent's `rotatedAt`, which the
        // caller's stale object may not have. The two are the same instant.
        rotationAgeMs: Date.now() - tip.createdAt.getTime(),
      },
      'interrupted rotation repaired; serving the existing generation',
    );

    return this.completeFor(tip);
  }

  /**
   * Revoke the family and refuse. Always throws.
   *
   * The whole family, not just the replayed generation: a replay means the token
   * is in two places, and there is no way from here to tell which holder is the
   * legitimate one. Invalidating everything and forcing a fresh sign-in is the
   * only choice that is safe in both cases.
   */
  private async handleReuse(session: AdminSession): Promise<never> {
    const revoked = await this.sessions.revokeFamily(
      session.familyId,
      REVOKE_REASON.REUSE_DETECTED,
    );
    await this.cacheRevocations(revoked, REVOKE_REASON.REUSE_DETECTED);
    this.logger.warn(
      { adminId: session.adminId, familyId: session.familyId, revoked: revoked.length },
      'refresh token reuse detected; family revoked',
    );
    throw new ProblemException({ type: ERR.SESSION_REUSE_DETECTED });
  }

  /**
   * Revoke the whole FAMILY the named session belongs to.
   *
   * ═══ WHY THE FAMILY AND NOT ONE GENERATION ═════════════════════════════════
   *
   * Revoking one generation looks right and silently fails to log anybody out.
   *
   * `resolveSessionId` prefers the generation the refresh token names, and a
   * refresh token stays syntactically valid after its generation has been rotated
   * away — `rotatedAt` is stamped, `revokedAt` is not. So: two tabs, tab A
   * refreshes (generation A rotated, B created and live), tab B still holds token
   * A, the admin clicks logout in tab B. A single-generation revoke matches
   * `{ id: A, revokedAt: null }`, which a rotated-but-unrevoked row still
   * satisfies — so generation A is dutifully revoked, the call reports success,
   * and generation B keeps working for up to twelve hours.
   *
   * The family is the right unit because a family IS one sign-in. Every generation
   * in it descends from one three-factor ceremony, so "log me out" can only mean
   * all of them. `handleReuse` already reasons this way for a replayed token; the
   * only difference is the reason recorded.
   *
   * Idempotent: an unknown or already-revoked session returns quietly. Logout is
   * something a client may retry, and a 404 for "already logged out" would be a
   * worse answer than silence.
   */
  async logout(principal: Principal | null, refreshToken: string | undefined): Promise<void> {
    // ═══ WHAT "SUCCESS" MEANS HERE ═══════════════════════════════════════════
    //
    // That PostgreSQL committed. Nothing else. `revokeFamily` throws if the
    // transaction fails and this method deliberately does not catch it, so a caller
    // that sees this resolve knows the revocation is durable.
    //
    // The Redis write below is the opposite: it cannot fail this method, because by
    // the time it runs the authoritative work is already done and there is nothing to
    // roll back. See `cacheRevocations`.
    //
    // What must never happen is the third case — reporting success without reaching
    // the database at all. That is not decided here; it is decided by whoever resolves
    // the credential, and it is why `AuthController.session` interrogates a null
    // principal instead of trusting it.
    const sessionId = this.resolveSessionId(principal, refreshToken);
    const session = await this.sessions.findById(sessionId);
    if (session === null) return;

    // Defence in depth behind `resolveSessionId`'s own ownership check. `sid` is a
    // signed claim so it cannot name a session we did not issue, but this revokes a
    // whole family now — so the blast radius is worth one explicit assertion that
    // the family being revoked really belongs to the caller.
    if (principal !== null && session.adminId !== principal.adminId) {
      throw new ProblemException({ type: ERR.TOKEN_INVALID });
    }

    const revoked = await this.sessions.revokeFamily(session.familyId, REVOKE_REASON.LOGOUT);
    await this.cacheRevocations(revoked, REVOKE_REASON.LOGOUT);
    this.logger.log(
      { adminId: session.adminId, familyId: session.familyId, revoked: revoked.length },
      'logout; family revoked',
    );
  }

  async logoutAll(principal: Principal | null, refreshToken: string | undefined): Promise<void> {
    const adminId = this.resolveAdminId(principal, refreshToken);
    const revoked = await this.sessions.revokeAllForAdmin(adminId, REVOKE_REASON.LOGOUT_ALL);
    await this.cacheRevocations(revoked, REVOKE_REASON.LOGOUT_ALL);
  }

  /** Used by the password paths: a credential change invalidates every session. */
  async revokeAllForAdmin(adminId: string, reason: RevokeReason): Promise<void> {
    const revoked = await this.sessions.revokeAllForAdmin(adminId, reason);
    await this.cacheRevocations(revoked, reason);
  }

  /**
   * Is this session still usable? Called by AuthGuard on every request.
   *
   * Returns what the liveness query already read: the session's stored
   * `lastActiveAt`, and the STABLE family id that `GET /auth/me` reports. Both are
   * null when no row was read — see `readLiveness`. Throws otherwise.
   *
   * ═══ THE CACHE IS DENY-ONLY ════════════════════════════════════════════════
   *
   * A positive flag rejects immediately. A *negative* one proves nothing, and
   * must not short-circuit the database — that is the whole correctness argument
   * here, and it is worth spelling out because the cheaper version looks right.
   *
   * `cacheRevocations` writes the flag through `setFlag`, which fails open: a
   * Redis write that never lands is logged and swallowed, because the alternative
   * is failing a logout that PostgreSQL has already committed. So a lost write
   * leaves the two stores disagreeing — Postgres says revoked, Redis has no key —
   * and `exists` answers `false` for a key that was merely never written. It
   * cannot distinguish that from "this session was never revoked".
   *
   * Returning early on `false` therefore accepted a revoked JWT for the rest of
   * its 15-minute life on the strength of a write we already knew might be lost.
   * One dropped Redis command, and logout silently stopped logging anybody out.
   *
   * So PostgreSQL is the authority for both revocation and expiry, and every
   * answer other than a positive flag verifies there. The cost is one indexed
   * primary-key lookup per authenticated request; the flag's remaining job is to
   * spare the database that lookup on the revoked path, which is the one a stolen
   * token can flood. Matches the consumer service, which reasons the same way.
   */
  async assertLive(sessionId: string): Promise<LiveSession> {
    const key = KEYS.session.revoked(sessionId);
    const cached = await this.cache.flag(key);
    if (cached === true) {
      // Always a revocation, never a timeout: this flag is only ever written by
      // `cacheRevocations`, which runs after an actual revoke.
      //
      // ─── One extra GET, on the path that is already ending in a 401 ────────
      //
      // The flag's VALUE is the reason it was written with, so this recovers whether
      // one session was ended or all of them without asking Postgres — which would
      // undo the whole point of the fast path, and which the test suite pins
      // (`readLiveness` must not be called here). `flag` stays the gate rather than
      // being replaced by this read, because its three-valued answer is what makes
      // the cache deny-only, and a `get` alone could not tell an absent key from a
      // Redis that did not answer. A missing or legacy value reads as the narrower
      // `SESSION_REVOKED` — see `revokedMessageCode`.
      //
      // No `lastActiveAt` on this path, deliberately: the row is never read, which is
      // the entire point of it. `GET /auth/session` reports null rather than paying
      // for a query to decorate a refusal.
      throw new SessionEndedException(
        revokedMessageCode(await this.cache.get(key)),
        ERR.SESSION_REVOKED,
      );
    }

    // `false` and `null` deliberately land here together: "no flag" and "Redis
    // could not answer" are equally weak evidence that a session is live.
    const { reason, lastActiveAt, familyId } = await this.sessions.readLiveness(sessionId);
    if (reason !== null) {
      // The slugs are the point of asking for a reason rather than a boolean. Both
      // are 401 and both call for the same client cleanup, but only a revocation is
      // an event someone else caused and may be worth surfacing to the admin.
      //
      // `revoked-all` is not a third SLUG — it is still `session_revoked` — it is a
      // third MESSAGE, so `GET /auth/session` can say "your sessions have been logged
      // out" rather than naming a device that was not involved.
      //
      // `lastActiveAt` rides along on the refusal so an admin who timed out can be
      // told when they were last seen. It is the row's stored value, never `now()`.
      throw new SessionEndedException(
        reason === 'revoked'
          ? 'SESSION_REVOKED'
          : reason === 'revoked-all'
            ? 'SESSION_REVOKED_ALL'
            : 'SESSION_EXPIRED',
        reason === 'expired' ? ERR.SESSION_EXPIRED : ERR.SESSION_REVOKED,
        lastActiveAt,
      );
    }

    // ═══ THE FAMILY IS REQUIRED FROM HERE ON ════════════════════════════════
    //
    // Unreachable: `family_id` is NOT NULL, and an absent row returned
    // `reason: 'revoked'` above. The branch exists because `readLiveness` types the
    // value as nullable for the dead paths, and this is the boundary where a live
    // session is promised.
    //
    // It refuses rather than returning null, and that direction is the point. This
    // value now keys elevation tickets, reauth challenges and the reauth rate-limit
    // bucket, so a caller receiving `null` would have no correct branch: skipping the
    // check would drop a security boundary, and inventing an id would spend a proof
    // against the wrong login. `UNAUTHENTICATED` is the only safe answer, and if this
    // ever fires it is a schema violation worth failing loudly on.
    if (familyId === null) {
      this.logger.error({ sessionId }, 'live session has no family id');
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    // Both facts the row already yielded, for the routes that report them. Read here
    // rather than by a controller because this query is already holding them.
    return { lastActiveAt, familyId };
  }

  /**
   * Record that this LOGIN was used. The write itself decides whether it is due.
   *
   * Takes the stable `familyId`, not the generation id the request's access token
   * names. Activity is a property of the sign-in, not of whichever refresh
   * generation happened to serve the request — and keying it on the generation meant
   * a fire-and-forget write could land on one the session had already rotated past.
   * See `SessionDbOperation.touch`, which resolves the family's live tip in the
   * statement itself.
   *
   * Called fire-and-forget from `AuthGuard`, so it must never throw and never make a
   * request wait — both are handled here rather than at the call site, so a second
   * caller cannot forget.
   *
   * ═══ THE REDIS COOLDOWN THAT USED TO GATE THIS IS GONE ═════════════════════
   *
   * It was a `SET NX EX` on `session:last-used:<id>`, and it was cheaper than what
   * replaced it: it spared the database round trip entirely on most requests. It was
   * also the wrong authority. A lost or evicted key let a write through early, and a
   * key that outlived its window SUPPRESSED a write the row was due for — so a
   * deadline derived from the stored timestamp would have been decided by a cache
   * that is explicitly allowed to lose writes.
   *
   * The interval now lives in `touch`'s WHERE clause, where the row adjudicates it
   * atomically and concurrent requests cannot produce two writes. What arrives here
   * per eligible request is one primary-key UPDATE that matches nothing four times
   * out of five. See `SessionDbOperation.touch`.
   */
  async touch(familyId: string): Promise<void> {
    try {
      await this.sessions.touch(familyId);
    } catch (err) {
      // Swallowed deliberately. Failing to record activity is a session that expires
      // slightly early, which is safe; propagating would turn it into a failed
      // request for the admin, which is not.
      this.logger.warn({ err, familyId }, 'activity write failed');
    }
  }

  // There is deliberately no `describe(sessionId)` reporting a session's two
  // deadlines. It existed for `GET /auth/session` and went with the fields it fed:
  // that route reports `lastActiveAt` now, and gets it from `assertLive` rather than
  // from a second query. The deadlines themselves are still reported at sign-in, on
  // `SessionPayload`, which is where a panel that wants an idle warning reads them —
  // and a panel holding `lastActiveAt` can compute the idle one itself.

  /**
   * Seed the deny-only revocation cache.
   *
   * `reason` is stored as the flag's VALUE — the same value `revokedReason` holds on
   * the row that was just written, so the two stores cannot disagree about scope. It
   * is what lets `assertLive` tell "one session ended" from "all of them" on the
   * cached path, where it deliberately never reaches Postgres.
   *
   * Still a flag, and still fail-open: the value is read only to choose a MESSAGE,
   * and its absence degrades to the narrower one rather than to "not revoked". The
   * decision itself remains the key's existence.
   *
   * ═══ FAILING HERE IS NOT A FAILED LOGOUT ═══════════════════════════════════
   *
   * Every `setFlag` swallows its own error, so this never rejects — and that is a
   * correctness requirement, not laziness. PostgreSQL has already committed by the
   * time this runs. Throwing would turn a logout that DID happen into a 500, and the
   * admin would retry an operation that had already succeeded while their client
   * reported failure.
   *
   * The cost of a lost write is one indexed primary-key lookup per request for the
   * remaining life of the access token: `assertLive` treats a missing flag exactly
   * like an unanswered Redis and asks PostgreSQL, which still says revoked. The cache
   * can only ever deny; it is never asked for permission.
   */
  private async cacheRevocations(
    sessionIds: readonly string[],
    reason: RevokeReason,
  ): Promise<void> {
    await Promise.all(
      sessionIds.map((id) =>
        this.cache.setFlag(KEYS.session.revoked(id), SESSION.REVOCATION_CACHE_SECONDS, reason),
      ),
    );
  }

  private resolveSessionId(principal: Principal | null, refreshToken: string | undefined): string {
    if (refreshToken !== undefined) {
      const claims = verifyRefreshToken(refreshToken);
      // A refresh token may only revoke its own account's session. Without this,
      // a valid token from admin A could name a session id belonging to B.
      if (principal !== null && claims.sub !== principal.adminId) {
        throw new ProblemException({ type: ERR.TOKEN_INVALID });
      }
      return claims.sid;
    }
    if (principal !== null) return principal.sessionId;
    throw new ProblemException({ type: ERR.UNAUTHENTICATED });
  }

  private resolveAdminId(principal: Principal | null, refreshToken: string | undefined): string {
    if (principal !== null) return principal.adminId;
    if (refreshToken !== undefined) return verifyRefreshToken(refreshToken).sub;
    throw new ProblemException({ type: ERR.UNAUTHENTICATED });
  }

  private mint(session: AdminSession, admin: Admin): IssuedSession {
    const access = signAccessToken({
      adminId: admin.id,
      sessionId: session.id,
      role: admin.role,
      ceilingAt: session.reauthenticateAt,
    });
    const refresh = signRefreshToken({
      adminId: admin.id,
      sessionId: session.id,
      familyId: session.familyId,
      // The CEILING, not the row's idle deadline. A token cannot be re-signed when
      // activity moves that deadline, so carrying a copy of it only ever produced a
      // token that died before its session did. The idle rule is enforced above, on
      // the row, where it can be re-read. See `SignRefreshInput.ceilingAt`.
      ceilingAt: session.reauthenticateAt,
    });

    return {
      sessionId: session.id,
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt: access.expiresAt,
      // The ROW's idle deadline, not the refresh token's `exp`. Those were the same
      // number until the token began carrying the ceiling instead; this field has
      // always MEANT the idle deadline — see `SessionPayload` in dto/response.dto.ts,
      // which documents it as "the IDLE deadline… It moves forward on ACTIVITY now,
      // not on refresh". Reading it off the row is what makes that true.
      refreshExpiresAt: session.expiresAt,
      // Reported to the client so the panel can say "you will be signed out at
      // 18:42" and prompt before it happens. Without it a client can only see
      // `refreshExpiresAt`, which slides, and so has no way to know a full
      // three-factor sign-in is coming — which is the failure this whole change is
      // about, one layer up.
      reauthenticateAt: session.reauthenticateAt,
      admin: toPublicAdmin(admin),
    };
  }
}
