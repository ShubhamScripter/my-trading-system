import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { CacheService, KEYS, LockService } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { config } from '../../src/config';
import { SESSION } from '../auth.constants';
import type { IssuedSession, RefreshContext } from '../auth.types';
import { generateSessionHandle } from '../auth.utility';
import { SessionService } from '../services/session.service';

/**
 * ═══ THE BROWSER'S SESSION RECORD ══════════════════════════════════════════
 *
 * The backend holds the access and refresh tokens on the browser's behalf. The
 * browser holds only the opaque handle that names this record, in the `orebit_session`
 * cookie.
 *
 * ─── What this does NOT change ─────────────────────────────────────────────
 *
 * Everything about the token model. The access JWT still authenticates every request,
 * `verifyAccessToken` still verifies it, `assertLive` still checks the session row on
 * every call, and `SessionService.rotate` still rotates a refresh token against the
 * same family with the same reuse detection. This file moves WHERE those tokens are
 * kept — from JavaScript and a cookie to a Redis record — and nothing about what they
 * are or how they are validated.
 *
 * That is the whole of the change: the browser can no longer read either token, so an
 * XSS steals a handle that is useless off our origin, rather than a fifteen-minute
 * access token in a response body and a refresh cookie the browser would attach to
 * every refresh the attacker cared to trigger.
 *
 * ─── Why Redis and not a column ────────────────────────────────────────────
 *
 * Because there is nothing durable here. The `Session` row already holds every fact
 * that has to survive a restart — the family, the deadline, the trust window, the
 * revocation — and this record holds only two tokens, both of which are re-derivable
 * by signing in again. A flush of this cache signs people out; it cannot corrupt
 * anything, and that is an acceptable failure mode against the cost of a schema
 * migration and a second writer onto the sessions table.
 *
 * ─── The one gap this shape has, named rather than hidden ──────────────────
 *
 * `redis-cache` runs `allkeys-lru`, so a record can be evicted under memory pressure
 * while its family is still live in PostgreSQL. That signs someone out early. It is a
 * real cost of not having a durable handle-to-family mapping, and the record's TTL is
 * kept as tight as correctness allows partly to reduce the pressure that causes it —
 * see `write`.
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
 * are never reached. Their sum is `SESSION.REFRESH_WAIT_MS`, which is what bounds the
 * whole wait.
 */
const BACKOFF_MS = [25, 50, 100, 200, 400, 225] as const;

/**
 * What is stored, as JSON, under `bff:session:<tagged handle>`.
 *
 * `refreshSealed` is encrypted; `accessToken` is not, and the asymmetry is deliberate.
 * The refresh token is a multi-day grant, so a dump of the Redis volume must not hand
 * it over. The access token expires in fifteen minutes and `assertLive` refuses it the
 * instant its session is revoked, so sealing it would cost a decrypt on every request
 * to protect a credential that is nearly dead already.
 */
interface SessionRecord {
  /** `Session.id` of the CURRENT generation. Moves on every rotation. */
  readonly sessionId: string;
  readonly accessToken: string;
  /** Epoch ms. Numbers rather than ISO strings because every read compares them. */
  readonly accessExpiresAt: number;
  readonly refreshSealed: string;
  /**
   * The session's own deadline at the time this record was written, epoch ms.
   *
   * Stored so the record's TTL can be derived from it on every rewrite rather than
   * from a constant — see `write`.
   */
  readonly expiresAt: number;
}

/**
 * What `resolve` hands back for a live session.
 *
 * `rotated` exists because this service has no absolute ceiling, so the session cookie
 * has to be slid rather than set once — and the moment to slide it is the moment the
 * session's own deadline moved, which is a rotation. Reported rather than acted on
 * here: this file has no reply to write a cookie to, and should not.
 */
export interface ResolvedSession {
  readonly kind: 'session';
  readonly accessToken: string;
  /** True only when THIS request performed the rotation. A request that read a valid
   *  token, or waited for somebody else's rotation, reports false — whoever did the
   *  work slides on its own response. */
  readonly rotated: boolean;
}

/**
 * What `resolve` can answer — three states, for the same reason `recordState` has
 * three rather than a nullable boolean.
 *
 * ═══ WHY 'absent' AND 'unavailable' ARE NOT ONE ANSWER ═════════════════════
 *
 * They were, and they folded into a single `null` on the argument that both mean
 * "this request cannot be authenticated, so refuse it". That argument is sound for
 * the REFUSAL and wrong for everything the caller does around it, and curl found the
 * consequence: during a Redis outage, `GET /auth/session` answered
 * `401 SESSION_EXPIRED` — telling a user they had been logged out for inactivity when
 * nothing of the sort had happened — and then CLEARED THE COOKIES.
 *
 * That last part is the damage. The handle is the only value naming the session, so
 * dropping it strands a live session that nobody, including its owner, can ever
 * revoke. It is precisely the harm `AuthGuard` goes out of its way to avoid on a 503
 * logout, arrived at from the other direction — and worse, because a page polling
 * this route on load walks into it.
 *
 * So the two are separate here and folded, if at all, by the caller:
 *
 *   'absent'       Redis answered: this handle names nothing. The session is over —
 *                  the record's TTL is the session's own deadline — so a 401 is the
 *                  truth and clearing the dead cookies is a kindness.
 *   'unavailable'  Redis did not answer. Nothing has been learned about the session,
 *                  which is very probably fine. `session_store_unavailable` is the
 *                  honest answer, exactly as `awaitHolder` already concluded for the
 *                  same reason, and its 503 is what keeps the cookies.
 */
export type Resolution =
  | ResolvedSession
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' };

/** What `withLock`'s callback returns, so a `null` from `withLock` itself means "the
 *  lock was held" and nothing else. Without the wrapper the two are
 *  indistinguishable, and they call for opposite handling. */
interface RefreshOutcome {
  readonly resolved: Resolution;
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
   * The write is fail-closed: a record that was never stored describes a session the
   * browser is about to be handed a cookie for and could never use, so refusing now
   * is better than looking successful and 401-ing on the next request.
   */
  async create(issued: IssuedSession): Promise<string> {
    const handle = generateSessionHandle();
    await this.write(handle, issued);
    return handle;
  }

  /**
   * The access token this handle's session should present, or why there is none.
   *
   * `'absent'` covers an unknown handle, an expired record, a malformed one, and a
   * record whose refresh token cannot be authenticated — all of which are
   * indistinguishable from the browser's point of view and have the same remedy: sign
   * in again. `'unavailable'` is the state that is NOT that; see `Resolution`.
   *
   * A refusal that is neither propagates instead: `rotate` throws `session_revoked`,
   * `session_reuse_detected` and `token_expired`, and those slugs are exactly the
   * reasons a 401 should carry.
   */
  async resolve(handle: string, client: RefreshContext): Promise<Resolution> {
    const record = await this.read(handle);
    if (record.kind !== 'record') return record;

    if (!this.isDueForRefresh(record.value)) {
      return { kind: 'session', accessToken: record.value.accessToken, rotated: false };
    }

    return this.refresh(handle, record.value, client);
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
   * exists to prevent. A named union cannot be collapsed by accident — `'unknown'` is
   * truthy, and every branch has to be spelled out.
   *
   * Three-valued on purpose, unlike `resolve`, which folds "no record" and "no Redis"
   * into one null. That is right for AUTHENTICATION, where both mean the same thing:
   * this request cannot be authenticated, so refuse it. It is wrong for LOGOUT, where
   * they are opposites.
   *
   * ═══ AN OUTAGE AND A LOST RECORD ARE DIFFERENT PROBLEMS ════════════════════
   *
   *   'absent'    Redis answered, truthfully, that this handle names nothing. There is
   *               no session left to identify, the browser's handle is already
   *               useless, and a repeat logout must keep succeeding. An honest 200.
   *
   *               Note this also covers an EVICTED record — see the header. Refusing
   *               here would break every ordinary repeat logout without making a
   *               single session safer.
   *
   *   'unknown'   Redis did not answer at all. The handle-to-session mapping is
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
   * `SessionService.rotate` treats a rotation conflict as a replayed refresh token and
   * revokes the whole family. That is right for a client-driven refresh, where two
   * callers presenting one token really is theft. It is wrong for this caller: refresh
   * is now automatic and unprompted, so two concurrent requests on one session reach
   * it as a matter of course, and without a lock ordinary concurrency — two tabs, or
   * one page firing three fetches at load — would sign the user out.
   *
   * The lock is best-effort, not a guarantee. Its TTL is fixed and a slow rotation can
   * outlive it, which is why `rotate` also repairs the loser rather than accusing it —
   * see `SessionService.recoverRotation`.
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
   *   token expired   `awaitHolder`.
   */
  private async refresh(
    handle: string,
    stale: SessionRecord,
    client: RefreshContext,
  ): Promise<Resolution> {
    const outcome = await this.locks.withLock<RefreshOutcome>(
      KEYS.bff.refreshLock(handle),
      SESSION.REFRESH_LOCK_SECONDS,
      async () => {
        const fresh = await this.read(handle);
        if (fresh.kind !== 'record') return { resolved: fresh };
        if (!this.isDueForRefresh(fresh.value)) {
          return {
            resolved: {
              kind: 'session' as const,
              accessToken: fresh.value.accessToken,
              rotated: false,
            },
          };
        }

        const refreshToken = this.open(fresh.value.refreshSealed, handle);
        if (refreshToken === null) {
          // The envelope did not authenticate: a truncated value, the wrong key, or a
          // record copied from another handle. Redis answered, so this is `'absent'`
          // rather than `'unavailable'` — not recoverable, not retryable, and not the
          // browser's fault to fix. It signs in again.
          this.logger.error(
            { sessionId: fresh.value.sessionId },
            'session record could not be opened',
          );
          return { resolved: { kind: 'absent' as const } };
        }

        const issued = await this.sessions.rotate(refreshToken, client);
        await this.write(handle, issued);
        return {
          resolved: { kind: 'session' as const, accessToken: issued.accessToken, rotated: true },
        };
      },
    );

    if (outcome !== null) return outcome.resolved;

    if (stale.accessExpiresAt > Date.now()) {
      return { kind: 'session', accessToken: stale.accessToken, rotated: false };
    }

    return { kind: 'session', accessToken: await this.awaitHolder(handle), rotated: false };
  }

  /**
   * Wait for whoever holds the refresh lock to publish its result.
   *
   * ═══ WHY WAITING IS THE RIGHT ANSWER HERE ══════════════════════════════════
   *
   * Exactly one request may rotate, because the refresh token is one-use and
   * presenting it twice is what reuse detection is for. That makes the losers' problem
   * "learn the answer", not "get an answer of their own" — and the record the holder
   * writes IS the answer, so there is nothing to coordinate beyond noticing it appear.
   * No second lock, no new shared state.
   *
   * ─── The objection this design has to answer ───────────────────────────────
   *
   * A request thread waiting on another request is how a connection pool gets
   * exhausted. That is a real hazard and it is answered by the shape of the wait
   * rather than by refusing to wait:
   *
   *   bounded    `REFRESH_WAIT_MS` total, and strictly under the lock's own TTL — a
   *              relationship `assertSessionClocksAreCoherent` pins — so a waiter can
   *              never outlive the holder it is waiting for.
   *   backoff    a handful of reads across that window, not a spin.
   *   usually    the holder finishes in about a millisecond, so the FIRST check almost
   *   free       always finds the record already written. The extra reads are paid
   *              only in the rare slow case.
   *   rare       only reached when the waiter's OWN token has already expired, which
   *              is a narrow window inside the skew.
   *
   * Against that: the alternative is signing a user out mid-request because a
   * different request happened to be rotating.
   *
   * ─── What a returned token does and does not mean ──────────────────────────
   *
   * `accessExpiresAt > now` decides only WHICH token to present. It is not an
   * authorisation decision and must never be mistaken for one: every token this method
   * returns still goes through `verifyAccessToken` and then `assertLive`, which
   * re-checks revocation and the deadline against PostgreSQL. A session revoked while
   * the holder was rotating is refused there, not here.
   */
  private async awaitHolder(handle: string): Promise<string> {
    for (const delay of BACKOFF_MS) {
      const fresh = await this.read(handle);
      if (fresh.kind === 'record' && fresh.value.accessExpiresAt > Date.now()) {
        return fresh.value.accessToken;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const last = await this.read(handle);
    if (last.kind === 'record' && last.value.accessExpiresAt > Date.now()) {
      return last.value.accessToken;
    }

    // The holder crashed, or is wedged. NOT a 401: this session is very probably fine,
    // and the thing that failed is the coordination around it. Telling the client to
    // retry is honest; telling it to sign in again is not.
    this.logger.warn('refresh holder did not publish a result within the wait budget');
    throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
  }

  /** Within the skew of expiry, or already past it. */
  private isDueForRefresh(record: SessionRecord): boolean {
    return record.accessExpiresAt - Date.now() <= SESSION.ACCESS_REFRESH_SKEW_SECONDS * 1000;
  }

  // ─── storage ──────────────────────────────────────────────────────────────

  /**
   * ═══ THE TTL IS THE SESSION'S OWN DEADLINE, NOT A CONSTANT ═════════════════
   *
   * The record must not outlive the credential it describes, and it must not die
   * BEFORE it either — one direction leaves a dead handle sitting in an LRU cache for
   * a week, the other signs an active user out. `Session.expiresAt` is the only value
   * that satisfies both, and this is written on every rotation, so it is re-derived
   * roughly every fifteen minutes and tracks the sliding idle deadline.
   *
   * That safety depends on rotation being frequent relative to the idle window, which
   * it is by construction: `assertSessionClocksAreCoherent` requires the access token
   * to expire well inside the idle window, and every rotation rewrites this record
   * from a freshly computed `expiresAt`. Between two rotations, `touch` can push the
   * row's deadline further out than this TTL — but the next rotation catches up long
   * before the TTL is reached.
   *
   * The COOKIE is scoped differently, to `REMEMBER_ME_SECONDS`, and the asymmetry is
   * deliberate: the cookie is set once at sign-in and never re-set by a server-side
   * rotation, so scoping IT to the idle deadline would delete a live credential from a
   * continuously-active browser after one idle window. See `sessionCookie.issue`.
   *
   * Floored at one second so a record is always actually written — `EX 0` is rejected,
   * and a session this close to its deadline is about to be refused by `assertLive`
   * anyway.
   *
   * ═══ THE PUBLISH SEAM ══════════════════════════════════════════════════════
   *
   * On the refresh path this write happens AFTER `SessionService.rotate` has
   * committed, so by the time it runs the durable store has already moved on: the
   * parent generation is stamped, and its child is the family's tip. Nothing spans the
   * two stores, and nothing can — that would be a distributed transaction across a
   * cache whose whole purpose is to be disposable.
   *
   * So a failure here leaves the record naming the PARENT, holding a refresh token
   * PostgreSQL has already spent. That is a poison pill unless somebody deals with it:
   * the next request presents it, and reuse detection reads a second presentation of
   * one token as theft and revokes the family. One dropped cache write, and a healthy
   * session gone.
   *
   * The answer is not compensation — there is nothing safe to roll back, since the
   * rotation is the durable truth and the child is real. It is RECOVERY, on the retry,
   * derived from that truth: see `SessionService.recoverRotation` and
   * `SessionDbOperation.findRecoverableRotation`. Which is also why the refusal here
   * has to be honest about being an infrastructure failure — a client told "the store
   * is away, try again" behaves differently from one told "sign in again", and only
   * the first is true.
   */
  private async write(handle: string, issued: IssuedSession): Promise<void> {
    const record: SessionRecord = {
      sessionId: issued.sessionId,
      accessToken: issued.accessToken,
      accessExpiresAt: issued.accessExpiresAt.getTime(),
      refreshSealed: this.seal(issued.refreshToken, handle),
      // The session's deadline. `refreshExpiresAt` IS `Session.expiresAt` — the token
      // is signed to the row's expiry rather than to a constant, see
      // `SessionService.mint` — so this is the row's own clock and not a second
      // opinion about it.
      expiresAt: issued.refreshExpiresAt.getTime(),
    };

    const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));

    try {
      await this.cache.set(KEYS.bff.session(handle), JSON.stringify(record), ttlSeconds);
    } catch {
      // `CacheService.set` is fail-closed and throws `internal_error`, which is the
      // right shape for its other callers and the wrong one here: a 500 tells a client
      // this service is broken, when what happened is that Redis is away and the
      // request is worth retrying. Re-mapped once, at the only boundary that knows
      // which of the two it is. The original is not logged again — `set` already did.
      throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
    }
  }

  /**
   * The record, or which of the two ways there is not one.
   *
   * ─── An absent record and an unreachable Redis are different facts ────────
   *
   * A record that is not there means the session is over: the record's TTL is the
   * session's own deadline. A Redis that did not answer means nothing has been
   * learned. Collapsing them was a bug — see `Resolution` — so the distinction is
   * made here, once, at the only place that can still see it.
   *
   * `CacheService.get` is fail-closed and throws, which is what makes the difference
   * observable at all. A MALFORMED value is `'absent'` rather than `'unavailable'`:
   * Redis answered, and it is not a shape this ever wrote, so there is nothing to
   * salvage and nothing to retry.
   */
  private async read(
    handle: string,
  ): Promise<{ kind: 'record'; value: SessionRecord } | { kind: 'absent' } | { kind: 'unavailable' }> {
    let raw: string | null;
    try {
      raw = await this.cache.get(KEYS.bff.session(handle));
    } catch {
      // Already logged by `CacheService.get`.
      return { kind: 'unavailable' };
    }
    if (raw === null) return { kind: 'absent' };

    try {
      return { kind: 'record', value: JSON.parse(raw) as SessionRecord };
    } catch {
      this.logger.error('session record was not valid JSON');
      return { kind: 'absent' };
    }
  }

  // ─── the envelope ─────────────────────────────────────────────────────────

  /**
   * AES-256-GCM, bound to the handle.
   *
   * The handle is the AAD, which is what stops an envelope being MOVED: anyone who can
   * write to Redis could otherwise copy the record stored under one handle to another,
   * and the reader would decrypt it happily and hand a second browser the first user's
   * refresh token. With it, the tag covers the identity as well as the contents, so a
   * record found under a different key fails authentication.
   *
   * The RAW handle, note, not the tagged form the key uses. The reader holds the raw
   * value — it came out of the cookie — and binding to the raw secret rather than to
   * its public-ish fingerprint is strictly stronger.
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
   * Every failure — a truncated blob, a wrong tag, a record moved from another handle
   * — lands on the same null. No caller could act on the difference, and
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
