import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { CacheService } from '../../redis/cache';
import type { RedisService } from '../../redis/client';

const RULE = { limit: 5, windowSeconds: 900 };

/**
 * A `multi()` chain whose `exec` resolves with whatever ioredis would return:
 * one `[error, value]` pair per queued command, or `null` for a dropped
 * transaction. The error slot is the whole point of these tests.
 */
function createRedis(exec: () => Promise<unknown>) {
  const chain = {
    incr: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec,
  };
  return {
    multi: vi.fn(() => chain),
    getdel: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    ttl: vi.fn().mockResolvedValue(60),
  };
}

let redis: ReturnType<typeof createRedis>;
let cache: CacheService;

function build(exec: () => Promise<unknown>): void {
  redis = createRedis(exec);
  cache = new CacheService(redis as unknown as RedisService);
}

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('CacheService.consume — a command-level error is not a free pass', () => {
  it('denies when INCR reports an error and the caller asked to fail closed', async () => {
    // `exec` RESOLVES here — the transaction ran, one command inside it failed.
    // Reading the value alone would yield `Number(null)` = 0, sail under the
    // limit, and let the request through with nothing logged.
    build(async () => [[new Error('WRONGTYPE'), null], [null, 1]]);

    const err = await problem(cache.consume('rate:test', RULE, 'deny'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('allows on the same error where a durable backstop exists', async () => {
    build(async () => [[new Error('WRONGTYPE'), null], [null, 1]]);

    await expect(cache.consume('rate:test', RULE, 'allow')).resolves.toBeUndefined();
  });

  it('denies when the transaction is dropped entirely', async () => {
    build(async () => null);

    const err = await problem(cache.consume('rate:test', RULE, 'deny'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('still enforces the limit on a healthy reply', async () => {
    build(async () => [[null, RULE.limit + 1], [null, 1]]);

    const err = await problem(cache.consume('rate:test', RULE, 'allow'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('passes a healthy reply under the limit', async () => {
    build(async () => [[null, 1], [null, 1]]);

    await expect(cache.consume('rate:test', RULE, 'deny')).resolves.toBeUndefined();
  });
});

/**
 * ═══ THE ERROR SLOT, ON THE OTHER COUNTER ═══════════════════════════════════
 *
 * `consume` has always read `[error, value]` properly. `increment` did not: it read
 * the replies as `.map(([, value]) => value)`, which throws the error slot away.
 *
 * The two failures that produced, and why neither was visible:
 *
 *   A COMMAND ERROR became 0.  `[[Error, null], [null, 1]]` mapped to `null`, and
 *   `Number(null)` is 0 — the same value the documented Redis-down fallback returns,
 *   but produced without entering the `catch` and therefore without a log line. The
 *   captcha ladder read it as "no failures recorded" and returned early, every time.
 *
 *   A DROPPED TRANSACTION became NaN.  `exec()` resolves `null`, `(r ?? [])` made it
 *   an empty array, and the absent first element became `Number(undefined)`. `NaN`
 *   does NOT return early — `NaN < limit` is false — so it reached
 *   `BLOCK_LADDER_SECONDS[NaN]`, got `undefined`, and set an IP block with no expiry.
 *
 * The distinction each test below pins is not the returned number on its own — the
 * documented fallback IS 0 — but whether the error reached the `catch` that logs it.
 * That is what separates a deliberate fail-open from a fabricated one, and it is the
 * assertion the old implementation cannot pass.
 */
describe('CacheService.increment — the error slot is not optional', () => {
  /** The `catch` in `increment` logs before returning its documented 0. A call here
   *  is proof the failure was detected rather than arithmetically absorbed. */
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  /** The error objects handed to the logger, whatever position they came from. */
  const loggedErrors = (): unknown[] =>
    logged.mock.calls.map((call) => (call[0] as { err?: unknown } | undefined)?.err);

  it('returns the counter on a healthy reply', async () => {
    build(async () => [
      [null, 7],
      [null, 1],
    ]);

    await expect(cache.increment('captcha:failures:ip:x', 900)).resolves.toBe(7);
    expect(logged).not.toHaveBeenCalled();
  });

  it('surfaces an INCR error instead of reading it as zero failures', async () => {
    // ═══ FINDING #2 ═══════════════════════════════════════════════════════════
    // The old code returned 0 from this reply with nothing logged. The 0 below is
    // the documented fallback; the logged error is the proof it was REACHED.
    const wrongType = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    build(async () => [
      [wrongType, null],
      [null, 1],
    ]);

    await expect(cache.increment('captcha:failures:ip:x', 900)).resolves.toBe(0);
    expect(loggedErrors()).toContain(wrongType);
  });

  it('surfaces an EXPIRE error too — a counter with no TTL never resets the ladder', async () => {
    // The second command position. `consume` only reads INCR's slot because a counter
    // is all it needs; here a lost TTL means a key that accumulates forever.
    const expireFailed = new Error('ERR syntax error');
    build(async () => [
      [null, 4],
      [expireFailed, null],
    ]);

    await expect(cache.increment('captcha:failures:ip:x', 900)).resolves.toBe(0);
    expect(loggedErrors()).toContain(expireFailed);
  });

  it('throws rather than returning NaN when the transaction is dropped', async () => {
    // ═══ THE DANGEROUS HALF OF FINDING #2 ════════════════════════════════════
    // `NaN` did not fail open: it failed THROUGH, into an undefined block TTL.
    build(async () => null);

    const result = await cache.increment('captcha:failures:ip:x', 900);

    expect(result).toBe(0);
    expect(result).not.toBeNaN();
    expect(logged).toHaveBeenCalled();
  });

  it('throws rather than returning NaN when the reply array is empty', async () => {
    // A transaction that reports no replies at all. `(r ?? [])` made this
    // indistinguishable from the dropped case, and it has the same NaN ending.
    build(async () => []);

    const result = await cache.increment('captcha:failures:ip:x', 900);

    expect(result).toBe(0);
    expect(result).not.toBeNaN();
    expect(logged).toHaveBeenCalled();
  });

  it('never returns a non-number, whatever INCR replied with', async () => {
    // The caller indexes an array with this value, so "a number or the documented 0"
    // has to hold unconditionally.
    build(async () => [
      [null, 'not-a-number'],
      [null, 1],
    ]);

    const result = await cache.increment('captcha:failures:ip:x', 900);

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });

  it('still fails open on a transport-level rejection, as documented', async () => {
    // The case that always worked: `exec` itself rejects. Unchanged.
    build(async () => {
      throw new Error('connection refused');
    });

    await expect(cache.increment('captcha:failures:ip:x', 900)).resolves.toBe(0);
    expect(logged).toHaveBeenCalled();
  });
});

describe('CacheService.take — single-use means atomic', () => {
  it('reads and deletes in one command', async () => {
    build(async () => []);
    redis.getdel.mockResolvedValue('state-value');

    await expect(cache.take('oauth:state:x')).resolves.toBe('state-value');

    // GET-then-DEL would let two concurrent callers both observe the value
    // before either deleted it, which is exactly the race `state` exists to stop.
    expect(redis.getdel).toHaveBeenCalledWith('oauth:state:x');
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('fails closed rather than reporting the key as absent', async () => {
    build(async () => []);
    redis.getdel.mockRejectedValue(new Error('connection refused'));

    // A swallowed failure here would read as "no such key", which on the OAuth
    // path means "that state was never issued" — a security conclusion drawn
    // from an infrastructure fault.
    const err = await problem(cache.take('oauth:state:x'));

    expect(err.type).toBe(ERR.INTERNAL_ERROR);
  });
});
