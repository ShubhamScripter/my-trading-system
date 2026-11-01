import { vi } from 'vitest';

/**
 * ═══ THE SHARED REDIS DOUBLE ═════════════════════════════════════════════════
 *
 * A minimal in-memory stand-in for the subset of ioredis that `CacheService` and
 * `LockService` actually call. Both of those are used UNMODIFIED against it, which
 * is the point: the code under test is the real coordination logic, and only the
 * store beneath it is fake.
 *
 * ─── Why this exists as a shared helper ────────────────────────────────────
 *
 * It grew out of the per-file `makeRedis` in bff.refresh.spec.ts, which honoured
 * `SET NX` — the one detail that made F04's contention tests meaningful, because a
 * double that always answers OK lets every caller "win" the lock and the race under
 * test never happens.
 *
 * That double was right about NX and wrong about two other things, and both had to
 * be fixed before F10 could be tested at all:
 *
 *   TTL      `set` discarded `'EX'` and the seconds entirely, so the store was a
 *            plain Map with no notion of expiry. "The lock lapses while its holder
 *            is still running" — which IS F10 — was not expressible. It is now, via
 *            `expire(key)`: a deterministic, test-driven lapse at a chosen instant.
 *            No timers, no sleeps; the test decides, exactly as the barrier does.
 *
 *   EVAL     it deleted unconditionally and never looked at `ARGV[1]`, so
 *            `LockService`'s Lua compare-and-delete was never exercised AS a
 *            compare. A test could not tell the shipped ownership-aware release
 *            from a bare `DEL` — which is why "owner A must not delete owner B's
 *            lock" was true in production but unproven. The comparison is
 *            implemented below.
 *
 * ─── What is deliberately NOT modelled ─────────────────────────────────────
 *
 * Time does not pass on its own. Entries carry an expiry and reads honour it, so a
 * spec using `vi.setSystemTime` behaves sensibly, but nothing lapses in the
 * background. A concurrency test that depended on wall-clock expiry would be a test
 * that sometimes proves nothing, which is the failure mode this whole suite is
 * written to avoid.
 */

interface Entry {
  readonly value: string;
  /** Epoch ms, or null for no TTL. */
  readonly expiresAt: number | null;
}

/** Which command a fault applies to. `null` means "no fault". */
export interface Faults {
  /**
   * Reject `SET` for keys matching this predicate.
   *
   * A predicate rather than a flag because F09's failure is specifically the
   * post-commit publish: the record write must fail while the LOCK write keeps
   * working, or the test is exercising a lock-acquire failure instead — which is a
   * different case with a different answer, already covered by F04.
   */
  set?: ((key: string) => boolean) | null;
  get?: ((key: string) => boolean) | null;
  eval?: boolean | null;
}

export function makeRedisDouble(faults: Faults = {}) {
  const store = new Map<string, Entry>();

  /** Absent, or lapsed. Reads collapse the two, exactly as Redis does. */
  function live(key: string): Entry | null {
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  /** `('EX', 30, 'NX')` → `{ ttlSeconds: 30, nx: true }`. Positional, like the
   *  real thing: the seconds follow the `EX` token. */
  function parseSetArgs(args: readonly unknown[]): { ttlSeconds: number | null; nx: boolean } {
    let ttlSeconds: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === 'EX') {
        const seconds = args[i + 1];
        if (typeof seconds === 'number') ttlSeconds = seconds;
        i += 1;
      } else if (arg === 'NX') {
        nx = true;
      }
    }
    return { ttlSeconds, nx };
  }

  const redis = {
    store,

    get: vi.fn(async (key: string) => {
      if (faults.get?.(key) === true) throw new Error(`redis double: GET ${key} failed`);
      return live(key)?.value ?? null;
    }),

    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (faults.set?.(key) === true) throw new Error(`redis double: SET ${key} failed`);

      const { ttlSeconds, nx } = parseSetArgs(args);
      // NX is checked against a LIVE entry, so a lapsed key is acquirable — which is
      // the whole of the F10 scenario.
      if (nx && live(key) !== null) return null;

      store.set(key, {
        value,
        expiresAt: ttlSeconds === null ? null : Date.now() + ttlSeconds * 1000,
      });
      return 'OK';
    }),

    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),

    exists: vi.fn(async (key: string) => (live(key) === null ? 0 : 1)),

    getdel: vi.fn(async (key: string) => {
      const value = live(key)?.value ?? null;
      store.delete(key);
      return value;
    }),

    /**
     * The compare-and-delete `LockService.release` runs, actually comparing.
     *
     * Not a general Lua interpreter — it recognises the one script this codebase
     * evaluates and implements its semantics. A double that ignored `ARGV[1]` (as the
     * previous one did) reports success for a release that must be a no-op, which is
     * precisely the bug it would be asked to detect.
     */
    eval: vi.fn(async (script: string, _numKeys: number, key: string, ...argv: unknown[]) => {
      if (faults.eval === true) throw new Error('redis double: EVAL failed');

      const isCompareAndDelete = script.includes('redis.call("get"') && script.includes('del');
      if (!isCompareAndDelete) {
        throw new Error(`redis double: unrecognised script\n${script}`);
      }

      const entry = live(key);
      if (entry !== null && entry.value === argv[0]) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),

    // ─── test controls ──────────────────────────────────────────────────────

    /**
     * Lapse a key NOW, as its TTL would have.
     *
     * This is how a test expresses "the lock expired while its holder was still
     * working" without waiting for anything. Returns whether a key was actually
     * there, so a test cannot silently expire the wrong key and still pass.
     */
    expire(key: string): boolean {
      return store.delete(key);
    },

    /** The TTL a key was written with, in seconds, or null. For asserting that a
     *  record's TTL really is the session ceiling. */
    ttlOf(key: string): number | null {
      const entry = store.get(key);
      if (entry === undefined || entry.expiresAt === null) return null;
      return Math.round((entry.expiresAt - Date.now()) / 1000);
    },

    /** The raw stored value, bypassing expiry — for asserting on what was written
     *  even after a test has lapsed it. */
    raw(key: string): string | null {
      return store.get(key)?.value ?? null;
    },
  };

  return redis;
}

export type RedisDouble = ReturnType<typeof makeRedisDouble>;
