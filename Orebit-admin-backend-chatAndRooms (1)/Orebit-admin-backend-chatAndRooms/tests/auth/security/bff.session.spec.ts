import { describe, expect, it, vi } from 'vitest';
import { SESSION } from '../../../auth/auth.constants';
import type { ClientContext, IssuedSession } from '../../../auth/auth.types';
import { BffSessionService } from '../../../auth/security/bff.session';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { toPublicAdmin } from '../../../auth/auth.utility';
import { makeAdmin } from '../../harness';

/**
 * ═══ WHAT THIS FILE EXISTS TO PIN ══════════════════════════════════════════
 *
 * The record that holds the access and refresh tokens on the browser's behalf. Three
 * properties, and each of them is load-bearing in a way a casual reading misses:
 *
 *   1. NEITHER TOKEN LEAVES. `resolve` hands back an access token to the guard,
 *      in-process, and nothing here ever produces a refresh token to a caller.
 *   2. THE ENVELOPE IS BOUND TO ITS HANDLE. A record copied from one handle to
 *      another must not open. Without that, anyone who can write to Redis hands a
 *      second browser the first admin's refresh token.
 *   3. CONCURRENT REFRESH DOES NOT LOOK LIKE THEFT. `SessionService.rotate` revokes
 *      the whole family on a rotation conflict, which is right for a client-driven
 *      refresh and catastrophic for an automatic one. The lock is what keeps ordinary
 *      concurrency from signing an admin out, and it is the single most important
 *      thing here.
 *
 * A real `CacheService` is not used — the point being asserted is the SHAPE of what
 * is stored and the ORDER of what is called, and a recording double captures both
 * exactly. Whether `SET EX` is atomic is Redis's guarantee, not this file's.
 */

const HANDLE_LENGTH = Math.ceil((SESSION.HANDLE_BYTES * 4) / 3);

const CLIENT: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceFingerprint: 'f'.repeat(32),
  userAgent: 'vitest',
};

const ACCESS = 'access-token-generation-one';
const REFRESH = 'refresh-token-generation-one';

function makeIssued(overrides: Partial<IssuedSession> = {}): IssuedSession {
  return {
    sessionId: '01920000-0000-7000-8000-00000000000b',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    refreshExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    reauthenticateAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    admin: toPublicAdmin(makeAdmin()),
    ...overrides,
  };
}

/**
 * A cache that actually stores, so a write followed by a read behaves like Redis
 * would. `set` records its TTL and its `onError` choice as well as the value,
 * because both are assertions below.
 */
function makeCache() {
  const store = new Map<string, string>();
  const writes: { key: string; ttl: number; onError: string }[] = [];

  return {
    store,
    writes,
    set: vi.fn(async (key: string, value: string, ttl: number, onError: string) => {
      writes.push({ key, ttl, onError });
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    clear: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/** A lock that grants by default. `held: true` simulates another request holding it,
 *  in which case the callback must never run. */
function makeLocks(options: { held?: boolean } = {}) {
  const withLock = vi.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) =>
    options.held === true ? null : fn(),
  );
  return { withLock };
}

/**
 * `cache` is injectable so two service instances can be built over ONE store — which
 * is how the lock cases below model two concurrent requests against the same
 * session. Building each with its own cache would make those tests pass because the
 * record was missing rather than because the lock was held.
 */
function build(
  options: {
    rotate?: ReturnType<typeof vi.fn>;
    held?: boolean;
    cache?: ReturnType<typeof makeCache>;
  } = {},
) {
  const cache = options.cache ?? makeCache();
  const locks = makeLocks({ held: options.held });
  const rotate = options.rotate ?? vi.fn();
  const sessions = { rotate };

  const service = new BffSessionService(sessions as never, cache as never, locks as never);
  return { service, cache, locks, rotate };
}

describe('create', () => {
  it('mints a handle of the documented shape', async () => {
    const { service } = build();
    const handle = await service.create(makeIssued());

    // base64url of 32 bytes. Derived from the constant rather than written out, so
    // changing the byte count cannot leave this checking the old width.
    expect(handle).toHaveLength(HANDLE_LENGTH);
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('mints a different handle every time', async () => {
    const { service } = build();
    const a = await service.create(makeIssued());
    const b = await service.create(makeIssued());
    expect(a).not.toBe(b);
  });

  /** ═══ NEITHER TOKEN IS READABLE FROM THE STORED VALUE ═══════════════════ */
  it('stores the refresh token sealed, never in the clear', async () => {
    const { service, cache } = build();
    const handle = await service.create(makeIssued());
    const raw = cache.store.get(`bff:session:${handle}`) ?? '';

    // The access token is stored as-is and that is deliberate — it dies in fifteen
    // minutes and `assertLive` refuses it the moment its session is revoked.
    expect(raw).toContain(ACCESS);
    // The refresh token is a twelve-hour grant. A dump of the Redis volume must not
    // hand it over.
    expect(raw).not.toContain(REFRESH);
  });

  it('fails closed on a write it could not complete', async () => {
    // A record that was never stored describes a session the browser is about to be
    // handed a cookie for and could never use. Refusing now beats looking successful
    // and 401-ing on the next request.
    //
    // `'unavailable'` rather than `'deny'`, and the difference is the slug, not the
    // decision — both refuse. `'deny'` answers `429 rate_limited`, which was a lie
    // here: nothing was rate limited, the session store was away. It also made this
    // the ONE refresh-path Redis failure not answering
    // `session_store_unavailable`, so a single outage produced 429 for the request
    // holding the lock and 503 for everything waiting on it. See F09.
    const { service, cache } = build();
    await service.create(makeIssued());
    expect(cache.writes[0]!.onError).toBe('unavailable');
  });

  it('gives the record the session ceiling as its TTL', async () => {
    const ceiling = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const { service, cache } = build();
    await service.create(makeIssued({ reauthenticateAt: ceiling }));

    // Not the idle deadline and not a round number: the record must not outlive the
    // credential it describes.
    expect(cache.writes[0]!.ttl).toBeGreaterThan(3 * 60 * 60 - 5);
    expect(cache.writes[0]!.ttl).toBeLessThanOrEqual(3 * 60 * 60);
  });
});

describe('resolve', () => {
  it('returns the stored access token while it is still fresh', async () => {
    const { service, rotate } = build();
    const handle = await service.create(makeIssued());

    await expect(service.resolve(handle, CLIENT)).resolves.toBe(ACCESS);
    // The common path is one cache read. Nothing was rotated.
    expect(rotate).not.toHaveBeenCalled();
  });

  it('answers null for a handle it never issued', async () => {
    const { service } = build();
    await expect(service.resolve('never-issued', CLIENT)).resolves.toBeNull();
  });

  it('answers null once the record is gone', async () => {
    const { service, cache } = build();
    const handle = await service.create(makeIssued());
    cache.store.clear();

    // Indistinguishable from a Redis outage, and correctly so: both mean this
    // request cannot be authenticated and both have the same remedy.
    await expect(service.resolve(handle, CLIENT)).resolves.toBeNull();
  });

  it('answers null for a record that is not the shape it wrote', async () => {
    const { service, cache } = build();
    const handle = await service.create(makeIssued());
    cache.store.set(`bff:session:${handle}`, 'not json at all');

    await expect(service.resolve(handle, CLIENT)).resolves.toBeNull();
  });

  /** ═══ THE ENVELOPE IS BOUND TO ITS HANDLE ═══════════════════════════════ */
  it('will not open a record copied to a different handle', async () => {
    const rotate = vi.fn().mockResolvedValue(makeIssued({ accessToken: 'must-not-be-reached' }));
    const { service, cache } = build({ rotate });
    const mine = await service.create(makeIssued());
    const theirs = await service.create(makeIssued());

    // Exactly what someone with write access to Redis would try: move the envelope
    // under a handle they control. The AAD is the handle, so the tag no longer
    // verifies and the refresh token stays sealed.
    cache.store.set(`bff:session:${theirs}`, cache.store.get(`bff:session:${mine}`)!);

    // Expire the access token so the refresh path — the one that has to open the
    // envelope — is the path taken.
    await expireAccess(cache, theirs);
    await expect(service.resolve(theirs, CLIENT)).resolves.toBeNull();

    // The assertion that makes this test mean something. Without the AAD the
    // envelope would open, the stolen refresh token would be presented, and this
    // would have been called — so a null answer alone would not have proved the
    // binding held.
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe('refresh', () => {
  /** An issued session whose access token is already past its refresh skew. */
  function stale(): IssuedSession {
    return makeIssued({ accessExpiresAt: new Date(Date.now() + 5 * 1000) });
  }

  it('rotates once and returns the new access token', async () => {
    const rotate = vi.fn().mockResolvedValue(
      makeIssued({ accessToken: 'access-token-generation-two' }),
    );
    const { service, rotate: spy } = build({ rotate });
    const handle = await service.create(stale());

    await expect(service.resolve(handle, CLIENT)).resolves.toBe('access-token-generation-two');
    expect(spy).toHaveBeenCalledTimes(1);
    // The refresh token it presented is the one that was sealed for this handle.
    expect(spy).toHaveBeenCalledWith(REFRESH, CLIENT);
  });

  it('refreshes before the token expires, not after', async () => {
    // The skew is what keeps a rotation from racing the expiry it prevents: a token
    // handed to `verifyAccessToken` must not expire in flight.
    const rotate = vi.fn().mockResolvedValue(makeIssued({ accessToken: 'rotated' }));
    const { service } = build({ rotate });
    const handle = await service.create(
      makeIssued({
        accessExpiresAt: new Date(
          Date.now() + (SESSION.ACCESS_REFRESH_SKEW_SECONDS - 5) * 1000,
        ),
      }),
    );

    // Still valid for twenty-five seconds, and refreshed anyway.
    await expect(service.resolve(handle, CLIENT)).resolves.toBe('rotated');
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('writes the new pair back under the same handle', async () => {
    const rotate = vi.fn().mockResolvedValue(
      makeIssued({ accessToken: 'rotated', refreshToken: 'refresh-two' }),
    );
    const { service, cache } = build({ rotate });
    const handle = await service.create(stale());
    await service.resolve(handle, CLIENT);

    // The browser's cookie is untouched by a rotation — only the tokens inside the
    // record move. That is what makes rotation invisible to the client.
    const raw = cache.store.get(`bff:session:${handle}`) ?? '';
    expect(raw).toContain('rotated');
    expect(raw).not.toContain('refresh-two');

    // And the next read serves the new token without rotating again.
    rotate.mockClear();
    await expect(service.resolve(handle, CLIENT)).resolves.toBe('rotated');
    expect(rotate).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE CASE THE LOCK EXISTS FOR ══════════════════════════════════════════
   *
   * `SessionService.rotate` converts a rotation conflict into `handleReuse`, which
   * revokes the entire family. Under the BFF, refresh is automatic, so two requests
   * arriving together on one session reach it routinely — and without the lock that
   * ordinary concurrency would present one refresh token twice and log the admin out
   * for credential theft they did not commit.
   */
  it('does not rotate when another request holds the lock', async () => {
    const cache = makeCache();
    // The request that got there first, which stored the record.
    const first = build({ cache });
    const handle = await first.service.create(stale());

    // A second request on the SAME session, arriving while the first still holds the
    // lock. Same store, so the record it finds is real.
    const second = build({ cache, held: true });
    await second.service.resolve(handle, CLIENT);

    // The whole point: it did not present the refresh token a second time. Doing so
    // is what `SessionService.rotate` reads as a replay, and it would have revoked
    // the family and signed the admin out.
    expect(second.rotate).not.toHaveBeenCalled();
  });

  it('proceeds on the token it already holds when the lock is held', async () => {
    // The common losing case, and the reason the skew is worth having: the token is
    // still good for a few more seconds, so waiting on another request would add
    // latency to buy nothing.
    const cache = makeCache();
    const first = build({ cache });
    const handle = await first.service.create(
      makeIssued({ accessExpiresAt: new Date(Date.now() + 5 * 1000) }),
    );

    const second = build({ cache, held: true });
    await expect(second.service.resolve(handle, CLIENT)).resolves.toBe(ACCESS);
  });

  /**
   * ═══ THIS ASSERTED `null`, AND THAT WAS F04 ════════════════════════════════
   *
   * The old expectation was that a request losing the lock, with an access token
   * already past `exp`, gets one re-read and then null — a 401. Its stated reason was
   * that waiting on another request is how a pool gets exhausted under load.
   *
   * The hazard is real; the conclusion was not. A 401 here signs out an admin whose
   * session is in perfect health, because a DIFFERENT request happened to be
   * rotating — and the race is only as wide as one transaction plus two signatures,
   * about a millisecond. Trading a healthy session for a saved millisecond is the
   * wrong side of that bargain.
   *
   * The wait answers the pool objection by its shape rather than by refusing to wait:
   * bounded by `REFRESH_WAIT_MS`, strictly inside the lock's own TTL, backed off
   * rather than spun, and in the ordinary case satisfied by the very first check. See
   * `awaitHolder` in security/bff.session.ts.
   *
   * Here the holder never lands at all, so this exercises the far end of that budget:
   * the answer is a TRANSIENT refusal, not an authentication failure. The session was
   * never shown to be invalid; only the coordination failed.
   */
  it('raises a transient refusal, not a 401, when the holder never publishes', async () => {
    const cache = makeCache();
    const first = build({ cache });
    const handle = await first.service.create(
      makeIssued({ accessExpiresAt: new Date(Date.now() - 1000) }),
    );

    const second = build({ cache, held: true });

    const err = await second.service.resolve(handle, CLIENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).type).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    // Emphatically not `unauthenticated`: nothing here showed the session to be dead.
    expect((err as ProblemException).status).toBe(503);
  }, 15_000);

  it('picks up the holder’s result on the re-read once it has landed', async () => {
    const cache = makeCache();
    const first = build({ cache });
    const handle = await first.service.create(
      makeIssued({ accessExpiresAt: new Date(Date.now() - 1000) }),
    );

    // The holder finishes: the record under this handle now carries a fresh token.
    const rotated = makeIssued({ accessToken: 'rotated-by-holder' });
    await cache.set(
      `bff:session:${handle}`,
      JSON.stringify({
        sessionId: rotated.sessionId,
        accessToken: rotated.accessToken,
        accessExpiresAt: rotated.accessExpiresAt.getTime(),
        refreshSealed: 'irrelevant-to-this-path',
        reauthenticateAt: rotated.reauthenticateAt.getTime(),
      }),
      3600,
      'deny',
    );

    const second = build({ cache, held: true });
    await expect(second.service.resolve(handle, CLIENT)).resolves.toBe('rotated-by-holder');
    expect(second.rotate).not.toHaveBeenCalled();
  });

  /** ═══ A REVOKED SESSION MUST NOT REFRESH BACK INTO A VALID ONE ══════════ */
  it.each([
    ['session_revoked', ERR.SESSION_REVOKED],
    ['session_reuse_detected', ERR.SESSION_REUSE_DETECTED],
    ['token_expired', ERR.TOKEN_EXPIRED],
  ])('propagates %s rather than answering null', async (_name, slug) => {
    // These are not "not signed in" — they are specific reasons the spec wants a
    // client to branch on, and collapsing them to null would lose exactly the
    // information that distinguishes "sign in again" from "your session was ended
    // elsewhere".
    const rotate = vi.fn().mockRejectedValue(new ProblemException({ type: slug }));
    const { service } = build({ rotate });
    const handle = await service.create(stale());

    await expect(service.resolve(handle, CLIENT)).rejects.toMatchObject({ type: slug });
  });
});

describe('destroy', () => {
  it('removes the record, so the handle resolves to nothing', async () => {
    const { service } = build();
    const handle = await service.create(makeIssued());
    await service.destroy(handle);

    await expect(service.resolve(handle, CLIENT)).resolves.toBeNull();
  });

  it('is quiet about a handle that is already gone', async () => {
    // Logout is something a client may retry, and the spec requires a repeat to
    // succeed.
    const { service } = build();
    await expect(service.destroy('never-issued')).resolves.toBeUndefined();
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Rewrite a stored record's access expiry into the past, leaving the sealed
 *  refresh token exactly as it was. */
async function expireAccess(cache: ReturnType<typeof makeCache>, handle: string): Promise<void> {
  const key = `bff:session:${handle}`;
  const record = JSON.parse(cache.store.get(key)!) as Record<string, unknown>;
  record['accessExpiresAt'] = Date.now() - 1000;
  cache.store.set(key, JSON.stringify(record));
}
