import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@prisma/client';
import { BffSessionService } from '../../../auth/security/bff.session';
import { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SessionService } from '../../../auth/services/session.service';
import { verifyAccessToken } from '../../../auth/security/jwt';
import { SESSION } from '../../../auth/auth.constants';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { KEYS } from '../../../redis';
import { makeCredential, makeUser } from '../../harness';

/**
 * ═══ THE PARTIAL FAILURE BETWEEN POSTGRES AND REDIS ════════════════════════
 *
 * The one scenario this whole migration created, and the one a mocked
 * `findRecoverableRotation` cannot prove anything about.
 *
 * Automatic in-request rotation means two stores have to agree, and nothing spans
 * them: `SessionService.rotate` commits to Postgres, then `BffSessionService.write`
 * publishes the new tokens to Redis. If the second half fails, the durable store has
 * already moved on — the parent is stamped, its child is the family's tip — while the
 * record the browser's handle names still holds the PARENT's refresh token, which
 * Postgres now considers spent.
 *
 * The next request presents it. Before recovery existed, `rotate` read that as a
 * replayed refresh token, revoked the entire family, and logged a security warning:
 * one dropped cache write cost a user their session and told an operator they had been
 * robbed.
 *
 * ─── Why this file uses the REAL query layer ───────────────────────────────
 *
 * `tests/auth/services/session.recovery.spec.ts` doubles `findRecoverableRotation` and
 * asserts the wiring around it — that a repair is attempted before reuse detection,
 * and that everything it declines still revokes the family. Necessary, and not
 * sufficient: it would pass with the predicate itself inverted.
 *
 * So everything below runs the real `BffSessionService`, the real `SessionService` and
 * the real `SessionDbOperation` over an in-memory Prisma double. What is faked is the
 * DATASTORE, never the logic under test — the CAS, the recovery predicate, the seal
 * and the publish seam are all the shipping code. The live curl walk covers the same
 * sequence against real Postgres, which is what proves the SQL itself.
 */

const USER = makeUser();
const CLIENT = { ipClass: '203.0.113.0/24', deviceKey: 'd'.repeat(64), userAgent: 'vitest', country: null, };

let rows: Session[];
let nextId = 0;

function seed(overrides: Partial<Session> = {}): Session {
  const id = 'session-0';
  const row = {
    id,
    familyId: id,
    parentId: null,
    userId: USER.id,
    deviceFingerprint: CLIENT.deviceKey,
    ipClass: CLIENT.ipClass,
    userAgent: CLIENT.userAgent,
    createdAt: new Date(Date.now() - 60_000),
    lastUsedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    rememberUntil: null,
    trustedDeviceId: null,
    ...overrides, country: null,
  } as Session;
  rows = [row];
  return row;
}

/**
 * An in-memory Prisma honouring exactly the query shapes `SessionDbOperation` issues.
 *
 * `beforeTransaction` is the seam that lets a concurrent revocation be injected at the
 * one instant that matters — after the row has been read and before the CAS runs —
 * which is what makes the logout-mid-rotation race deterministic rather than a sleep.
 */
function createPrisma() {
  const api = {
    beforeTransaction: null as null | (() => void),
    session: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.find((r) => r.id === where.id) ?? null;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { familyId?: string; rotatedAt?: null; revokedAt?: null };
          take?: number;
        }) => {
          const matched = rows.filter(
            (r) =>
              (where.familyId === undefined || r.familyId === where.familyId) &&
              (!('rotatedAt' in where) || r.rotatedAt === null) &&
              (!('revokedAt' in where) || r.revokedAt === null),
          );
          return take === undefined ? matched : matched.slice(0, take);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; rotatedAt?: null; revokedAt?: null };
          data: Partial<Session>;
        }) => {
          const matched = rows.filter(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (!('rotatedAt' in where) || r.rotatedAt === null) &&
              (!('revokedAt' in where) || r.revokedAt === null),
          );
          for (const r of matched) Object.assign(r, data);
          return { count: matched.length };
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<Session> }) => {
        const row = {
          ...seedShape(),
          ...data,
          id: `session-${++nextId}`,
          createdAt: new Date(),
        } as Session;
        rows.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      api.beforeTransaction?.();
      api.beforeTransaction = null;
      return fn(api);
    }),
    $executeRaw: vi.fn(async () => 0),
    $executeRawUnsafe: vi.fn(async () => 0),
  };
  return api;
}

function seedShape(): Partial<Session> {
  return {
    revokedAt: null,
    revokedReason: null,
    rotatedAt: null,
    rememberUntil: null,
    trustedDeviceId: null,
  };
}

/** A Redis double that stores, and that can be told to drop the NEXT write — which is
 *  precisely the failure being reproduced. */
function createCache() {
  const store = new Map<string, string>();
  const api = {
    store,
    /** Set once to make the next `set` throw the way `CacheService.set` does. */
    failNextSet: false,
    set: vi.fn(async (key: string, value: string) => {
      if (api.failNextSet) {
        api.failNextSet = false;
        throw new ProblemException({ type: ERR.INTERNAL_ERROR });
      }
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    clear: vi.fn(async (key: string) => void store.delete(key)),
    flag: vi.fn(async (key: string): Promise<boolean | null> => store.has(key)),
    setFlag: vi.fn(async () => undefined),
    startCooldown: vi.fn(async () => false),
    consume: vi.fn(async () => undefined),
  };
  return api;
}

let prisma: ReturnType<typeof createPrisma>;
let cache: ReturnType<typeof createCache>;
let dbop: SessionDbOperation;
let sessions: SessionService;
let bff: BffSessionService;
let logs: string[];

beforeEach(() => {
  nextId = 0;
  prisma = createPrisma();
  cache = createCache();
  logs = [];

  dbop = new SessionDbOperation(prisma as never);
  sessions = new SessionService(
    dbop,
    {
      findWithCredential: vi.fn(async () => ({ user: USER, credential: makeCredential() })),
    } as never,
    { findLive: vi.fn(async () => null), touch: vi.fn(), trust: vi.fn() } as never,
    { sendNewDeviceLogin: vi.fn() } as never,
    cache as never,
    { consumeAll: vi.fn(async () => undefined) } as never,
  );
  bff = new BffSessionService(sessions, cache as never, {
    // Grant every time: this file is about the two-store seam, not about contention.
    withLock: vi.fn(async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()),
  } as never);

  // The repair logs distinctly on purpose — an operator has to be able to tell an
  // unhealthy store from an attack — so the log line is part of the contract.
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(
      (bff as unknown as { logger: Record<string, (...a: unknown[]) => void> }).logger,
      level,
    ).mockImplementation((...args: unknown[]) => void logs.push(`${level}:${JSON.stringify(args)}`));
    vi.spyOn(
      (sessions as unknown as { logger: Record<string, (...a: unknown[]) => void> }).logger,
      level,
    ).mockImplementation((...args: unknown[]) => void logs.push(`${level}:${JSON.stringify(args)}`));
  }
});

describe('interrupted rotation — the record write fails AFTER Postgres committed', () => {
  it('repairs the record on the next request instead of revoking the family', async () => {
    const parent = seed();

    // ─── A live BFF session, with its access token inside the refresh skew ───
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    // ─── The rotation commits, and the publish is dropped ────────────────────
    cache.failNextSet = true;
    await expect(bff.resolve(handle, CLIENT)).rejects.toMatchObject({
      // Honest about being an infrastructure failure rather than a session ending.
      type: ERR.SESSION_STORE_UNAVAILABLE,
      status: 503,
    });

    // Postgres has moved on regardless: the parent is spent and its child is the tip.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rotatedAt).not.toBeNull();
    expect(rows[1]?.parentId).toBe(parent.id);
    // And the record still names the PARENT, holding a refresh token Postgres
    // considers spent. This is the poison pill.
    expect(recordSessionId(handle)).toBe(parent.id);

    // ─── The next request presents that spent token ─────────────────────────
    const resolved = await bff.resolve(handle, CLIENT);

    // 1. the session is still usable
    expect(resolved.kind).toBe('session');
    expect(resolved).toMatchObject({ kind: 'session' });

    // 2. the family was NOT revoked — no row carries a revocation of any kind
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    expect(rows.every((r) => r.revokedReason === null)).toBe(true);

    // 3. no reuse was detected, and no second child was created: the repair SERVES
    //    the generation the first rotation produced rather than rotating again
    expect(rows).toHaveLength(2);

    // 4. the repair is logged distinctly, so an operator can tell a slow store from
    //    an attack. `handleReuse`'s warning must be absent.
    expect(logs.some((l) => l.includes('interrupted rotation repaired'))).toBe(true);
    expect(logs.some((l) => l.includes('reuse detected'))).toBe(false);

    // 5. and the record now names the child, so the pill is swallowed once only
    expect(recordSessionId(handle)).toBe(rows[1]?.id);
  });

  it('serves a working session, not merely a non-error', async () => {
    const parent = seed();
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    cache.failNextSet = true;
    await expect(bff.resolve(handle, CLIENT)).rejects.toBeInstanceOf(ProblemException);

    const resolved = await bff.resolve(handle, CLIENT);
    if (resolved.kind !== 'session') throw new Error('expected a session');

    // The access token it handed back has to authenticate — `assertLive` is what a
    // real request would put it through next, and it names the child generation.
    const claims = verifyAccessToken(resolved.accessToken);
    expect(claims.sid).toBe(rows[1]?.id);
    await expect(sessions.assertLive(claims.sid)).resolves.toMatchObject({
      familyId: parent.familyId,
    });
  });

  it('does NOT repair once the recovery window has passed', async () => {
    // The bound is what keeps this a repair rather than a general amnesty on reuse
    // detection. A dropped write is retried by the next request, seconds later; a
    // replay arriving minutes afterwards is treated as theft, as it always was.
    const parent = seed();
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    cache.failNextSet = true;
    await expect(bff.resolve(handle, CLIENT)).rejects.toBeInstanceOf(ProblemException);

    // Age the committed rotation past the window.
    const rotatedAt = rows[0]?.rotatedAt as Date;
    rows[0]!.rotatedAt = new Date(
      rotatedAt.getTime() - (SESSION.ROTATION_RECOVERY_WINDOW_SECONDS + 5) * 1000,
    );

    await expect(bff.resolve(handle, CLIENT)).rejects.toMatchObject({
      type: ERR.SESSION_REUSE_DETECTED,
    });
    // And now the family IS revoked, with the reason that says why.
    expect(rows.every((r) => r.revokedReason === 'REUSE_DETECTED')).toBe(true);
  });

  it('does NOT repair a replay from an earlier generation', async () => {
    // The one-step bound. A token from two generations back fails because the tip's
    // parent has moved on — the legitimate client has rotated since.
    const parent = seed();
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    // First rotation succeeds and publishes.
    await bff.resolve(handle, CLIENT);
    ageIntoSkew(handle);
    // Second rotation succeeds and publishes; the tip is now a grandchild.
    await bff.resolve(handle, CLIENT);
    expect(rows).toHaveLength(3);

    // Now replay the ORIGINAL parent's token by putting its record back.
    const stale = await mintRecordValue(parent, handle);
    cache.store.set(KEYS.bff.session(handle), stale);
    ageIntoSkew(handle);

    await expect(bff.resolve(handle, CLIENT)).rejects.toMatchObject({
      type: ERR.SESSION_REUSE_DETECTED,
    });
  });
});

describe('logout racing a rotation is not theft', () => {
  it('reports the revocation, not session_reuse_detected', async () => {
    // Unreachable before this migration — a person could not click "sign out" and
    // "refresh" at the same instant. Routine now, because the refresh is not theirs
    // to time: the CAS predicate includes `revokedAt: null`, so a logout committing
    // while a rotation is in flight makes the update match zero rows.
    const parent = seed();
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    // The revocation lands after the row was read and before the CAS runs.
    prisma.beforeTransaction = () => {
      rows[0]!.revokedAt = new Date();
      rows[0]!.revokedReason = 'LOGOUT';
    };

    const err = await bff.resolve(handle, CLIENT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemException);
    expect(err).toMatchObject({ type: ERR.SESSION_REVOKED, status: 401 });
    // The distinction that matters: this is a SessionEndedException carrying WHY, not
    // a theft accusation.
    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED');
    expect((err as { type: string }).type).not.toBe(ERR.SESSION_REUSE_DETECTED);
    // No security warning was logged, and no family sweep was performed.
    expect(logs.some((l) => l.includes('reuse detected'))).toBe(false);
    expect(rows.filter((r) => r.revokedReason === 'REUSE_DETECTED')).toHaveLength(0);
  });

  it('names the wider scope for an account-wide sweep', async () => {
    const parent = seed();
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    prisma.beforeTransaction = () => {
      rows[0]!.revokedAt = new Date();
      rows[0]!.revokedReason = 'PASSWORD_CHANGED';
    };

    const err = await bff.resolve(handle, CLIENT).catch((e: unknown) => e);

    // Still `session_revoked` on the wire — the split is a MESSAGE distinction, so a
    // client's exhaustive switch on `type` stays exhaustive.
    expect(err).toMatchObject({ type: ERR.SESSION_REVOKED });
    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED_ALL');
  });
});

describe('the device key a server-side rotation may not have', () => {
  it('carries the parent’s fingerprint forward when no device cookie arrived', async () => {
    const parent = seed({
      rememberUntil: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      trustedDeviceId: 'device-1',
    });
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    await bff.resolve(handle, { ...CLIENT, deviceKey: null });

    const child = rows[1] as Session;
    // Mandatory: a null here would break device-scoped logout for the rest of the
    // session, and would make `honourTrust` refuse on every later rotation because
    // the fingerprint it compares against had been erased.
    expect(child.deviceFingerprint).toBe(parent.deviceFingerprint);
    expect(child.deviceFingerprint).not.toBe('');
    // The trust itself is correctly withdrawn — this request could not show the
    // cookie the trust was granted to — so the session continues on the idle rule.
    expect(child.rememberUntil).toBeNull();
    expect(child.trustedDeviceId).toBeNull();
  });

  it('keeps the trust when the device cookie is present and the device is live', async () => {
    const rememberUntil = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const parent = seed({ rememberUntil, trustedDeviceId: 'device-1' });
    const handle = await mintRecord(parent);
    ageIntoSkew(handle);

    sessions = new SessionService(
      dbop,
      {
        findWithCredential: vi.fn(async () => ({ user: USER, credential: makeCredential() })),
      } as never,
      {
        findLive: vi.fn(async () => ({ id: 'device-1', userAgentAtTrust: null })),
        touch: vi.fn(),
        trust: vi.fn(),
      } as never,
      { sendNewDeviceLogin: vi.fn() } as never,
      cache as never,
      { consumeAll: vi.fn(async () => undefined) } as never,
    );
    bff = new BffSessionService(sessions, cache as never, {
      withLock: vi.fn(async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()),
    } as never);

    await bff.resolve(handle, CLIENT);

    const child = rows[1] as Session;
    expect(child.deviceFingerprint).toBe(parent.deviceFingerprint);
    // Carried across, never recomputed: a rotation that recalculated the window would
    // push it forward on every refresh and make it effectively infinite.
    expect(child.rememberUntil?.getTime()).toBe(rememberUntil.getTime());
    expect(child.trustedDeviceId).toBe('device-1');
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Mint a record for `row` and return the handle naming it. */
async function mintRecord(row: Session): Promise<string> {
  const issued = await (
    sessions as unknown as { mint: (s: Session, u: unknown, p: boolean) => never }
  ).mint(row, USER, true);
  return bff.create(issued as never);
}

/** The raw record value a fresh mint for `row` would produce under `handle`. */
async function mintRecordValue(row: Session, handle: string): Promise<string> {
  const before = new Set(cache.store.keys());
  const fresh = await mintRecord(row);
  const key = KEYS.bff.session(fresh);
  const raw = cache.store.get(key) as string;
  cache.store.delete(key);
  for (const k of cache.store.keys()) if (!before.has(k) && k !== key) cache.store.delete(k);
  // The envelope is bound to the handle as AAD, so a record built for `fresh` cannot
  // be opened under `handle`. Rebuild it by sealing against the target handle.
  const rec = JSON.parse(raw) as Record<string, unknown>;
  const seal = (
    bff as unknown as { seal: (plaintext: string, handle: string) => string }
  ).seal.bind(bff);
  const refresh = (
    bff as unknown as { open: (sealed: string, handle: string) => string | null }
  ).open.bind(bff)(rec.refreshSealed as string, fresh);
  rec.refreshSealed = seal(refresh as string, handle);
  return JSON.stringify(rec);
}

/** Push the stored record's access token to the edge of the refresh skew. Only the
 *  plaintext field is touched; the sealed refresh token is left exactly as written. */
function ageIntoSkew(handle: string): void {
  const key = KEYS.bff.session(handle);
  const rec = JSON.parse(cache.store.get(key) as string) as Record<string, unknown>;
  rec.accessExpiresAt = Date.now() + 1000;
  cache.store.set(key, JSON.stringify(rec));
}

function recordSessionId(handle: string): string {
  const rec = JSON.parse(cache.store.get(KEYS.bff.session(handle)) as string) as {
    sessionId: string;
  };
  return rec.sessionId;
}
