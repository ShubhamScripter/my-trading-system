import { Injectable, Logger } from '@nestjs/common';
import type { Credential, Session, TrustedDevice, User } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { MailService } from '../../src/mail/mail.service';
import { antiPhishingCodeOf } from '../../src/settings/antiPhishing/antiPhishing.utility';
import { secondsFromNow } from '../../src/utils/public.utils';
import { SESSION } from '../auth.constants';
import { policy } from '../limits';
import type {
  ClientContext,
  IssuedSession,
  Principal,
  RefreshContext,
  RevokeReason,
} from '../auth.types';
import { REVOKE_REASON } from '../auth.types';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../security/jwt';
import { SessionDbOperation, SessionRotationConflict } from '../persistence/session.dboperation';
import { UserDbOperation } from '../persistence/user.dboperation';
import { DeviceDbOperation } from '../persistence/device.dboperation';
import { SessionEndedException, revokedMessageCode } from '../security/session.message';
import { deviceLabel, isDeviceKey, sessionExpiry, toPublicUser } from '../auth.utility';

/**
 * One device's live sessions, as `listSessions` groups them. The controller maps
 * this to the wire shape; keeping Dates here means the mapper stays the single
 * place a Date becomes a string.
 */
export interface SessionGroup {
  deviceId: string | null;
  label: string | null;
  trustedUntil: Date | null;
  current: boolean;
  sessions: Session[];
}

/**
 * What `assertLive` hands back on the way past — two facts the liveness query had
 * already read and used to discard.
 *
 * `familyId` is non-nullable here even though `readLiveness` types it as nullable,
 * and that is the contract: a live session HAS a family, so a caller needs no null
 * branch for the value it keys security decisions on. `assertLive` refuses rather
 * than returning one.
 */
export interface LiveSession {
  /** The row's stored activity instant. Null only when no row was read — the cached
   *  revocation path, which deliberately never queries. */
  readonly lastUsedAt: Date | null;
  /** The STABLE login this generation belongs to, constant across every rotation. */
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
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger('SessionService');

  constructor(
    private readonly sessions: SessionDbOperation,
    private readonly users: UserDbOperation,
    private readonly devices: DeviceDbOperation,
    private readonly mail: MailService,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
  ) {}

  /**
   * Mint the first generation of a new family.
   *
   * Signing in again on a browser this user already trusts produces a trusted
   * session, without the client asking for one. That is the behaviour a user
   * expects from "remember this device" — it remembers the device, not the login —
   * and putting it here rather than in each login path is why password, email-OTP
   * and OAuth all inherit it.
   */
  async issue(
    user: User,
    credential: Credential | null,
    client: ClientContext,
  ): Promise<IssuedSession> {
    // Scoped to this user, not just this browser. The cookie is one per browser
    // profile and a trust is per account, so on a shared machine the query must ask
    // for THIS user's trust rather than fetching whichever one exists and then
    // rejecting it — which is what it used to do, and which quietly denied a second
    // user the remember-me they had asked for.
    const trusted = await this.devices.findLive(client.deviceKey, user.id);

    // Asked BEFORE the row is written, or the session we are about to create would
    // itself be the evidence that this device is known.
    const seenBefore = await this.sessions.deviceSeenBefore(user.id, client.deviceKey);

    const session = await this.sessions.createFirstGeneration(
      user.id,
      client,
      sessionExpiry(trusted?.expiresAt ?? null),
      trusted === null ? null : { rememberUntil: trusted.expiresAt, trustedDeviceId: trusted.id },
    );

    if (!seenBefore) this.notifyNewDevice(user, client);

    return this.mint(session, user, credential !== null);
  }

  /**
   * Record that this session was just used. Throttled, and never throws.
   *
   * Called by AuthGuard on every authenticated request, so it has two jobs beyond
   * the write: cost nothing when it has already run recently, and never turn a
   * bookkeeping failure into a failed request. Redis decides the first; the
   * swallowed catch decides the second.
   *
   * `startCooldown` returns true when Redis is unreachable, so an outage means we
   * write on every request rather than never — the direction that loses money
   * instead of data.
   *
   * ─── The FAMILY, not the generation ───────────────────────────────────────
   *
   * Both the throttle key and the row predicate. This took a session id, which was
   * right while the client drove the refresh cycle; the backend drives it now, so a
   * rotation replaces the generation the caller's token names roughly every fifteen
   * minutes. Keyed on that id, the throttle found an empty bucket after every
   * rotation and the write went to whichever row the token happened to name — which,
   * because this call is fire-and-forget, can be a generation the session has already
   * moved past. The family survives rotation and `assertLive` has just resolved it.
   */
  async touch(familyId: string): Promise<void> {
    try {
      const fresh = await this.cache.startCooldown(
        KEYS.session.lastUsed(familyId),
        SESSION.LAST_USED_THROTTLE_SECONDS,
      );
      if (!fresh) return;

      await this.sessions.touch(familyId);
    } catch (err) {
      this.logger.error({ err, familyId }, 'lastUsedAt write failed');
    }
  }

  /**
   * Remember this browser, and extend the caller's current session to match.
   *
   * Runs after authentication rather than during it, which is the whole reason
   * OAuth, password and email-OTP login all get remember-me for free: by the time
   * this is reachable a session exists, so no `rememberMe` flag has to be threaded
   * through three different login paths.
   *
   * The device secret never reaches the database — only `client.deviceKey`, its
   * peppered hash, which is also what the session row already carries.
   */
  async trustDevice(principal: Principal, client: ClientContext): Promise<TrustedDevice> {
    await this.rateLimitSessionAdmin(principal.familyId);

    const device = await this.trustDeviceFor(principal.userId, client);

    // Applied to every live session on this device, not just the caller's: the
    // user asked to be remembered on this browser, and a second tab holding its
    // own session would otherwise idle out while the first survived.
    await this.sessions.applyTrustOnDevice(
      principal.userId,
      client.deviceKey,
      device.id,
      device.expiresAt,
    );
    return device;
  }

  /**
   * Record the trust without touching any session.
   *
   * Split out for registration, which trusts the browser *before* its first
   * session exists — `issue` then reads the trust back and stamps the window at
   * creation, so the refresh token it signs already matches the longer row.
   */
  async trustDeviceFor(userId: string, client: ClientContext): Promise<TrustedDevice> {
    return this.devices.trust({
      userId,
      tokenHash: client.deviceKey,
      ipClassAtTrust: client.ipClass,
      userAgentAtTrust: client.userAgent,
      label: deviceLabel(client.userAgent),
      expiresAt: secondsFromNow(SESSION.REMEMBER_ME_SECONDS),
    });
  }

  /**
   * Forget a device and end the sessions that trust was holding open.
   *
   * The sweep is the point. Revoking the trust row alone would leave those
   * sessions running on a `rememberUntil` whose authority no longer exists — the
   * user would click "sign out this device" and it would stay signed in for the
   * rest of the week.
   */
  async untrustDevice(principal: Principal, deviceId: string): Promise<void> {
    // Metered like every other session mutation. It was not, even though `trustDevice`
    // was and both this file and redis/keys.ts described the bucket as covering "trust
    // changes" — so the half that revokes sessions was the unmetered half.
    await this.rateLimitSessionAdmin(principal.familyId);

    // Ownership is enforced inside the query; ids are time-ordered UUIDv7 and
    // must never be revocable by whoever can guess one.
    const device = await this.devices.revoke(deviceId, principal.userId);
    if (device === null) {
      throw new ProblemException({ type: ERR.NOT_FOUND });
    }

    const revoked = await this.sessions.revokeAllForUserOnDevice(
      principal.userId,
      device.tokenHash,
      REVOKE_REASON.LOGOUT,
    );
    await this.cacheRevocations(revoked, REVOKE_REASON.LOGOUT);
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
   * ═══ THE CALLER CHANGED, AND THAT CHANGED WHAT "TWICE" MEANS ═══════════════
   *
   * This used to be reached only from `POST /auth/session {action:'refresh'}` — a
   * client asking, explicitly, once. It is now reached from `BffSessionService`, on
   * whichever ordinary request happens to find the stored access token near expiry.
   * Refresh is automatic, unprompted, and invisible to the page.
   *
   * That makes two presentations of one refresh token something that happens for
   * benign reasons, where before it was either a client bug or theft. Two of them
   * are answered below rather than by `handleReuse`, and both are real:
   *
   *   F09  the rotation committed and its publication to the Redis record failed,
   *        so the next request opens the stale record and presents a spent token.
   *   F10  the Redis refresh lock lapsed mid-rotation and a second owner appeared,
   *        so one of the two lost the CAS through no fault of its own.
   *
   * Plus the ordinary one: a logout that commits while a rotation is in flight. That
   * used to be unreachable — a person could not click "sign out" and "refresh" at the
   * same instant — and is now routine, because the refresh is not theirs to time.
   *
   * `recoverRotation` handles the first two and `handleReuse` remains what happens
   * when it does not apply, so reuse detection stays the default rather than becoming
   * a special case.
   */
  async rotate(refreshToken: string, client: RefreshContext): Promise<IssuedSession> {
    const claims = verifyRefreshToken(refreshToken);

    // Charged after the signature is verified — so a forged token cannot spend a real
    // session's quota — and before the database is touched, so a client stuck in a
    // refresh loop stops costing queries rather than merely being told off after them.
    //
    // Two windows, because one cannot describe both failure modes. A tight window
    // alone refuses a legitimate burst: several tabs waking together each present the
    // same expired access token and each refresh at once. A loose window alone lets a
    // client with a broken retry guard spin all day just under the cap. Together they
    // permit the burst and refuse the spin.
    // `claims.fam`, not `claims.sid`: the family is what a rotation preserves.
    await this.rateLimitRefresh(claims.fam);

    const session = await this.sessions.findById(claims.sid);

    if (session === null || session.userId !== claims.sub || session.familyId !== claims.fam) {
      throw new ProblemException({ type: ERR.TOKEN_INVALID });
    }

    if (session.revokedAt !== null) {
      // `SessionEndedException` rather than a bare `ProblemException`: the row that
      // was just read carries WHY, and this is the last place that fact exists. On the
      // wire it is the same `401 session_revoked` it always was — only
      // `GET /auth/session` looks at the code, and only because it asked to.
      throw new SessionEndedException(
        revokedMessageCode(session.revokedReason),
        ERR.SESSION_REVOKED,
        session.lastUsedAt,
      );
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new ProblemException({ type: ERR.TOKEN_EXPIRED });
    }

    // ═══ ALREADY ROTATED: EITHER A REPLAY, OR OUR OWN LOST PUBLICATION ══════
    //
    // A pre-emptive check for the already-rotated case, so the common replay returns
    // the accurate `session_reuse_detected` rather than a generic conflict. The
    // authoritative check is still the CAS inside `rotate` — this one races, that one
    // cannot.
    //
    // But "already rotated" has two causes and they are opposites. F09: this rotation
    // COMMITTED and only its publication to the session record failed, so the retry is
    // presenting a token the server itself spent moments ago. Revoking the family for
    // that told a user their credentials were stolen because a cache write was
    // dropped.
    //
    // So the repair is attempted FIRST and reuse detection is what happens when it
    // does not apply. `recoverRotation` returns null for everything that is not
    // exactly an interrupted publication — see `findRecoverableRotation`.
    if (session.rotatedAt !== null) {
      const repaired = await this.recoverRotation(session);
      if (repaired !== null) return repaired;
      await this.handleReuse(session);
    }

    // The trust window is carried across, never recomputed. A rotation that
    // recalculated it would push the window forward on every refresh and make it
    // effectively infinite — with nothing about the session looking wrong.
    //
    // `session.lastUsedAt`, not now: the idle window is measured from the last time
    // a person used the product, and a refresh is not that. Anchoring here is what
    // stops a client that refreshes in the background from holding an abandoned
    // session open forever. An idle-dead session never reaches this line — the
    // `expiresAt` check above already refused it, because `touch` keeps that column
    // and `lastUsedAt` moving together.
    const trust = await this.honourTrust(session, client);
    const expiresAt = sessionExpiry(trust?.rememberUntil ?? null, session.lastUsedAt);
    let child: Session;
    try {
      child = await this.sessions.rotate(session, client, expiresAt, trust);
    } catch (err) {
      if (err instanceof SessionRotationConflict) {
        // ═══ LOST THE CAS: CONCURRENT USE, BUT BY WHOM? ═════════════════════
        //
        // Something else claimed this generation between our read and our write, and
        // for a client-driven refresh that really is what reuse detection is for.
        //
        // Under the BFF there are two benign causes, and they have to be told apart
        // before anyone is accused of theft.
        //
        // The first is a REVOCATION landing mid-rotation — the CAS predicate includes
        // `revokedAt: null`, so a logout, a logout-all or a password change that
        // commits while this is in flight makes the update match zero rows. That is
        // somebody signing out at an unlucky moment, and under the BFF it is routine
        // because the refresh is not theirs to time. Routing it to `handleReuse`
        // would log a security warning and tell them their credentials were stolen
        // every time it happened.
        //
        // The second is F10: the Redis refresh lock's TTL is fixed and shorter than a
        // rotation's own bound, so it can lapse mid-rotation, a second owner appears,
        // and one of the two loses. The database is what actually guarantees one-use
        // and it did its job — there is exactly one child. The loser's error was in
        // its INTERPRETATION, not in the outcome.
        //
        // So: re-read the row, answer honestly if it was revoked, look at what
        // committed, and only then call it theft.
        const fresh = await this.sessions.findById(session.id);
        if (fresh !== null && fresh.revokedAt !== null) {
          throw new SessionEndedException(
            revokedMessageCode(fresh.revokedReason),
            ERR.SESSION_REVOKED,
            fresh.lastUsedAt,
          );
        }

        const repaired = await this.recoverRotation(session);
        if (repaired !== null) return repaired;
        await this.handleReuse(session);
      }
      throw err;
    }

    return this.completeFor(child);
  }

  /**
   * Re-read the account and mint. Shared by rotation and by recovery.
   *
   * ═══ WHY THIS IS A SHARED HELPER AND NOT DUPLICATED ════════════════════════
   *
   * Recovery hands out a working session, so it has to clear exactly the same account
   * checks a rotation does. Writing them twice would mean two lists that agree today,
   * and the failure mode of them drifting is a user whose account was deleted or
   * disabled refreshing their way back in through the repair path. One function, two
   * callers, no opportunity to forget.
   *
   * Re-read rather than trusting the token's claims: an account removed since the
   * session was minted must not be able to refresh its way to another day.
   */
  private async completeFor(generation: Session): Promise<IssuedSession> {
    const found = await this.users.findWithCredential(generation.userId);
    if (found === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    return this.mint(generation, found.user, found.credential !== null);
  }

  /**
   * Repair an interrupted rotation, or return null to leave the caller's own refusal
   * in place.
   *
   * ═══ THE ONE THING THIS MUST NOT BECOME ════════════════════════════════════
   *
   * A general exception to refresh-token reuse detection. It is a repair path for ONE
   * situation — a rotation that committed and whose publication did not — and
   * `findRecoverableRotation` is where that situation is defined. Both callers fall
   * through to `handleReuse` when it answers null, so reuse detection stays the
   * default and this stays the exception that has to prove itself.
   *
   * No rotation happens. The generation the caller presented was already consumed,
   * once; this serves the child that consumption produced. The CAS is not reached, so
   * the one-use guarantee is not involved.
   *
   * ─── Logged distinctly, and that is operationally load-bearing ────────────
   *
   * Before this existed, a lapsed refresh lock and genuine token theft produced the
   * SAME observable: a `REUSE_DETECTED` family revocation. An operator could not tell
   * an unhealthy Redis from an attack. A sustained rate of this line means the store
   * or the database is slow; `handleReuse` continues to mean what it says.
   */
  private async recoverRotation(parent: Session): Promise<IssuedSession | null> {
    // Identity, not the row. `parent` was loaded before the rotation this is
    // repairing, so its `rotatedAt` is stale by construction on the CAS-conflict path
    // — `findRecoverableRotation` re-reads it.
    const tip = await this.sessions.findRecoverableRotation({
      parentId: parent.id,
      familyId: parent.familyId,
      windowSeconds: SESSION.ROTATION_RECOVERY_WINDOW_SECONDS,
    });
    if (tip === null) return null;

    this.logger.log(
      {
        userId: parent.userId,
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
   * Revoke one named session belonging to the caller.
   *
   * The ownership check is the whole security content of this method. Session ids
   * are UUIDv7 — they encode a timestamp and sort chronologically, so an id minted
   * near yours is guessable in a way a random UUID is not. Revoking by id without
   * confirming the owner would be a denial-of-service against arbitrary accounts.
   *
   * The family, not the generation: revoking the one row a client happens to name
   * leaves its rotated children alive, which is the same defect device logout had.
   */
  async revokeSession(principal: Principal, sessionId: string): Promise<void> {
    await this.rateLimitSessionAdmin(principal.familyId);

    const session = await this.sessions.findById(sessionId);
    if (session === null || session.userId !== principal.userId) {
      // Indistinguishable from a session that never existed — a different answer
      // here would confirm which ids belong to other people.
      throw new ProblemException({ type: ERR.NOT_FOUND });
    }

    const revoked = await this.sessions.revokeFamily(session.familyId, REVOKE_REASON.LOGOUT);
    await this.cacheRevocations(revoked, REVOKE_REASON.LOGOUT);
  }

  /**
   * The caller's live sessions, grouped by the device they sit on.
   *
   * Grouping happens here rather than in SQL because the join is on a hash the
   * database has no reason to know is a device: `Session.deviceFingerprint` and
   * `TrustedDevice.tokenHash` hold the same value, and matching them in memory
   * over one user's handful of live sessions is cheaper than teaching Postgres
   * about it.
   */
  async listSessions(principal: Principal): Promise<SessionGroup[]> {
    const [live, devices] = await Promise.all([
      this.sessions.listLiveForUser(principal.userId),
      this.devices.listForUser(principal.userId),
    ]);

    const trustByKey = new Map(devices.map((device) => [device.tokenHash, device]));
    const groups = new Map<string, SessionGroup>();

    for (const session of live) {
      const trust = trustByKey.get(session.deviceFingerprint) ?? null;
      const group = groups.get(session.deviceFingerprint) ?? {
        deviceId: trust?.id ?? null,
        label: trust?.label ?? deviceLabel(session.userAgent),
        trustedUntil: trust?.expiresAt ?? null,
        current: false,
        sessions: [],
      };

      group.sessions.push(session);
      if (session.id === principal.sessionId) group.current = true;
      groups.set(session.deviceFingerprint, group);
    }

    // The device you are on first; the rest newest-first. A user scanning for
    // something to revoke should not have to work out which row is themselves.
    return [...groups.values()].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return (b.sessions[0]?.createdAt.getTime() ?? 0) - (a.sessions[0]?.createdAt.getTime() ?? 0);
    });
  }

  /**
   * The trust window this refresh may actually claim — `null` means the idle rule.
   *
   * This is what makes remember-me *device*-bound rather than session-bound, and
   * it is the difference between a stolen refresh token being worth a day and
   * being worth a week. A token copied out of the browser and replayed elsewhere
   * arrives without that browser's `orebit_device` cookie, so `deviceKey` does not
   * match and the extension is simply not granted. The thief still gets a session
   * — the token is valid — but only an idle-window one.
   *
   * Three ways to lose the window, all silent and all correct: the cookie is
   * absent or belongs to a different browser; the trust was revoked from the
   * device list; or it expired. In every case the session keeps working, just on
   * the ordinary rule, so a user who clears cookies is not logged out — they are
   * merely no longer remembered.
   *
   * Returns the pair rather than just the date because the child row needs both
   * columns. `trustedDeviceId` is what lets "untrust this device" find every
   * session a trust is holding open, and a chain of rotations that dropped it would
   * leave the link pointing only at generations nobody is using any more.
   */
  private async honourTrust(
    session: Session,
    client: RefreshContext,
  ): Promise<{ rememberUntil: Date; trustedDeviceId: string } | null> {
    if (session.rememberUntil === null) return null;

    // `null` and "a different browser's key" are one branch on purpose: both mean
    // this request cannot show the cookie the trust was granted to. Null is the
    // commoner of the two now — the guard reads the device cookie without issuing
    // one, so a browser that has cleared its cookies genuinely presents nothing.
    if (client.deviceKey === null || session.deviceFingerprint !== client.deviceKey) {
      this.logger.warn(
        { userId: session.userId, sessionId: session.id },
        'refresh presented without the trusted device cookie; trust not honoured',
      );
      return null;
    }

    const device = await this.devices.findLive(client.deviceKey, session.userId);
    if (device === null) return null;

    // A changed user-agent is logged, never enforced. Browsers rewrite it on every
    // update, so treating a mismatch as theft would sign users out on a routine
    // Tuesday — and an attacker holding the cookie can set any UA they like, so it
    // would catch nobody. It is here to be *visible* in the device list.
    if (device.userAgentAtTrust !== null && device.userAgentAtTrust !== client.userAgent) {
      this.logger.log(
        { userId: session.userId, deviceId: device.id },
        'trusted device user-agent changed since it was trusted',
      );
    }

    void this.touchDevice(device.id);
    // `device.id`, not `session.trustedDeviceId`: the live trust row is the
    // authority. They are the same value in the ordinary case, and where they
    // differ — a device untrusted and trusted again, which inserts a new row — the
    // parent's column names a revoked trust the child has no business inheriting.
    return { rememberUntil: session.rememberUntil, trustedDeviceId: device.id };
  }

  /**
   * Gap M4 — a sign-in from a browser this account has not used before.
   *
   * The try/catch and the `void` this used to be called through are both gone, and
   * their absence is the point: `MailService.sendNewDeviceLogin` is already
   * non-blocking and already swallows its own failures, so wrapping it added a
   * second layer of the same guarantee and made a plain call look like something
   * that needed handling.
   */
  private notifyNewDevice(user: User, client: ClientContext): void {
    this.mail.sendNewDeviceLogin(
      user.email,
      deviceLabel(client.userAgent) ?? 'an unrecognised device',
      client.ipClass,
      // Read off the row this method already holds — no extra query. `null` when the
      // account has no code, which renders as no footer.
      antiPhishingCodeOf(user),
    );
  }

  /** Throttled and self-catching, exactly like `touch` — same reasoning. */
  private async touchDevice(deviceId: string): Promise<void> {
    try {
      const fresh = await this.cache.startCooldown(
        KEYS.device.lastUsed(deviceId),
        SESSION.LAST_USED_THROTTLE_SECONDS,
      );
      if (fresh) await this.devices.touch(deviceId);
    } catch (err) {
      this.logger.error({ err, deviceId }, 'trusted-device lastUsedAt write failed');
    }
  }

  /**
   * Revoke the family and refuse. Always throws.
   *
   * The whole family, not just the replayed generation: a replay means the token
   * is in two places, and there is no way from here to tell which holder is the
   * legitimate one. Invalidating everything and forcing a fresh login is the only
   * choice that is safe in both cases.
   */
  private async handleReuse(session: Session): Promise<never> {
    const revoked = await this.sessions.revokeFamily(session.familyId, REVOKE_REASON.REUSE_DETECTED);
    await this.cacheRevocations(revoked, REVOKE_REASON.REUSE_DETECTED);
    this.logger.warn(
      { userId: session.userId, familyId: session.familyId, revoked: revoked.length },
      'refresh token reuse detected; family revoked',
    );
    throw new ProblemException({ type: ERR.SESSION_REUSE_DETECTED });
  }

  /**
   * Revoke every live session for the caller's browser/device. This is deliberately
   * narrower than `logoutAll`: closing one tab must close the other tabs on that
   * device without signing the user out on their other devices.
   *
   * The device is read from the session row, not from the request, so grouping
   * survives a cleared cookie.
   *
   * ─── Why the family is revoked unconditionally ──────────────────────────────
   *
   * Because the device sweep alone does not guarantee the thing logout promises:
   * that the credential in the caller's hand can never mint another session.
   *
   * That sweep matches on `deviceFingerprint`, so it reaches the live generation only
   * when the live generation SHARES the fingerprint of the row we resolved. A
   * family's fingerprint can drift — the child is stamped with the deviceKey of
   * whichever request rotated it, so clearing cookies used to mint a child under a
   * new one and leave the sweep covering only the ancestor's. That specific drift is
   * narrower now, because `SessionDbOperation.rotate` carries the parent's
   * fingerprint forward when a request arrives without a device cookie — but the
   * family sweep is what makes the guarantee hold regardless of it.
   *
   * Whatever the principal names, its whole chain — every ancestor and the live
   * child — is revoked, because they all carry the same `familyId` from
   * `createFirstGeneration` onward. Revoking the single generation the principal
   * names would not do it: a rotated-but-unrevoked ancestor still satisfies a
   * `revokedAt: null` filter, so the call would succeed against a spent row and
   * leave the live child running. The device sweep is still run, and still does the
   * job it is here for: ending the OTHER families on this browser, which is what
   * makes closing one tab close the rest.
   *
   * Both, not one. The family alone would leave a second tab's independent login
   * running; the device alone leaves the hole above.
   */
  async logout(principal: Principal): Promise<void> {
    // Charged before anything is revoked.
    await this.rateLimitSessionAdmin(principal.familyId);

    const session = await this.sessions.findById(principal.sessionId);

    // A missing row is already unusable. Keeping logout idempotent also avoids
    // turning a second click in the client into an authentication error.
    if (session === null) return;

    // Defence in depth behind the signed `sid` claim. It cannot name a session we did
    // not issue, but this revokes a whole family — so the blast radius is worth one
    // explicit assertion that the family really belongs to the caller.
    if (session.userId !== principal.userId) {
      throw new ProblemException({ type: ERR.TOKEN_INVALID });
    }

    // The caller's own chain, always. See the header — and it is also why revoking
    // the single id the principal names would not be enough: a rotated-but-unrevoked
    // ancestor still satisfies a `revokedAt: null` filter, so that would succeed
    // against a spent generation and leave its live child running.
    const revoked = [await this.sessions.revokeFamily(session.familyId, REVOKE_REASON.LOGOUT)];

    // Sessions created before device cookies used a header-derived hash. Never
    // group on that coarse legacy value: two distinct devices could share it, so
    // sweeping it would sign a stranger out. Those sessions get family scope only,
    // which is correct — it is the chain the caller actually presented.
    if (isDeviceKey(session.deviceFingerprint)) {
      revoked.push(
        await this.sessions.revokeAllForUserOnDevice(
          session.userId,
          session.deviceFingerprint,
          REVOKE_REASON.LOGOUT,
        ),
      );
    }

    // Deduplicated: the two sweeps overlap on the caller's own session in theory,
    // though not in practice — the family sweep revokes it first, and the device
    // sweep's `revokedAt: null` filter then no longer sees it. Cheap insurance
    // against writing the same Redis key twice if that ordering ever changes.
    await this.cacheRevocations([...new Set(revoked.flat())], REVOKE_REASON.LOGOUT);
  }

  async logoutAll(principal: Principal): Promise<void> {
    // The widest of the session mutations, and it was the one charging nothing.
    await this.rateLimitSessionAdmin(principal.familyId);

    const revoked = await this.sessions.revokeAllForUser(
      principal.userId,
      REVOKE_REASON.LOGOUT_ALL,
    );
    await this.cacheRevocations(revoked, REVOKE_REASON.LOGOUT_ALL);
  }

  /** Used by the password paths: every session but the one making the change. */
  async revokeAllForUserExcept(
    userId: string,
    keepSessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    const revoked = await this.sessions.revokeAllForUserExcept(userId, keepSessionId, reason);
    await this.cacheRevocations(revoked, reason);
  }

  /** Used by the password paths: a credential change invalidates every session. */
  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<void> {
    const revoked = await this.sessions.revokeAllForUser(userId, reason);
    await this.cacheRevocations(revoked, reason);
  }

  /**
   * Is this session still usable? Called by AuthGuard on every request.
   *
   * Returns what the liveness query already read: the session's stored `lastUsedAt`,
   * and the STABLE family id. Throws otherwise.
   *
   * The cache is deny-only: a positive flag rejects immediately, but a cache miss can
   * never prove a session is live. PostgreSQL remains the authority for both
   * revocation and expiry, so misses and Redis failures always verify there.
   *
   * ═══ WHY IT RETURNS A REASON-SHAPED REFUSAL NOW ════════════════════════════
   *
   * It threw a bare `session_revoked` for all three dead states — revoked, expired,
   * and absent. So a user whose session simply timed out was told it had been
   * REVOKED, which reads as somebody else acting on their account. The reason was
   * always available; `readLiveness` just stopped discarding it.
   *
   * Both halves still 401 and both call for the same client cleanup. What differs is
   * the sentence a person reads, which is the whole of what `GET /auth/session` is
   * for — see security/session.message.ts.
   */
  async assertLive(sessionId: string): Promise<LiveSession> {
    const key = KEYS.session.revoked(sessionId);
    const cached = await this.cache.flag(key);
    if (cached === true) {
      // Always a revocation, never a timeout: this flag is only ever written by
      // `cacheRevocations`, which runs after an actual revoke.
      //
      // ─── One extra GET, on a path that is already ending in a 401 ──────────
      //
      // The flag's VALUE is the reason it was written with, so this recovers whether
      // one session was ended or all of them without asking Postgres — which would
      // undo the whole point of the fast path. `flag` stays the gate rather than
      // being replaced by this read, because its three-valued answer is what makes
      // the cache deny-only: a `get` alone could not tell an absent key from a Redis
      // that did not answer.
      //
      // Swallowed on failure, unlike everywhere else `cache.get` is called. It is
      // fail-closed and throws a 500, and a Redis blip between the `exists` that just
      // answered and this `get` must not turn an honest 401 into an outage. A missing
      // or legacy value reads as the narrower `SESSION_REVOKED` anyway — see
      // `revokedMessageCode` — so there is nothing here worth failing a request over.
      const reason = await this.cache.get(key).catch(() => null);

      // No `lastUsedAt` on this path, deliberately: the row is never read, which is
      // the entire point of it. `GET /auth/session` reports null rather than paying
      // for a query to decorate a refusal.
      throw new SessionEndedException(revokedMessageCode(reason), ERR.SESSION_REVOKED);
    }

    // `false` and `null` deliberately land here together: "no flag" and "Redis could
    // not answer" are equally weak evidence that a session is live.
    const { reason, lastUsedAt, familyId } = await this.sessions.readLiveness(sessionId);
    if (reason !== null) {
      // `revoked-all` is not a third SLUG — it is still `session_revoked` — it is a
      // third MESSAGE, so the status route can say "your sessions have been logged
      // out" rather than naming a device that was not involved.
      //
      // `lastUsedAt` rides along on the refusal so a user who timed out can be told
      // when they were last seen. The row's stored value, never `now()`.
      throw new SessionEndedException(
        reason === 'revoked'
          ? 'SESSION_REVOKED'
          : reason === 'revoked-all'
            ? 'SESSION_REVOKED_ALL'
            : 'SESSION_EXPIRED',
        reason === 'expired' ? ERR.SESSION_EXPIRED : ERR.SESSION_REVOKED,
        lastUsedAt,
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
    // value keys the activity write and every session-administration quota, so a
    // caller receiving `null` would have no correct branch: skipping the check would
    // drop a rate-limit boundary, and substituting the generation id would reintroduce
    // the bucket a client could reset by refreshing. If this ever fires it is a schema
    // violation worth failing loudly on.
    if (familyId === null) {
      this.logger.error({ sessionId }, 'live session has no family id');
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    return { lastUsedAt, familyId };
  }

  /**
   * Refresh calls for one session FAMILY — the short window and the hour, together.
   *
   * ─── Why the family, and why one call ───────────────────────────────────────
   *
   * Keyed on `familyId` because a rotation mints a child with a new session id: keyed
   * on that, a successful refresh always found an empty bucket, so the limit only
   * constrained a client replaying ONE generation and never a client looping on
   * refresh — which is the case it names in its own comment. The family id is the id
   * of the first generation and never changes, so it is the only key here a client
   * cannot rotate away from.
   *
   * Charged through `QuotaService.consumeAll` rather than two `cache.consume` calls
   * because the two windows are one decision. Sequentially, a request refused by the
   * hourly window had already been charged against the short one — so a client sitting
   * at the hourly limit burned its ten-minute allowance too, and the retry advice it
   * got back described the wrong window. `consumeAll` tests every key before it charges
   * any, so the pair is granted together or not at all.
   *
   * `allow` on a Redis failure. Unlike the mail budgets there is nothing expensive
   * behind this: the worst a lost limiter permits is a client making more database
   * round trips than it should, and refusing every refresh during a Redis outage
   * would sign every user out of the product instead.
   */
  private async rateLimitRefresh(familyId: string): Promise<void> {
    await this.quota.consumeAll(
      [
        { key: KEYS.rate.refreshByFamily(familyId), rule: policy().SESSION.REFRESH_SHORT },
        { key: KEYS.rate.refreshByFamilyHourly(familyId), rule: policy().SESSION.REFRESH_HOURLY },
      ],
      // The cache instance: these bound request volume, not a cost, so they are not
      // worth the durable instance's write amplification and may be lost on eviction.
      'burst',
      'allow',
    );
  }

  /**
   * Logout, logout-all, revoke, trust and untrust — one bucket for all of them.
   *
   * They are the same kind of state-changing session administration and nobody
   * legitimately performs ten in a minute. One bucket rather than five because
   * splitting them would only let a caller do ten of each; what is being bounded is
   * the caller's ability to churn session state at all.
   *
   * Keyed on the family for the same reason `rateLimitRefresh` is: on the session id,
   * a caller could refresh between mutations and start again with a full allowance.
   */
  private async rateLimitSessionAdmin(familyId: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.sessionAdminByFamily(familyId),
      policy().SESSION.ADMIN_BY_FAMILY,
      'allow',
    );
  }

  // ═══ REMOVED: resolveSessionId / resolveFamilyId / resolveUserId ═══════════
  //
  // All three existed because `POST /auth/session` could be called with a refresh
  // cookie and no bearer, so the caller's identity had to be recoverable from the
  // token in the cookie — and each therefore PREFERRED the token over the principal,
  // and each needed a cross-account guard to stop account A's token naming account
  // B's session.
  //
  // No refresh token reaches this service in a request any more. It is sealed inside
  // the session record and only `rotate` ever sees one, handed over by
  // `BffSessionService`. The session cookie resolves to an access token which the
  // guard verifies into a `Principal` before any of these methods are reachable, so
  // the principal is the only identity source there is — and being the only one, it
  // needs no preference order and no cross-account guard.
  //
  // Deleted rather than left for a future caller: their whole shape invites putting a
  // credential back into the request body, which is what this change removed.

  /**
   * Seed the deny-only revocation cache.
   *
   * `reason` is stored as the flag's VALUE — the same value `revokedReason` holds on
   * the rows that were just written, so the two stores cannot disagree about scope. It
   * is what lets `assertLive` tell "one session ended" from "all of them" on the
   * cached path, where it deliberately never reaches Postgres.
   *
   * Still a flag, and still fail-open: the value is read only to choose a MESSAGE, and
   * its absence degrades to the narrower one rather than to "not revoked". The
   * decision itself remains the key's existence.
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

  /**
   * Sign a token pair for a session row.
   *
   * ═══ THE ONE PLACE A PLATFORM SESSION IS EVER MINTED ════════════════════════
   *
   * Every path that hands a caller a working session reaches this method:
   *
   *     login.service.ts        password and email-OTP sign-in
   *     oauth.service.ts        provider sign-in
   *     registration.service.ts a brand new account
   *     2fa.controller.ts       the second leg of a sign-in ceremony
   *     completeFor             refresh rotation, and the rotation-recovery repair
   *
   * which is why the account check belongs HERE and not in any of them.
   *
   * ─── Why the callers cannot be trusted to do it ─────────────────────────────
   *
   * They demonstrably were not. Before account deletion existed, `status` was read by
   * the two sign-in services and nowhere else, so the 2FA ceremony and the rotation
   * path would both mint a session for an account whose `status` had moved — the
   * ceremony because it re-reads with `findWithCredential`, which filters `deletedAt`
   * and not `status`, and rotation for the identical reason. `completeFor`'s own
   * docblock promises to stop "a user whose account was deleted or disabled refreshing
   * their way back in", and it did not.
   *
   * Fixing those two would have left five lists that agree today and drift tomorrow.
   * One assertion at the point of issue cannot be forgotten by a path that does not
   * exist yet, and that is the whole argument for its being here.
   *
   * ─── Why this is not redundant with the session sweep ───────────────────────
   *
   * Deleting an account revokes every session it has, which ends the tokens already
   * issued. This ends the ones not issued yet. Neither covers the other: a sweep
   * cannot revoke a session that a login is about to create, and this cannot reach a
   * token already in somebody's browser. The deleted state needs both.
   *
   * `ACCOUNT_DISABLED` rather than a deletion-specific slug, because it is the answer
   * the two sign-in paths already give for exactly this condition and a caller learns
   * nothing useful from the difference.
   */
  private mint(session: Session, user: User, hasPassword: boolean): IssuedSession {
    if (user.status !== 'ACTIVE') {
      this.logger.warn(
        { userId: user.id, sessionId: session.id, status: user.status },
        'refused to mint a session for a non-active account',
      );
      throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
    }

    const access = signAccessToken({
      userId: user.id,
      sessionId: session.id,
      publicCode: user.publicCode,
    });
    const refresh = signRefreshToken({
      userId: user.id,
      sessionId: session.id,
      familyId: session.familyId,
      // The row's expiry, not a constant. A trusted device's row outlives the idle
      // window, and a token signed to the constant would expire underneath it.
      expiresAt: session.expiresAt,
    });

    return {
      sessionId: session.id,
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt,
      user: toPublicUser(user, hasPassword),
    };
  }
}
