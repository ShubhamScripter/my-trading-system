import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { QuotaService } from '../../redis/quota';
import type { DurableRedisQuotaService, RedisService } from '../../redis/client';

/**
 * The TypeScript half of `QuotaService`: how a call is marshalled into the script,
 * and what is done with what comes back.
 *
 * The Lua itself is NOT exercised here — a fake that returned whatever this file
 * expected would be testing the fake. It is covered against a real Redis in
 * `quota.integration.spec.ts`, which is where the two-pass check, the sliding window
 * and the idempotent refund are actually proven.
 */

const HOURLY = { limit: 5, windowSeconds: 3600 };
const DAILY = { limit: 20, windowSeconds: 86_400 };

/**
 * A connection whose custom commands are already attached.
 *
 * `defineCommand` is a no-op here: on a real ioredis it installs the method, and
 * here the method is installed up front so `attach` finds it and leaves it alone.
 */
function createRedis() {
  return {
    defineCommand: vi.fn(),
    quotaConsumeAll: vi.fn<(...args: (string | number)[]) => Promise<[number, number]>>(),
    quotaRefundAll: vi.fn<(...args: (string | number)[]) => Promise<number>>(),
    zremrangebyscore: vi.fn(),
    zcard: vi.fn(),
  };
}

let burst: ReturnType<typeof createRedis>;
let durable: ReturnType<typeof createRedis>;
let quota: QuotaService;

beforeEach(() => {
  burst = createRedis();
  durable = createRedis();
  quota = new QuotaService(
    burst as unknown as RedisService,
    durable as unknown as DurableRedisQuotaService,
  );
});

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('QuotaService.consumeAll — what reaches the script', () => {
  it('sends every key first, then now, the token, and a limit/window pair per key', async () => {
    burst.quotaConsumeAll.mockResolvedValue([0, 0]);

    const charge = await quota.consumeAll(
      [
        { key: 'rate:a', rule: HOURLY },
        { key: 'rate:b', rule: DAILY },
      ],
      'burst',
      'deny',
    );

    const args = burst.quotaConsumeAll.mock.calls[0] as (string | number)[];
    // numKeys, then the keys, then ARGV.
    expect(args[0]).toBe(2);
    expect(args.slice(1, 3)).toEqual(['rate:a', 'rate:b']);
    expect(args[4]).toBe(charge.token);
    // Windows are converted to milliseconds for the script, which scores in ms.
    expect(args.slice(5)).toEqual([5, 3_600_000, 20, 86_400_000]);
  });

  it('routes a durable quota to the durable connection and leaves the cache alone', async () => {
    durable.quotaConsumeAll.mockResolvedValue([0, 0]);

    await quota.consumeAll([{ key: 'rate:mail', rule: HOURLY }], 'durable', 'deny');

    expect(durable.quotaConsumeAll).toHaveBeenCalledOnce();
    expect(burst.quotaConsumeAll).not.toHaveBeenCalled();
  });

  it('does not call the script at all when there is nothing to charge', async () => {
    const charge = await quota.consumeAll([], 'burst', 'deny');

    expect(burst.quotaConsumeAll).not.toHaveBeenCalled();
    expect(charge.keys).toEqual([]);
  });
});

describe('QuotaService.consumeAll — refusing', () => {
  it('reports the wait the script measured, not the nominal window', async () => {
    // Blocked on entry 1, with 90 seconds until its oldest charge ages out. The
    // window is an hour; answering "3600" would send the caller away for forty times
    // longer than it needs to wait.
    burst.quotaConsumeAll.mockResolvedValue([1, 90_000]);

    const err = await problem(
      quota.consumeAll([{ key: 'rate:a', rule: HOURLY }], 'burst', 'deny'),
    );

    expect(err.type).toBe(ERR.RATE_LIMITED);
    expect(err.retryAfterSeconds).toBe(90);
  });

  it('never answers a sub-second wait as zero', async () => {
    // 400ms rounds to 0, and `Retry-After: 0` reads as "go again now" — which
    // produces precisely the retry storm the header exists to prevent.
    burst.quotaConsumeAll.mockResolvedValue([1, 400]);

    const err = await problem(
      quota.consumeAll([{ key: 'rate:a', rule: HOURLY }], 'burst', 'deny'),
    );

    expect(err.retryAfterSeconds).toBe(1);
  });
});

describe('QuotaService.consumeAll — when Redis is unreachable', () => {
  it('denies where the quota is the only thing gating an expense', async () => {
    burst.quotaConsumeAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await problem(
      quota.consumeAll([{ key: 'rate:a', rule: HOURLY }], 'burst', 'deny'),
    );

    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('allows where a durable backstop exists, and returns a charge that refunds to nothing', async () => {
    burst.quotaConsumeAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const charge = await quota.consumeAll([{ key: 'rate:a', rule: HOURLY }], 'burst', 'allow');

    // The important half: nothing was charged, so the returned handle must name no
    // keys. A charge that claimed `rate:a` would send a later compensation to remove
    // a member that was never added — harmless with ZREM, but it would also let a
    // caller believe a quota had been spent when it had not.
    expect(charge.keys).toEqual([]);

    await quota.refund(charge, 'burst');
    expect(burst.quotaRefundAll).not.toHaveBeenCalled();
  });
});

describe('QuotaService.refund', () => {
  it('removes the charge token from every key it was charged against', async () => {
    burst.quotaConsumeAll.mockResolvedValue([0, 0]);
    burst.quotaRefundAll.mockResolvedValue(1);

    const charge = await quota.consumeAll(
      [
        { key: 'rate:a', rule: HOURLY },
        { key: 'rate:b', rule: DAILY },
      ],
      'burst',
      'deny',
    );
    await quota.refund(charge, 'burst');

    expect(burst.quotaRefundAll).toHaveBeenCalledWith(2, 'rate:a', 'rate:b', charge.token);
  });

  it('swallows a failure rather than replacing one problem with a 500', async () => {
    burst.quotaConsumeAll.mockResolvedValue([0, 0]);
    burst.quotaRefundAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const charge = await quota.consumeAll([{ key: 'rate:a', rule: HOURLY }], 'burst', 'deny');

    // A refund is already the unhappy path. Failing it leaves the caller one slot
    // poorer, which is the direction that cannot be abused.
    await expect(quota.refund(charge, 'burst')).resolves.toBeUndefined();
  });
});
