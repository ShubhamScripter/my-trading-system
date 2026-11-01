import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache';
import {
  DurableRedisBlockingService,
  DurableRedisQuotaService,
  DurableRedisService,
  RedisService,
  RedisSubscriberService,
} from './client';
import { LockService } from './lock';
import { QuotaService } from './quota';
import { UsernameBloomService } from './username-bloom';

export { CacheService, type OnCacheError, type RateLimit } from './cache';
export {
  DurableRedisBlockingService,
  DurableRedisQuotaService,
  DurableRedisService,
  RedisService,
  RedisSubscriberService,
} from './client';
export { KEYS } from './keys';
export { LockService } from './lock';
export {
  QuotaService,
  type QuotaCharge,
  type QuotaEntry,
  type QuotaStore,
} from './quota';
export { UsernameBloomService, type BloomVerdict } from './username-bloom';

/**
 * The public surface of `redis/`. Global because the connections are singletons
 * and every module that caches needs one; importing it per-module would only
 * invite a second connection.
 *
 * TWO INSTANCES with opposite persistence settings — the cache (`REDIS_URL`) and the
 * durable queue instance (`REDIS_DURABLE_URL`). See the note on `DurableRedisService`
 * for why this is not one instance with two databases.
 *
 * FIVE CONNECTIONS across those two instances, because a connection carries a retry
 * policy and a position in one command pipeline, and those cannot be shared by callers
 * that disagree about either:
 *
 *   RedisService                   cache      fail fast; the request path
 *   RedisSubscriberService         cache      subscriber mode locks out other commands
 *   DurableRedisService            durable    never drop a message; queue writes
 *   DurableRedisBlockingService    durable    parked in XREADGROUP ... BLOCK
 *   DurableRedisQuotaService       durable    bounded; the request path again
 *
 * The last three all reach the same durable instance. What is split between them is
 * the socket and the retry policy, not the data.
 */
@Global()
@Module({
  providers: [
    RedisService,
    RedisSubscriberService,
    DurableRedisService,
    DurableRedisBlockingService,
    DurableRedisQuotaService,
    CacheService,
    LockService,
    QuotaService,
    UsernameBloomService,
  ],
  exports: [
    RedisService,
    RedisSubscriberService,
    DurableRedisService,
    DurableRedisBlockingService,
    DurableRedisQuotaService,
    CacheService,
    LockService,
    QuotaService,
    UsernameBloomService,
  ],
})
export class RedisModule {}
