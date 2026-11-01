import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SESSION } from '../../auth/auth.constants';
import { AuthController } from '../../auth/auth.controller';
import { toSessionPayload } from '../../auth/auth.dto';
import type { IssuedSession } from '../../auth/auth.types';
import { toPublicAdmin } from '../../auth/auth.utility';
import { AuthGuard, OptionalAuthGuard } from '../../auth/security/guards';
import type { BffSessionService } from '../../auth/security/bff.session';
import { signAccessToken } from '../../auth/security/jwt';
import type { SessionService } from '../../auth/services/session.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin } from '../harness';

/**
 * ═══ THE CONTRACT THIS MIGRATION EXISTS TO ESTABLISH ═══════════════════════
 *
 * The browser knows one secret: the opaque handle in `orebit_admin_session`. It never
 * receives an access token, a refresh token, or anything else it could present to
 * the API directly.
 *
 * Two halves, and this file pins both:
 *
 *   what goes OUT   No response body carries a credential. Asserted against the
 *                   serialiser, because that is the single place every session
 *                   response is built.
 *   what comes IN   The guard resolves a cookie to a server-held token and hands the
 *                   existing pipeline the same `Principal` it always did. The point
 *                   is what did NOT change: `verifyAccessToken` and `assertLive` are
 *                   still the checks, so revocation and expiry behave as before.
 *
 * ─── Why the leak test asserts on a value, not a field list ───────────────
 *
 * The fixtures below use `refreshToken: 'rt-must-not-appear-in-any-body'` and an
 * access token spelled the same way. A test that listed forbidden FIELD NAMES would
 * pass the day someone renames one; a test that hunts for the VALUE cannot. The
 * consumer backend uses the same trick and for the same reason — an assertion on the
 * substring `refresh` would otherwise pass on `refreshExpiresAt`.
 */

const ACCESS = 'at-must-not-appear-in-any-body';
const REFRESH = 'rt-must-not-appear-in-any-body';

function makeIssued(overrides: Partial<IssuedSession> = {}): IssuedSession {
  return {
    sessionId: '01920000-0000-7000-8000-00000000000b',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessExpiresAt: new Date('2026-06-15T12:15:00.000Z'),
    refreshExpiresAt: new Date('2026-06-15T14:00:00.000Z'),
    reauthenticateAt: new Date('2026-06-16T00:00:00.000Z'),
    admin: toPublicAdmin(makeAdmin()),
    ...overrides,
  };
}

describe('what a session response carries', () => {
  /** ═══ NEITHER TOKEN, ANYWHERE IN THE PAYLOAD ════════════════════════════ */
  it('contains no access or refresh token', () => {
    const serialised = JSON.stringify(toSessionPayload(makeIssued(), 'csrf-token'));

    expect(serialised).not.toContain(ACCESS);
    expect(serialised).not.toContain(REFRESH);
  });

  it('still reports both deadlines, so a client can warn before either', () => {
    const payload = toSessionPayload(makeIssued(), 'csrf-token');

    // The idle deadline and the absolute ceiling are not interchangeable: one moves
    // on activity, the other never moves, and only the second can be counted down to.
    expect(payload.refreshExpiresAt).toBe('2026-06-15T14:00:00.000Z');
    expect(payload.reauthenticateAt).toBe('2026-06-16T00:00:00.000Z');
  });

  it('reports the CSRF token, which authorises nothing on its own', () => {
    // Returned in the body as well as a readable cookie so a client that cannot parse
    // `Set-Cookie` still has it. Not a credential: it proves only that a request came
    // from a page on our origin.
    expect(toSessionPayload(makeIssued(), 'csrf-token').csrfToken).toBe('csrf-token');
  });

  it('has no field whose value is a credential', () => {
    // The structural version of the first assertion, and the one that survives a
    // rename: every value is a timestamp, the CSRF token, or public account data.
    const payload = toSessionPayload(makeIssued(), 'csrf-token');
    expect(Object.keys(payload).sort()).toEqual([
      'admin',
      'csrfToken',
      'reauthenticateAt',
      'refreshExpiresAt',
    ]);
  });
});

/**
 * ═══ GET /auth/session ANSWERS EXACTLY FIVE FIELDS ═════════════════════════
 *
 * The narrowest useful answer, and the narrowness is the contract rather than a
 * coincidence — a frontend deciding what to render needs the role, and a reason it
 * can branch on, and nothing else. It previously carried `admin`, `expiresAt` and
 * `reauthenticateAt`; all three left, because account details belong on
 * `GET /auth/me` and the deadlines are reported at sign-in on `SessionPayload`.
 *
 * The exact-keys assertion is the point of this block. Asserting only that the five
 * expected fields are PRESENT would pass on a payload that also leaked a session id,
 * an expiry, or a token, which is what a `toEqual` on the whole object rules out.
 *
 * `message` and `lastActiveAt` are the two newest. The four signed-out codes the
 * first can carry instead, and the null the second becomes, are in
 * tests/auth/session-message.spec.ts.
 */
describe('GET /auth/session', () => {
  const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
  /** The stored activity instant the guard hands the handler. */
  const ACTIVE_AT = new Date('2026-09-08T10:05:00.000Z');

  function build(role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN', row: unknown | null = undefined) {
    const admin = row === undefined ? makeAdmin({ id: ADMIN_ID, role }) : row;
    const admins = { findById: vi.fn().mockResolvedValue(admin) };
    const controller = new AuthController(
      {} as never,
      // SessionService. Unreached: the handler reads the admin row and nothing else,
      // which is what removing the two deadlines bought.
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );
    // `familyId` distinct from `sessionId`: these routes report the LOGIN, and equal
    // values would let a test pass while the code read the generation.
    const principal = {
      adminId: ADMIN_ID,
      sessionId: 'sid',
      familyId: 'fam',
      role,
    } as const;
    return { controller, principal, admins };
  }

  it('returns exactly role, permissions, authenticated and message — and nothing else', async () => {
    const { controller, principal } = build();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data).toEqual({
      role: 'ADMIN',
      permissions: [],
      authenticated: true,
      lastActiveAt: '2026-09-08T10:05:00.000Z',
      message: { code: 'LOGGED_IN', text: 'You are logged in.' },
    });
  });

  /**
   * ═══ THE STORED INSTANT, NOT `now()` ═══════════════════════════════════════
   *
   * The handler reports what the guard handed it — the row's own `last_active_at`,
   * read by `assertLive` on the way in. Reporting `now()` instead would make the
   * field a tautology (always "just now") and hide the write interval the frontend
   * needs to reason about.
   */
  it('reports the STORED activity instant rather than the current time', async () => {
    const { controller, principal } = build();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.lastActiveAt).toBe(ACTIVE_AT.toISOString());
    // Nowhere near now: the fixture is a fixed date in the past.
    expect(new Date(data.lastActiveAt!).getTime()).toBeLessThan(Date.now());
  });

  it('reports null when no session row was read', async () => {
    // The cached-revocation fast path never queries, so there is no instant to give.
    const { controller, principal } = build();
    const { data } = await controller.sessionStatus(principal, null);

    expect(data.lastActiveAt).toBeNull();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('reports the real role: %s', async (role) => {
    // Not hardcoded, and not inferred from anything — it is the account's own value.
    const { controller, principal } = build(role);
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.role).toBe(role);
  });

  /**
   * The role comes from the DATABASE ROW, not from `Principal.role`.
   *
   * An access token lives fifteen minutes, so a demoted admin's `rol` claim is stale
   * for that long — and this endpoint is exactly what a UI decides what to show from.
   * `GET /auth/me` and `SuperAdminGuard` re-read for the same reason. This test is
   * what stops someone "simplifying" the handler by dropping the lookup.
   */
  it('prefers the freshly-read row over a stale token claim', async () => {
    const admins = { findById: vi.fn().mockResolvedValue(makeAdmin({ id: ADMIN_ID, role: 'ADMIN' })) };
    const controller = new AuthController(
      {} as never,
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );

    // The token still says SUPER_ADMIN; the account has since been demoted.
    const { data } = await controller.sessionStatus(
      {
        adminId: ADMIN_ID,
        sessionId: 'sid',
        familyId: 'fam',
        role: 'SUPER_ADMIN',
      },
      ACTIVE_AT,
    );

    expect(data.role).toBe('ADMIN');
    expect(admins.findById).toHaveBeenCalledWith(ADMIN_ID);
  });

  it('carries no token, no session id, and no expiry', async () => {
    // The structural assertion above already forbids these; this one names them, so a
    // failure says WHAT leaked rather than only that the shape changed.
    const { controller, principal } = build();
    const serialised = JSON.stringify((await controller.sessionStatus(principal, ACTIVE_AT)).data);

    for (const forbidden of [
      'accessToken',
      'refreshToken',
      'sessionId',
      'expiresAt',
      'reauthenticateAt',
      'admin',
      'email',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('permissions is an empty ARRAY, not null or absent', async () => {
    // A client is expected to iterate it from day one, so the shape has to be right
    // even while it is always empty.
    const { controller, principal } = build();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(Array.isArray(data.permissions)).toBe(true);
    expect(data.permissions).toHaveLength(0);
  });

  it('refuses rather than reporting authenticated:false when the account is gone', async () => {
    // A token outliving a soft-deleted admin is a stale credential, so 401 — and
    // deliberately NOT a 200 saying `authenticated: false`, which would discard the reason
    // the client needs.
    const { controller, principal } = build('ADMIN', null);

    await expect(controller.sessionStatus(principal, ACTIVE_AT)).rejects.toMatchObject({
      type: 'unauthenticated',
    });
  });
});

describe('how a request is authenticated', () => {
  /** The stable login the seeded access token's generation belongs to. Distinct from
   *  `PRINCIPAL_CLAIMS.sid` on purpose: the two are different identifiers with
   *  different jobs, and activity is keyed on this one. */
  const LIVE_FAMILY_ID = '01920000-0000-7000-8000-00000000f001';

  const PRINCIPAL_CLAIMS = {
    sub: '01920000-0000-7000-8000-00000000000a',
    sid: '01920000-0000-7000-8000-00000000000b',
    rol: 'SUPER_ADMIN' as const,
  };

  function build(
    options: {
      cookies?: Record<string, string>;
      headers?: Record<string, string>;
      method?: string;
      resolved?: string | null;
      notActivity?: boolean;
      assertLive?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const req = {
      cookies: options.cookies ?? {},
      headers: options.headers ?? {},
      method: options.method ?? 'GET',
      url: '/auth/me',
      ip: '203.0.113.9',
    };

    const resolve = vi.fn().mockResolvedValue(options.resolved ?? null);
    const bff = { resolve } as unknown as BffSessionService;
    const touch = vi.fn().mockResolvedValue(undefined);
    const sessions = {
      // `assertLive` resolves the PAIR the guard destructures — the stored activity
      // instant and the stable login id.
      //
      // `familyId` is a REAL id here rather than null, and that matters now: the guard
      // records activity against the family, so a null would be indistinguishable from
      // the fail-safe skip. It is also the faithful value — `readLiveness` selects it
      // from a NOT NULL column and an absent row throws instead, so a session that
      // reaches this point always has one. `lastActiveAt` stays null; no test here
      // reads it.
      assertLive:
        options.assertLive ??
        vi.fn().mockResolvedValue({ lastActiveAt: null, familyId: LIVE_FAMILY_ID }),
      touch,
    } as unknown as SessionService;

    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(options.notActivity === true ? true : undefined),
    };

    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;

    return {
      guard: new AuthGuard(sessions, bff, reflector as never),
      optional: new OptionalAuthGuard(sessions, bff),
      context,
      resolve,
      touch,
      req,
    };
  }

  /**
   * The token the cookie resolves to is a real signed access token, because
   * `verifyAccessToken` runs on it unchanged. `bearerFor` in the harness signs one
   * with the fixture key, which is what lets this test assert the whole path rather
   * than a stub of it.
   */
  function accessTokenFor(): string {
    return signAccessToken({
      adminId: PRINCIPAL_CLAIMS.sub,
      sessionId: PRINCIPAL_CLAIMS.sid,
      role: PRINCIPAL_CLAIMS.rol,
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
    }).token;
  }

  it('resolves the session cookie and authenticates from it', async () => {
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
    });

    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
    expect(t.resolve).toHaveBeenCalledWith('a-handle', expect.objectContaining({ ip: '203.0.113.9' }));
  });

  it('sends no bearer token of its own', async () => {
    // The behavioural statement of the whole change: a browser holding only the
    // cookie authenticates, with no `Authorization` header anywhere.
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
    });

    await t.guard.canActivate(t.context);
    expect(t.req.headers['authorization']).toBeUndefined();
  });

  it('still checks the session row, so revocation is not deferred to token expiry', async () => {
    // `assertLive` is what makes a logout take effect immediately rather than at the
    // end of the access token's fifteen minutes. Moving the token server-side must
    // not have skipped it.
    const assertLive = vi
      .fn()
      .mockResolvedValue({ lastActiveAt: null, familyId: LIVE_FAMILY_ID });
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
      assertLive,
    });

    await t.guard.canActivate(t.context);
    // Called with the GENERATION the token names — that is what identifies the
    // credential being checked. What comes back is the family, which is what
    // authorisation then binds to.
    expect(assertLive).toHaveBeenCalledWith(PRINCIPAL_CLAIMS.sid);
  });

  it('answers unauthenticated when the handle resolves to nothing', async () => {
    // A dead handle reads as "no credential", which is what the mandatory guard turns
    // into a 401. A REVOKED session throws its own slug from inside `resolve`, which
    // is how a client tells "sign in again" from "ended elsewhere".
    const t = build({ cookies: { [SESSION.COOKIE_NAME]: 'stale' }, resolved: null });

    await expect(t.guard.canActivate(t.context)).rejects.toMatchObject({
      type: 'unauthenticated',
    });
  });

  it('passes with no credential at all through the optional guard', async () => {
    const t = build();
    await expect(t.optional.canActivate(t.context)).resolves.toBe(true);
  });

  /**
   * ═══ A REGRESSION THE COOKIE INTRODUCED, AND THE FIX FOR IT ════════════════
   *
   * `POST /auth/session {logout}` must succeed even when the session is already
   * over — the spec requires a repeated logout to succeed, and an admin whose
   * session died while they were away has to end up signed out rather than staring
   * at an error.
   *
   * It used to work by accident: a browser sent no `Authorization` header on logout,
   * so `authenticate` found no credential, passed, and the controller cleaned up.
   * Once the COOKIE became what the guard inspects, a revoked session started
   * throwing from `bff.resolve` before the controller ran, and logout answered 401.
   *
   * Caught by curl, not by any unit test — every double in this file returns a
   * healthy session, so nothing exercised the dead-session path through the optional
   * guard until a live run revoked one. These are that path.
   */
  describe('a session that is already over', () => {
    const DEAD = ['session_revoked', 'session_reuse_detected', 'token_expired', 'unauthenticated'];

    it.each(DEAD)('is tolerated by the optional guard: %s', async (slug) => {
      const t = build();
      t.resolve.mockRejectedValue(new ProblemException({ type: slug as never }));
      t.req.cookies[SESSION.COOKIE_NAME] = 'a-dead-handle';

      // Passes with no principal, so logout falls through to its idempotent path.
      await expect(t.optional.canActivate(t.context)).resolves.toBe(true);
    });

    it.each(DEAD)('is still REFUSED by the mandatory guard: %s', async (slug) => {
      const t = build();
      t.resolve.mockRejectedValue(new ProblemException({ type: slug as never }));
      t.req.cookies[SESSION.COOKIE_NAME] = 'a-dead-handle';

      // The tolerance must not leak onto protected routes: a client needs the
      // specific reason to tell "sign in again" from "ended elsewhere".
      await expect(t.guard.canActivate(t.context)).rejects.toMatchObject({ type: slug });
    });

    it('does not swallow a refusal that is not about the session', async () => {
      // Only the four session-state slugs are tolerated. A malformed credential, a
      // forged CSRF token or an internal fault still throws from both guards.
      const t = build();
      t.resolve.mockRejectedValue(new ProblemException({ type: 'token_invalid' as never }));
      t.req.cookies[SESSION.COOKIE_NAME] = 'a-handle';

      await expect(t.optional.canActivate(t.context)).rejects.toMatchObject({
        type: 'token_invalid',
      });
    });
  });

  /** ═══ ACTIVITY ══════════════════════════════════════════════════════════ */

  it('records activity for an ordinary request', async () => {
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
    });

    await t.guard.canActivate(t.context);
    // ═══ THE FAMILY, NOT THE GENERATION ═════════════════════════════════════
    //
    // F07. This call is fire-and-forget, so it can land after a concurrent request
    // has already rotated the generation `sid` names — and a generation-keyed write
    // would then advance a row the session has moved past, leaving the live one
    // stale. Activity belongs to the login, so it is keyed on the login.
    expect(t.touch).toHaveBeenCalledWith(LIVE_FAMILY_ID);
    expect(t.touch).not.toHaveBeenCalledWith(PRINCIPAL_CLAIMS.sid);
  });

  it('refuses outright when no family id was resolved', async () => {
    // Unreachable in production: `readLiveness` reads `family_id` from a NOT NULL
    // column, and no row at all answers `revoked` rather than a null family. The
    // branch exists because the type permits it.
    //
    // It REFUSES rather than carrying on without the value, and that is the whole
    // point of testing an unreachable branch. Everything downstream binds to
    // `familyId` — the activity write, and the principal that elevation tickets and
    // reauth challenges are checked against — and there is no safe way to proceed:
    // skipping the authorisation key would drop a security boundary, and falling
    // back to `claims.sid` would reintroduce F08. So the request is unauthenticated.
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
      assertLive: vi.fn().mockResolvedValue({ lastActiveAt: null, familyId: null }),
    });

    await expect(t.guard.canActivate(t.context)).rejects.toSatisfy(
      (err: unknown) => err instanceof ProblemException && err.type === ERR.UNAUTHENTICATED,
    );
    expect(t.touch).not.toHaveBeenCalled();
  });

  it('does not record activity on a route marked @NotActivity()', async () => {
    // `GET /auth/session` is the case: a client that rechecks on tab focus and
    // reconnect would otherwise hold an abandoned session open by asking whether it
    // was still open.
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
      notActivity: true,
    });

    await t.guard.canActivate(t.context);
    expect(t.touch).not.toHaveBeenCalled();
  });

  it('never records activity through the optional guard', async () => {
    // Every route behind it is ending a session or partway through establishing one,
    // so there is no session whose window it would be correct to slide.
    const t = build({
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
      resolved: accessTokenFor(),
    });

    await t.optional.canActivate(t.context);
    expect(t.touch).not.toHaveBeenCalled();
  });
});
