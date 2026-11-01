import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../src/contracts';
import { ProblemException } from '../src/http';
import { RedisService } from './client';

/**
 * Fixed-window counters and the small set of cached flags the auth flow needs.
 *
 * Redis is not a source of truth here, so every method has to answer one
 * question: what happens when Redis is unreachable? The answer differs per call
 * site, and it is a parameter rather than a global policy — see `OnCacheError`.
 */

export type OnCacheError =
  /**
   * Deny the request. Correct where the limit protects something expensive or
   * abusable that has no other backstop — sending email, in practice. A cache
   * outage degrades signup; it does not become an open email relay.
   */
  | 'deny'
  /**
   * Allow the request. Correct only where a durable second line of defence
   * exists. Login uses this because `Credential.failedAttempts` / `lockedUntil`
   * live in Postgres and keep enforcing lockout with Redis completely down.
   */
  | 'allow';

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
      this.logger.error({ err, key }, `rate limit unavailable, failing ${onError}`);
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
      // WHICH budget refused, the way `QuotaService.consumeAll` already reports its
      // own. Without this a 429 reaches the log as nothing but `type: rate_limited`
      // and a URL — and one URL can sit behind several buckets, so the line names
      // neither the limit that was hit nor the one to raise. Two `POST
      // /settings/security/email` refusals, one for `start` and one for `resend`, are
      // indistinguishable in the log and were not in the code.
      //
      // The key is safe to log: every identifier inside it is HMAC-tagged by `tag()`
      // in redis/keys.ts, so this names a bucket without naming an account.
      this.logger.warn(
        { key, limit: rule.limit, windowSeconds: rule.windowSeconds, count, retryAfterSeconds: ttl },
        'rate limit exceeded',
      );
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
   *
   * ─── That 0 has to be REACHED, not arrived at by arithmetic ─────────────────
   *
   * The fail-open contract above is the documented behaviour, and it is only sound
   * when the failure goes through the `catch` below — which is what logs it. This
   * method used to read the replies as `.map(([, value]) => value)`, discarding
   * ioredis's per-command error slot, and so produced the same 0 by accident:
   *
   *   `[[Error('WRONGTYPE'), null], [null, 1]]`  →  `null`  →  `Number(null)` = 0
   *
   * Identical return, nothing logged, and `catch` never entered. A key collision or
   * a Redis command error then read as "this IP has no captcha failures", so
   * `CaptchaService.recordFailure` returned early every time: the penalty ladder
   * stopped running and the siteverify quota it protects stopped being protected,
   * with no error anywhere to say so.
   *
   * The dropped-transaction case was worse than silent. `exec()` resolves with
   * `null`, `(r ?? [])` made that an empty array, and the missing first element
   * became `Number(undefined)` — `NaN`. `NaN < limit` is FALSE, so that path did not
   * return early: it walked into `BLOCK_LADDER_SECONDS[NaN]`, which is `undefined`,
   * and set the block key with an undefined TTL. A Redis hiccup could therefore
   * mint a permanent IP block out of nothing.
   *
   * So every value here is extracted only after its error slot has been checked, and
   * the result is verified to be a number before it leaves. See `consume` above,
   * which has always done this and carries the longer note on why.
   */
  async increment(key: string, windowSeconds: number): Promise<number> {
    try {
      const replies = await this.redis
        .multi()
        .incr(key)
        .expire(key, windowSeconds, 'NX')
        .exec();

      // `exec` resolves with `null` when the transaction did not run at all. That is a
      // failure, not an empty result, and it must not be flattened into one.
      if (replies === null) throw new Error('redis dropped the counter transaction');

      // EVERY slot, not just INCR's. `consume` only needs the counter, but a failed
      // EXPIRE here would leave the captcha counter with no TTL at all — a key that
      // accumulates forever and never resets the ladder. Checked in a loop rather than
      // per-command so that adding a command to this pipeline cannot reintroduce a
      // silently-dropped error.
      for (const [commandErr] of replies) {
        if (commandErr !== null) throw commandErr;
      }

      const incr = replies[0];
      if (incr === undefined) throw new Error('redis returned no reply for INCR');

      const count = Number(incr[1]);
      // The last gate on the `NaN` path. The checks above close every route this
      // method can currently produce one by, and this makes the guarantee total: the
      // caller indexes an array with what it gets back, so "a number, or the
      // documented 0" has to hold no matter what a reply ever contains.
      if (!Number.isFinite(count)) throw new Error('redis returned a non-numeric counter');

      return count;
    } catch (err) {
      this.logger.error({ err, key }, 'counter increment failed');
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
   * Fails open by logging, like `clear`: a lost refund costs the user one send
   * from their budget, which is the direction that cannot be abused.
   */
  async refund(key: string): Promise<void> {
    try {
      await this.refundOrThrow(key);
    } catch (err) {
      this.logger.error({ err, key }, 'counter refund failed');
    }
  }

  /**
   * `refund`, but it reports a failure instead of swallowing it.
   *
   * For `MailUndoRegistry` and nothing else. Compensations are retried until they
   * settle, and a caller cannot retry what it was told succeeded — the swallowing
   * version made a Redis-down refund log `'undelivered mail compensated'` while
   * nothing had been given back, which is worse than a loud failure because it looks
   * like a fix.
   *
   * Every other caller keeps `refund`'s fail-open behaviour, which is right for them:
   * they have nowhere to retry to, and a lost refund costs one send from a budget
   * that expires on its own.
   */
  async refundOrThrow(key: string): Promise<void> {
    if ((await this.redis.exists(key)) !== 1) return;
    await this.redis.decr(key);
  }

  /**
   * Push a key's expiry out to `seconds` from now, unconditionally.
   *
   * The counterpart to the `EXPIRE ... NX` that `increment` uses. That one anchors a
   * key's lifetime to its FIRST write, which is right for a fixed window — the window
   * has to end somewhere, or it is not a window.
   *
   * It is wrong for a memory. The CAPTCHA strike counter is the escalation ladder's
   * record of how many times an IP has offended, and anchoring it to the first strike
   * meant it expired a fixed period after that strike however many followed. A caller
   * pacing themselves just under the window started every campaign at rung one, so
   * the ladder never climbed. Sliding the TTL on each new strike is what makes
   * "twelve hours from the newest offence" mean what it says.
   *
   * Fails open by logging: a TTL we could not extend costs a strike's memory, and the
   * key expires on its own regardless.
   */
  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.redis.expire(key, seconds);
    } catch (err) {
      this.logger.error({ err, key }, 'expiry refresh failed');
    }
  }

  /** Drop a key. What lets a success wipe a failure streak. */
  async clear(key: string): Promise<void> {
    try {
      await this.clearOrThrow(key);
    } catch (err) {
      // Losing this costs the user the rest of their window; it never costs
      // correctness, because the key expires on its own regardless.
      this.logger.error({ err, key }, 'counter clear failed');
    }
  }

  /** `clear`, reporting failure rather than swallowing it. See `refundOrThrow` for
   *  why the compensation path needs to know. */
  async clearOrThrow(key: string): Promise<void> {
    await this.redis.del(key);
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
      this.logger.error({ err, key }, 'cooldown read failed');
      return 0;
    }
  }

  /** Start a cooldown. Returns false when one was already running. */
  async startCooldown(key: string, seconds: number): Promise<boolean> {
    try {
      return (await this.redis.set(key, '1', 'EX', seconds, 'NX')) === 'OK';
    } catch (err) {
      this.logger.error({ err, key }, 'cooldown write failed');
      return true;
    }
  }

  /**
   * ─── the three fail-closed methods ────────────────────────────────────────
   *
   * `set`, `get` and `take` are the OAuth flow's storage, and they are the only
   * methods here that refuse rather than degrade. The reason is that their return
   * value is indistinguishable from a legitimate answer: a swallowed `get`
   * failure reads as "no such key", which on this path means "that `state` was
   * never issued" — a security conclusion drawn from an infrastructure fault.
   *
   * Callers that genuinely want the fail-open direction must say so at the call
   * site, as `CaptchaService.recordFailure` does for its penalty write.
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.error({ err, key }, 'cache write failed');
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
  }

  /**
   * Store a short-lived ceremony marker only when no ceremony is already live.
   *
   * This is deliberately separate from `set`: callers must make the exclusivity
   * decision explicit, rather than accidentally replacing another browser's
   * security ceremony.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (err) {
      this.logger.error({ err, key }, 'exclusive cache write failed');
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
  }

  /** Delete an exclusive marker only when it still belongs to its creator. */
  async clearIfValue(key: string, value: string): Promise<void> {
    try {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        key,
        value,
      );
    } catch (err) {
      // Leaving a short-lived marker is safe: it refuses a duplicate ceremony until
      // expiry, while deleting a newer owner's marker would be unsafe.
      this.logger.error({ err, key }, 'exclusive cache clear failed');
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.error({ err, key }, 'cache read failed');
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
  }

  /**
   * Read and delete atomically — what makes an OAuth `state` single-use.
   *
   * GETDEL, not GET-then-DEL. The two-command version let concurrent callers all
   * read the value before any of them deleted it, so "single-use" held only in the
   * absence of a race — which is precisely the condition an attacker controls.
   */
  async take(key: string): Promise<string | null> {
    try {
      return await this.redis.getdel(key);
    } catch (err) {
      this.logger.error({ err, key }, 'cache take failed');
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
  }

  /**
   * Three-valued on purpose: `true`/`false` when Redis answered, `null` when it
   * could not. Session guards may reject on `true`, but must fall through to the
   * database for `false` and `null`; neither proves a session is still live.
   */
  async flag(key: string): Promise<boolean | null> {
    try {
      return (await this.redis.exists(key)) === 1;
    } catch (err) {
      this.logger.error({ err, key }, 'flag read failed');
      return null;
    }
  }

  /**
   * `value` is a note the flag carries, never part of the decision.
   *
   * The DECISION is always the key's existence, which is what `flag` reads and what
   * makes the deny-only contract above sound. This exists because one reader wants a
   * detail alongside it: `cacheRevocations` stores the revoke reason, so `assertLive`
   * can tell "one session ended" from "all of them" on the fast path without asking
   * Postgres — which would undo the whole point of having a fast path.
   *
   * A reader of the value must degrade gracefully when it is absent or unrecognised,
   * because this write is fail-OPEN and because `'1'` is what every other flag holds.
   * Anything that cannot degrade belongs in `set`, which reports its failures.
   */
  async setFlag(key: string, ttlSeconds: number, value = '1'): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      // Losing this write costs a database read on the next request; it never
      // costs correctness, because the database is the authority.
      this.logger.error({ err, key }, 'flag write failed');
    }
  }

  /**
   * ─── the read-through hash ────────────────────────────────────────────────
   *
   * One key holding a whole lookup table, read a few fields at a time. Built for
   * the email blocklist: eight thousand rules that every signup and every login
   * queries, and that change only when an operator adds one.
   *
   * Fail-OPEN in the specific sense that matters here — every method degrades to
   * "I do not know", never to "no match". The caller then asks Postgres, which is
   * the authority. That is the opposite direction from `get`/`take` above, and for
   * the opposite reason: a swallowed failure there fabricates a security
   * conclusion, whereas here it costs a database round trip the service was making
   * anyway before this cache existed.
   */

  /**
   * Read several fields at once, or `null` if the table is not cached.
   *
   * `null` and "a table with no matches" are deliberately different returns. A
   * missing key means the cache has never been built, or was invalidated, and the
   * caller must go to the database; an empty array of matches means the cache IS
   * built and genuinely holds none of these values. Collapsing the two would make a
   * cold cache read as "nothing is blocked".
   */
  async hashFields(key: string, fields: readonly string[]): Promise<(string | null)[] | null> {
    if (fields.length === 0) return [];
    try {
      // `EXISTS` and `HMGET` pipelined: `HMGET` on a missing key returns all nulls,
      // which is indistinguishable from a populated table holding none of them.
      const [existsResult, valuesResult] = (await this.redis
        .pipeline()
        .exists(key)
        .hmget(key, ...fields)
        .exec()) as [[Error | null, number], [Error | null, (string | null)[]]];

      if (existsResult[0] !== null || valuesResult[0] !== null) return null;
      if (existsResult[1] !== 1) return null;
      return valuesResult[1];
    } catch (err) {
      this.logger.error({ err, key }, 'hash read failed');
      return null;
    }
  }

  /**
   * Replace a whole table in one command.
   *
   * `HSET` with every field is atomic, which is what lets `hashFields` treat "the
   * key exists" as "the table is complete" — there is no window in which a reader
   * sees a half-built hash. The delete-then-write is pipelined for the same reason:
   * a stale field left behind by a rule an operator REMOVED would keep blocking an
   * address that is no longer on the list.
   *
   * A TTL as well as explicit invalidation. Invalidation is what keeps this fresh;
   * the TTL is what bounds the damage if an invalidation is ever missed — a bug
   * then costs hours of staleness rather than until the next deploy.
   */
  async setHash(
    key: string,
    entries: ReadonlyMap<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const pipeline = this.redis.pipeline().del(key);
      if (entries.size > 0) {
        pipeline.hset(key, Object.fromEntries(entries));
        pipeline.expire(key, ttlSeconds);
      }
      await pipeline.exec();
    } catch (err) {
      // Losing this costs a database read per request until it succeeds. It never
      // costs correctness — the database is the authority.
      this.logger.error({ err, key }, 'hash write failed');
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
