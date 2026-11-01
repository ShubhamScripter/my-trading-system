import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ERR } from '../src/contracts';
import { ProblemException } from '../src/http';
import type { OnCacheError, RateLimit } from './cache';
import { DurableRedisQuotaService, RedisService } from './client';

/**
 * ═══ ROLLING-WINDOW QUOTAS ══════════════════════════════════════════════════
 *
 * The companion to `CacheService.consume`, not a replacement for it. That one is a
 * fixed-window `INCR` and it is the right tool for a request-flood ceiling: cheap,
 * one counter, and nobody cares that the boundary is approximate when the thing
 * being bounded is "calls to an endpoint".
 *
 * This exists for the quotas where the boundary IS the vulnerability.
 *
 * ─── Why rolling, and what a fixed window actually costs ────────────────────
 *
 * A fixed window anchored at the first hit admits `2 × limit` requests across a
 * boundary: spend the whole budget in the last second of one window, then the whole
 * budget again in the first second of the next. For a login-attempt ceiling that is
 * a rounding error. For "OTP emails per recipient per day" it is double the mail
 * bill and double the inbox flood, which is the abuse the quota was written to stop.
 * A sliding log has no boundary to straddle — the window moves with the clock, so
 * the limit means what it says at every instant.
 *
 * ─── Why the log rather than a counter ──────────────────────────────────────
 *
 * A sorted set costs more than an integer: one member per charge, held for the
 * window. At the cardinality here — a handful of sends per recipient per day — that
 * is a few dozen bytes, and it buys two properties a counter cannot offer.
 *
 * The first is an honest `Retry-After`. A counter knows only "you are over"; the log
 * knows exactly when the oldest charge falls out of the window, so the refusal
 * reports the real wait rather than the nominal window rounded up. That is the
 * difference between a client that retries once and a client that retries early,
 * gets refused again, and calls it a retry storm.
 *
 * The second is a refund that cannot be abused. See `refund`.
 *
 * ─── Why one script rather than one call per quota ──────────────────────────
 *
 * Because "5 per hour AND 20 per day" is one decision, not two, and running it as
 * two round trips makes it two. The failure is not hypothetical: a caller at 4/hour
 * and 20/day sends two concurrent requests, both pass the hourly check, both are
 * charged, and the daily quota then refuses one — leaving it charged for a send that
 * never happened. `consumeAll` checks every quota before charging any of them, so
 * the outcome is all or nothing and there is nothing to compensate.
 */

/** One quota to check and charge. `key` comes from `KEYS`, never built inline. */
export interface QuotaEntry {
  readonly key: string;
  readonly rule: RateLimit;
}

/**
 * A charge that succeeded, and the handle needed to give it back.
 *
 * `token` is the sorted-set member every entry was charged under. Holding it is the
 * whole refund protocol — see `refund`.
 */
export interface QuotaCharge {
  readonly token: string;
  readonly keys: readonly string[];
}

/**
 * Which instance holds a quota.
 *
 * Not a detail — it is the difference between a quota that survives a Redis restart
 * and one that does not, and the policy assigns it per quota rather than globally.
 *
 *  `burst`    the cache instance. Request and failure counters, where losing the
 *             window to an eviction costs one caller a few extra attempts.
 *  `durable`  the queue's instance, which runs with persistence on and no eviction
 *             policy. Everything whose loss has a COST attached: email budgets,
 *             where a flush would otherwise hand every address a fresh allowance.
 *
 * ─── Why a whole call shares one store ──────────────────────────────────────
 *
 * A Lua script is atomic within one Redis instance and there is no such thing as an
 * atomic script across two. So the atomicity `consumeAll` promises can only hold if
 * every entry in the call lives on the same instance — which means the short and
 * daily halves of one budget must be stored together. They are, on `durable`: they
 * are two views of the same cost, and splitting them across instances to satisfy a
 * storage table would forfeit the property that makes them correct.
 */
export type QuotaStore = 'burst' | 'durable';

/**
 * Check every quota, then charge every quota — or charge none.
 *
 * KEYS  the quota keys, in the caller's order.
 * ARGV  [1] now in epoch ms, [2] the member to charge under, then per key a
 *       `limit` and a `windowMs` pair in the same order as KEYS.
 *
 * Returns `{ blockedIndex, retryAfterMs }`. `blockedIndex` is 1-based so `0` can
 * mean "nothing blocked" without colliding with a real entry.
 *
 * `ZREMRANGEBYSCORE` in the check pass is a write, and deliberately a safe one: it
 * only drops members that have already aged out of the window, so it can refuse a
 * request but never grant one. That is what lets the check pass run before any
 * decision has been made without weakening the all-or-nothing guarantee.
 */
const CONSUME_ALL = `
local now = tonumber(ARGV[1])
local member = ARGV[2]

-- Pass 1: trim and test. Nothing here grants a slot.
for i = 1, #KEYS do
  local limit = tonumber(ARGV[2 + (i - 1) * 2 + 1])
  local windowMs = tonumber(ARGV[2 + (i - 1) * 2 + 2])

  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - windowMs)

  if redis.call('ZCARD', KEYS[i]) >= limit then
    -- The oldest surviving charge is the one whose expiry frees a slot.
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retryMs = 0
    if oldest[2] ~= nil then
      retryMs = (tonumber(oldest[2]) + windowMs) - now
      if retryMs < 0 then retryMs = 0 end
    end
    return { i, retryMs }
  end
end

-- Pass 2: every quota had room, so all of them pay.
for i = 1, #KEYS do
  local windowMs = tonumber(ARGV[2 + (i - 1) * 2 + 2])
  redis.call('ZADD', KEYS[i], now, member)
  -- The newest member is the last to age out, so the key must outlive it.
  redis.call('PEXPIRE', KEYS[i], windowMs)
end

return { 0, 0 }
`;

/**
 * Give back one charge, everywhere it was made.
 *
 * `ZREM` of a member that is not there is a no-op, which is the entire reason this
 * is safe to call twice. See `QuotaService.refund`.
 */
const REFUND_ALL = `
for i = 1, #KEYS do
  redis.call('ZREM', KEYS[i], ARGV[1])
end
return 1
`;

/** The two scripts, once `defineCommand` has attached them to a connection. */
interface QuotaCommands {
  quotaConsumeAll(...args: (string | number)[]): Promise<[number, number]>;
  quotaRefundAll(...args: (string | number)[]): Promise<number>;
}

type QuotaRedis = Redis & QuotaCommands;

@Injectable()
export class QuotaService {
  private readonly logger = new Logger('Quota');

  private readonly burst: QuotaRedis;
  private readonly durable: QuotaRedis;

  /**
   * `DurableRedisQuotaService`, NOT `DurableRedisService` — the same instance over a
   * different socket. The queue's connection never gives up on a command, which is
   * right for a message and wrong here: with retries unbounded, a durable-Redis outage
   * left the HTTP caller waiting on a command that would never reject, so the
   * `deny`-on-error branch below could not run. The bounded connection makes the
   * failure reachable. It also keeps these calls out of the pipeline behind the mail
   * worker's parked blocking read.
   */
  constructor(cache: RedisService, durable: DurableRedisQuotaService) {
    this.burst = attach(cache);
    this.durable = attach(durable);
  }

  /**
   * Charge every quota in `entries`, atomically, or refuse without charging any.
   *
   * Returns a `QuotaCharge` the caller keeps only if it may need to hand the charge
   * back. Throws `rate_limited` with a `Retry-After` read from the blocking quota's
   * own oldest entry — the honest wait, not the window length.
   *
   * `onError` follows the same convention as `CacheService.consume`, and for the
   * same reason: `deny` where the quota is the only thing standing between a caller
   * and an expense (outbound mail), `allow` where Postgres is still enforcing
   * something underneath.
   */
  async consumeAll(
    entries: readonly QuotaEntry[],
    store: QuotaStore,
    onError: OnCacheError,
  ): Promise<QuotaCharge> {
    const token = randomBytes(16).toString('base64url');
    if (entries.length === 0) return { token, keys: [] };

    const keys = entries.map((entry) => entry.key);
    const args: (string | number)[] = [Date.now(), token];
    for (const entry of entries) {
      args.push(entry.rule.limit, entry.rule.windowSeconds * 1000);
    }

    let blockedIndex: number;
    let retryAfterMs: number;
    try {
      [blockedIndex, retryAfterMs] = await this.connection(store).quotaConsumeAll(
        keys.length,
        ...keys,
        ...args,
      );
    } catch (err) {
      this.logger.error({ err, keys, store }, `quota unavailable, failing ${onError}`);
      if (onError === 'deny') {
        throw new ProblemException({
          type: ERR.RATE_LIMITED,
          detail: 'Service temporarily unavailable. Please try again shortly.',
          retryAfterSeconds: 30,
        });
      }
      // Nothing was charged, so the token names no member anywhere. A refund with it
      // is a no-op, which is what makes the allow path safe to return from here.
      return { token, keys: [] };
    }

    if (blockedIndex > 0) {
      const blocked = entries[blockedIndex - 1];
      this.logger.warn(
        { key: blocked?.key, limit: blocked?.rule.limit, store },
        'quota exceeded',
      );
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        // Always at least a second: a sub-second `Retry-After` rounds to 0, which
        // reads as "retry immediately" and produces exactly the storm it should
        // prevent.
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      });
    }

    return { token, keys };
  }

  /**
   * Hand back a charge for something that did not happen.
   *
   * ─── Why this one is safe and a counter's refund is not ────────────────────
   *
   * A refund against a counter is `DECR`, and `DECR` is not idempotent: run it twice
   * for one failed send and the caller is a slot better off than if the send had
   * never been attempted. That turns a compensation into a way to mint quota, which
   * is precisely the abuse a refund path invites — fail a send deliberately, collect
   * two slots back.
   *
   * Here the refund is `ZREM` of the exact member the charge added. Removing it
   * twice removes it once, because the second call finds nothing to remove. The
   * guarantee is a property of the data structure rather than a rule this code has
   * to remember, and it holds no matter how many times a retry or a duplicated
   * compensation runs.
   *
   * Never throws. A refund is already the unhappy path, and failing it must not
   * replace one problem with a 500 — the charge simply stands, which costs the
   * caller a slot and cannot be exploited.
   */
  async refund(charge: QuotaCharge, store: QuotaStore): Promise<void> {
    try {
      await this.refundOrThrow(charge, store);
    } catch (err) {
      this.logger.error({ err, keys: charge.keys, store }, 'quota refund failed');
    }
  }

  /**
   * `refund`, but it reports a failure instead of swallowing it.
   *
   * For `MailUndoRegistry` and nothing else. Compensations are now retried until they
   * settle, and a caller cannot retry what it was told succeeded — the swallowing
   * version made a Redis-down refund report success while nothing had been given back.
   *
   * Safe to call repeatedly for the reason above: `ZREM` of a named member is
   * idempotent, so a retried compensation cannot over-refund.
   */
  async refundOrThrow(charge: QuotaCharge, store: QuotaStore): Promise<void> {
    if (charge.keys.length === 0) return;
    await this.connection(store).quotaRefundAll(charge.keys.length, ...charge.keys, charge.token);
  }

  /**
   * How many charges are live in `key`'s window right now.
   *
   * For metrics and for the diagnostics the policy asks for on the shared-IP
   * registration limit — not for enforcement, which must go through `consumeAll` so
   * the check and the charge cannot separate.
   */
  async used(key: string, rule: RateLimit, store: QuotaStore): Promise<number> {
    try {
      const connection = this.connection(store);
      await connection.zremrangebyscore(key, '-inf', Date.now() - rule.windowSeconds * 1000);
      return await connection.zcard(key);
    } catch (err) {
      this.logger.error({ err, key, store }, 'quota read failed');
      return 0;
    }
  }

  private connection(store: QuotaStore): QuotaRedis {
    return store === 'durable' ? this.durable : this.burst;
  }
}

/**
 * Register the scripts on a connection.
 *
 * `defineCommand` rather than `eval` so ioredis sends `EVALSHA` and only falls back
 * to the full script on `NOSCRIPT` — which happens once per Redis restart rather than
 * once per request.
 *
 * `numberOfKeys` is deliberately not fixed at definition time: the count varies with
 * how many quotas a call site checks together, so it is passed as the first argument
 * instead.
 *
 * ─── On `Date.now()` rather than Redis `TIME` ───────────────────────────────
 *
 * The window is scored with the application's clock, so several API instances
 * sharing a quota must agree on the time. They do, to within NTP's margin, and the
 * error that margin produces is a few milliseconds at the edge of a window measured
 * in minutes. `TIME` inside the script would remove even that, at the cost of making
 * every window untestable without a live Redis — a bad trade for a quota whose
 * correctness is measured in whole requests.
 */
function attach(connection: Redis): QuotaRedis {
  connection.defineCommand('quotaConsumeAll', { lua: CONSUME_ALL });
  connection.defineCommand('quotaRefundAll', { lua: REFUND_ALL });
  return connection as QuotaRedis;
}
