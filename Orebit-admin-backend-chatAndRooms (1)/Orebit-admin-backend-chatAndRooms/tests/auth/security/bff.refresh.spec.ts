import { describe, expect, it, vi } from 'vitest';
import { BffSessionService } from '../../../auth/security/bff.session';
import { makeRedisDouble } from '../../redis/double';
import { CacheService } from '../../../redis/cache';
import { LockService } from '../../../redis/lock';
import { SESSION } from '../../../auth/auth.constants';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { toPublicAdmin } from '../../../auth/auth.utility';
import { makeAdmin } from '../../harness';
import type { ClientContext, IssuedSession } from '../../../auth/auth.types';

/**
 * ═══ CONCURRENT REQUESTS MUST NOT 401 BECAUSE ANOTHER IS REFRESHING (F04) ════
 *
 * Under the BFF the browser never refreshes; the backend does, mid-request. So two
 * ordinary API calls landing together on one session routinely both discover that
 * the access token needs rotating. Exactly one may rotate — the refresh token is
 * one-use and presenting it twice is what reuse detection exists to catch — so the
 * other has to be told the answer rather than turned away.
 *
 * It was turned away. The loser of the lock got ONE re-read with no wait at all, so
 * if the winner had not yet finished a Postgres transaction plus two ES256
 * signatures, the loser read the old record, saw an expired access token, returned
 * null, and the guard raised `401 unauthenticated` — for a session that was in
 * perfect health.
 *
 * ─── What is real here and what is doubled ─────────────────────────────────
 *
 * Real: `BffSessionService`, `CacheService`, `LockService`, and a Redis double that
 * honours `SET NX` so the lock genuinely admits one winner. Doubled: `rotate`, which
 * is gated on a promise barrier so the interleaving is chosen by the test rather
 * than by chance.
 *
 * No test here sleeps to make a race happen. The barrier decides the order; the
 * bounded wait inside the service is what does the waiting.
 */

const CLIENT: ClientContext = {
  ip: '203.0.113.9',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'f'.repeat(64),
  userAgent: 'vitest',
};

const ROTATED_ACCESS = 'access-token-generation-two';

function makeIssued(overrides: Partial<IssuedSession> = {}): IssuedSession {
  return {
    sessionId: '01920000-0000-7000-8000-00000000000b',
    accessToken: 'access-token-generation-one',
    refreshToken: 'refresh-token-generation-one',
    accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    refreshExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    reauthenticateAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    admin: toPublicAdmin(makeAdmin()),
    ...overrides,
  };
}

/**
 * The shared Redis double — see tests/redis/double.ts.
 *
 * It honours `SET … NX`, which is what makes the contention tests below meaningful:
 * a double that always answers OK lets every caller "win" the lock, and the race
 * under test never happens. `CacheService` and `LockService` are used unmodified.
 *
 * It is also STRICTER than the local double this file used to carry — it honours
 * `EX` and it actually compares `ARGV[1]` in the release script. Both were needed for
 * F10, and every case here passes against the stricter version, which is the point
 * of re-running them after the swap.
 */
const makeRedis = makeRedisDouble;

/** A promise the test resolves when it wants the winner's rotation to complete. */
function barrier() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

function build(rotate: ReturnType<typeof vi.fn>) {
  const redis = makeRedis();
  const cache = new CacheService(redis as never);
  const locks = new LockService(redis as never);
  const service = new BffSessionService({ rotate } as never, cache, locks);
  return { redis, cache, locks, service, rotate };
}

/** A session whose access token has ALREADY expired — the case with no stale token
 *  to fall back on, which is where the false 401 lived. */
async function staleSession(service: BffSessionService): Promise<string> {
  return service.create(makeIssued({ accessExpiresAt: new Date(Date.now() - 1000) }));
}

describe('F04 — concurrent refresh', () => {
  // ── Case 1 ──────────────────────────────────────────────────────────────────
  it('rotates once and serves both requests when two arrive together', async () => {
    const { gate, release } = barrier();
    const rotate = vi.fn(async () => {
      await gate;
      return makeIssued({ accessToken: ROTATED_ACCESS, accessExpiresAt: new Date(Date.now() + 900_000) });
    });
    const t = build(rotate);
    const handle = await staleSession(t.service);

    // Both in flight before either can finish: the winner is blocked on the barrier.
    const a = t.service.resolve(handle, CLIENT);
    const b = t.service.resolve(handle, CLIENT);
    release();

    await expect(a).resolves.toBe(ROTATED_ACCESS);
    await expect(b).resolves.toBe(ROTATED_ACCESS);
    // One-use rotation is intact: the loser waited for the answer, it did not go and
    // present the same refresh token a second time.
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  // ── Case 2 ──────────────────────────────────────────────────────────────────
  it('serves N concurrent requests with no false 401 and exactly one rotation', async () => {
    const { gate, release } = barrier();
    const rotate = vi.fn(async () => {
      await gate;
      return makeIssued({ accessToken: ROTATED_ACCESS, accessExpiresAt: new Date(Date.now() + 900_000) });
    });
    const t = build(rotate);
    const handle = await staleSession(t.service);

    const requests = Array.from({ length: 8 }, () => t.service.resolve(handle, CLIENT));
    release();
    const tokens = await Promise.all(requests);

    expect(tokens).toEqual(Array.from({ length: 8 }, () => ROTATED_ACCESS));
    expect(tokens.filter((x) => x === null)).toHaveLength(0);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  // ── Case 3 ──────────────────────────────────────────────────────────────────
  it('a request arriving after the rotation reads the new record and does not rotate again', async () => {
    const rotate = vi.fn(async () =>
      makeIssued({ accessToken: ROTATED_ACCESS, accessExpiresAt: new Date(Date.now() + 900_000) }),
    );
    const t = build(rotate);
    const handle = await staleSession(t.service);

    await expect(t.service.resolve(handle, CLIENT)).resolves.toBe(ROTATED_ACCESS);
    await expect(t.service.resolve(handle, CLIENT)).resolves.toBe(ROTATED_ACCESS);

    expect(rotate).toHaveBeenCalledTimes(1);
  });

  // ── Case 4 ──────────────────────────────────────────────────────────────────
  /**
   * When the refresh genuinely fails, waiters must not be quietly authenticated.
   * The winner's refusal is the session's refusal.
   */
  it('does not falsely authenticate waiters when the rotation itself fails', async () => {
    const { gate, release } = barrier();
    const rotate = vi.fn(async () => {
      await gate;
      throw new ProblemException({ type: ERR.SESSION_REVOKED });
    });
    const t = build(rotate);
    const handle = await staleSession(t.service);

    const winner = t.service.resolve(handle, CLIENT).catch((e: unknown) => e);
    const waiter = t.service.resolve(handle, CLIENT).catch((e: unknown) => e);
    release();

    // The winner learns the real reason.
    expect((await winner) as ProblemException).toBeInstanceOf(ProblemException);
    expect(((await winner) as ProblemException).type).toBe(ERR.SESSION_REVOKED);
    // The waiter is refused too — never handed a token.
    const w = await waiter;
    expect(typeof w === 'string').toBe(false);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  // ── Case 5 ──────────────────────────────────────────────────────────────────
  /**
   * ═══ A STUCK OWNER IS A DEPENDENCY PROBLEM, NOT AN INVALID SESSION ═════════
   *
   * If the winner never writes — it crashed, or its transaction is wedged — the
   * waiter's budget runs out. Answering 401 there would sign out an admin whose
   * session is perfectly valid, which is F04 again in slow motion. A transient
   * refusal tells the client to retry instead.
   */
  it('raises a transient refusal, not a 401, when the wait budget is exhausted', async () => {
    const rotate = vi.fn(async () => new Promise<IssuedSession>(() => undefined)); // never settles
    const t = build(rotate);
    const handle = await staleSession(t.service);

    void t.service.resolve(handle, CLIENT); // takes the lock, never finishes
    const waiter = await t.service.resolve(handle, CLIENT).catch((e: unknown) => e);

    expect(waiter).toBeInstanceOf(ProblemException);
    expect((waiter as ProblemException).type).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    expect((waiter as ProblemException).status).toBe(503);
  }, 15_000);

  // ── Case 8 ──────────────────────────────────────────────────────────────────
  /**
   * The wait is bounded by construction. A winner that never writes must cost a
   * capped number of reads and then stop — never an unbounded poll, which is the
   * objection the previous single-re-read design was defending against.
   */
  it('polls a bounded number of times and then gives up', async () => {
    const rotate = vi.fn(async () => new Promise<IssuedSession>(() => undefined));
    const t = build(rotate);
    const handle = await staleSession(t.service);

    void t.service.resolve(handle, CLIENT);
    const before = t.redis.get.mock.calls.length;
    await t.service.resolve(handle, CLIENT).catch(() => undefined);
    const reads = t.redis.get.mock.calls.length - before;

    // Small and finite. The exact number is the backoff schedule's length, not a
    // free parameter — what matters is that it cannot grow without limit.
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(10);
  }, 15_000);

  /** The common case must stay cheap: a still-valid access token inside the refresh
   *  skew proceeds immediately rather than waiting for the holder. */
  it('does not wait at all when the caller still holds a usable token', async () => {
    const { gate, release } = barrier();
    const rotate = vi.fn(async () => {
      await gate;
      return makeIssued({ accessToken: ROTATED_ACCESS });
    });
    const t = build(rotate);
    // Inside the skew, so a refresh is due — but the token has not actually expired.
    const handle = await t.service.create(
      makeIssued({ accessExpiresAt: new Date(Date.now() + 5_000) }),
    );

    void t.service.resolve(handle, CLIENT);
    await expect(t.service.resolve(handle, CLIENT)).resolves.toBe('access-token-generation-one');
    release();
  });

  /**
   * ═══ AN UNREACHABLE REDIS IS NOT "SOMEBODY ELSE HOLDS THE LOCK" ════════════
   *
   * `withLock` answers `null` for "the lock is held", and the caller reacts by
   * waiting for that holder to publish a result. A Redis outage must NOT be folded
   * into that same answer: there is no holder, so the wait would be a second spent
   * on nothing before failing anyway.
   *
   * Nor may it escape untyped. The acquire was the one unguarded Redis call left in
   * the auth stack, so an outage there surfaced as a bare ioredis rejection and the
   * problem filter rendered it `500 internal_error` — telling the client the server
   * is broken, when what actually happened is a dependency being briefly away and
   * the request being perfectly retryable.
   *
   * Reachable in practice on a blip rather than a full outage: a full outage fails
   * the record READ first and never reaches the lock. This is the failover /
   * connection-reset case, where the record was served and Redis then went away.
   */
  it('raises the typed transient refusal when the lock cannot be acquired at all', async () => {
    const rotate = vi.fn();
    const t = build(rotate);
    const handle = await staleSession(t.service);

    // The record is readable; Redis dies on the acquire.
    t.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    const err = await t.service.resolve(handle, CLIENT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    expect((err as ProblemException).status).toBe(503);
    // And it did not sit out the whole wait budget for a holder that never existed.
    expect(rotate).not.toHaveBeenCalled();
  });

  it('does not treat an unreachable Redis as a held lock', async () => {
    const t = build(vi.fn());
    t.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    // `null` is reserved for "held". An outage is a different answer entirely.
    const err = await t.locks
      .withLock('lock:bff-refresh:x', 5, async () => 'ran')
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.SESSION_STORE_UNAVAILABLE);
  });

  it('still answers null — not a refusal — when the lock is genuinely held', async () => {
    const t = build(vi.fn());
    await t.locks.withLock('lock:contended', 5, async () => 'first');

    // Held by a live holder: the caller should wait for it, so this must stay null.
    // Written through the double's own `set` rather than poked into the map, so the
    // entry carries a TTL exactly as a real holder's would.
    await t.redis.set('lock:contended', 'someone-else', 'EX', 5, 'NX');
    await expect(t.locks.withLock('lock:contended', 5, async () => 'second')).resolves.toBeNull();
  });

  it('keeps the wait budget inside the lock it waits on', () => {
    // A waiter that outlived the lock could start waiting on a holder that no longer
    // exists, which is how a bounded wait becomes a pointless one.
    expect(SESSION.REFRESH_WAIT_MS).toBeLessThan(SESSION.REFRESH_LOCK_SECONDS * 1000);
  });
});
