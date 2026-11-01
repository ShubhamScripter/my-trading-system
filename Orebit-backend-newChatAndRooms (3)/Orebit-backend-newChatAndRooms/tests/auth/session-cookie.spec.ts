import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { cookieValue, sessionCookie } from '../../auth/security/session.cookie';
import { csrfTokenMatches } from '../../auth/auth.utility';

/**
 * The cookie pair that replaced the refresh token in a response body.
 *
 * What is worth testing here is not that `setCookie` was called — it is the three
 * properties the pair has to hold for the migration to be an improvement rather than a
 * rearrangement:
 *
 *   the pair moves together    issue, slide and clear each touch BOTH cookies. A
 *                              session cookie without its CSRF companion is a
 *                              cookie-authenticated state change with no CSRF
 *                              defence, which is worse than what it replaced.
 *   the cookie can be slid     this service has no absolute ceiling, so a cookie set
 *                              once at sign-in would silently become one. A user who
 *                              opens the app daily must not be signed out on day
 *                              seven for a reason nobody chose.
 *   recovery never rotates     `ensureCsrf` reports the existing token untouched, so
 *                              a page polling it cannot invalidate the token an
 *                              in-flight save is carrying.
 */

const HANDLE = 'a-handle-thirty-two-bytes-base64url';

function request(cookies: Record<string, string> = {}): FastifyRequest {
  return { cookies } as FastifyRequest;
}

type Reply = FastifyReply & {
  setCookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
};

function reply(): Reply {
  return { setCookie: vi.fn(), clearCookie: vi.fn() } as unknown as Reply;
}

/** Every `setCookie` call as `[name, value, options]`, by cookie name. */
function written(res: Reply): Record<string, { value: string; options: Record<string, unknown> }> {
  const out: Record<string, { value: string; options: Record<string, unknown> }> = {};
  for (const call of res.setCookie.mock.calls) {
    const [name, value, options] = call as [string, string, Record<string, unknown>];
    out[name] = { value, options };
  }
  return out;
}

describe('sessionCookie.issue', () => {
  it('sets both cookies, and returns the CSRF token it minted', () => {
    const res = reply();
    const token = sessionCookie(request(), res).issue(HANDLE);

    const cookies = written(res);
    expect(Object.keys(cookies).sort()).toEqual([CSRF.COOKIE_NAME, SESSION.COOKIE_NAME].sort());
    expect(cookies[SESSION.COOKIE_NAME]?.value).toBe(HANDLE);
    // The returned token IS the cookie's value. A response body naming a different
    // one would fail every double-submit check the client then attempted.
    expect(cookies[CSRF.COOKIE_NAME]?.value).toBe(token);
  });

  it('binds the CSRF token to this handle and no other', () => {
    const res = reply();
    const token = sessionCookie(request(), res).issue(HANDLE);

    expect(csrfTokenMatches(token, HANDLE)).toBe(true);
    // The check that makes this more than a double-submit pair: a sibling subdomain
    // can WRITE both cookies, so the token has to be unforgeable and bound.
    expect(csrfTokenMatches(token, 'another-handle')).toBe(false);
  });

  it('keeps the handle unreadable and the CSRF token readable', () => {
    const res = reply();
    sessionCookie(request(), res).issue(HANDLE);
    const cookies = written(res);

    // The whole point of the migration.
    expect(cookies[SESSION.COOKIE_NAME]?.options.httpOnly).toBe(true);
    // Spelled out as false rather than omitted: the page has to read this one to
    // echo it, so the difference is a decision rather than an oversight.
    expect(cookies[CSRF.COOKIE_NAME]?.options.httpOnly).toBe(false);
  });

  it('root-scopes both cookies, so every route receives them', () => {
    const res = reply();
    sessionCookie(request(), res).issue(HANDLE);
    const cookies = written(res);

    // `/auth/session` was correct while exactly one route read a credential. Every
    // route authenticates from this cookie now.
    expect(cookies[SESSION.COOKIE_NAME]?.options.path).toBe('/');
    expect(cookies[CSRF.COOKIE_NAME]?.options.path).toBe('/');
  });

  it('gives the pair one lifetime, and it is the longest a session can have', () => {
    const res = reply();
    sessionCookie(request(), res).issue(HANDLE);
    const cookies = written(res);

    // A CSRF cookie outliving the session cookie protects nothing; one expiring
    // first fails the double-submit check on a request that should have succeeded.
    expect(cookies[SESSION.COOKIE_NAME]?.options.maxAge).toBe(SESSION.REMEMBER_ME_SECONDS);
    expect(cookies[CSRF.COOKIE_NAME]?.options.maxAge).toBe(SESSION.REMEMBER_ME_SECONDS);
  });

  it('never sets a domain, on either cookie', () => {
    const res = reply();
    sessionCookie(request(), res).issue(HANDLE);
    const cookies = written(res);

    // Host-only, deliberately. A `Domain=.orebit.io` cookie would be readable and
    // writable by every subdomain — which is precisely the attacker the signed CSRF
    // token exists to defeat, so handing them the session cookie too would be odd.
    // It is also why `clear` passes only `path`.
    expect(cookies[SESSION.COOKIE_NAME]?.options).not.toHaveProperty('domain');
    expect(cookies[CSRF.COOKIE_NAME]?.options).not.toHaveProperty('domain');
  });

  it('mints a different CSRF token for a different handle', () => {
    const first = reply();
    const second = reply();
    const a = sessionCookie(request(), first).issue(HANDLE);
    const b = sessionCookie(request(), second).issue('a-different-handle');

    expect(a).not.toBe(b);
  });
});

describe('sessionCookie.slide — the reason this service needs one', () => {
  it('re-sets both cookies with their EXISTING values', () => {
    const res = reply();
    const req = request({
      [SESSION.COOKIE_NAME]: HANDLE,
      [CSRF.COOKIE_NAME]: 'the-token-the-client-already-has',
    });

    sessionCookie(req, res).slide();
    const cookies = written(res);

    expect(cookies[SESSION.COOKIE_NAME]?.value).toBe(HANDLE);
    // NOT a fresh token. A new one would invalidate whatever an in-flight save is
    // carrying, so a background request racing a save would make the save fail — a
    // self-inflicted version of the bug `ensureCsrf` exists to fix.
    expect(cookies[CSRF.COOKIE_NAME]?.value).toBe('the-token-the-client-already-has');
  });

  it('refreshes the lifetime, which is the only thing it changes', () => {
    const res = reply();
    sessionCookie(
      request({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: 'tok' }),
      res,
    ).slide();
    const cookies = written(res);

    // Without this, a cookie set once at sign-in becomes an absolute ceiling this
    // service does not have: `Session.expiresAt` slides on activity with nothing
    // above it, so a user who opens the app daily would be signed out on day seven.
    expect(cookies[SESSION.COOKIE_NAME]?.options.maxAge).toBe(SESSION.REMEMBER_ME_SECONDS);
    expect(cookies[CSRF.COOKIE_NAME]?.options.maxAge).toBe(SESSION.REMEMBER_ME_SECONDS);
  });

  it('does nothing for a caller who did not authenticate by cookie', () => {
    const res = reply();
    sessionCookie(request(), res).slide();

    // A bearer caller has no cookie to extend. Emitting `Set-Cookie` here would be a
    // guard handing browser state to a client that never asked for any.
    expect(res.setCookie).not.toHaveBeenCalled();
  });

  it('does not invent a CSRF cookie when there is none', () => {
    const res = reply();
    sessionCookie(request({ [SESSION.COOKIE_NAME]: HANDLE }), res).slide();
    const cookies = written(res);

    // Minting a replacement is `ensureCsrf`'s job, and it is a decision this method
    // must not make silently: it would invalidate a token an in-flight request may
    // still be carrying.
    expect(cookies[SESSION.COOKIE_NAME]).toBeDefined();
    expect(cookies[CSRF.COOKIE_NAME]).toBeUndefined();
  });
});

describe('sessionCookie.ensureCsrf — recovery for a client on another origin', () => {
  it('returns a usable token unchanged, and emits NO Set-Cookie', () => {
    const minting = reply();
    const token = sessionCookie(request(), minting).issue(HANDLE);

    const res = reply();
    const recovered = sessionCookie(
      request({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: token }),
      res,
    ).ensureCsrf();

    expect(recovered).toBe(token);
    // The whole of the common path, and what makes this safe on a route a client may
    // poll: rotating per call would break a concurrent save.
    expect(res.setCookie).not.toHaveBeenCalled();
  });

  it('mints one when the client has the session cookie but no CSRF cookie', () => {
    // The failure this closes. The app is served from `WEB_APP_URL`, a different
    // origin, so it cannot read `orebit_csrf` — a reload leaves the page
    // authenticated with no way to populate the header, and every mutation 403s
    // until the user signs in again.
    const res = reply();
    const token = sessionCookie(request({ [SESSION.COOKIE_NAME]: HANDLE }), res).ensureCsrf();

    expect(token).not.toBeNull();
    expect(csrfTokenMatches(token as string, HANDLE)).toBe(true);
    expect(written(res)[CSRF.COOKIE_NAME]?.value).toBe(token);
  });

  it('does not launder a token bound to a different handle', () => {
    const other = reply();
    const foreign = sessionCookie(request(), other).issue('someone-elses-handle');

    const res = reply();
    const token = sessionCookie(
      request({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: foreign }),
      res,
    ).ensureCsrf();

    // A value planted by a sibling subdomain fails the hash, so this mints a real
    // token OVER the top of it rather than blessing it. Reporting the foreign value
    // back would be reporting a token the client cannot use.
    expect(token).not.toBe(foreign);
    expect(csrfTokenMatches(token as string, HANDLE)).toBe(true);
  });

  it('replaces a value that is not ours at all', () => {
    const res = reply();
    const token = sessionCookie(
      request({ [SESSION.COOKIE_NAME]: HANDLE, [CSRF.COOKIE_NAME]: 'not.a.token' }),
      res,
    ).ensureCsrf();

    expect(csrfTokenMatches(token as string, HANDLE)).toBe(true);
  });

  it('returns null for a bearer caller rather than a token nothing checks', () => {
    const res = reply();

    // `assertCsrf` never asks a bearer caller for a token, so reporting one would
    // invite a non-browser client to start sending a header that is not verified.
    expect(sessionCookie(request(), res).ensureCsrf()).toBeNull();
    expect(res.setCookie).not.toHaveBeenCalled();
  });
});

describe('sessionCookie.clear', () => {
  it('clears both, and describes them the way they were set', () => {
    const res = reply();
    sessionCookie(request(), res).clear();

    const calls = res.clearCookie.mock.calls as Array<[string, Record<string, unknown>]>;
    const byName = Object.fromEntries(calls.map(([name, options]) => [name, options]));

    expect(Object.keys(byName).sort()).toEqual([CSRF.COOKIE_NAME, SESSION.COOKIE_NAME].sort());
    // `path` only, and that is correct rather than incomplete: no `domain` is ever
    // set on the way in, so naming one here would fail to match — leaving the live
    // cookies in place and adding a second, differently-scoped pair.
    expect(byName[SESSION.COOKIE_NAME]).toEqual({ path: '/' });
    expect(byName[CSRF.COOKIE_NAME]).toEqual({ path: '/' });
  });
});

describe('cookieValue', () => {
  it('reads a present value', () => {
    expect(cookieValue(request({ [SESSION.COOKIE_NAME]: HANDLE }), SESSION.COOKIE_NAME)).toBe(
      HANDLE,
    );
  });

  it('treats an empty string as absent', () => {
    // A cleared cookie can arrive as one, and a present-but-empty handle would be
    // sent to Redis as a lookup — and, worse, `assertCsrf` would be skipped for it
    // while the guard still had something truthy to branch on.
    expect(cookieValue(request({ [SESSION.COOKIE_NAME]: '' }), SESSION.COOKIE_NAME)).toBeNull();
  });

  it('survives a request with no cookies at all', () => {
    expect(cookieValue({} as FastifyRequest, SESSION.COOKIE_NAME)).toBeNull();
  });
});
