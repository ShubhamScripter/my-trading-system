import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './client';

/**
 * Distributed lock — SET NX + a fencing token, released only by its owner.
 *
 * Nothing in the auth flow uses this yet, and that is the correct state of
 * affairs rather than an omission. The two places a lock looks tempting are
 * username allocation and OTP verification, and both are better served by the
 * database: username uniqueness is a partial unique index (an authority a lock
 * cannot be, since a lock cannot survive its holder crashing), and OTP attempt
 * counting is a conditional UPDATE on the row.
 *
 * It exists now because the money paths will need it — `redis/` is where the
 * README says it lives, and having it here keeps the next author from inventing
 * a second one.
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
   */
  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');
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
      this.logger.error({ err, key }, 'lock release failed; relying on TTL');
    }
  }
}
