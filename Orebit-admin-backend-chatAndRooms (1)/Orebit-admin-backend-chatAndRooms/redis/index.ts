import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache';
import { RedisService } from './client';
import { DurableRedisService } from './durable.client';
import { LockService } from './lock';

export { CacheService, type OnCacheError, type RateLimit } from './cache';
export { RedisService } from './client';
export { DurableRedisService } from './durable.client';
export { KEYS } from './keys';
export { LockService } from './lock';

/**
 * The public surface of `redis/`. Global because the connections are singletons
 * and every module that caches needs them; importing it per-module would only
 * invite a second connection.
 *
 * TWO connections, to two different instances. `RedisService` is the cache;
 * `DurableRedisService` is the queue's storage. See durable.client.ts for why they are
 * not one client with two databases — the short version is that durability, eviction
 * policy and blocking reads all differ, and none of the three is per-database.
 */
@Global()
@Module({
  providers: [RedisService, DurableRedisService, CacheService, LockService],
  exports: [RedisService, DurableRedisService, CacheService, LockService],
})
export class RedisModule {}
