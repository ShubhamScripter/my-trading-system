import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../src/contracts';
import { ProblemException } from '../src/http';
import { RedisService } from './client';
import { redactKey } from './keys';

/**
 * Fixed-window counters and the small set of cached values the auth flow needs.
 *
 * Redis is not a source of truth here, so every method has to answer one
 * question: what happens when Redis is unreachable? EVERY method in this file
 * answers it explicitly — there is no method that lets an ioredis rejection
 * propagate, because an untyped throw escapes `ProblemJsonFilter` as a 500, which
 * tells a client to retry the same request rather than what to do instead.
 *
 * Three answers are in use, and which one a method gets is not a style choice:
 *
 *   parameterised   `consume` and `set` take `OnCacheError`, because the same
 *                   method serves call sites whose correct answer is opposite.
 *                   Required rather than defaulted, so a new call site has to
 *                   decide rather than inherit.
 *   fail-closed     `take` returns null, which every one of its four callers
 *                   already turns into its own typed refusal. Null rather than a
 *                   throw keeps that answer specific — `reauth_required` or
 *                   `passkey_challenge_invalid` rather than a bare 500.
 *   fail-open       `increment`, `refund`, `clear`, `cooldownRemaining`, `setFlag`.
 *                   Losing any of these costs enforcement, never correctness, and
 *                   a counter we could not write must not be able to penalise
 *                   anyone.
 *
 * `flag` is the deliberate exception to all three: it is three-valued, because its
 * caller — the session-revocation check — must NOT read an unreachable cache as
 * "not revoked" and has a database to fall through to.
 *
 * One caveat on `setFlag`'s place in that list, because it is the only fail-open
 * write whose key is later read as a security decision: a lost write costs nothing
 * ONLY while every reader treats a missing flag as no evidence at all. That is not
 * self-evident the way a dropped rate-limit counter is. See `setFlag`.
 */

export type OnCacheError =
  /**
   * Deny the request. Correct where the limit protects something expensive or
   * abusable that has no other backstop — sending email, in practice. A cache
   * outage degrades sign-in; it does not become an open email relay.
   */
  | 'deny'
  /**
   * Allow the request. Correct only where a durable second line of defence
   * exists. Login uses this because `AdminCredential.failedAttempts` /
   * `lockedUntil` live in Postgres and keep enforcing lockout with Redis
   * completely down.
   */
  | 'allow'
  /**
   * Refuse with `session_store_unavailable` (503) rather than `rate_limited` (429).
   *
   * ═══ WHY A THIRD POSTURE AND NOT JUST 'deny' ═══════════════════════════════
   *
   * `'deny'` and this one agree on the DECISION — refuse — and differ on what the
   * refusal means, which is the whole point. `'deny'` says "you have spent your
   * allowance", and every original caller of it was a rate limit or a single-use
   * credential where that reading is close enough to be actionable.
   *
   * The BFF session record is neither. When its write fails, the caller has not
   * exceeded anything: the session store was briefly unreachable, on a request that
   * is perfectly retryable, and the two conditions call for different client
   * behaviour. Worse, it was the ONE refresh-path Redis failure not already mapped to
   * `session_store_unavailable` — `LockService` and the refresh waiter both use it —
   * so one outage produced 429 for the holder and 503 for everyone waiting on it.
   *
   * `RATE_LIMITED` is also, by accident, absent from `DEAD_SESSION_TYPES`, which is
   * where `session_store_unavailable` is absent BY DESIGN. Borrowing the wrong slug
   * therefore broke logout through `OptionalAuthGuard` as well.
   */
  | 'unavailable';

export interface RateLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger('Cache');

  constructor(private readonly redis: RedisService) {}

  /**
   * Increment `key`'s counter and throw `rate_limited` once it exceeds `limit`.
   *
   * INCR then EXPIRE-if-new, in one pipeline. The window is anchored to the first
   * hit rather than to a wall-clock boundary, so a caller cannot get 2×`limit`
   * requests through by straddling a boundary.
   */
  async consume(key: string, rule: RateLimit, onError: OnCacheError): Promise<void> {
    let count: number;
    try {
      const replies = await this.redis
        .multi()
        .incr(key)
        .expire(key, rule.windowSeconds, 'NX')
        .exec();

      // `exec` resolves with an `[error, value]` pair per command and rejects only
      // when the whole transaction fails. Reading `value` without its error slot
      // turns a command-level failure — a WRONGTYPE from a key collision, say —
      // into `Number(null)`, which is 0, which is under every limit. The request
      // would then pass unlimited and unlogged, including at the `deny` call sites
      // that gate outbound email. Surfacing the error routes it to the catch
      // below, where `onError` actually gets to decide.
      const incr = replies?.[0];
      if (incr === undefined) throw new Error('redis returned no reply for INCR');
      const [incrErr, incrValue] = incr;
      if (incrErr !== null) throw incrErr;

      count = Number(incrValue);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, `rate limit unavailable, failing ${onError}`);
      if (onError === 'deny') {
        throw new ProblemException({
          type: ERR.RATE_LIMITED,
          detail: 'Service temporarily unavailable. Please try again shortly.',
          retryAfterSeconds: 30,
        });
      }
      return;
    }

    if (count > rule.limit) {
      const ttl = await this.ttl(key);
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
      });
    }
  }

  /**
   * Increment a counter and return its new value, WITHOUT judging it.
   *
   * The deliberate split from `consume`, which increments and enforces in one
   * step. That fusion is right when every request costs a token and the only
   * outcome is pass or 429. It is wrong when the caller has to decide — when only
   * some outcomes count, or when exceeding the limit means something other than
   * throwing. The captcha penalty needs both: only a rejected token counts, and
   * tripping the limit starts an escalating block rather than a flat refusal.
   *
   * Returns 0 when Redis is unreachable, which reads as "no failures recorded" —
   * the fail-open direction. A counter we could not write must not be able to
   * penalise anyone.
   */
  async increment(key: string, windowSeconds: number): Promise<number> {
    try {
      const [incr] = await this.redis
        .multi()
        .incr(key)
        .expire(key, windowSeconds, 'NX')
        .exec()
        .then((r) => (r ?? []).map(([, value]) => value));
      return Number(incr);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'counter increment failed');
      return 0;
    }
  }

  /**
   * Give back one unit of a counter consumed by `consume`.
   *
   * For the case where the limit correctly gated an action that then failed on
   * our side — an OTP whose email SMTP would not take. The check has to happen
   * before the attempt to gate it at all, so the only honest correction after the
   * fact is a refund.
   *
   * Deliberately does NOT recreate an expired key: `DECR` on a missing key would
   * spring it back to -1 with no TTL, and that key would then sit at a negative
   * count until something else expired it — silently granting unlimited attempts.
   * A window that has already closed needs no refund.
   *
   * Fails open by logging, like `clear`: a lost refund costs the admin one send
   * from their budget, which is the direction that cannot be abused.
   */
  async refund(key: string): Promise<void> {
    try {
      if ((await this.redis.exists(key)) !== 1) return;
      await this.redis.decr(key);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'counter refund failed');
    }
  }

  /** Drop a key. What lets a success wipe a failure streak. */
  async clear(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      // Losing this costs the user the rest of their window; it never costs
      // correctness, because the key expires on its own regardless.
      this.logger.error({ err, key: redactKey(key) }, 'counter clear failed');
    }
  }

  /**
   * Seconds remaining before `key` may be used again, or 0 if it is free now.
   * Used for the resend cooldown, which needs to *report* the wait rather than
   * just refuse.
   */
  async cooldownRemaining(key: string): Promise<number> {
    try {
      const ttl = await this.redis.ttl(key);
      return ttl > 0 ? ttl : 0;
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'cooldown read failed');
      return 0;
    }
  }

  /** Start a cooldown. Returns false when one was already running. */
  async startCooldown(key: string, seconds: number): Promise<boolean> {
    try {
      return (await this.redis.set(key, '1', 'EX', seconds, 'NX')) === 'OK';
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'cooldown write failed');
      return true;
    }
  }

  /**
   * Store `value` under `key` for `ttlSeconds`.
   *
   * `onError` is required, not defaulted, and that is the point: this method stores
   * WebAuthn challenges and elevation tickets as well as captcha penalties, and the
   * right answer to a failed write is opposite in those two cases. A default would
   * silently pick one of them for every future call site.
   *
   * `'deny'` throws. Correct for anything single-use the caller is about to hand
   * out: a challenge or ticket that was never stored cannot be verified, so the
   * caller would be issuing a credential guaranteed to fail. Better to refuse now
   * with a typed error than to look successful and refuse a second later.
   *
   * `'allow'` logs and continues. Correct only where a lost write costs
   * enforcement rather than correctness — the captcha penalty, whose real defence
   * is the provider check.
   *
   * `'unavailable'` throws too, with the store-unavailable slug instead of the rate
   * limit one. Correct where the failed write is infrastructure rather than a budget
   * — the BFF session record. See the union's own note.
   */
  async set(key: string, value: string, ttlSeconds: number, onError: OnCacheError): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, `cache write failed, failing ${onError}`);
      if (onError === 'unavailable') {
        // Not a rate limit and not a session ending: the store is away. 503, and a
        // slug the refresh path already uses for its other two Redis failures.
        throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
      }
      if (onError === 'deny') {
        throw new ProblemException({
          type: ERR.RATE_LIMITED,
          detail: 'Service temporarily unavailable. Please try again shortly.',
          retryAfterSeconds: 30,
        });
      }
    }
  }

  /**
   * Read a value, or null if it is absent OR unreadable.
   *
   * The two are conflated on purpose. Every current reader of a cached value treats
   * absence as "no such thing" and fails closed on it, so an unreachable cache
   * reaching them as null lands in the same branch. A reader that needs to tell the
   * two apart should use the three-valued `flag` below instead — that is what it
   * exists for.
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'cache read failed');
      return null;
    }
  }

  /**
   * Read and delete ATOMICALLY, in one Redis command.
   *
   * `GETDEL`, not `GET` followed by `DEL`, and the difference is the whole
   * security property. Two concurrent callers issuing GET-then-DEL both read the
   * value before either deletes it, so both succeed — which makes "single-use"
   * true only of callers that happen not to overlap. `GETDEL` is one command, so
   * exactly one caller receives the value and every other receives null.
   *
   * That is what makes a WebAuthn challenge single-use, and what makes an
   * elevation ticket one proof for one write: the value is consumed by the act of
   * reading it, so a replayed assertion finds nothing to verify against even if it
   * arrives microseconds later.
   *
   * Requires Redis 6.2+. docker-compose.yml pins redis:7-alpine.
   *
   * Returns null when Redis is unreachable, which REFUSES the caller. All four
   * call sites turn null into a typed refusal of their own — `reauth_required` in
   * src/2fa/elevation.ts, `passkey_challenge_invalid` via `parseChallenge` in the
   * other three — so failing closed here needs no error slug of its own and does
   * not cost the caller its specific answer.
   */
  async take(key: string): Promise<string | null> {
    try {
      return await this.redis.getdel(key);
    } catch (err) {
      // Fail-closed on purpose. Every caller of `take` is spending a single-use
      // security credential, and a cache we cannot reach must not be read as
      // "the credential was valid".
      this.logger.error({ err, key: redactKey(key) }, 'take failed; refusing the caller');
      return null;
    }
  }

  /**
   * Three-valued: `true`/`false` when Redis answered, `null` when it could not.
   *
   * Only `true` is load-bearing. The revocation check treats `false` and `null`
   * identically — both fall through to PostgreSQL — because an absent key means
   * "no flag was read", which is not the same as "no revocation exists": the
   * write that would have set it fails open (see `setFlag`). The distinction is
   * kept anyway because it is real and cheap, and because collapsing it to a
   * boolean would invite the next reader to trust a `false`.
   */
  async flag(key: string): Promise<boolean | null> {
    try {
      return (await this.redis.exists(key)) === 1;
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'flag read failed');
      return null;
    }
  }

  /**
   * Set a flag for `ttlSeconds`. Fails open, and that is only safe because of how
   * the flag is read.
   *
   * Swallowing the error is right: the sole caller is `cacheRevocations`, running
   * after PostgreSQL has already committed the revocation, so there is nothing to
   * roll back and throwing would only turn a committed logout into a 500.
   *
   * The corollary is binding on the reader, not on this method — a flag that may
   * silently not exist can only ever be evidence *for* revocation, never against
   * it. `SessionService.assertLive` is where that is enforced; this comment used
   * to claim "the database is the authority" while the read path returned early on
   * a negative flag and never asked it.
   *
   * ─── `value` is a LABEL, never the decision ───────────────────────────────
   *
   * It defaults to `'1'`, which is what every flag was before, and the DECISION is
   * still the key's existence — `flag` reads `EXISTS` and nothing else. The sole
   * caller that passes one is `cacheRevocations`, which stores the revoke reason so
   * `assertLive` can say whether one session ended or all of them without falling
   * through to Postgres and losing the fast path. A reader that acted on the value's
   * absence rather than the key's would be reintroducing exactly the bug the
   * three-valued `flag` above exists to prevent.
   */
  async setFlag(key: string, ttlSeconds: number, value = '1'): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'flag write failed');
    }
  }

  private async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch {
      return 0;
    }
  }
}
