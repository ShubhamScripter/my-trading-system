import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { csrfTokenMatches, generateCsrfToken } from '../../auth/auth.utility';
import type { BffSessionService } from '../../auth/security/bff.session';
import { OptionalAuthGuard } from '../../auth/security/guards';
import { sessionCookie } from '../../auth/security/session.cookie';
import { AuthController } from '../../auth/auth.controller';
import { makeAdmin, makePrincipal } from '../harness';
import type { SessionService } from '../../auth/services/session.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ WHY DOUBLE-SUBMIT ALONE WAS NOT ENOUGH ════════════════════════════════
 *
 * The CSRF token used to be `randomBytes(32)`, and the check was that the cookie
 * and the header carried the same value. That question can be answered by anyone
 * who can WRITE the cookie, and writing is governed by a far weaker rule than
 * reading: any sibling subdomain can set a cookie on the parent domain.
 *
 * So `blog.orebit.io` — or a stray CNAME, or a vendor widget that can emit a
 * `Set-Cookie` for `.orebit.io` — plants a value it chose in `orebit_admin_csrf`
 * and echoes the same value in the header. Both halves agree. The check passes.
 * The admin's own session cookie, attached by the browser, authenticates it.
 *
 * The token is now `nonce.HMAC(pepper, nonce:handle)`. The forgery above requires
 * signing over a handle the attacker cannot read, with a pepper they do not have.
 * `refuses a matching pair the caller chose for itself` below is that attack, and it
 * is the test that would have passed against the old implementation.
 *
 * ═══ TWO THINGS MOVED, AND THIS FILE MOVED WITH THEM ═══════════════════════
 *
 *   what it binds to  The cookie used to carry the refresh JWT, so the token was
 *                     bound to that. It now carries an opaque handle naming a
 *                     server-side record, so the token binds to the handle. The
 *                     property is identical; only the secret's name changed.
 *   where it runs     It used to fire inside `sessionCookie.require()`, i.e. on the
 *                     one route that read a cookie. The cookie is root-scoped now,
 *                     so every mutating route is cookie-authenticated and the check
 *                     lives in `authenticate()` — which is why the enforcement cases
 *                     below drive a GUARD rather than the cookie port.
 */

const HANDLE = 'handle-for-session-one';
const OTHER_HANDLE = 'handle-for-session-two';

/** A request carrying whichever cookies and headers a case needs. */
function makeReq(
  cookies: Record<string, string>,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return { cookies, headers, method, url: '/admins', ip: '203.0.113.5' };
}

function makeReply() {
  const set: Record<string, { value: string; options: Record<string, unknown> }> = {};
  return {
    set,
    setCookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      set[name] = { value, options };
    }),
    clearCookie: vi.fn(),
  };
}

function bind(req: ReturnType<typeof makeReq>, reply = makeReply()) {
  return { cookies: sessionCookie(req as never, reply as never), reply };
}

describe('the token itself', () => {
  it('verifies against the handle it was minted for', () => {
    expect(csrfTokenMatches(generateCsrfToken(HANDLE), HANDLE)).toBe(true);
  });

  /** ═══ THE BINDING ══════════════════════════════════════════════════════ */
  it('does NOT verify against a different handle', () => {
    // A token captured from one session is useless against another. Without the
    // binding, any token we ever issued would work on any session.
    expect(csrfTokenMatches(generateCsrfToken(HANDLE), OTHER_HANDLE)).toBe(false);
  });

  it('issues a different token every time, for the same handle', () => {
    // The nonce. Two tabs on the same session must not receive an identical string,
    // or the token doubles as a session identifier.
    expect(generateCsrfToken(HANDLE)).not.toBe(generateCsrfToken(HANDLE));
  });

  it('rejects a value that was never signed', () => {
    expect(csrfTokenMatches('just-a-random-string', HANDLE)).toBe(false);
  });

  it('rejects a well-shaped value with a forged signature', () => {
    const real = generateCsrfToken(HANDLE);
    const nonce = real.slice(0, real.indexOf('.'));
    expect(csrfTokenMatches(`${nonce}.${'0'.repeat(64)}`, HANDLE)).toBe(false);
  });

  it('rejects a token with no separator, and one with an empty nonce', () => {
    expect(csrfTokenMatches('nodot', HANDLE)).toBe(false);
    expect(csrfTokenMatches('.signature', HANDLE)).toBe(false);
  });

  it('does not let the nonce be re-cut to forge a match', () => {
    // `indexOf` splits on the FIRST dot, so a nonce containing one cannot be
    // re-partitioned into a different (nonce, signature) pair that still verifies.
    const real = generateCsrfToken(HANDLE);
    const shifted = real.replace('.', '..');
    expect(csrfTokenMatches(shifted, HANDLE)).toBe(false);
  });
});

describe('issuing the pair', () => {
  it('sets a CSRF cookie that verifies against the handle', () => {
    const { cookies, reply } = bind(makeReq({}));
    const returned = cookies.issue(HANDLE, new Date(Date.now() + 3600_000));

    const cookie = reply.set[CSRF.COOKIE_NAME];
    expect(cookie?.value).toBe(returned);
    expect(csrfTokenMatches(returned, HANDLE)).toBe(true);
  });

  it('leaves the CSRF cookie readable and the session cookie not', () => {
    const { cookies, reply } = bind(makeReq({}));
    cookies.issue(HANDLE, new Date(Date.now() + 3600_000));

    // The page must read one to echo it back, and must never be able to read the
    // other. This is the asymmetry the whole scheme rests on.
    expect(reply.set[CSRF.COOKIE_NAME]?.options['httpOnly']).toBe(false);
    expect(reply.set[SESSION.COOKIE_NAME]?.options['httpOnly']).toBe(true);
  });

  it('scopes both cookies to the whole site', () => {
    // Every route authenticates from the session cookie now, so a narrower path
    // would silently unauthenticate every request outside it — and a CSRF cookie
    // sent on fewer routes than the credential it guards would fail the check on
    // requests that should have succeeded.
    const { cookies, reply } = bind(makeReq({}));
    cookies.issue(HANDLE, new Date(Date.now() + 3600_000));

    expect(reply.set[SESSION.COOKIE_NAME]?.options['path']).toBe('/');
    expect(reply.set[CSRF.COOKIE_NAME]?.options['path']).toBe('/');
  });

  /**
   * ═══ A PROPERTY THAT WAS DELIBERATELY GIVEN UP ═════════════════════════════
   *
   * Bound to the refresh token, the CSRF token rotated on every refresh for free, so
   * a captured pair went stale on the session's next use. The handle is stable for
   * the life of the session, so it no longer does.
   *
   * Pinned as a test rather than left as a comment because it is the one thing this
   * change made weaker, and a future reader should meet it as a decision rather than
   * discover it as a surprise. What still holds — that a captured pair is useless on
   * any OTHER session — is the case above.
   */
  it('does not re-bind when the tokens behind the session rotate', () => {
    const { cookies, reply } = bind(makeReq({}));
    cookies.issue(HANDLE, new Date(Date.now() + 3600_000));
    const issued = reply.set[CSRF.COOKIE_NAME]?.value ?? '';

    // A rotation replaces the access and refresh tokens inside the record; the
    // handle, and therefore this token, is untouched.
    expect(csrfTokenMatches(issued, HANDLE)).toBe(true);
  });
});

/**
 * The enforcement half, driven through `OptionalAuthGuard` because that is where the
 * check now lives. The guard is constructed directly rather than through Nest — it
 * takes two collaborators and neither needs a container.
 *
 * `bff.resolve` is a spy that would return a token if it were reached. Every refusal
 * below also asserts it was NOT reached, which pins the ORDERING: CSRF is checked
 * before the credential is spent, so a forged request never causes a session lookup,
 * let alone a token rotation.
 */
describe('enforcing it on a cookie-authenticated request', () => {
  function guardFor(req: ReturnType<typeof makeReq>) {
    const resolve = vi.fn().mockResolvedValue(null);
    const bff = { resolve } as unknown as BffSessionService;
    const sessions = { assertLive: vi.fn(), touch: vi.fn() } as unknown as SessionService;
    const guard = new OptionalAuthGuard(sessions, bff);
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { guard, context, resolve };
  }

  async function refusal(call: () => Promise<unknown>): Promise<ProblemException> {
    try {
      await call();
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      return err as ProblemException;
    }
    throw new Error('expected the call to be refused, but it succeeded');
  }

  /** A request holding a genuine, correctly-issued pair. */
  function legitimate(handle = HANDLE, method = 'POST') {
    const token = generateCsrfToken(handle);
    return makeReq(
      { [SESSION.COOKIE_NAME]: handle, [CSRF.COOKIE_NAME]: token },
      { [CSRF.HEADER_NAME]: token },
      method,
    );
  }

  it('accepts a correctly issued pair and goes on to resolve the session', async () => {
    const { guard, context, resolve } = guardFor(legitimate());
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(HANDLE, expect.anything());
  });

  /** ═══ THE ONE THE OLD SCHEME FAILED ════════════════════════════════════ */
  it('refuses a matching pair the caller chose for itself', async () => {
    // Exactly what a sibling subdomain can arrange: it writes the CSRF cookie and
    // sends the same value in the header, while the browser attaches the admin's
    // real session cookie. Under unsigned double-submit both halves matched and this
    // request went through.
    const planted = 'attacker-chosen-value';
    const { guard, context, resolve } = guardFor(
      makeReq(
        { [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: planted },
        { [CSRF.HEADER_NAME]: planted },
      ),
    );

    expect((await refusal(() => guard.canActivate(context))).type).toBe(ERR.FORBIDDEN);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a genuine token issued for a different session', async () => {
    // Signed, minted by us, and still wrong — it belongs to another handle.
    const foreign = generateCsrfToken(OTHER_HANDLE);
    const { guard, context, resolve } = guardFor(
      makeReq(
        { [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: foreign },
        { [CSRF.HEADER_NAME]: foreign },
      ),
    );

    expect((await refusal(() => guard.canActivate(context))).type).toBe(ERR.FORBIDDEN);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses when the header is missing', async () => {
    const token = generateCsrfToken(HANDLE);
    const { guard, context } = guardFor(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: token }),
    );

    expect((await refusal(() => guard.canActivate(context))).type).toBe(ERR.FORBIDDEN);
  });

  it('refuses when the header and cookie disagree', async () => {
    const { guard, context } = guardFor(
      makeReq(
        { [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: generateCsrfToken(HANDLE) },
        { [CSRF.HEADER_NAME]: generateCsrfToken(HANDLE) },
      ),
    );

    // Both are individually valid for this handle; they are not the same value, so
    // the double-submit half still has to fail.
    expect((await refusal(() => guard.canActivate(context))).type).toBe(ERR.FORBIDDEN);
  });

  it('refuses when the CSRF cookie is absent entirely', async () => {
    const { guard, context } = guardFor(makeReq({ [SESSION.COOKIE_NAME]: HANDLE }));
    expect((await refusal(() => guard.canActivate(context))).type).toBe(ERR.FORBIDDEN);
  });

  /**
   * ═══ THE TWO EXEMPTIONS, AND WHY EACH IS SOUND ═════════════════════════════
   */

  it('does not demand a token on a GET', async () => {
    // A safe method changes nothing, so there is nothing to forge. Demanding a token
    // would make every read fail for a client that has not read the cookie yet.
    const { guard, context, resolve } = guardFor(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE }, {}, 'GET'),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(HANDLE, expect.anything());
  });

  it('does not demand a token when there is no session cookie', async () => {
    // A bearer is not attached ambiently — the caller had to put it there — so there
    // is no cross-site request to forge, and demanding a token would break every
    // non-browser client for no gain.
    const { guard, context, resolve } = guardFor(makeReq({}, { authorization: 'Bearer nope' }));

    // It gets past CSRF and fails later, on the token itself. That it reached the
    // token at all is the assertion.
    await refusal(() => guard.canActivate(context));
    expect(resolve).not.toHaveBeenCalled();
  });
});

/**
 * ═══ F14 — RECOVERING THE TOKEN ON A SEPARATE PANEL HOST ═══════════════════
 *
 * `issue` returns the token so `POST /auth/login` can put it in the body, and that
 * was the only way to ever learn it. Enough for a panel on the API's own origin,
 * which can read `orebit_admin_csrf` with script — but `config.ADMIN_APP_URL` is a
 * separate origin and `corsOptions` sets `credentials: true` for it, so the panel
 * may legitimately live on another host.
 *
 * There the cookie is unreadable: host-only for the API, and reading another
 * origin's cookie is what the same-origin policy forbids. A RELOAD therefore left
 * the tab authenticated — the browser still attaches both cookies — with no way to
 * populate `x-csrf-token`, so every mutation AND the logout returned 403 until the
 * admin signed in again. The same-host localhost setup never showed it, because
 * cookies ignore ports.
 *
 * `ensureCsrf` reads the cookie the browser did send and reports it. The two
 * properties below are what make that safe rather than merely convenient.
 */
describe('F14 — ensureCsrf', () => {
  it('reports the existing token so a cross-origin panel can relearn it', () => {
    const token = generateCsrfToken(HANDLE);
    const { cookies } = bind(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: token }, {}, 'GET'),
    );

    expect(cookies.ensureCsrf()).toBe(token);
  });

  /**
   * ═══ THE PROPERTY THAT MAKES THIS SAFE ON A REPEATABLE ROUTE ═════════════
   *
   * `GET /auth/me` is a route a panel may call whenever it likes. Minting a fresh
   * token per call would invalidate the one an in-flight request is already
   * carrying, so a background refresh racing a save would make the save fail — a
   * self-inflicted version of the bug being fixed.
   */
  it('does not rotate a valid token, and sets no cookie at all', () => {
    const token = generateCsrfToken(HANDLE);
    const { cookies, reply } = bind(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: token }, {}, 'GET'),
    );

    expect(cookies.ensureCsrf()).toBe(token);
    expect(cookies.ensureCsrf()).toBe(token);
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('repairs an absent token, and the replacement verifies against the handle', () => {
    const { cookies, reply } = bind(makeReq({ [SESSION.COOKIE_NAME]: HANDLE }, {}, 'GET'));

    const token = cookies.ensureCsrf();

    expect(token).not.toBeNull();
    // The repair has to produce a token `assertCsrf` will accept, or it has reported
    // recovery while mutations keep failing.
    expect(csrfTokenMatches(token as string, HANDLE)).toBe(true);
    expect(reply.set[CSRF.COOKIE_NAME]?.value).toBe(token);
  });

  /**
   * A token minted for a DIFFERENT session is not ours to echo back. It fails
   * `assertCsrf`'s second check, so returning it would report a value the client
   * cannot use.
   */
  it('repairs a token bound to another handle rather than echoing it', () => {
    const foreign = generateCsrfToken(OTHER_HANDLE);
    const { cookies } = bind(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: foreign }, {}, 'GET'),
    );

    const token = cookies.ensureCsrf();

    expect(token).not.toBe(foreign);
    expect(csrfTokenMatches(token as string, HANDLE)).toBe(true);
  });

  /**
   * The sibling-subdomain attack from the top of this file, arriving at the recovery
   * path instead of the enforcement path. A planted value fails the HMAC, so it is
   * replaced rather than laundered into a valid one.
   */
  it('does not launder a value the caller planted for itself', () => {
    const planted = 'attacker-chose-this';
    const { cookies } = bind(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: planted }, {}, 'GET'),
    );

    expect(cookies.ensureCsrf()).not.toBe(planted);
  });

  it('reports null for a bearer caller, who is never asked for a token', () => {
    // Symmetric with `does not demand a token when there is no session cookie`
    // above: no ambient credential, so no CSRF requirement and nothing to report.
    // Reporting one would invite a script to start sending a header nothing checks.
    const { cookies, reply } = bind(makeReq({}, { authorization: 'Bearer nope' }, 'GET'));

    expect(cookies.ensureCsrf()).toBeNull();
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE REPAIR ERRS LONG, AND THE ASYMMETRY IS THE REASON ═══════════════
   *
   * A CSRF cookie outliving its session cookie protects nothing and authorises
   * nothing — an inert value whose partner is gone. One expiring FIRST fails the
   * double-submit check on requests that should have succeeded, which is the very
   * failure this method exists to end. So the repair uses the absolute ceiling,
   * the longest life any session can have.
   */
  it('gives the repaired cookie the session ceiling, never something shorter', () => {
    const { cookies, reply } = bind(makeReq({ [SESSION.COOKIE_NAME]: HANDLE }, {}, 'GET'));

    cookies.ensureCsrf();

    expect(reply.set[CSRF.COOKIE_NAME]?.options.maxAge).toBe(SESSION.ABSOLUTE_TTL_SECONDS);
  });

  it('keeps the repaired cookie readable and path-scoped like its partner', () => {
    const { cookies, reply } = bind(makeReq({ [SESSION.COOKIE_NAME]: HANDLE }, {}, 'GET'));

    cookies.ensureCsrf();
    const options = reply.set[CSRF.COOKIE_NAME]?.options;

    // Not httpOnly is the mechanism, not an oversight — a same-origin page reads it.
    // The two write sites share `csrfCookieOptions` precisely so these cannot drift.
    expect(options?.httpOnly).toBe(false);
    expect(options?.sameSite).toBe('lax');
    expect(options?.path).toBe(CSRF.COOKIE_PATH);
  });
});

/**
 * The route wiring, end to end through the controller.
 *
 * `ensureCsrf` above is the mechanism; this is the contract a panel actually reads.
 * Asserted here rather than in a routes spec because the question — "can a
 * cross-origin panel relearn its CSRF token" — is a CSRF question, and splitting it
 * from the cases above would leave each half looking complete on its own.
 */
describe('F14 — GET /auth/me carries the token', () => {
  const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';

  function buildController() {
    const admins = { findById: vi.fn().mockResolvedValue(makeAdmin({ id: ADMIN_ID })) };
    const controller = new AuthController(
      {} as never,
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );
    return { controller, principal: makePrincipal({ adminId: ADMIN_ID }) };
  }

  it('reports the token a cookie-authenticated panel must echo', async () => {
    const token = generateCsrfToken(HANDLE);
    const { cookies } = bind(
      makeReq({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: token }, {}, 'GET'),
    );
    const { controller, principal } = buildController();

    const { data } = await controller.me(principal, null, cookies.ensureCsrf());

    // The whole of F14: after a reload, this is the only place the token comes from
    // for a panel that cannot read the API host's cookie.
    expect(data.csrfToken).toBe(token);
  });

  it('reports null for a bearer caller rather than omitting the field', async () => {
    const { cookies } = bind(makeReq({}, { authorization: 'Bearer nope' }, 'GET'));
    const { controller, principal } = buildController();

    const { data } = await controller.me(principal, null, cookies.ensureCsrf());

    // Explicitly null, so a client can tell "no CSRF in this deployment" from "this
    // field is new and your server is old".
    expect(data.csrfToken).toBeNull();
    expect('csrfToken' in data).toBe(true);
  });

  it('adds the token without disturbing what the route already reported', async () => {
    const { cookies } = bind(makeReq({ [SESSION.COOKIE_NAME]: HANDLE }, {}, 'GET'));
    const { controller, principal } = buildController();

    const { data } = await controller.me(principal, 'family-id', cookies.ensureCsrf());

    expect(Object.keys(data).sort()).toEqual(['admin', 'csrfToken', 'session']);
    // The family id, still preferred over the rotation generation.
    expect(data.session.sessionId).toBe('family-id');
  });
});
