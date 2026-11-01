import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../src/config';

/**
 * The DURABLE Redis connection — a second instance, not a second database.
 *
 * ═══ WHY THIS IS NOT `RedisService` ════════════════════════════════════════════
 *
 * Three reasons, and each one alone would be enough.
 *
 * 1. DIFFERENT DURABILITY. `RedisService` points at `redis-cache`, which runs
 *    `--save "" --appendonly no --maxmemory-policy allkeys-lru`. Everything on it is
 *    reconstructible and is evicted freely under memory pressure. A queued sign-in
 *    code is neither: evicting one is a code that never arrives, and the emailed code
 *    is a mandatory second factor with no recovery flow behind it.
 *
 * 2. BLOCKING READS. The worker sits in `BRPOPLPUSH` with a timeout, which occupies
 *    its connection for the whole wait. On the shared client that would park every
 *    rate-limit check in the service behind a blocked socket — an outage caused by a
 *    queue that is working correctly.
 *
 * 3. OPPOSITE FAILURE POSTURE. `RedisService` sets `maxRetriesPerRequest: 2` because
 *    a cache that cannot answer quickly should fail fast and let the caller decide.
 *    Here the caller cannot decide anything useful: this instance IS the storage, and
 *    giving up on a command means losing a job. So it retries harder.
 */
@Injectable()
export class DurableRedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisDurable');

  constructor() {
    super(config.REDIS_DURABLE_URL, {
      /**
       * Ten rather than the cache's two. A command against durable storage that fails
       * is a job lost or a job duplicated, so it is worth waiting through a
       * reconnection for. The bounded backoff below still caps the total wait.
       */
      maxRetriesPerRequest: 10,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();
    this.logger.log('connected');
  }

  /**
   * `disconnect`, not `quit`, and the difference matters here.
   *
   * `quit` waits for every queued command to be written, and a worker parked in a
   * `BRPOPLPUSH` with a multi-second timeout is exactly such a command — so `quit`
   * would hang the shutdown until that block expires. `OtpQueueService` stops its
   * workers and returns in-flight jobs to the queue in its own `onModuleDestroy`
   * before this runs; by the time we get here there is nothing left worth draining.
   */
  async onModuleDestroy(): Promise<void> {
    this.disconnect();
  }
}
