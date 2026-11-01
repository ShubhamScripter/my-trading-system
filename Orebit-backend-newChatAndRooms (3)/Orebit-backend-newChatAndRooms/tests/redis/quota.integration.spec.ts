import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { QuotaService } from '../../redis/quota';
import type { DurableRedisQuotaService, RedisService } from '../../redis/client';

/**
 * ═══ THE LUA, AGAINST A REAL REDIS ══════════════════════════════════════════
 *
 * The rest of the suite is pure unit tests and dials nothing — see `tests/setup.ts`.
 * This file is the deliberate exception, and it earns it: every property that makes
 * `QuotaService` worth having lives inside the script, and a fake Redis proving
 * things about a fake sorted set proves nothing at all. Two-pass all-or-nothing, the
 * sliding window, and the idempotent refund are behaviours of Redis executing that
 * Lua, so they are tested by Redis executing that Lua.
 *
 * ─── Running it ─────────────────────────────────────────────────────────────
 *
 *   docker compose up -d redis-cache
 *
 * The default URL matches `docker-compose.yml`'s development password. Point
 * `TEST_REDIS_URL` elsewhere to use another instance.
 *
 * When nothing answers, the suite SKIPS rather than fails. A developer without
 * Docker running must not see a red suite for an environment problem — but the skip
 * is loud in the reporter, so it cannot quietly become "these tests never run".
 */

const URL = process.env['TEST_REDIS_URL'] ?? 'redis://:orebit-local-dev@127.0.0.1:6379';

/** A distinct prefix per run, so a leftover key from an interrupted run cannot make
 *  the next one fail — and so this is safe against a shared development instance. */
const PREFIX = `test:quota:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
let n = 0;
const key = (name: string): string => `${PREFIX}:${name}:${(n += 1)}`;

let connection: Redis | null = null;

async function reachable(): Promise<boolean> {
  const probe = new Redis(URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 1_000,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    connection = probe;
    return true;
  } catch {
    probe.disconnect();
    return false;
  }
}

let live = false;

/**
 * One test, skipped when nothing is listening.
 *
 * The reachability probe has to run in `beforeAll` rather than at module scope,
 * because the project compiles to CommonJS and there is no top-level await — so
 * `describe.skipIf`, which is evaluated at collection time, cannot see the answer.
 * `ctx.skip()` decides per test instead, which reaches the same place.
 */
function integration(name: string, body: () => Promise<void>): void {
  it(name, async (ctx: TestContext) => {
    if (!live) ctx.skip();
    await body();
  });
}

describe('QuotaService against a live Redis', () => {
  let quota: QuotaService;

  beforeAll(async () => {
    live = await reachable();
    if (!live) return;
    const redis = connection as unknown as RedisService;
    quota = new QuotaService(redis, redis as unknown as DurableRedisQuotaService);
  });

  afterAll(async () => {
    if (connection === null) return;
    const keys = await connection.keys(`${PREFIX}*`);
    if (keys.length > 0) await connection.del(...keys);
    await connection.quit();
  });

  const hourly = (limit: number) => ({ limit, windowSeconds: 3600 });

  async function charge(keys: readonly string[], limits: readonly number[]): Promise<void> {
    await quota.consumeAll(
      keys.map((k, i) => ({ key: k, rule: hourly(limits[i] as number) })),
      'burst',
      'deny',
    );
  }

  integration('admits exactly N and refuses N+1', async () => {
    const k = key('n-plus-one');

    for (let i = 0; i < 3; i += 1) {
      await expect(charge([k], [3])).resolves.toBeUndefined();
    }

    await expect(charge([k], [3])).rejects.toMatchObject({ type: 'rate_limited' });
  });

  integration('charges NOTHING when any one quota in the set would be exceeded', async () => {
    // The loophole the atomic script closes. Hourly is full, daily has room. A
    // check-then-charge implementation running two round trips would spend a daily
    // slot and then refuse — leaving the caller billed for a request that never
    // happened, and owing a compensation on a path that just returned 429.
    const hour = key('atomic-hour');
    const day = key('atomic-day');

    for (let i = 0; i < 2; i += 1) await charge([hour, day], [2, 10]);
    await expect(charge([hour, day], [2, 10])).rejects.toMatchObject({ type: 'rate_limited' });

    expect(await quota.used(hour, hourly(2), 'burst')).toBe(2);
    // The assertion that matters: still 2, not 3.
    expect(await quota.used(day, hourly(10), 'burst')).toBe(2);
  });

  integration('reports a Retry-After measured from the oldest charge, not the window length', async () => {
    const k = key('retry-after');
    await charge([k], [1]);

    try {
      await charge([k], [1]);
      throw new Error('expected a refusal');
    } catch (err) {
      // The window is an hour and the charge was just made, so the honest answer is
      // "about an hour" — and, crucially, it shrinks as the charge ages rather than
      // being the constant 3600 a fixed window would report.
      const retryAfterSeconds = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
      expect(retryAfterSeconds).toBeGreaterThan(3590);
      expect(retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  integration('slides: a charge that ages out of the window frees its slot', async () => {
    // A one-second window makes this observable without faking a clock — the script
    // scores in real milliseconds, so a fake timer would not move it.
    const k = key('sliding');
    const oneSecond = { limit: 1, windowSeconds: 1 };

    await quota.consumeAll([{ key: k, rule: oneSecond }], 'burst', 'deny');
    await expect(
      quota.consumeAll([{ key: k, rule: oneSecond }], 'burst', 'deny'),
    ).rejects.toMatchObject({ type: 'rate_limited' });

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // No boundary was crossed and no counter reset — the first charge simply left the
    // window. This is the property a fixed window cannot offer: there is no instant
    // at which the whole budget becomes available at once.
    await expect(
      quota.consumeAll([{ key: k, rule: oneSecond }], 'burst', 'deny'),
    ).resolves.toBeDefined();
  });

  integration('refunds idempotently — three refunds of one charge return one slot', async () => {
    const k = key('refund');
    const rule = hourly(2);

    const first = await quota.consumeAll([{ key: k, rule }], 'burst', 'deny');
    await quota.consumeAll([{ key: k, rule }], 'burst', 'deny');
    expect(await quota.used(k, rule, 'burst')).toBe(2);

    await quota.refund(first, 'burst');
    await quota.refund(first, 'burst');
    await quota.refund(first, 'burst');

    // One, not negative one. Against a DECR counter the same three calls would leave
    // the bucket below zero — free quota, minted by deliberately failing a send.
    expect(await quota.used(k, rule, 'burst')).toBe(1);
  });

  integration('gives the refunded slot back to the next caller', async () => {
    const k = key('refund-frees');
    const rule = hourly(1);

    const charged = await quota.consumeAll([{ key: k, rule }], 'burst', 'deny');
    await expect(
      quota.consumeAll([{ key: k, rule }], 'burst', 'deny'),
    ).rejects.toMatchObject({ type: 'rate_limited' });

    await quota.refund(charged, 'burst');

    await expect(
      quota.consumeAll([{ key: k, rule }], 'burst', 'deny'),
    ).resolves.toBeDefined();
  });

  integration('holds the limit under concurrency', async () => {
    // Ten callers, five slots, all in flight at once. The script is atomic, so
    // exactly five may win however the round trips interleave.
    const k = key('concurrent');
    const rule = hourly(5);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        quota.consumeAll([{ key: k, rule }], 'burst', 'deny'),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await quota.used(k, rule, 'burst')).toBe(5);
  });

  integration('expires a key once its longest window has passed', async () => {
    // Without PEXPIRE the sorted sets would accumulate forever: a key whose members
    // have all aged out is only trimmed when someone next touches it, and nobody ever
    // touches the key of an address that signed up once.
    const k = key('ttl');
    await quota.consumeAll([{ key: k, rule: { limit: 5, windowSeconds: 60 } }], 'burst', 'deny');

    const ttl = await (connection as Redis).pttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
