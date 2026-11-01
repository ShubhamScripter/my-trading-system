import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { config } from '../src/config';
import { DurableRedisQuotaService } from './client';
import { KEYS } from './keys';

/**
 * ═══ THE USERNAME AVAILABILITY FILTER ═══════════════════════════════════════
 *
 * A Bloom filter over every username that has ever been CLAIMED or RESERVED, so the
 * live availability check can answer the common case — "no, nobody has ever had this"
 * — without touching Postgres.
 *
 * `GET /settings/profile/username/check` is called on a keystroke debounce. Most of
 * what it is asked about has never existed, and a database round trip per keystroke to
 * establish that is the cost this removes.
 *
 * ─── The one rule that matters ──────────────────────────────────────────────
 *
 *   NEGATIVE is an answer.        Any bit clear => the name was never inserted => free.
 *   POSITIVE is a QUESTION.       All bits set => maybe => ask Postgres, always.
 *
 * A Bloom filter has false positives and no false negatives. So a positive is never,
 * on its own, "taken", and this class deliberately gives callers no way to treat it as
 * one: `test` returns `'absent' | 'maybe'`, not a boolean. Nothing named `has()` exists
 * for someone to misuse.
 *
 * ─── Why a bitmap and not `BF.ADD` ──────────────────────────────────────────
 *
 * RedisBloom is a module, and this deployment runs `redis:7-alpine` (docker-compose.yml)
 * — no modules. Managed Redis usually has none either, so depending on one would make
 * the filter an infrastructure decision rather than a cache. A Bloom filter is an array
 * of bits with a hash function in front of it; Redis has had `SETBIT`/`GETBIT` since
 * 2.2, and the hashing is fifteen lines below. There is nothing in `BF.*` this needs.
 *
 * ─── Why it never deletes, and why that is safe ─────────────────────────────
 *
 * It cannot: clearing a bit for a released username would also clear it for every other
 * name that hashes onto that bit, turning their positives into false NEGATIVES — the
 * one error this structure must not make.
 *
 * So entries are permanent and the filter drifts, permanently, toward saying "maybe"
 * about names that are long since free. That costs a Postgres query and nothing else,
 * because the filter never gets the last word: a released or expired username reads as
 * "maybe", Postgres says available, and the caller is told available. A stale bit
 * cannot make a free username unavailable — see `UsernameService.availability`.
 *
 * ─── Why the DURABLE instance ───────────────────────────────────────────────
 *
 * The cache instance is `allkeys-lru`. A filter evicted under memory pressure would
 * come back empty, and an empty bitmap answers "definitely absent" for every username
 * in the product — which is the false negative above, arrived at through operations
 * rather than through hashing. `noeviction` plus AOF removes that. The `ready` flag
 * below removes the rest of it: an absent flag means the bitmap is not to be trusted
 * at all, so even a flushed durable instance degrades to plain Postgres rather than to
 * a wrong answer.
 */

/**
 * What the filter is willing to say. Deliberately not a boolean.
 *
 * `'absent'` is load-bearing and may be acted on. `'maybe'` covers three different
 * situations a caller must handle identically — a true positive, a false positive, and
 * "the filter was unavailable or not ready" — so they are one value rather than three.
 */
export type BloomVerdict = 'absent' | 'maybe';

/**
 * Bits in the filter. A power of two so a position is a mask rather than a modulo,
 * which also sidesteps the bias `hash % m` introduces when `m` is not a divisor of the
 * hash space.
 *
 * 2^25 bits is 4 MB. At two million entries — every account plus every reservation ever
 * written — that is 0.36 bits of load per hash and a false-positive rate near 0.07%,
 * so essentially every "maybe" this returns is a real one. Four megabytes on an
 * instance that already holds the mail queue is not a number worth optimising.
 */
const BLOOM_BITS = 1 << 25;
const BLOOM_MASK = BLOOM_BITS - 1;

/** Hashes per entry. Six is near-optimal for the load above and costs six `GETBIT`s. */
const BLOOM_HASHES = 6;

/**
 * Bump to rebuild from scratch — a resize, or a hashing change.
 *
 * In the key, so a rebuild writes a NEW bitmap while readers finish against the old
 * one, and the `ready` flag for the new generation is what moves them across. Mutating
 * the live bitmap instead would expose a half-built filter, whose clear bits are
 * exactly the false negatives this file exists to prevent.
 */
const BLOOM_GENERATION = 1;

/**
 * Test every position, stopping at the first clear bit.
 *
 * Returns 1 for "every bit set" (maybe present) and 0 for "at least one clear"
 * (definitely absent).
 *
 * A script rather than a pipeline of `GETBIT`s so the read cannot interleave with a
 * concurrent `ADD`. Without atomicity a reader could observe three of another writer's
 * six bits, conclude "absent", and report a username as free at the exact moment it was
 * being claimed. Postgres would still refuse the claim, so this is a UX bug rather than
 * a correctness one — but it costs one round trip to not have it.
 */
const BLOOM_TEST = `
for i = 1, #ARGV do
  if redis.call('GETBIT', KEYS[1], ARGV[i]) == 0 then
    return 0
  end
end
return 1
`;

/** Set every position. One round trip, and atomic for the reason above. */
const BLOOM_ADD = `
for i = 1, #ARGV do
  redis.call('SETBIT', KEYS[1], ARGV[i], 1)
end
return 1
`;

interface BloomCommands {
  usernameBloomTest(...args: (string | number)[]): Promise<number>;
  usernameBloomAdd(...args: (string | number)[]): Promise<number>;
}

type BloomRedis = Redis & BloomCommands;

@Injectable()
export class UsernameBloomService {
  private readonly logger = new Logger('UsernameBloom');

  private readonly redis: BloomRedis;
  private readonly bitmapKey = KEYS.username.bloom(BLOOM_GENERATION);
  private readonly readyKey = KEYS.username.bloomReady(BLOOM_GENERATION);
  private readonly warmingKey = KEYS.username.bloomWarming(BLOOM_GENERATION);

  /**
   * Cached once the flag has been seen. Only ever flips false -> true, and a filter
   * cannot become un-ready without a restart, so a stale `true` is not reachable: the
   * flag is only ever deleted alongside the bitmap it describes.
   *
   * This is what keeps the fast path to ONE Redis round trip. Checking the flag before
   * every test would double the cost of the thing this class exists to make cheap.
   */
  private ready = false;

  /**
   * `DurableRedisQuotaService`, for the reason `QuotaService` uses it: the durable
   * instance's ordinary connection retries forever, which is right for a queued message
   * and wrong on an HTTP path — a Redis stall would hang the availability check instead
   * of letting it fall through to Postgres. The bounded connection makes the failure
   * reachable, and keeps these calls out of the pipeline behind the mail worker's
   * parked blocking read.
   */
  constructor(durable: DurableRedisQuotaService) {
    this.redis = attach(durable);
  }

  /**
   * Is this username definitely absent from the filter?
   *
   * Answers `'maybe'` for anything it is not certain about, including its own failures.
   * The caller queries Postgres on `'maybe'`, so every error path here degrades
   * performance and nothing else — which is why none of them throw.
   */
  async test(usernameLower: string): Promise<BloomVerdict> {
    if (!this.ready) {
      // Not warmed yet. An unbuilt bitmap is all zeroes, and all zeroes says
      // "definitely absent" about every username in the product.
      return 'maybe';
    }

    try {
      const present = await this.redis.usernameBloomTest(
        1,
        this.bitmapKey,
        ...positions(usernameLower),
      );
      return present === 1 ? 'maybe' : 'absent';
    } catch (err) {
      this.logger.error({ err }, 'bloom test failed, falling through to the database');
      return 'maybe';
    }
  }

  /**
   * Record a username as claimed or reserved.
   *
   * Never throws. It is called after the transaction that claimed the name has already
   * committed, so failing here cannot undo anything — Postgres has the truth. The cost
   * of a lost add is that `/check` reports an available answer for a name that is
   * taken, which the next `POST` refuses correctly.
   */
  async add(...usernamesLower: readonly string[]): Promise<void> {
    if (usernamesLower.length === 0) return;

    try {
      const offsets = usernamesLower.flatMap((username) => positions(username));
      await this.redis.usernameBloomAdd(1, this.bitmapKey, ...offsets);
    } catch (err) {
      this.logger.error({ err, count: usernamesLower.length }, 'bloom add failed');
    }
  }

  /**
   * Claim the right to build the filter. False means somebody else is on it, or it is
   * already built.
   *
   * `SET NX PX` rather than a lock service, and the TTL is what makes it safe: an
   * instance that dies mid-warm leaves the claim to expire rather than leaving the
   * filter permanently unbuildable. A second instance then rebuilds from scratch, which
   * is correct because `add` is idempotent — setting a bit that is already set is a
   * no-op, so two overlapping warm-ups produce the same bitmap as one.
   */
  async beginWarmUp(ttlSeconds: number): Promise<boolean> {
    try {
      if ((await this.redis.exists(this.readyKey)) === 1) {
        this.ready = true;
        return false;
      }
      const claimed = await this.redis.set(this.warmingKey, '1', 'EX', ttlSeconds, 'NX');
      return claimed === 'OK';
    } catch (err) {
      this.logger.error({ err }, 'bloom warm-up claim failed; filter stays disabled');
      return false;
    }
  }

  /**
   * Declare the filter complete and start trusting negatives.
   *
   * Called only after every claimed and reserved username has been added. Setting it
   * early is the one mistake that turns this class into a source of wrong answers.
   *
   * No TTL: the bitmap is permanent, so the statement that it is populated is too.
   */
  async markReady(): Promise<void> {
    try {
      await this.redis.set(this.readyKey, '1');
      await this.redis.del(this.warmingKey);
      this.ready = true;
      this.logger.log({ bits: BLOOM_BITS, hashes: BLOOM_HASHES }, 'username filter ready');
    } catch (err) {
      // The filter stays off. Every check goes to Postgres, which is slower and right.
      this.logger.error({ err }, 'could not mark the username filter ready');
    }
  }

  /** Whether negatives are currently being trusted. For the status of the process, and
   *  for tests that need to assert the database was or was not consulted. */
  isReady(): boolean {
    return this.ready;
  }
}

/**
 * The `BLOOM_HASHES` bit positions for one username.
 *
 * Kirsch-Mitzenmacher: two independent hashes generate k of them as `h1 + i*h2`, which
 * has the same false-positive behaviour as k separate hash functions and costs one
 * HMAC instead of k.
 *
 * ─── Why HMAC rather than a plain hash ──────────────────────────────────────
 *
 * `redis/keys.ts`' argument, for a different attack. Usernames are a dictionary, so
 * with an unkeyed hash anyone could compute which names collide onto the same bits and
 * submit a stream of them to drive the false-positive rate up — turning the filter back
 * into a database query per keystroke, which is precisely what it exists to avoid.
 * Keying it means the positions cannot be computed without a secret that lives in the
 * process environment.
 *
 * The input is ALWAYS the normalised username. Every caller passes the output of
 * `normaliseUsername`, so `Shubh` and `shubh` set and test the same bits — the same
 * rule that makes `username_lower` the column uniqueness sits on.
 */
function positions(usernameLower: string): number[] {
  const digest = createHmac('sha256', config.rateLimitKeySecret).update(usernameLower).digest();

  const h1 = digest.readUInt32BE(0);
  // Forced odd so it is coprime with the power-of-two modulus, which is what stops the
  // k positions from collapsing onto a short cycle for some inputs.
  const h2 = digest.readUInt32BE(4) | 1;

  const offsets: number[] = [];
  for (let i = 0; i < BLOOM_HASHES; i += 1) {
    // `>>> 0` keeps the arithmetic unsigned; the mask does the modulo.
    offsets.push(((h1 + Math.imul(i, h2)) >>> 0) & BLOOM_MASK);
  }
  return offsets;
}

/**
 * Register the scripts on the connection.
 *
 * `defineCommand` so ioredis sends `EVALSHA` and only falls back to the full script on
 * `NOSCRIPT` — once per Redis restart rather than once per keystroke. `numberOfKeys` is
 * passed per call rather than fixed here, matching `redis/quota.ts`.
 */
function attach(connection: Redis): BloomRedis {
  connection.defineCommand('usernameBloomTest', { lua: BLOOM_TEST });
  connection.defineCommand('usernameBloomAdd', { lua: BLOOM_ADD });
  return connection as BloomRedis;
}
