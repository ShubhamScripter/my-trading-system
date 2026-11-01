import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../src/config';

/**
 * The Redis connection, as a Nest provider.
 *
 * `maxRetriesPerRequest: 2` and a bounded backoff are deliberate: this instance
 * holds rate-limit counters and the session-revocation cache, none of which is a
 * source of truth. A command that cannot complete quickly should fail fast and
 * let the caller decide, rather than holding an HTTP request open waiting for a
 * cache. See `cache.ts` for what each caller decides.
 */
@Injectable()
export class RedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Redis');

  constructor() {
    super(config.REDIS_URL, {
      maxRetriesPerRequest: 2,
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

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}

/**
 * The DURABLE Redis PRODUCER connection — mail enqueue, retry scheduling, acks.
 *
 * ─── Why a second connection, and why the options are different ─────────────
 *
 * `RedisService` above is a cache, and its options say so: two retries then fail
 * fast, because none of what it holds is a source of truth and an HTTP request must
 * not wait on it. Every one of those choices is wrong for a queue.
 *
 * `maxRetriesPerRequest: null` is the important one. On the cache, a command that
 * cannot complete should give up and let the caller decide — `CacheService` takes an
 * `OnCacheError` for exactly that. Here there is no caller to decide: the value being
 * written IS the message, and failing fast means dropping a one-time code somebody is
 * waiting for. `null` makes ioredis queue the command until the connection returns
 * instead of rejecting it.
 *
 * ─── Why not a second database on the first instance ────────────────────────
 *
 * Because persistence is per-instance, not per-database. The cache runs
 * `appendonly no` with `maxmemory-policy allkeys-lru` — configured to discard data
 * under pressure, which is right for a rate-limit counter and unacceptable for a
 * queued message. `SELECT 1` would share that policy.
 *
 * ─── Why THREE durable connections and not one ──────────────────────────────
 *
 * This class used to serve all three roles below, and the options above are only
 * correct for one of them. A single socket cannot be parked in a five-second blocking
 * read AND answer a rate-limit check on the request path: ioredis pipelines commands
 * onto one connection in order, so an OTP enqueue issued while the worker is blocked
 * waits behind it. `maxRetriesPerRequest: null` then makes the same socket wrong for
 * `QuotaService`, whose whole contract is that it can FAIL and let the caller decide —
 * with retries disabled a durable-Redis outage left HTTP requests waiting indefinitely
 * for a command that would never reject, so the `deny`-on-error branch it exists for
 * could never run.
 *
 * All three still point at the same durable INSTANCE. What is split is the socket and
 * the retry policy, not the data.
 */
@Injectable()
export class DurableRedisService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisDurable');

  constructor() {
    super(config.redisDurableUrl, {
      // See the note above: never give up on a command carrying a message.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();

    if (config.mailQueueIsDurable) {
      this.logger.log('connected to the durable instance');
      return;
    }

    // Not fatal — a single-instance development machine is a legitimate setup — but
    // it must not be silent. The queue is only as durable as the instance under it,
    // and the cache instance is configured to evict.
    this.logger.warn(
      'REDIS_DURABLE_URL is unset, so the mail queue is sharing the CACHE instance. ' +
        'That instance runs `appendonly no` with an LRU eviction policy, so a restart ' +
        'or memory pressure can silently drop queued mail. Set REDIS_DURABLE_URL in ' +
        'any environment that matters.',
    );
  }

  async onModuleDestroy(): Promise<void> {
    // `quit` rather than `disconnect`: this connection no longer carries the blocking
    // read (see `DurableRedisBlockingService`), so there is nothing that will refuse
    // to drain — and an enqueue still in flight at shutdown is a message, which is
    // worth waiting for.
    await this.quit();
  }
}

/**
 * The DURABLE Redis CONSUMER connection — `XREADGROUP ... BLOCK`, and nothing else.
 *
 * A blocking read holds the socket open for `MAIL_QUEUE.BLOCK_MS` at a time. Anything
 * else sharing that socket queues behind it, which is how an OTP enqueue on the
 * request path ended up waiting on the mail worker's idle poll. Its own connection
 * costs one socket and removes the coupling entirely.
 *
 * `maxRetriesPerRequest: null` for the original reason: the cache's retry policy would
 * count a parked BLOCK as a stalled command and tear the connection down.
 */
@Injectable()
export class DurableRedisBlockingService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisDurableBlocking');

  constructor() {
    super(config.redisDurableUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // `disconnect` rather than `quit`: this is the one parked in a blocking
    // `XREADGROUP`, and `quit` waits for in-flight commands to finish — which that one
    // will not do until its BLOCK elapses. The worker is stopped before this runs, so
    // there is nothing left to drain.
    this.disconnect();
  }
}

/**
 * The DURABLE Redis REQUEST-PATH connection — `QuotaService`'s durable store.
 *
 * Same instance as the two above, opposite retry policy, and the difference is the
 * point. Email-cost budgets have to survive an eviction, so they live on the durable
 * instance; but they are charged on the HTTP request path, so a caller must find out
 * QUICKLY when they cannot be charged.
 *
 * `commandTimeout` is the property that makes that true, and `maxRetriesPerRequest`
 * alone is not enough: while ioredis is disconnected it holds commands in an offline
 * queue that no retry count bounds, so without a timeout a durable-Redis outage is an
 * HTTP request that waits forever rather than one that fails. With it, every call
 * settles within a second and `QuotaService` reaches the `deny`-on-error branch it was
 * written for — a 429 with a Retry-After, which is the honest answer when the budget
 * cannot be checked, rather than a hung connection.
 */
@Injectable()
export class DurableRedisQuotaService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisDurableQuota');

  constructor() {
    super(config.redisDurableUrl, {
      // Bounded, unlike the producer above: there IS a caller here, and it can decide.
      maxRetriesPerRequest: 2,
      commandTimeout: 1_000,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}

/**
 * A SUBSCRIBER connection on the cache instance.
 *
 * Its own connection because it has to be: once a client issues `SUBSCRIBE`, Redis
 * puts it in subscriber mode and it may no longer run ordinary commands. Sharing
 * `RedisService` would take the whole cache offline the moment anything subscribed.
 *
 * `maxRetriesPerRequest: null` because a subscriber has no request to fail. The cache's
 * fail-fast policy exists so an HTTP caller is not left waiting; nothing here is
 * waiting, and a dropped subscription is a missed invalidation rather than a slow
 * response. ioredis re-issues its subscriptions on reconnect, and every consumer of
 * this connection additionally re-reads on `ready` — see `RateLimitPolicyService` —
 * so a message lost while the socket was down is still picked up.
 */
@Injectable()
export class RedisSubscriberService extends Redis implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisSubscriber');

  constructor() {
    super(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.on('error', (err: Error) => this.logger.error({ err }, 'connection error'));
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.disconnect();
  }
}
