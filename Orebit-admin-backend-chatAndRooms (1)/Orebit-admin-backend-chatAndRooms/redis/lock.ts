import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ERR } from '../src/contracts';
import { ProblemException } from '../src/http';
import { RedisService } from './client';
import { redactKey } from './keys';

/**
 * Distributed lock — SET NX + a fencing token, released only by its owner.
 *
 * ONE caller in the auth flow: `BffSessionService.refresh`, which uses it to make
 * token rotation single-flight. That is a narrow exception to the rule this header
 * used to state absolutely — OTP verification and TOTP replay protection are still
 * better served by a conditional UPDATE, because a row is an authority a lock cannot
 * be, a lock being unable to survive its holder crashing.
 *
 * Refresh is the exception because concurrent requests on one session reach
 * `SessionService.rotate` routinely — refresh is automatic and unprompted under the
 * BFF — and letting them race costs latency and log noise for no benefit.
 *
 * ═══ WHAT THIS LOCK DOES AND DOES NOT GUARANTEE ══════════════════════════════
 *
 *   Redis lock                          best-effort single-flight / contention
 *                                       control. Guarantees NOTHING.
 *   family FOR UPDATE + generation CAS  correctness / one-use rotation.
 *
 * This header used to claim the opposite — that the conflict "has to be PREVENTED
 * here rather than adjudicated there" — and that belief is what made a fixed,
 * comparatively short TTL dangerous. It cannot be prevented here: the TTL is smaller
 * than the rotation's own configured bound (`maxWait` + `timeout` on the transaction,
 * with two statements that can each wait on `lock_timeout`), so the lock CAN lapse
 * while its holder is still working and a second owner CAN appear. That was F10.
 *
 * What makes that survivable is not this file. It is that the database adjudicates
 * correctly — exactly one child per generation, whoever wins — and that the loser now
 * repairs instead of reporting theft. See `SessionService.recoverRotation`.
 *
 * So a lapsed lock is a missed optimisation, not a security event. Anyone tempted to
 * lengthen the TTL, add a renewal heartbeat, or re-check the fencing token mid-section
 * should first be clear about which invariant they are protecting — and that the
 * answer is none of the ones above.
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger('Lock');

  constructor(private readonly redis: RedisService) {}

  /**
   * Run `fn` while holding `key`, or return null if the lock is already held.
   *
   * The token guards against the classic failure: a holder that overran its TTL
   * must not release a lock that has since been acquired by someone else. The
   * release is a compare-and-delete in Lua so that check is atomic.
   *
   * ═══ THREE OUTCOMES, NOT TWO ═══════════════════════════════════════════════
   *
   *   ran        the lock was taken and `fn`'s value comes back.
   *   null       SOMEBODY ELSE HOLDS IT. There is a live holder doing the work, so a
   *              caller can sensibly wait for their result.
   *   throws     REDIS COULD NOT ANSWER. There is no holder and no lock; nothing is
   *              being coordinated at all.
   *
   * The last two must not be folded together, and that is the whole of this method's
   * error handling. Returning null for an outage would tell the caller to wait for a
   * holder that does not exist — a second of patience spent on nothing, and then the
   * same failure anyway. `BffSessionService.refresh` does exactly that waiting, so
   * the distinction is load-bearing rather than theoretical.
   *
   * ─── Why it throws a typed refusal rather than the driver's error ──────────
   *
   * This acquire used to be unguarded — the one Redis call in the auth stack that
   * let a raw ioredis rejection escape. `ProblemJsonFilter` has no choice but to
   * render an unrecognised throw as `500 internal_error`, which tells a client the
   * server is broken. What actually happened is a dependency being briefly away on a
   * request that is perfectly retryable, and `503` says so. Same reasoning, and the
   * same slug, as the refresh coordination timeout it sits next to.
   *
   * `CacheService` already refuses this way for the same class of failure, so the
   * shape is the house one rather than a new idea. If a caller ever appears that
   * should proceed instead of refusing, this wants the explicit `OnCacheError`
   * parameter `CacheService` takes — not a silent null.
   */
  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    const token = randomUUID();

    let acquired: string | null;
    try {
      acquired = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      this.logger.error({ err, key: redactKey(key) }, 'lock acquire failed; refusing the caller');
      throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
    }

    if (acquired !== 'OK') return null;

    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }

  private async release(key: string, token: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    try {
      await this.redis.eval(script, 1, key, token);
    } catch (err) {
      // The TTL will clear it. Logged because a lock we could not release is a
      // window in which the critical section is unguarded.
      this.logger.error({ err, key: redactKey(key) }, 'lock release failed; relying on TTL');
    }
  }
}
