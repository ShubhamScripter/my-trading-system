import { describe, expect, it, vi } from 'vitest';
import type { AdminSession } from '@prisma/client';
import { SessionService } from '../../auth/services/session.service';
import { SessionFamilyRevoked } from '../../auth/persistence/session.dboperation';
import { signRefreshToken, verifyRefreshToken } from '../../auth/security/jwt';
import { SESSION } from '../../auth/auth.constants';
import type { ClientContext } from '../../auth/auth.types';
import { REVOKE_REASON } from '../../auth/auth.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KEYS } from '../../redis';
import { makeAdmin, makeSession } from '../harness';

/**
 * ═══ THE TEST THAT PROVES LOGOUT ACTUALLY LOGS SOMEBODY OUT ════════════════
 *
 * A refresh token stays syntactically valid after its generation has been rotated
 * away: `rotate` stamps `rotatedAt` and leaves `revokedAt` null. That one fact is
 * what made single-generation logout useless, and it is invisible in the happy
 * path — one tab, no rotation, and revoking "the session the token names" is
 * indistinguishable from revoking the live one.
 *
 * The bug it produced: two tabs, tab A refreshes, tab B still holds the pre-
 * rotation token, admin clicks logout in tab B. The old code matched
 * `{ id: A, revokedAt: null }` — which a rotated-but-unrevoked row still satisfies
 * — so it revoked a generation that was already dead, reported success, and left
 * the live generation working for up to twelve hours.
 *
 * `staleTokenKillsLiveSession` below is that scenario. If it fails, logout is
 * cosmetic again.
 */

const ADMIN_ID = '01920000-0000-7000-8000-000000000001';
const FAMILY_ID = '01920000-0000-7000-8000-0000000000f0';
const GEN_A = '01920000-0000-7000-8000-00000000000a';
const GEN_B = '01920000-0000-7000-8000-00000000000b';

function makeCache() {
  return {
    consume: vi.fn().mockResolvedValue(undefined),
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    startCooldown: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    take: vi.fn().mockResolvedValue(null),
    flag: vi.fn().mockResolvedValue(false),
    setFlag: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Generation A is ROTATED but NOT revoked — the state the bug lived in — and
 * generation B is the live child. Both share one `familyId`, because one family is
 * one sign-in.
 */
function twoGenerations() {
  return {
    a: makeSession({
      id: GEN_A,
      adminId: ADMIN_ID,
      familyId: FAMILY_ID,
      rotatedAt: new Date(Date.now() - 1000),
      revokedAt: null,
    }),
    b: makeSession({
      id: GEN_B,
      adminId: ADMIN_ID,
      familyId: FAMILY_ID,
      parentId: GEN_A,
      rotatedAt: null,
      revokedAt: null,
    }),
  };
}

interface Doubles {
  sessions: Record<string, ReturnType<typeof vi.fn>>;
  admins: Record<string, ReturnType<typeof vi.fn>>;
  cache: ReturnType<typeof makeCache>;
}

function build(overrides: Partial<Doubles> = {}) {
  const { a, b } = twoGenerations();
  const byId = new Map([
    [GEN_A, a],
    [GEN_B, b],
  ]);

  const doubles: Doubles = {
    sessions: {
      findById: vi.fn(async (id: string) => byId.get(id) ?? null),
      // Returns every live id in the family, which is what the real one does so
      // the caller can seed the revocation cache.
      revokeFamily: vi.fn().mockResolvedValue([GEN_A, GEN_B]),
      revokeAllForAdmin: vi.fn().mockResolvedValue([GEN_A, GEN_B]),
      readLiveness: vi
        .fn()
        .mockResolvedValue({ reason: null, lastActiveAt: new Date(), familyId: FAMILY_ID }),
      createFirstGeneration: vi.fn(async (input: {
        adminId: string;
        expiresAt: Date;
        reauthenticateAt: Date;
      }) =>
        makeSession({
          adminId: input.adminId,
          expiresAt: input.expiresAt,
          reauthenticateAt: input.reauthenticateAt,
        }),
      ),
      // No `expiresAt` parameter: the real `rotate` reads both activity clocks off
      // the parent ROW inside its own transaction, under the family lock. Uncontended
      // — which is every case in this file — the row and the object agree, so the
      // double answers with the parent's own values. That is what keeps "a refresh is
      // not activity" observable through this double.
      rotate: vi.fn(async (parent: AdminSession, _client: unknown) =>
        makeSession({
          id: '01920000-0000-7000-8000-00000000000c',
          familyId: parent.familyId,
          parentId: parent.id,
          lastActiveAt: parent.lastActiveAt,
          expiresAt: parent.expiresAt,
          reauthenticateAt: parent.reauthenticateAt,
        }),
      ),
      ...overrides.sessions,
    },
    admins: {
      findById: vi.fn().mockResolvedValue(makeAdmin({ id: ADMIN_ID })),
      touchLastSeen: vi.fn().mockResolvedValue(undefined),
      ...overrides.admins,
    },
    cache: overrides.cache ?? makeCache(),
  };

  const service = new SessionService(
    doubles.sessions as never,
    doubles.admins as never,
    doubles.cache as never,
  );

  return { service, genA: a, genB: b, ...doubles };
}

function principal(sessionId: string) {
  // `familyId` is deliberately NOT `sessionId`: this file's subject is which of the
  // two `logout` and `rotate` reach for, and equal values would hide a mix-up.
  return { adminId: ADMIN_ID, sessionId, familyId: FAMILY_ID, role: 'SUPER_ADMIN' as const };
}

/** A real signed refresh token, so `resolveSessionId` exercises `verifyRefreshToken`
 *  rather than a stub of it — the `sid` claim is the whole input to the bug. */
function refreshFor(sessionId: string, adminId = ADMIN_ID) {
  return signRefreshToken({
    adminId,
    sessionId,
    familyId: FAMILY_ID,
    // Far enough out that the token is live for every test here; the ones about
    // deadlines set the SESSION ROW's clocks, which is what `rotate` actually reads.
    //
    // Note this helper always mints a FRESH token, which is exactly why it could not
    // surface F03 — the bug was in what `mint` freezes into a token that is then
    // presented later. The two-rotation test in this file does that instead.
    ceilingAt: new Date(Date.now() + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000),
  }).token;
}

function slugOf(err: unknown): string {
  return err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
}

// ─── logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
  /** ═══ THE ONE THE BUG WAS ═══════════════════════════════════════════════ */
  it('kills the LIVE generation when handed a STALE refresh token', async () => {
    const t = build();

    // Tab B's token names generation A, which was rotated away and is already dead.
    await t.service.logout(principal(GEN_B), refreshFor(GEN_A));

    // The family, not the generation. Revoking `GEN_A` alone would leave `GEN_B`
    // live for the rest of the twelve-hour refresh window.
    expect(t.sessions.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, REVOKE_REASON.LOGOUT);
  });

  it('caches a revocation for EVERY generation the family returned', async () => {
    const t = build();

    await t.service.logout(principal(GEN_B), refreshFor(GEN_A));

    // Without this the still-live access token from a revoked generation keeps
    // working until it expires, because AuthGuard reads the cache, not the table.
    const cached = t.cache.setFlag.mock.calls.map((c) => c[0] as string);
    expect(cached).toEqual(
      expect.arrayContaining([KEYS.session.revoked(GEN_A), KEYS.session.revoked(GEN_B)]),
    );
  });

  it('revokes the family when only a principal is presented', async () => {
    const t = build();
    await t.service.logout(principal(GEN_B), undefined);
    expect(t.sessions.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, REVOKE_REASON.LOGOUT);
  });

  it('revokes the family when only a refresh token is presented', async () => {
    const t = build();
    await t.service.logout(null, refreshFor(GEN_B));
    expect(t.sessions.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, REVOKE_REASON.LOGOUT);
  });

  /**
   * Idempotent. A client may retry a logout, and "already logged out" is a success
   * from the caller's point of view — there is nothing for them to do differently.
   */
  it('returns quietly for a session that no longer exists', async () => {
    const t = build({
      sessions: { findById: vi.fn().mockResolvedValue(null) },
    });

    await expect(t.service.logout(principal(GEN_B), undefined)).resolves.toBeUndefined();
    expect(t.sessions.revokeFamily).not.toHaveBeenCalled();
  });

  /**
   * Ownership, checked twice. `resolveSessionId` rejects a token whose `sub`
   * disagrees with the principal; this asserts the second check, on the resolved
   * row's own `adminId`. It matters more now than it did: the blast radius is a
   * whole family rather than one row.
   */
  it('refuses a token naming a session that belongs to another admin', async () => {
    const other = '01920000-0000-7000-8000-0000000000ff';
    const t = build();

    await expect(
      t.service.logout(principal(GEN_B), refreshFor(GEN_A, other)),
    ).rejects.toSatisfy((err) => slugOf(err) === ERR.TOKEN_INVALID);
  });

  it('refuses when neither a principal nor a token is presented', async () => {
    const t = build();
    await expect(t.service.logout(null, undefined)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.UNAUTHENTICATED,
    );
  });
});

// ─── logout-all ──────────────────────────────────────────────────────────────

describe('logoutAll', () => {
  /** Every family, not just the caller's — that is the difference from `logout`. */
  it('revokes every session the admin has', async () => {
    const t = build();
    await t.service.logoutAll(principal(GEN_B), undefined);
    expect(t.sessions.revokeAllForAdmin).toHaveBeenCalledWith(
      ADMIN_ID,
      REVOKE_REASON.LOGOUT_ALL,
    );
  });

  it('caches a revocation for each one', async () => {
    const t = build();
    await t.service.logoutAll(principal(GEN_B), undefined);
    expect(t.cache.setFlag).toHaveBeenCalledTimes(2);
  });
});

/**
 * ═══ A LOGOUT MID-REFRESH IS NOT CREDENTIAL THEFT ══════════════════════════════
 *
 * `rotate` now refuses when the session family was revoked while the refresh was in
 * flight, and the class it throws decides what the admin is told.
 *
 * Reusing `SessionRotationConflict` would have been the obvious shortcut, and it
 * would have been wrong in a way nobody would notice for months: that class routes
 * to `handleReuse`, which revokes the family a second time with REUSE_DETECTED,
 * answers `session_reuse_detected`, and logs a WARN saying a refresh token was
 * replayed. Under the BFF a refresh is automatic and unprompted, so this path is
 * reached whenever somebody clicks "log out" while a background rotation happens to
 * be running — an ordinary event that would be reported to them as a stolen token,
 * and would overwrite the true LOGOUT reason with a false one.
 */
describe('rotate against a family revoked mid-flight', () => {
  const CLIENT: ClientContext = {
    ip: '203.0.113.195',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };

  function racedBy(reason: string | null) {
    return build({
      sessions: {
        rotate: vi.fn().mockRejectedValue(new SessionFamilyRevoked(FAMILY_ID, reason)),
      },
    });
  }

  it('answers session_revoked rather than session_reuse_detected', async () => {
    const t = racedBy(REVOKE_REASON.LOGOUT);

    await expect(t.service.rotate(refreshFor(GEN_B), CLIENT)).rejects.toSatisfy(
      (err: unknown) => err instanceof ProblemException && err.type === ERR.SESSION_REVOKED,
    );
  });

  it('does not revoke the family again, and does not report a replay', async () => {
    const t = racedBy(REVOKE_REASON.LOGOUT);

    await t.service.rotate(refreshFor(GEN_B), CLIENT).catch(() => undefined);

    // `handleReuse` is the thing that must NOT have run: it would stamp the family
    // REUSE_DETECTED over the LOGOUT that actually ended it.
    expect(t.sessions.revokeFamily).not.toHaveBeenCalled();
  });

  /**
   * The reason travels from the row that was read under the lock all the way to the
   * message, so an admin whose sessions were ALL ended is told that, rather than
   * being sent looking for a single device that was not involved.
   */
  it.each([
    [REVOKE_REASON.LOGOUT, 'SESSION_REVOKED'],
    [REVOKE_REASON.LOGOUT_ALL, 'SESSION_REVOKED_ALL'],
    [REVOKE_REASON.PASSWORD_CHANGED, 'SESSION_REVOKED_ALL'],
    [null, 'SESSION_REVOKED'],
  ])('carries the family reason %s through as %s', async (reason, expected) => {
    const t = racedBy(reason);

    await expect(t.service.rotate(refreshFor(GEN_B), CLIENT)).rejects.toMatchObject({
      messageCode: expected,
    });
  });
});

// ─── assertLive ──────────────────────────────────────────────────────────────

describe('assertLive', () => {
  /** A positive flag is the one answer Redis can give that stands on its own. */
  it('refuses a session the cache reports revoked, without touching the database', async () => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(true);
    const t = build({ cache });

    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_REVOKED,
    );
    expect(t.cache.flag).toHaveBeenCalledWith(KEYS.session.revoked(GEN_B));
    expect(t.sessions.readLiveness).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE SPLIT BRAIN: A REVOCATION POSTGRES HAS AND REDIS LOST ═════════════
   *
   * This replaced a test that asserted the exact opposite — that a `false` flag
   * short-circuits the database — and that test was load-bearing for the bug, so
   * do not soften it back.
   *
   * The sequence is entirely ordinary, needing no unusual timing:
   *
   *   1. `revokeFamily` commits. Postgres now says revoked.
   *   2. `cacheRevocations` calls `setFlag`; the Redis write is lost. `setFlag`
   *      fails open by design — the revocation is already committed, so there is
   *      nothing to roll back and throwing would 500 a successful logout.
   *   3. The next request reads the flag. `exists` returns 0 → `false`, because
   *      the key was never written. Redis CANNOT tell that apart from "this
   *      session was never revoked".
   *   4. Trusting that `false` accepted the revoked access JWT for the remainder
   *      of its 15 minutes.
   *
   * One dropped Redis command and logout became cosmetic — the same class of
   * failure as the stale-token bug at the top of this file, reached by a different
   * route. Postgres is asked because only Postgres knows.
   */
  it('refuses a session Postgres revoked even when the Redis flag write was lost', async () => {
    const cache = makeCache();
    // The lost write: `setFlag` reports success (it swallows its own errors) and
    // the key is nevertheless absent on the next read.
    cache.setFlag.mockResolvedValue(undefined);
    cache.flag.mockResolvedValue(false);

    const t = build({ cache, sessions: { readLiveness: vi.fn().mockResolvedValue({ reason: 'revoked', lastActiveAt: new Date() }) } });

    // Step 1–2, through the real code path rather than a hand-set fixture.
    await t.service.logout(principal(GEN_B), undefined);
    expect(t.sessions.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, REVOKE_REASON.LOGOUT);
    expect(t.cache.setFlag).toHaveBeenCalled();

    // Steps 3–4: the very next request must be refused anyway.
    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_REVOKED,
    );
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(GEN_B);
  });

  /** Same reasoning for the other two revocation entry points named in the gate. */
  it.each([
    ['logout-all', (s: SessionService) => s.logoutAll(principal(GEN_B), undefined)],
    [
      'a credential-change sweep',
      (s: SessionService) => s.revokeAllForAdmin(ADMIN_ID, REVOKE_REASON.LOGOUT_ALL),
    ],
  ])('refuses after %s when the Redis flag write was lost', async (_label, revoke) => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(false);
    const t = build({ cache, sessions: { readLiveness: vi.fn().mockResolvedValue({ reason: 'revoked', lastActiveAt: new Date() }) } });

    await revoke(t.service);

    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_REVOKED,
    );
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(GEN_B);
  });

  /**
   * ═══ CASE 5: AN IDLE TIMEOUT SAYS SO ═══════════════════════════════════════
   *
   * Expiry has no flag at all — nothing ever calls `setFlag` for it — so a `false`
   * reading is the ONLY thing Redis can say about an expired session. Another reason
   * the negative answer cannot be terminal.
   *
   * And the refusal is `session_expired`, not `session_revoked`. Both are 401 and both
   * call for the same client cleanup, but only a revocation is something someone else
   * did; telling an admin who was simply idle that their session "has been revoked"
   * reads as a security event they need to act on.
   */
  it('refuses an expired session as EXPIRED, which the cache never flags', async () => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(false);
    const t = build({ cache, sessions: { readLiveness: vi.fn().mockResolvedValue({ reason: 'expired', lastActiveAt: new Date() }) } });

    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_EXPIRED,
    );
    expect(t.cache.setFlag).not.toHaveBeenCalled();
  });

  /**
   * The cache's positive flag is written only by `cacheRevocations`, which runs after
   * an actual revoke — so that fast path can never mean "timed out", and must keep
   * answering `session_revoked` even though the database is not consulted.
   */
  it('keeps the cached fast path reporting revoked, never expired', async () => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(true);
    const t = build({ cache, sessions: { readLiveness: vi.fn().mockResolvedValue({ reason: 'expired', lastActiveAt: new Date() }) } });

    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_REVOKED,
    );
    expect(t.sessions.readLiveness).not.toHaveBeenCalled();
  });

  /**
   * `null` means "Redis could not answer". It lands in the same branch as
   * `false`, which is the point — neither is evidence that a session is live.
   */
  it('falls through to the database when the cache cannot answer', async () => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(null);
    const t = build({ cache, sessions: { readLiveness: vi.fn().mockResolvedValue({ reason: 'revoked', lastActiveAt: new Date() }) } });

    await expect(t.service.assertLive(GEN_B)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.SESSION_REVOKED,
    );
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(GEN_B);
  });

  it('accepts a live session with Redis unreachable', async () => {
    const cache = makeCache();
    cache.flag.mockResolvedValue(null);
    const t = build({ cache });

    // Resolves rather than throws, and resolves to the row's activity instant — the
    // value `GET /auth/session` reports. Not `undefined` any more: this method
    // returns what it read, so the one route that wants it needs no second query.
    // A pair now, not a bare instant: `assertLive` also hands back the stable login
    // id, because the row it reads already carries it and `GET /auth/me` reports it.
    await expect(t.service.assertLive(GEN_B)).resolves.toEqual({
      lastActiveAt: expect.any(Date),
      familyId: FAMILY_ID,
    });
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(GEN_B);
  });

  /** The happy path still costs a lookup: only Postgres can confirm liveness. */
  it('accepts a session only after Postgres confirms it is usable', async () => {
    const t = build();
    // A pair now, not a bare instant: `assertLive` also hands back the stable login
    // id, because the row it reads already carries it and `GET /auth/me` reports it.
    await expect(t.service.assertLive(GEN_B)).resolves.toEqual({
      lastActiveAt: expect.any(Date),
      familyId: FAMILY_ID,
    });
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(GEN_B);
  });
});

// ─── issue ──────────────────────────────────────────────────────────────────

describe('issue', () => {
  const client: ClientContext = {
    ip: '203.0.113.195',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };

  it('stores the immutable 12h ceiling and the idle deadline from the window', async () => {
    const t = build();
    const admin = makeAdmin({ id: ADMIN_ID });

    const before = Date.now();
    const issued = await t.service.issue(admin, 'TOTP', client);
    const after = Date.now();

    expect(t.sessions.createFirstGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: ADMIN_ID,
        mfaMethod: 'TOTP',
        client,
        lastActiveAt: expect.any(Date),
        expiresAt: expect.any(Date),
        reauthenticateAt: expect.any(Date),
      }),
    );

    const createFn = t.sessions.createFirstGeneration as ReturnType<typeof vi.fn>;
    const call = createFn.mock.calls[0]?.[0] as {
      lastActiveAt: Date;
      expiresAt: Date;
      reauthenticateAt: Date;
    };
    const reauthMs = call.reauthenticateAt.getTime();
    const expiresMs = call.expiresAt.getTime();
    const activeMs = call.lastActiveAt.getTime();

    // reauthenticateAt is exactly 12 hours from now
    expect(reauthMs).toBeGreaterThanOrEqual(before + SESSION.ABSOLUTE_TTL_SECONDS * 1000);
    expect(reauthMs).toBeLessThanOrEqual(after + SESSION.ABSOLUTE_TTL_SECONDS * 1000);

    // ═══ THE LOGIN INSTANT IS THE FIRST ACTIVITY ═════════════════════════════
    //
    // The requirement's initial value: sign in at 10:00 and `last_active_at` is
    // 10:00. So an admin who signs in and walks away is idle from the sign-in.
    expect(activeMs).toBeGreaterThanOrEqual(before);
    expect(activeMs).toBeLessThanOrEqual(after);

    // And the deadline is derived from THAT, by the same rule `touch` applies later
    // — not from a separate `now()`, which would let the two drift by a round trip.
    expect(expiresMs).toBe(activeMs + SESSION.INACTIVITY_TIMEOUT_SECONDS * 1000);

    expect(t.admins.touchLastSeen).toHaveBeenCalledWith(ADMIN_ID);
    expect(issued.sessionId).toBeDefined();
    expect(issued.accessToken).toBeDefined();
    expect(issued.refreshToken).toBeDefined();
  });

  /**
   * ═══ EVERY SIGN-IN PATH GOES THROUGH THIS ONE METHOD ═══════════════════════
   *
   * The requirement asks for the initial timestamp on the login, TOTP and passkey
   * flows separately. They are the same code path: `MfaService.complete` is the only
   * caller of `issue`, and all four of its branches — TOTP sign-in, TOTP enrollment
   * confirmed mid-sign-in, passkey registration, passkey assertion — reach it. So the
   * timestamp is proven once, here, and `tests/auth/mfa.spec.ts` covers the branches
   * arriving.
   *
   * This test is the guard against the funnel being widened: a second caller of
   * `createFirstGeneration` that computed its own clocks would not be covered by the
   * assertion above.
   */
  it('is the only thing that computes a new session clock', async () => {
    const t = build();
    await t.service.issue(makeAdmin({ id: ADMIN_ID }), 'TOTP', client);

    expect(t.sessions.createFirstGeneration).toHaveBeenCalledTimes(1);
    // Not `rotate`: a new sign-in is a new family, never a child generation.
    expect(t.sessions.rotate).not.toHaveBeenCalled();
  });
});

// ─── rotate (immutable ceiling & idle timeout) ──────────────────────────────

describe('rotate - absolute ceiling and idle timeout', () => {
  const client: ClientContext = {
    ip: '203.0.113.195',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };

  const SESSION_START = new Date('2026-06-15T00:00:00.000Z');
  const ABSOLUTE_CEILING = new Date(SESSION_START.getTime() + 12 * 60 * 60 * 1000); // 12:00:00

  /**
   * ═══ A REFRESH IS NOT ACTIVITY ═════════════════════════════════════════════
   *
   * These two cases used to assert the opposite: that a rotation recomputed the
   * child's deadline as `min(now + idle, ceiling)`. That was wrong, and the OREBiT
   * auth spec says why in as many words — background polling and token refresh do
   * not count as activity.
   *
   * It mattered little while a client refreshed on its own timer and mattered
   * completely once the BFF made refresh automatic and unprompted: the mechanism that
   * keeps a session USABLE would have been the only thing keeping it ALIVE, so a
   * session nobody was touching would never have expired.
   *
   * The idle window is advanced by `SessionDbOperation.touch`, called from
   * `AuthGuard` for requests not marked `@NotActivity()`. `rotate` carries the
   * parent's deadline forward verbatim, which is what both cases below now pin.
   *
   * The CEILING was always copied and still is — see the hour-12 case below, which
   * is unchanged and is what stops any sequence of refreshes outliving the sign-in.
   */
  it('carries the parent expiresAt forward unchanged rather than extending it', async () => {
    // 1 hour into the session (01:00:00)
    const hour1 = new Date(SESSION_START.getTime() + 1 * 60 * 60 * 1000);
    const parentExpiry = new Date(SESSION_START.getTime() + 2 * 60 * 60 * 1000); // 02:00:00
    vi.useFakeTimers();
    vi.setSystemTime(hour1);

    try {
      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: parentExpiry,
        reauthenticateAt: ABSOLUTE_CEILING, // 12:00:00
        rotatedAt: null,
        revokedAt: null,
      });

      const t = build({
        sessions: { findById: vi.fn().mockResolvedValue(parent) },
      });

      const issued = await t.service.rotate(refreshFor(GEN_A), client);

      // NOT hour1 + the idle window. The refresh contributed nothing to the deadline.
      //
      // And it now contributes nothing by CONSTRUCTION rather than by arithmetic: the
      // service passes no deadline at all, so there is no argument left through which
      // a refresh could smuggle a longer life. That is a stronger form of the property
      // this test was written to pin than the old third-argument assertion was.
      expect(t.sessions.rotate).toHaveBeenCalledWith(parent, client);
      expect(issued.refreshExpiresAt).toEqual(parentExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cannot keep a session alive by refreshing it in a loop', async () => {
    // The failure the old rule produced, stated as a test: a client refreshing
    // every few minutes against a deadline half an hour away used to push that
    // deadline a full window out on every call, indefinitely. Now the deadline it
    // inherits is the one real activity last left, so the session dies on schedule
    // however often it is refreshed.
    const hour11 = new Date(SESSION_START.getTime() + 11 * 60 * 60 * 1000);
    const lastRealActivity = new Date(SESSION_START.getTime() + 11.5 * 60 * 60 * 1000);
    vi.useFakeTimers();
    vi.setSystemTime(hour11);

    try {
      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: lastRealActivity, // 11:30:00
        reauthenticateAt: ABSOLUTE_CEILING, // 12:00:00
        rotatedAt: null,
        revokedAt: null,
      });

      const t = build({
        sessions: { findById: vi.fn().mockResolvedValue(parent) },
      });

      const issued = await t.service.rotate(refreshFor(GEN_A), client);

      // hour11 + the idle window would have been clamped to the 12:00 ceiling —
      // still free life bought by a refresh rather than by the admin.
      // It buys nothing now, and there is no longer a parameter it could buy it with.
      expect(t.sessions.rotate).toHaveBeenCalledWith(parent, client);
      expect(issued.refreshExpiresAt).toEqual(lastRealActivity);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses refresh at or after hour 12 (reauthenticateAt reached) with token_expired', async () => {
    // Exactly at hour 12 (12:00:00)
    const hour12 = new Date(SESSION_START.getTime() + 12 * 60 * 60 * 1000);
    vi.useFakeTimers();
    vi.setSystemTime(hour12);

    try {
      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: ABSOLUTE_CEILING,
        reauthenticateAt: ABSOLUTE_CEILING,
        rotatedAt: null,
        revokedAt: null,
      });

      const t = build({
        sessions: { findById: vi.fn().mockResolvedValue(parent) },
      });

      await expect(t.service.rotate(refreshFor(GEN_A), client)).rejects.toSatisfy(
        (err) => slugOf(err) === ERR.TOKEN_EXPIRED,
      );

      expect(t.sessions.rotate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ═══ F03: AN ACTIVE SESSION MUST NOT LOSE ITS REFRESH CAPABILITY ═══════════
   *
   * The refresh JWT's `exp` used to be the session row's idle deadline as it stood
   * at ROTATION time. That deadline moves — `touch` pushes it forward on every
   * eligible request — but a signed JWT cannot move with it. And the ordering makes
   * the gap unavoidable rather than unlucky: `bff.resolve` (which mints) runs at
   * guards.ts:191, `sessions.touch` (which advances the row) at guards.ts:235, and
   * the latter is fire-and-forget. The token is therefore ALWAYS minted against a
   * `lastActiveAt` that is already stale.
   *
   * So an admin who is quiet for a while and then works continuously gets a token
   * whose frozen deadline arrives while the row is still comfortably alive, and is
   * signed out mid-task with `token_expired`.
   *
   * The two rotations below are the real thing: the second presents the token the
   * FIRST one minted, which is the only way to observe what `mint` froze into it.
   * `refreshFor` cannot show this — it deliberately signs a fresh, live token so
   * that the deadline tests exercise the ROW, which is why this never surfaced here.
   */
  it('can still refresh after the deadline that was frozen into its previous token', async () => {
    const CHILD = '01920000-0000-7000-8000-00000000000c';
    vi.useFakeTimers();
    vi.setSystemTime(SESSION_START);

    try {
      // A session that has been quiet: the row's idle deadline is only 10 min out.
      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: new Date(SESSION_START.getTime() + 10 * 60 * 1000),
        reauthenticateAt: ABSOLUTE_CEILING,
        rotatedAt: null,
        revokedAt: null,
      });
      const first = build({ sessions: { findById: vi.fn().mockResolvedValue(parent) } });

      // The BFF rotates on the admin's behalf. Whatever deadline this mints is frozen.
      const issued = await first.service.rotate(refreshFor(GEN_A), client);

      // The admin now works steadily for twenty minutes. `touch` keeps the ROW alive,
      // pushing its deadline out to 00:50 — well past the 00:10 the token remembers.
      vi.setSystemTime(new Date(SESSION_START.getTime() + 20 * 60 * 1000));
      const child = makeSession({
        id: CHILD,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        expiresAt: new Date(SESSION_START.getTime() + 50 * 60 * 1000),
        reauthenticateAt: ABSOLUTE_CEILING,
        rotatedAt: null,
        revokedAt: null,
      });
      const second = build({ sessions: { findById: vi.fn().mockResolvedValue(child) } });

      // The session is alive by every authoritative measure. Only the token disagreed.
      await expect(second.service.rotate(issued.refreshToken, client)).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ═══ THE GATE THAT MUST KEEP DOING THE WORK ════════════════════════════════
   *
   * The companion to the test above, and the one that stops the fix becoming a hole.
   * The token here is freshly signed and verifiably LIVE — `refreshFor` mints it at
   * `now`. The row's idle deadline is in the past. The refusal must therefore come
   * from `session.expiresAt` in PostgreSQL (session.service.ts:158), never from the
   * JWT's own `exp`.
   *
   * It passes before the F03 change and after it, which is the proof that the
   * database was always the authority here and that lengthening the token's life
   * cannot let an idle-expired session through.
   */
  it('refuses an idle-expired row even though the presented token is still valid', async () => {
    const hour4 = new Date(SESSION_START.getTime() + 4 * 60 * 60 * 1000);
    vi.useFakeTimers();
    vi.setSystemTime(hour4);

    try {
      const token = refreshFor(GEN_A);
      // Not an assumption: the token really is live at this instant.
      expect(() => verifyRefreshToken(token)).not.toThrow();

      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: new Date(SESSION_START.getTime() + 3 * 60 * 60 * 1000), // idle-expired
        reauthenticateAt: ABSOLUTE_CEILING,
        rotatedAt: null,
        revokedAt: null,
      });
      const t = build({ sessions: { findById: vi.fn().mockResolvedValue(parent) } });

      await expect(t.service.rotate(token, client)).rejects.toSatisfy(
        (err) => slugOf(err) === ERR.TOKEN_EXPIRED,
      );
      expect(t.sessions.rotate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses refresh after idle timeout even if before absolute ceiling', async () => {
    // 4 hours into the session, but last refresh was at hour 1 (expiresAt = 03:00:00)
    const hour4 = new Date(SESSION_START.getTime() + 4 * 60 * 60 * 1000);
    vi.useFakeTimers();
    vi.setSystemTime(hour4);

    try {
      const parent = makeSession({
        id: GEN_A,
        adminId: ADMIN_ID,
        familyId: FAMILY_ID,
        createdAt: SESSION_START,
        expiresAt: new Date(SESSION_START.getTime() + 3 * 60 * 60 * 1000), // expired at 03:00:00
        reauthenticateAt: ABSOLUTE_CEILING, // 12:00:00
        rotatedAt: null,
        revokedAt: null,
      });

      const t = build({
        sessions: { findById: vi.fn().mockResolvedValue(parent) },
      });

      await expect(t.service.rotate(refreshFor(GEN_A), client)).rejects.toSatisfy(
        (err) => slugOf(err) === ERR.TOKEN_EXPIRED,
      );

      expect(t.sessions.rotate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

