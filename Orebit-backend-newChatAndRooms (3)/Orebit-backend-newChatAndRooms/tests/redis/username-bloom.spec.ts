import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsernameBloomService } from '../../redis/username-bloom';

/**
 * The availability filter.
 *
 * The Redis double holds a real bit set and answers the two scripts the way the Lua
 * does — `test` is an AND over the offsets, `add` sets them — so the hashing is
 * genuinely exercised rather than stubbed. What that buys is the property this whole
 * structure lives or dies by:
 *
 *   NO FALSE NEGATIVES. A username that was added must never report absent.
 *
 * A false positive costs one database query. A false negative hands two accounts the
 * same username, so it is tested with volume rather than with an example.
 */

interface Fake {
  bits: Set<number>;
  keys: Map<string, string>;
  failing: boolean;
  setbits: number;
}

let fake: Fake;
let bloom: UsernameBloomService;

function makeRedis(): Record<string, unknown> {
  const guard = () => {
    if (fake.failing) throw new Error('redis is down');
  };

  return {
    // The real client attaches the Lua here; the double is already holding equivalent
    // implementations, so this only has to exist.
    defineCommand: () => undefined,

    // `(numKeys, key, ...offsets)`, matching how the service calls it.
    usernameBloomTest: async (_numKeys: number, _key: string, ...offsets: number[]) => {
      guard();
      return offsets.every((offset) => fake.bits.has(offset)) ? 1 : 0;
    },
    usernameBloomAdd: async (_numKeys: number, _key: string, ...offsets: number[]) => {
      guard();
      for (const offset of offsets) fake.bits.add(offset);
      fake.setbits = fake.bits.size;
      return 1;
    },

    exists: async (key: string) => {
      guard();
      return fake.keys.has(key) ? 1 : 0;
    },
    set: async (key: string, value: string, ..._rest: unknown[]) => {
      guard();
      if (_rest.includes('NX') && fake.keys.has(key)) return null;
      fake.keys.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      guard();
      fake.keys.delete(key);
      return 1;
    },
  };
}

/** A service whose filter is built and trusted — the steady state in production. */
async function ready(): Promise<UsernameBloomService> {
  const service = new UsernameBloomService(makeRedis() as never);
  await service.markReady();
  return service;
}

beforeEach(() => {
  fake = { bits: new Set(), keys: new Map(), failing: false, setbits: 0 };
  bloom = new UsernameBloomService(makeRedis() as never);
});

describe('the readiness flag is the correctness switch', () => {
  it('answers `maybe` for everything before the filter is built', async () => {
    // An unbuilt bitmap is all zeroes, and all zeroes says "definitely absent" about
    // every username in the product. Until the flag is set, nothing may be trusted.
    await expect(bloom.test('never_seen')).resolves.toBe('maybe');
    expect(bloom.isReady()).toBe(false);
  });

  it('does not even query Redis while it is not ready', async () => {
    const redis = makeRedis();
    const spy = vi.spyOn(redis, 'usernameBloomTest' as never);
    const service = new UsernameBloomService(redis as never);

    await service.test('never_seen');

    expect(spy).not.toHaveBeenCalled();
  });

  it('trusts negatives once ready', async () => {
    const service = await ready();
    await expect(service.test('never_seen')).resolves.toBe('absent');
    expect(service.isReady()).toBe(true);
  });
});

describe('membership', () => {
  it('reports a name it was told about as `maybe`', async () => {
    const service = await ready();
    await service.add('shubh_dev');

    await expect(service.test('shubh_dev')).resolves.toBe('maybe');
  });

  it('reports a name it was never told about as `absent`', async () => {
    const service = await ready();
    await service.add('shubh_dev');

    await expect(service.test('someone_else')).resolves.toBe('absent');
  });

  it('NEVER produces a false negative, over a large set', async () => {
    // The one error this structure may not make: an added name reporting absent means
    // the availability check skips the database and offers a username somebody holds.
    const service = await ready();
    const names = Array.from({ length: 2_000 }, (_, i) => `user_name_${i}`);

    await service.add(...names);

    for (const name of names) {
      expect(await service.test(name)).toBe('maybe');
    }
  });

  it('keeps false positives rare enough for the fast path to be worth having', async () => {
    const service = await ready();
    await service.add(...Array.from({ length: 2_000 }, (_, i) => `user_name_${i}`));

    let positives = 0;
    const probes = 5_000;
    for (let i = 0; i < probes; i += 1) {
      if ((await service.test(`unseen_probe_${i}`)) === 'maybe') positives += 1;
    }

    // Generous — the point is that the common case skips Postgres, not a precise rate.
    expect(positives / probes).toBeLessThan(0.01);
  });

  it('adds many names in one call rather than one round trip each', async () => {
    const redis = makeRedis();
    const spy = vi.spyOn(redis, 'usernameBloomAdd' as never);
    const service = new UsernameBloomService(redis as never);
    await service.markReady();

    await service.add('one_name', 'two_names', 'three_name');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when given nothing', async () => {
    const service = await ready();
    await service.add();
    expect(fake.bits.size).toBe(0);
  });

  it('treats the same name identically every time it is hashed', async () => {
    // Load-bearing: the write path adds a name and a later check hashes it again. If
    // those disagreed the filter would report absent for names it holds.
    const service = await ready();
    await service.add('stable_name');
    const after = new Set(fake.bits);

    await service.add('stable_name');

    expect(fake.bits).toEqual(after);
  });
});

describe('normalisation is the caller’s job, and the filter is case-sensitive', () => {
  it('does not fold case itself', async () => {
    // Deliberate: every caller passes the output of `normaliseUsername`, and a filter
    // that also folded would hide a caller that forgot to. Here the mismatch is visible.
    const service = await ready();
    await service.add('shubh_dev');

    await expect(service.test('SHUBH_DEV')).resolves.toBe('absent');
  });
});

describe('when Redis is unavailable', () => {
  it('answers `maybe` rather than throwing, so the check falls through to Postgres', async () => {
    const service = await ready();
    fake.failing = true;

    // Slower, and right. An availability check that threw would break a typing field
    // over a cache outage.
    await expect(service.test('any_name')).resolves.toBe('maybe');
  });

  it('swallows a failed add — the transaction has already committed', async () => {
    const service = await ready();
    fake.failing = true;

    await expect(service.add('some_name')).resolves.toBeUndefined();
  });

  it('refuses to claim a warm-up it cannot verify', async () => {
    fake.failing = true;
    await expect(bloom.beginWarmUp(60)).resolves.toBe(false);
    expect(bloom.isReady()).toBe(false);
  });

  it('leaves the filter untrusted when the ready flag cannot be written', async () => {
    fake.failing = true;
    await bloom.markReady();

    expect(bloom.isReady()).toBe(false);
    await expect(bloom.test('never_seen')).resolves.toBe('maybe');
  });
});

describe('warm-up is single-flight', () => {
  it('lets the first caller claim it and refuses the second', async () => {
    await expect(bloom.beginWarmUp(60)).resolves.toBe(true);

    const second = new UsernameBloomService(makeRedis() as never);
    await expect(second.beginWarmUp(60)).resolves.toBe(false);
  });

  it('refuses a claim when the filter is already built, and starts trusting it', async () => {
    await bloom.markReady();

    const later = new UsernameBloomService(makeRedis() as never);
    await expect(later.beginWarmUp(60)).resolves.toBe(false);

    // The loser of the race still benefits: readiness lives in Redis, so it reads the
    // winner's flag rather than staying on the database forever.
    expect(later.isReady()).toBe(true);
  });

  it('releases the claim once the filter is ready', async () => {
    await bloom.beginWarmUp(60);
    await bloom.markReady();

    const next = new UsernameBloomService(makeRedis() as never);
    // Not claimable, but because it is DONE rather than because a lock is stuck.
    await expect(next.beginWarmUp(60)).resolves.toBe(false);
    expect(next.isReady()).toBe(true);
  });
});
