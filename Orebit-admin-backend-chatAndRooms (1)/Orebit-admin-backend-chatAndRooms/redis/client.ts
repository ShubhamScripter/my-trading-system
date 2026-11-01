import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../src/config';

/**
 * The Redis connection, as a Nest provider.
 *
 * `maxRetriesPerRequest: 2` and a bounded backoff are deliberate: this instance
 * holds rate-limit counters, the session-revocation cache and in-flight WebAuthn
 * challenges, none of which is a durable source of truth. A command that cannot
 * complete quickly should fail fast and let the caller decide, rather than
 * holding an HTTP request open waiting for a cache. See `cache.ts` for what each
 * caller decides.
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
