import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../redis/cache';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ THE TEST THAT PROVES SINGLE-USE IS SINGLE-USE ═════════════════════════
 *
 * `CacheService.take` is the primitive four security credentials are spent
 * through: the elevation ticket that authorises one administrative write, and the
 * three WebAuthn challenges. Each is meant to work exactly once.
 *
 * ─── Why the assertion is "one command, and it is GETDEL" ───────────────────
 *
 * It is tempting to test atomicity by firing two concurrent `take` calls and
 * asserting one wins. That test cannot fail against a test double, because a
 * double's get-then-delete runs inside one synchronous turn of the event loop and
 * is therefore atomic *by accident*. `tests/2fa/elevation.spec.ts` had exactly
 * that test, and it passed for the whole period `take` was a non-atomic GET
 * followed by DEL — the double's atomicity was standing in for the code's.
 *
 * So the property is asserted where it actually lives: `take` must issue ONE
 * command, and that command must be `GETDEL`. Atomicity is then Redis's
 * guarantee rather than ours, which is the correct place for it. A future edit
 * that splits it back into GET + DEL fails the second test below regardless of
 * how the double behaves.
 */

/** A Redis double that records which commands were issued, so a spec can assert
 *  on the command sequence and not merely on the return value. */
function makeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: string[] = [];

  return {
    store,
    calls,
    getdel: vi.fn(async (key: string) => {
      calls.push('getdel');
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    get: vi.fn(async (key: string) => {
      calls.push('get');
      return store.get(key) ?? null;
    }),
    del: vi.fn(async (key: string) => {
      calls.push('del');
      return store.delete(key) ? 1 : 0;
    }),
    set: vi.fn(async (key: string, value: string) => {
      calls.push('set');
      store.set(key, value);
      return 'OK';
    }),
    exists: vi.fn(async (key: string) => {
      calls.push('exists');
      return store.has(key) ? 1 : 0;
    }),
    decr: vi.fn(async (key: string) => {
      calls.push('decr');
      const next = Number(store.get(key) ?? 0) - 1;
      store.set(key, String(next));
      return next;
    }),
  };
}

/**
 * A `multi()` chain whose `exec` resolves with whatever ioredis would return:
 * one `[error, value]` pair per queued command, or `null` for a dropped
 * transaction. The error slot is the whole point of the `consume` tests.
 */
function makeMultiRedis(exec: () => Promise<unknown>) {
  const chain = {
    incr: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    exec,
  };
  return {
    multi: vi.fn(() => chain),
    ttl: vi.fn().mockResolvedValue(60),
  };
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

/**
 * ═══ A COMMAND-LEVEL ERROR IS NOT A FREE PASS ══════════════════════════════
 *
 * `consume` is the only limiter the `deny` call sites have, and its failure mode
 * was silent in the one direction that matters. `exec` rejects only when the
 * whole transaction fails; a single command failing inside a transaction that
 * otherwise ran comes back as an error in that command's `[error, value]` pair,
 * with the pair still present and its value `null`. Reading the value alone made
 * that `Number(null)` — 0 — which is under every limit, so the request passed
 * with nothing thrown, nothing logged, and `onError` never consulted.
 */
describe('consume', () => {
  const RULE = { limit: 5, windowSeconds: 900 };
  let redis: ReturnType<typeof makeMultiRedis>;
  let cache: CacheService;

  function build(exec: () => Promise<unknown>): void {
    redis = makeMultiRedis(exec);
    cache = new CacheService(redis as never);
  }

  it('denies when INCR reports an error and the caller asked to fail closed', async () => {
    // `exec` RESOLVES here — the transaction ran, one command inside it failed.
    build(async () => [
      [new Error('WRONGTYPE'), null],
      [null, 1],
    ]);

    const err = await problem(cache.consume('rate:test', RULE, 'deny'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('allows on the same error where a durable backstop exists', async () => {
    build(async () => [
      [new Error('WRONGTYPE'), null],
      [null, 1],
    ]);

    await expect(cache.consume('rate:test', RULE, 'allow')).resolves.toBeUndefined();
  });

  it('denies when the transaction is dropped entirely', async () => {
    build(async () => null);

    const err = await problem(cache.consume('rate:test', RULE, 'deny'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('still enforces the limit on a healthy reply', async () => {
    build(async () => [
      [null, RULE.limit + 1],
      [null, 1],
    ]);

    const err = await problem(cache.consume('rate:test', RULE, 'allow'));

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('passes a healthy reply under the limit', async () => {
    build(async () => [
      [null, 1],
      [null, 1],
    ]);

    await expect(cache.consume('rate:test', RULE, 'deny')).resolves.toBeUndefined();
  });
});

/**
 * ═══ A REFUND MUST NOT RESURRECT A CLOSED WINDOW ═══════════════════════════
 *
 * `refund` gives back a slot `consume` took for a send that then failed on our
 * side. The whole method is two lines and one of them is a guard, because the
 * naive version is actively harmful: `DECR` on a key that has already expired
 * CREATES it at -1 with no TTL, and a counter sitting at -1 forever grants
 * unlimited sends rather than the five this bucket exists to allow.
 */
describe('refund', () => {
  let redis: ReturnType<typeof makeRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = makeRedis({ 'rate:live': '3' });
    cache = new CacheService(redis as never);
  });

  it('gives back one unit of a live counter', async () => {
    await cache.refund('rate:live');
    expect(redis.store.get('rate:live')).toBe('2');
  });

  /** ═══ THE ONE THAT STOPS AN UNLIMITED-SEND BUG ═════════════════════════ */
  it('does not decrement a window that has already closed', async () => {
    await cache.refund('rate:expired');

    expect(redis.decr).not.toHaveBeenCalled();
    // Stated separately from the call assertion: the harm is not the wasted
    // command, it is the -1 key with no TTL that the command would leave behind.
    expect(redis.store.has('rate:expired')).toBe(false);
  });

  it('checks existence before decrementing, not after', async () => {
    await cache.refund('rate:live');
    expect(redis.calls).toEqual(['exists', 'decr']);
  });

  /**
   * Fail-open, like `clear`. A lost refund costs the admin one send from their
   * budget — the direction that cannot be abused. Throwing would turn a failed
   * mail delivery into a 500 on a login step that otherwise succeeded.
   */
  it('swallows a Redis failure rather than throwing', async () => {
    redis.exists.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(cache.refund('rate:live')).resolves.toBeUndefined();
  });

  it('swallows a failure from the decrement itself', async () => {
    redis.decr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(cache.refund('rate:live')).resolves.toBeUndefined();
  });
});

describe('take', () => {
  let redis: ReturnType<typeof makeRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = makeRedis({ 'k:live': 'value' });
    cache = new CacheService(redis as never);
  });

  it('returns the value and removes the key', async () => {
    await expect(cache.take('k:live')).resolves.toBe('value');
    expect(redis.store.has('k:live')).toBe(false);
  });

  it('returns null for a key that was never set', async () => {
    await expect(cache.take('k:absent')).resolves.toBeNull();
  });

  /** ═══ THE ONE THAT MAKES IT SINGLE-USE ═════════════════════════════════ */
  it('issues exactly one command, and that command is GETDEL', async () => {
    await cache.take('k:live');

    expect(redis.calls).toEqual(['getdel']);
    // Stated separately from the sequence above, because these two are the
    // specific regression: a GET followed by a DEL lets two concurrent callers
    // both read the value before either deletes it, so both spend one credential.
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('does not issue a delete for a key that was absent', async () => {
    await cache.take('k:absent');
    expect(redis.calls).toEqual(['getdel']);
  });

  /**
   * Fail-closed. Every caller of `take` is spending a single-use credential, so a
   * cache we cannot reach must never read as "the credential was valid".
   *
   * `null` rather than a throw, deliberately: all four call sites already turn
   * null into their own typed refusal — `reauth_required` in
   * src/2fa/elevation.ts, `passkey_challenge_invalid` via `parseChallenge` in the
   * other three. Throwing here would replace those with an untyped 500, which
   * tells a client to retry rather than to prove a factor again.
   */
  it('returns null when Redis is unreachable', async () => {
    redis.getdel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(cache.take('k:live')).resolves.toBeNull();
  });

  it('does not fall back to GET when GETDEL fails', async () => {
    redis.getdel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await cache.take('k:live');

    // A fallback would be the bug back again, and worse for being deliberate.
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  /**
   * Sequential double-spend, through the real implementation.
   *
   * Weaker than the concurrent case — Redis owns that — but it is the assertion a
   * reader expects to find here, and it holds for the right reason: the first call
   * removed the key.
   */
  it('refuses the same key a second time', async () => {
    await expect(cache.take('k:live')).resolves.toBe('value');
    await expect(cache.take('k:live')).resolves.toBeNull();
  });
});

/**
 * ═══ NO METHOD LETS AN IOREDIS REJECTION ESCAPE ════════════════════════════
 *
 * An untyped throw out of this file leaves `ProblemJsonFilter` as `internal_error`
 * — a 500, which tells a client to retry the identical request. That is the wrong
 * instruction for every one of these call sites: the right one is either "prove a
 * factor again" or "this succeeded, carry on".
 *
 * So the direction is chosen per method and asserted here, rather than being
 * whatever ioredis happens to do.
 */
describe('set', () => {
  let redis: ReturnType<typeof makeRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = makeRedis();
    cache = new CacheService(redis as never);
  });

  it('writes the value with the requested TTL', async () => {
    await cache.set('k:new', 'v', 60, 'deny');
    expect(redis.set).toHaveBeenCalledWith('k:new', 'v', 'EX', 60);
    expect(redis.store.get('k:new')).toBe('v');
  });

  /**
   * `deny` is for anything single-use the caller is about to hand out — a WebAuthn
   * challenge or an elevation ticket. Storing it is what makes it verifiable, so a
   * failed write means the credential is already dead; returning it anyway just
   * moves the failure to the victim's next request.
   */
  it('throws on a failed write when told to deny', async () => {
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(cache.set('k:new', 'v', 60, 'deny')).rejects.toSatisfy(
      (err) => err instanceof ProblemException && err.type === ERR.RATE_LIMITED,
    );
  });

  /** Typed, so the client is told to wait rather than handed a bare 500. */
  it('reports a retry-after when it denies', async () => {
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const err = await cache.set('k:new', 'v', 60, 'deny').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).retryAfterSeconds).toBeGreaterThan(0);
  });

  /**
   * `allow` is for the captcha penalty and nothing else. A penalty we could not
   * write costs enforcement, never correctness — the provider's own verdict is the
   * real defence and still runs with Redis down.
   */
  it('swallows a failed write when told to allow', async () => {
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(cache.set('k:new', 'v', 60, 'allow')).resolves.toBeUndefined();
  });
});

describe('get', () => {
  let redis: ReturnType<typeof makeRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = makeRedis({ 'k:live': 'value' });
    cache = new CacheService(redis as never);
  });

  it('returns the stored value', async () => {
    await expect(cache.get('k:live')).resolves.toBe('value');
  });

  /**
   * Absent and unreadable are conflated, because every reader treats absence as
   * "no such thing" and fails closed on it. A reader that must tell them apart uses
   * the three-valued `flag` instead — which is exactly what the session-revocation
   * check does, since reading an outage as "not revoked" is how logout stops
   * working under load.
   */
  it('returns null rather than throwing when Redis is unreachable', async () => {
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(cache.get('k:live')).resolves.toBeNull();
  });
});
