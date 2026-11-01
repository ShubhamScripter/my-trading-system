import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { CacheService, KEYS, LockService } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { config } from '../../src/config';
import { SESSION } from '../auth.constants';
import type { ClientContext, IssuedSession } from '../auth.types';
import { generateSessionHandle } from '../auth.utility';
import { SessionService } from '../services/session.service';

/**
 * ═══ THE BROWSER'S SESSION RECORD ══════════════════════════════════════════
 *
 * The backend holds the access and refresh tokens on the browser's behalf. The
 * browser holds only the opaque handle that names this record, in the
 * `orebit_admin_session` cookie.
 *
 * ─── What this does NOT change ─────────────────────────────────────────────
 *
 * Everything about the token model. The access JWT still authenticates every
 * request, `verifyAccessToken` still verifies it, `assertLive` still checks the
 * session row on every call, and `SessionService.rotate` still rotates a refresh
 * token against the same family with the same reuse detection. This file moves
 * WHERE those tokens are kept — from JavaScript and a cookie to a Redis record —
 * and nothing about what they are or how they are validated.
 *
 * That is the whole of the change the OREBiT auth spec asks for: the browser can no
 * longer read either token, so an XSS on the panel steals a handle that is useless
 * off-origin, rather than a fifteen-minute access token and the ability to mint more.
 *
 * ─── Why Redis and not a column ────────────────────────────────────────────
 *
 * Because there is nothing durable here. The `AdminSession` row already holds every
 * fact that has to survive a restart — the family, both clocks, the revocation — and
 * this record holds only two tokens, both of which are re-derivable by signing in
 * again. A flush of this cache signs admins out; it cannot corrupt anything, and for
 * a population of a handful of people that is an acceptable failure mode against the
 * cost of a schema migration and a second writer onto the session table.
 *
 * The record's TTL is the session's absolute ceiling, so it cannot outlive the
 * credential it describes.
 */

/** 96 bits, the GCM-recommended IV size. Larger is not better here — anything but
 *  12 bytes forces an internal GHASH derivation for no benefit. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * How long a request waits between checks for the refresh holder's result.
 *
 * Backoff rather than a fixed interval: the holder normally finishes in about a
 * millisecond, so the first check almost always succeeds and the later, longer waits
 * are never reached. Their sum is `SESSION.REFRESH_WAIT_MS`, which is what bounds
 * the whole wait — pinned by a test so the two cannot drift apart.
 */
const BACKOFF_MS = [25, 50, 100, 200, 400, 225] as const;

/**
 * What is stored, as JSON, under `bff:session:<handle>`.
 *
 * `refreshSealed` is encrypted; `accessToken` is not, and the asymmetry is
 * deliberate. The refresh token is a twelve-hour grant, so a dump of the Redis
 * volume must not hand it over. The access token expires in fifteen minutes and
 * `assertLive` refuses it the instant its session is revoked, so sealing it would
 * cost a decrypt on every request to protect a credential that is nearly dead
 * already. Same reasoning `OTP_QUEUE_KEY` applies to a queued code versus the rest
 * of its job.
 */
interface SessionRecord {
  /** `AdminSession.id` of the CURRENT generation. Moves on every rotation. */
  readonly sessionId: string;
  readonly accessToken: string;
  /** Epoch ms. Numbers rather than ISO strings because every read compares them. */
  readonly accessExpiresAt: number;
  readonly refreshSealed: string;
  /** The family's absolute ceiling. Fixed for the life of the session. */
  readonly reauthenticateAt: number;
}

/** What `withLock`'s callback returns, so a `null` from `withLock` itself means
 *  "the lock was held" and nothing else. Without the wrapper the two are
 *  indistinguishable, and they call for opposite handling. */
interface RefreshOutcome {
  readonly token: string | null;
}

@Injectable()
export class BffSessionService {
  private readonly logger = new Logger('BffSession');

  constructor(
    private readonly sessions: SessionService,
    private readonly cache: CacheService,
    private readonly locks: LockService,
  ) {}

  /**
   * Store a freshly-minted session and return the handle that names it.
   *
   * Called once, by the two `POST /2fa` actions that complete the sign-in ceremony.
   * The write is fail-closed (`'deny'`): a record that was never stored describes a
   * session the browser is about to be handed a cookie for and could never use, so
   * refusing now is better than looking successful and 401-ing on the next request.
   */
  async create(issued: IssuedSession): Promise<string> {
    const handle = generateSessionHandle();
    await this.write(handle, issued);
    return handle;
  }

  /**
   * The access token this handle's session should present, or null if there is none.
   *
   * Null means "not signed in" and the caller turns it into a 401. It covers an
   * unknown handle, an expired record, a Redis outage, and a record whose refresh
   * token cannot be authenticated — all of which are indistinguishable from the
   * browser's point of view and have the same remedy.
   *
   * A refusal that is NOT null-shaped propagates instead: `rotate` throws
   * `session_revoked`, `session_reuse_detected` and `token_expired`, and those slugs
   * are exactly the reasons the spec asks a 401 to carry. `session_store_unavailable`
   * joins them — see `awaitHolder` — and is the one that is explicitly NOT a session
   * ending, so it answers 503 rather than 401.
   */
  async resolve(handle: string, client: ClientContext): Promise<string | null> {
    const record = await this.read(handle);
    if (record === null) return null;

    if (!this.isDueForRefresh(record)) return record.accessToken;

    return this.refresh(handle, record, client);
  }

  /** Drop the record. Called on logout, after the session itself is revoked.
   *
   *  Deliberately silent: `CacheService.clear` swallows its own errors, so a Redis
   *  failure here cannot turn a revocation PostgreSQL has already committed into a
   *  failed request. The record expires on its own regardless. */
  async destroy(handle: string): Promise<void> {
    await this.cache.clear(KEYS.bff.session(handle));
  }

  /**
   * What Redis can tell us about this handle — three states, never two.
   *
   * ═══ WHY THIS IS NOT `boolean | null` ══════════════════════════════════════
   *
   * Because the third state is the entire point, and a nullable boolean invites
   * exactly one mistake: `if (!state)` folds `null` in with `false`, reading "Redis
   * could not answer" as "there is nothing there". That fold IS the bug this method
   * exists to prevent. A named union cannot be collapsed by accident — `'unknown'`
   * is truthy, and every branch has to be spelled out.
   *
   * Three-valued on purpose, unlike `resolve`, which folds "no record" and "no
   * Redis" into one null. That is right for AUTHENTICATION, where both mean the same
   * thing: this request cannot be authenticated, so refuse it. It is wrong for
   * LOGOUT, where they are opposites.
   *
   * ═══ AN OUTAGE AND A LOST RECORD ARE DIFFERENT PROBLEMS ════════════════════
   *
   *   'absent'    Redis answered, truthfully, that this handle names nothing. There
   *               is no session left to identify, the browser's handle is already
   *               useless, and a repeat logout must keep succeeding. An honest 200.
   *
   *               Note this also covers an EVICTED record — `redis-cache` runs
   *               `allkeys-lru`, so one can be dropped under memory pressure while
   *               its family is still live in PostgreSQL. That is a real gap, and it
   *               is NOT this method's to close: refusing here would break every
   *               ordinary repeat logout without making a single session safer. The
   *               cure is a durable handle-to-family mapping, which does not exist.
   *
   *   'unknown'   Redis did not answer at all. The handle-to-family mapping is
   *               unreachable, so the authoritative revocation cannot even be
   *               attempted — and a caller must not report success. See
   *               `ERR.SESSION_STORE_UNAVAILABLE`.
   *
   * The `boolean | null` that `CacheService.flag` returns is mapped HERE, once, and
   * never travels any further in that shape.
   */
  async recordState(handle: string): Promise<'present' | 'absent' | 'unknown'> {
    const flag = await this.cache.flag(KEYS.bff.session(handle));
    // Redis could not answer. Not evidence of anything.
    if (flag === null) return 'unknown';
    return flag ? 'present' : 'absent';
  }

  // ─── refresh ──────────────────────────────────────────────────────────────

  /**
   * Rotate under a lock, or proceed on the token we already hold.
   *
   * ═══ WHY THE LOCK IS NOT OPTIONAL ══════════════════════════════════════════
   *
   * `SessionService.rotate` treats a rotation conflict as a replayed refresh token
   * and revokes the whole family. That is right for a client-driven refresh, where
   * two callers presenting one token really is theft. It is wrong for this caller:
   * refresh is now automatic and unprompted, so two concurrent requests on one
   * session reach it as a matter of course, and without a lock ordinary concurrency
   * would sign the admin out. See `REFRESH_LOCK_SECONDS` in auth.constants.ts.
   *
   * ═══ THE THREE WAYS OUT, IN ORDER ══════════════════════════════════════════
   *
   *   won the lock    re-read inside it (a holder may have finished between our read
   *                   and our acquire), and rotate only if the fresh record still
   *                   needs it. The refresh token is opened from the FRESH record,
   *                   never the stale one — presenting a token that has already been
   *                   rotated away is precisely what trips reuse detection.
   *   lost the lock,  proceed on the token we have. This is the common case and the
   *   token valid     reason the skew exists: it is still good for up to
   *                   `ACCESS_REFRESH_SKEW_SECONDS`, so waiting would add latency to
   *                   buy nothing.
   *   lost the lock,  WAIT, briefly and with a bound, for the holder's answer — see
   *   token expired   `awaitHolder`. This used to be a single re-read with no wait at
   *                   all, and a 401 if the holder had not landed yet, which signed
   *                   out healthy sessions on a race the width of one transaction.
   */
  private async refresh(
    handle: string,
    stale: SessionRecord,
    client: ClientContext,
  ): Promise<string | null> {
    const outcome = await this.locks.withLock<RefreshOutcome>(
      KEYS.bff.refreshLock(handle),
      SESSION.REFRESH_LOCK_SECONDS,
      async () => {
        const fresh = await this.read(handle);
        if (fresh === null) return { token: null };
        if (!this.isDueForRefresh(fresh)) return { token: fresh.accessToken };

        const refreshToken = this.open(fresh.refreshSealed, handle);
        if (refreshToken === null) {
          // The envelope did not authenticate: a truncated value, the wrong key, or
          // a record copied from another handle. Not recoverable and not the
          // browser's fault to fix — it signs in again.
          this.logger.error({ sessionId: fresh.sessionId }, 'session record could not be opened');
          return { token: null };
        }

        const issued = await this.sessions.rotate(refreshToken, client);
        await this.write(handle, issued);
        return { token: issued.accessToken };
      },
    );

    if (outcome !== null) return outcome.token;

    if (stale.accessExpiresAt > Date.now()) return stale.accessToken;

    return this.awaitHolder(handle);
  }

  /**
   * Wait for whoever holds the refresh lock to publish its result.
   *
   * ═══ WHY WAITING IS THE RIGHT ANSWER HERE ══════════════════════════════════
   *
   * Exactly one request may rotate, because the refresh token is one-use and
   * presenting it twice is what reuse detection is for. That makes the losers'
   * problem "learn the answer", not "get an answer of their own" — and the record
   * the holder writes IS the answer, so there is nothing to coordinate beyond
   * noticing it appear. No second lock, no new shared state.
   *
   * ─── The objection this design has to answer ───────────────────────────────
   *
   * The previous version refused to wait on purpose, reasoning that a request thread
   * waiting on another request is how a pool gets exhausted. That is a real hazard
   * and it is answered by the shape of the wait rather than by refusing to wait:
   *
   *   bounded    `REFRESH_WAIT_MS` total, and strictly under the lock's own TTL, so a
   *              waiter can never outlive the holder it is waiting for.
   *   backoff    a handful of reads across that window, not a spin.
   *   usually    the holder finishes in about a millisecond, so the FIRST check
   *   free       almost always finds the record already written. The extra reads are
   *              paid only in the rare slow case.
   *
   * Against that: the alternative is signing an admin out mid-request because a
   * different request happened to be rotating.
   *
   * ─── What a returned token does and does not mean ──────────────────────────
   *
   * `accessExpiresAt > now` decides only WHICH token to present. It is not an
   * authorisation decision and must never be mistaken for one: every token this
   * method returns still goes through `verifyAccessToken` and then `assertLive`,
   * which re-checks revocation and both deadlines against PostgreSQL. A session
   * revoked while the holder was rotating is refused there, not here.
   */
  private async awaitHolder(handle: string): Promise<string> {
    for (const delay of BACKOFF_MS) {
      const fresh = await this.read(handle);
      if (fresh !== null && fresh.accessExpiresAt > Date.now()) return fresh.accessToken;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const last = await this.read(handle);
    if (last !== null && last.accessExpiresAt > Date.now()) return last.accessToken;

    // The holder crashed, or is wedged. NOT a 401: this session is very probably
    // fine, and the thing that failed is the coordination around it. Telling the
    // client to retry is honest; telling it to sign in again is not.
    this.logger.warn('refresh holder did not publish a result within the wait budget');
    throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
  }

  /** Within the skew of expiry, or already past it. */
  private isDueForRefresh(record: SessionRecord): boolean {
    return record.accessExpiresAt - Date.now() <= SESSION.ACCESS_REFRESH_SKEW_SECONDS * 1000;
  }

  // ─── storage ──────────────────────────────────────────────────────────────

  private async write(handle: string, issued: IssuedSession): Promise<void> {
    const record: SessionRecord = {
      sessionId: issued.sessionId,
      accessToken: issued.accessToken,
      accessExpiresAt: issued.accessExpiresAt.getTime(),
      refreshSealed: this.seal(issued.refreshToken, handle),
      reauthenticateAt: issued.reauthenticateAt.getTime(),
    };

    // The absolute ceiling, floored at one second so a record is always actually
    // written — `EX 0` is rejected, and a session this close to its ceiling is about
    // to be refused by `isUnusable` anyway.
    const ttlSeconds = Math.max(
      1,
      Math.ceil((record.reauthenticateAt - Date.now()) / 1000),
    );

    // ═══ THE PUBLISH SEAM — WHERE F09 LIVED ══════════════════════════════════
    //
    // On the refresh path this write happens AFTER `SessionService.rotate` has
    // committed, so by the time it runs the durable store has already moved on: the
    // parent generation is stamped, and its child is the family's tip. Nothing spans
    // the two stores, and nothing can — that would be a distributed transaction
    // across a cache whose whole purpose is to be disposable.
    //
    // So a failure here leaves the record naming the PARENT, holding a refresh token
    // PostgreSQL has already spent. That used to be a poison pill: the next request
    // presented it, and `rotate` read a second presentation of one token as theft and
    // revoked the family. One dropped cache write, and a healthy session was gone.
    //
    // The answer is not compensation — there is nothing safe to roll back, since the
    // rotation is the durable truth and the child is real. It is RECOVERY, on the
    // retry, derived from that truth: see `SessionService.recoverRotation` and
    // `SessionDbOperation.findRecoverableRotation`. Which is also why this refusal
    // has to be honest about being an infrastructure failure rather than borrowing
    // the rate-limit slug — a client that is told "slow down" and a client that is
    // told "the store is away, try again" behave differently, and only the second is
    // true.
    await this.cache.set(
      KEYS.bff.session(handle),
      JSON.stringify(record),
      ttlSeconds,
      'unavailable',
    );
  }

  /**
   * Read and parse, or null.
   *
   * `CacheService.get` conflates absence with a Redis it could not reach, and that
   * conflation is correct here: both mean this request cannot be authenticated, and
   * both have the same remedy. A malformed value lands on the same null — it is not
   * a shape this ever wrote, so there is nothing to salvage.
   */
  private async read(handle: string): Promise<SessionRecord | null> {
    const raw = await this.cache.get(KEYS.bff.session(handle));
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      this.logger.error('session record was not valid JSON');
      return null;
    }
  }

  // ─── the envelope ─────────────────────────────────────────────────────────

  /**
   * AES-256-GCM, bound to the handle.
   *
   * The handle is the AAD, which is what stops an envelope being MOVED: anyone who
   * can write to Redis could otherwise copy the record stored under one handle to
   * another, and the reader would decrypt it happily and hand a second browser admin
   * A's refresh token. With it, the tag covers the identity as well as the contents,
   * so a record found under a different key fails authentication.
   *
   * Simpler than the OTP queue's version of this envelope, which has to store its
   * AAD components in the clear because they live inside the payload it has not
   * decrypted yet. Here the AAD is the lookup key, so the reader already holds it.
   *
   * Layout is `iv | tag | ciphertext`, base64 — one value, written and read as a unit.
   */
  private seal(plaintext: string, handle: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', config.bffSessionKey, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(handle, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  /**
   * Open an envelope, or null if it cannot be authenticated.
   *
   * Every failure — a truncated blob, a wrong tag, a record moved from another
   * handle — lands on the same null. No caller could act on the difference, and
   * distinguishing them would only invite someone to log the reason next to the
   * ciphertext.
   */
  private open(sealed: string, handle: string): string | null {
    try {
      const buf = Buffer.from(sealed, 'base64');
      if (buf.length <= IV_BYTES + TAG_BYTES) return null;

      const decipher = createDecipheriv(
        'aes-256-gcm',
        config.bffSessionKey,
        buf.subarray(0, IV_BYTES),
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(handle, 'utf8'));
      decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

      // `final()` is what authenticates. Nothing before it returns is trusted.
      const plaintext = Buffer.concat([
        decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      return null;
    }
  }
}
