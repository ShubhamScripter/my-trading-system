import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BffSessionService } from '../../../auth/security/bff.session';
import { SESSION } from '../../../auth/auth.constants';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { KEYS } from '../../../redis';
import type { IssuedSession } from '../../../auth/auth.types';
import { makePublicUser } from '../../harness';

/**
 * The server-side session record: what the browser's handle names.
 *
 * ═══ WHAT THESE TESTS ARE FOR ══════════════════════════════════════════════
 *
 * Not "does Redis get written". The properties worth pinning are the ones that stop
 * this being a downgrade from the cookie it replaced:
 *
 *   the refresh token is sealed, and sealed TO THIS HANDLE — otherwise anyone who
 *   can write to Redis moves a record and gets somebody else's session;
 *   a refresh is single-flight — otherwise ordinary concurrency presents one refresh
 *   token twice and reuse detection signs the user out;
 *   a Redis failure is never mistaken for an absent record — the two used to fold
 *   into one null, and the fold cleared a live session's only credential;
 *   the record's TTL tracks the session's own deadline — otherwise it either outlives
 *   the credential or kills an active session.
 */

const HANDLE_A = 'handle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HANDLE_B = 'handle-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const CLIENT = { ipClass: '203.0.113.0/24', deviceKey: 'd'.repeat(64), userAgent: 'vitest', country: null, };

function issued(overrides: Partial<IssuedSession> = {}): IssuedSession {
  return {
    sessionId: 'session-1',
    accessToken: 'access.token.one',
    refreshToken: 'refresh.token.one',
    accessExpiresAt: new Date(Date.now() + 15 * 60_000),
    refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    user: makePublicUser(),
    ...overrides,
  };
}

/**
 * A Redis double that actually stores, because half of what is being tested is what
 * the NEXT read sees. A bag of `vi.fn()`s would let a broken seal pass.
 */
function createCache() {
  const store = new Map<string, string>();
  return {
    store,
    ttls: new Map<string, number>(),
    set: vi.fn(async function (this: void, key: string, value: string, ttl: number) {
      store.set(key, value);
      cache.ttls.set(key, ttl);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    clear: vi.fn(async (key: string) => void store.delete(key)),
    /** Three-valued, like the real one: `null` is "Redis did not answer", which is
     *  the state `recordState` exists to keep separable from "there is nothing here". */
    flag: vi.fn(async (key: string): Promise<boolean | null> => store.has(key)),
  };
}

/** `withLock` that grants by default. `held` makes every acquisition fail, which is
 *  how a loser is simulated without real concurrency. */
function createLocks() {
  return {
    held: false,
    withLock: vi.fn(async function <T>(
      _key: string,
      _ttl: number,
      fn: () => Promise<T>,
    ): Promise<T | null> {
      return locks.held ? null : fn();
    }),
  };
}

let cache: ReturnType<typeof createCache>;
let locks: ReturnType<typeof createLocks>;
let sessions: { rotate: ReturnType<typeof vi.fn> };
let bff: BffSessionService;

beforeEach(() => {
  cache = createCache();
  locks = createLocks();
  sessions = { rotate: vi.fn() };
  bff = new BffSessionService(sessions as never, cache as never, locks as never);
});

describe('create and resolve', () => {
  it('returns a handle that is not derivable from the session', async () => {
    const session = issued();
    const handle = await bff.create(session);

    expect(handle).not.toContain(session.sessionId);
    expect(handle).not.toContain(session.accessToken);
    // 32 bytes, base64url — 43 characters with no padding.
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('gives two sessions two handles', async () => {
    expect(await bff.create(issued())).not.toBe(await bff.create(issued()));
  });

  it('resolves the stored access token without rotating', async () => {
    const session = issued();
    const handle = await bff.create(session);

    const resolved = await bff.resolve(handle, CLIENT);

    expect(resolved).toEqual({ kind: 'session', accessToken: session.accessToken, rotated: false });
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('answers "absent" for a handle it never issued', async () => {
    expect(await bff.resolve(HANDLE_A, CLIENT)).toEqual({ kind: 'absent' });
  });

  it('stores the record under a key the raw handle does not appear in', async () => {
    const handle = await bff.create(issued());

    const [key] = [...cache.store.keys()];
    expect(key).toBe(KEYS.bff.session(handle));
    // A bearer credential in a Redis key would be handed over by a `KEYS *`
    // listing, a slow-query report, or any log line that names the key.
    expect(key).not.toContain(handle);
  });
});

describe('the envelope', () => {
  it('does not store the refresh token in the clear', async () => {
    const session = issued();
    await bff.create(session);

    const raw = [...cache.store.values()][0] as string;
    expect(raw).not.toContain(session.refreshToken);
  });

  it('stores the access token in the clear, deliberately', async () => {
    // The asymmetry is a decision. The refresh token is a multi-day grant, so a dump
    // of the volume must not hand it over; the access token expires in fifteen
    // minutes and `assertLive` refuses it the instant its session is revoked, so
    // sealing it would cost a decrypt per request to protect a near-dead credential.
    const session = issued();
    await bff.create(session);

    const raw = [...cache.store.values()][0] as string;
    expect(raw).toContain(session.accessToken);
  });

  it('cannot be opened after the record is moved to another handle', async () => {
    const session = issued({ accessExpiresAt: new Date(Date.now() - 1000) });
    const handle = await bff.create(session);

    // Exactly what an attacker with write access to Redis would do: copy A's record
    // under their own handle and present it. The handle is the AES-GCM AAD, so the
    // tag covers the identity as well as the contents.
    cache.store.set(KEYS.bff.session(HANDLE_B), cache.store.get(KEYS.bff.session(handle)) as string);

    const resolved = await bff.resolve(HANDLE_B, CLIENT);

    expect(resolved).toEqual({ kind: 'absent' });
    // And critically: it never reached `rotate`, so the victim's refresh token was
    // not spent and their family was not revoked as a side effect of the attempt.
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('refuses a truncated envelope rather than throwing', async () => {
    const session = issued({ accessExpiresAt: new Date(Date.now() - 1000) });
    const handle = await bff.create(session);
    const key = KEYS.bff.session(handle);

    const record = JSON.parse(cache.store.get(key) as string) as { refreshSealed: string };
    record.refreshSealed = record.refreshSealed.slice(0, 8);
    cache.store.set(key, JSON.stringify(record));

    await expect(bff.resolve(handle, CLIENT)).resolves.toEqual({ kind: 'absent' });
  });

  it('treats a value it never wrote as no record at all', async () => {
    cache.store.set(KEYS.bff.session(HANDLE_A), 'not json');

    await expect(bff.resolve(HANDLE_A, CLIENT)).resolves.toEqual({ kind: 'absent' });
  });
});

describe('the record TTL', () => {
  it('is the session’s own deadline, not a constant', async () => {
    // It must not outlive the credential it describes, and it must not die before it
    // either: one direction parks a dead handle in an LRU cache for a week, the other
    // signs an active user out.
    const handle = await bff.create(
      issued({ refreshExpiresAt: new Date(Date.now() + 3600_000) }),
    );

    const ttl = cache.ttls.get(KEYS.bff.session(handle)) as number;
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('is floored at one second, so a record is always actually written', async () => {
    // `EX 0` is rejected outright, and a session this close to its deadline is about
    // to be refused by `assertLive` anyway.
    const handle = await bff.create(issued({ refreshExpiresAt: new Date(Date.now() - 60_000) }));

    expect(cache.ttls.get(KEYS.bff.session(handle))).toBe(1);
  });
});

describe('refresh — the skew, and what happens under the lock', () => {
  /** A record whose access token is inside the refresh skew. */
  async function dueForRefresh(): Promise<string> {
    return bff.create(
      issued({
        accessExpiresAt: new Date(Date.now() + (SESSION.ACCESS_REFRESH_SKEW_SECONDS - 5) * 1000),
      }),
    );
  }

  it('rotates when the stored token is within the skew, and reports it', async () => {
    const handle = await dueForRefresh();
    sessions.rotate.mockResolvedValue(issued({ accessToken: 'access.token.two' }));

    const resolved = await bff.resolve(handle, CLIENT);

    expect(sessions.rotate).toHaveBeenCalledWith('refresh.token.one', CLIENT);
    // `rotated: true` is what tells the guard to slide the cookie: the session's
    // deadline just moved, so the credential naming it has to move with it.
    expect(resolved).toEqual({ kind: 'session', accessToken: 'access.token.two', rotated: true });
  });

  it('takes the lock, and takes it on this handle', async () => {
    const handle = await dueForRefresh();
    sessions.rotate.mockResolvedValue(issued());

    await bff.resolve(handle, CLIENT);

    expect(locks.withLock).toHaveBeenCalledWith(
      KEYS.bff.refreshLock(handle),
      SESSION.REFRESH_LOCK_SECONDS,
      expect.any(Function),
    );
  });

  it('publishes the new token, so the next request needs no rotation', async () => {
    const handle = await dueForRefresh();
    sessions.rotate.mockResolvedValue(issued({ accessToken: 'access.token.two' }));

    await bff.resolve(handle, CLIENT);
    sessions.rotate.mockClear();

    const second = await bff.resolve(handle, CLIENT);
    expect(second).toEqual({ kind: 'session', accessToken: 'access.token.two', rotated: false });
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('proceeds on the token it has when it loses the lock and the token is still valid', async () => {
    const handle = await dueForRefresh();
    locks.held = true;

    const resolved = await bff.resolve(handle, CLIENT);

    // The common case, and the reason the skew exists: the token is good for up to
    // ACCESS_REFRESH_SKEW_SECONDS more, so waiting would add latency to buy nothing.
    expect(resolved).toEqual({ kind: 'session', accessToken: 'access.token.one', rotated: false });
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('does not rotate twice when a holder finished between the read and the acquire', async () => {
    const handle = await dueForRefresh();
    const key = KEYS.bff.session(handle);

    // Simulate the holder landing while we were acquiring: the fresh record inside
    // the lock is no longer due. Presenting the stale record's refresh token here is
    // exactly what trips reuse detection.
    locks.withLock.mockImplementation(async (_key, _ttl, fn) => {
      const record = JSON.parse(cache.store.get(key) as string) as Record<string, unknown>;
      record.accessToken = 'access.token.published-by-the-holder';
      record.accessExpiresAt = Date.now() + 15 * 60_000;
      cache.store.set(key, JSON.stringify(record));
      return fn();
    });

    const resolved = await bff.resolve(handle, CLIENT);

    expect(sessions.rotate).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      kind: 'session',
      accessToken: 'access.token.published-by-the-holder',
      rotated: false,
    });
  });

  it('lets a rotation refusal propagate rather than folding it into null', async () => {
    // `session_revoked`, `session_reuse_detected` and `token_expired` are the reasons
    // a 401 should carry. Folding them into null would answer a bare
    // `unauthenticated` and lose the one thing the client could act on.
    const handle = await dueForRefresh();
    sessions.rotate.mockRejectedValue(new ProblemException({ type: ERR.SESSION_REVOKED }));

    await expect(bff.resolve(handle, CLIENT)).rejects.toMatchObject({
      type: ERR.SESSION_REVOKED,
    });
  });

  it('refuses when the envelope cannot be opened, without spending anything', async () => {
    const handle = await dueForRefresh();
    const key = KEYS.bff.session(handle);
    const record = JSON.parse(cache.store.get(key) as string) as { refreshSealed: string };
    record.refreshSealed = Buffer.from('x'.repeat(64)).toString('base64');
    cache.store.set(key, JSON.stringify(record));

    await expect(bff.resolve(handle, CLIENT)).resolves.toEqual({ kind: 'absent' });
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('waits for the holder when it lost the lock AND its own token has expired', async () => {
    const handle = await bff.create(issued({ accessExpiresAt: new Date(Date.now() - 1000) }));
    const key = KEYS.bff.session(handle);
    locks.held = true;

    // The holder publishes on the first backoff tick. Before this waited at all, a
    // race the width of one transaction signed healthy sessions out.
    let reads = 0;
    cache.get.mockImplementation(async (k: string) => {
      if (k === key && ++reads === 2) {
        const record = JSON.parse(cache.store.get(key) as string) as Record<string, unknown>;
        record.accessToken = 'access.token.from.the.holder';
        record.accessExpiresAt = Date.now() + 15 * 60_000;
        cache.store.set(key, JSON.stringify(record));
      }
      return cache.store.get(k) ?? null;
    });

    const resolved = await bff.resolve(handle, CLIENT);

    expect(resolved).toEqual({ kind: 'session', accessToken: 'access.token.from.the.holder', rotated: false });
  });

  it('answers 503, not 401, when the holder never publishes', async () => {
    const handle = await bff.create(issued({ accessExpiresAt: new Date(Date.now() - 1000) }));
    locks.held = true;

    // The holder crashed or is wedged. This session is very probably fine and the
    // thing that failed is the coordination around it — telling the client to retry
    // is honest, telling it to sign in again is not.
    await expect(bff.resolve(handle, CLIENT)).rejects.toMatchObject({
      type: ERR.SESSION_STORE_UNAVAILABLE,
      status: 503,
    });
  }, 10_000);
});

describe('a Redis failure means different things on different paths', () => {
  it('is a 503 on the write, because work has already committed elsewhere', async () => {
    // `CacheService.set` throws `internal_error`, which is right for its other
    // callers and wrong here: a 500 tells a client this service is broken, when what
    // happened is that Redis is away and the request is worth retrying.
    cache.set.mockRejectedValue(new ProblemException({ type: ERR.INTERNAL_ERROR }));

    await expect(bff.create(issued())).rejects.toMatchObject({
      type: ERR.SESSION_STORE_UNAVAILABLE,
      status: 503,
    });
  });

  it('is "unavailable" on the read, and NOT "absent"', async () => {
    // These folded into one null, and the fold was a real defect found by curl. An
    // absent record means the session is over — its TTL is the session's own deadline
    // — so the caller answers 401 and clearing the dead cookies is a kindness. A Redis
    // that did not answer means nothing has been learned, and clearing there drops the
    // only value naming a live session. See `Resolution`.
    cache.get.mockRejectedValue(new ProblemException({ type: ERR.INTERNAL_ERROR }));

    await expect(bff.resolve(HANDLE_A, CLIENT)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('calls a malformed record "absent", because Redis DID answer', async () => {
    // The distinction is about whether anything was learned, not about whether the
    // read threw. A value this never wrote is neither retryable nor salvageable.
    cache.store.set(KEYS.bff.session(HANDLE_A), '{ not json');

    await expect(bff.resolve(HANDLE_A, CLIENT)).resolves.toEqual({ kind: 'absent' });
  });
});

describe('recordState — three states, never two', () => {
  it('reports a live record as present', async () => {
    const handle = await bff.create(issued());
    await expect(bff.recordState(handle)).resolves.toBe('present');
  });

  it('reports an unknown handle as absent, so a repeat logout succeeds', async () => {
    await expect(bff.recordState(HANDLE_A)).resolves.toBe('absent');
  });

  it('reports a Redis that did not answer as unknown, NOT as absent', async () => {
    // The fold this method exists to prevent. `if (!state)` would read "Redis could
    // not answer" as "there is nothing there", and a logout would report success
    // while the revocation was never even attempted.
    cache.flag.mockResolvedValue(null);

    await expect(bff.recordState(HANDLE_A)).resolves.toBe('unknown');
  });
});

describe('destroy', () => {
  it('drops the record', async () => {
    const handle = await bff.create(issued());
    await bff.destroy(handle);

    await expect(bff.resolve(handle, CLIENT)).resolves.toEqual({ kind: 'absent' });
  });

  it('stays silent when Redis cannot be reached', async () => {
    // `CacheService.clear` swallows its own errors, so a failure here cannot turn a
    // revocation PostgreSQL has already committed into a failed request. The record
    // expires on its own regardless.
    cache.clear.mockResolvedValue(undefined);
    await expect(bff.destroy(HANDLE_A)).resolves.toBeUndefined();
  });
});
