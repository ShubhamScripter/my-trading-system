import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../src/config';
import { CSRF, SESSION } from '../auth.constants';
import { csrfTokenMatches, generateCsrfToken } from '../auth.utility';

/**
 * The cookie that carries the session handle, and the CSRF token that has to
 * accompany it.
 *
 * ─── What the cookie holds, and why it changed ─────────────────────────────
 *
 * It used to hold the refresh JWT itself. It now holds an opaque handle naming a
 * server-side record that holds BOTH tokens — see security/bff.session.ts.
 *
 * The reason is the half the old arrangement could not fix. httpOnly already kept
 * script away from the refresh token, but the ACCESS token was returned in the
 * response body and therefore lived in JavaScript by necessity: it had to go into an
 * `Authorization` header, so the page had to be able to read it. An XSS on the panel
 * stole a working credential. A handle needs no header, so nothing has to be
 * readable, and what an XSS can now lift is a value that authorises nothing off our
 * origin.
 *
 * ─── The two cookies are a pair, and the pair is cryptographically joined ──
 *
 * `issue` sets both and `clear` clears both, deliberately in one place: a session
 * cookie without its CSRF companion is a cookie-authenticated state change with no
 * CSRF defence, which is worse than what it replaced. Keeping them in one function
 * makes forgetting one of them impossible rather than merely unlikely.
 *
 * They are also joined in the value itself. The CSRF token is
 * `nonce.HMAC(pepper, nonce:handle)`, not a bare random string, so it is verifiable
 * as ours and verifiable as belonging to THIS session. Unsigned double-submit —
 * which is what this was — is defeated by a sibling subdomain that can write a cookie
 * on the parent domain, because writing does not require reading. See
 * `generateCsrfToken` in auth/auth.utility.ts, and `assertCsrf` in security/guards.ts
 * for where the check now runs.
 *
 * ─── Both cookies are root-scoped now ─────────────────────────────────────
 *
 * `/auth/session` was correct while exactly one route read a cookie. Every route
 * authenticates from this one, so it has to be sent on every route. That widening is
 * what moved the CSRF check out of this file: it is no longer one endpoint's concern.
 */

/** The narrow port a controller sees. A small interface rather than passing
 *  `FastifyReply` down, so the controller stays testable without a live HTTP
 *  layer. */
export interface SessionCookie {
  /**
   * Set the session cookie and a fresh CSRF token. Returns the CSRF token so the
   * response can name it for clients that cannot read cookies.
   *
   * `expiresAt` is the session's absolute ceiling — `IssuedSession.reauthenticateAt`,
   * not the idle deadline. Passed rather than derived from a constant so the cookie
   * cannot outlive the session it names; see the note on `maxAge` below for why the
   * ceiling is the right one of the two clocks.
   */
  issue(handle: string, expiresAt: Date): string;
  /** The handle the client presented, or null. */
  read(): string | null;
  /**
   * ═══ CSRF RECOVERY FOR A PANEL ON ANOTHER HOST ═══════════════════════════
   *
   * The token this client must echo, WITHOUT rotating a good one. Null when the
   * caller did not authenticate by cookie.
   *
   * ─── The gap this closes (F14) ────────────────────────────────────────────
   *
   * `issue` returns the token so sign-in can put it in the response body, and that
   * was the only way to ever learn it. It is enough for a panel served from the API's
   * own origin, which can read `orebit_admin_csrf` with script and does not need to
   * be told — but that is not the only supported topology. `config.ADMIN_APP_URL` is
   * a separate origin and `corsOptions` sets `credentials: true` for it, so the
   * panel may legitimately live on another host.
   *
   * There, the cookie is unreadable: it is host-only for the API and reading another
   * origin's cookie is exactly what the same-origin policy forbids. So a RELOAD or a
   * new tab left the page authenticated — the browser still attaches both cookies —
   * and with no way to populate `x-csrf-token`. Every mutation and the logout
   * returned 403 until the admin signed in again, which is the one flow that hands
   * the token over.
   *
   * The cookie still ARRIVES on the request; only the client cannot read it. So the
   * server reads it and reports it, and the browser's copy is left exactly as it is.
   *
   * ─── Read, don't rotate ───────────────────────────────────────────────────
   *
   * A valid token is returned unchanged and NO `Set-Cookie` is emitted. That is the
   * whole of the common path and it is what makes this safe on a route a panel may
   * call repeatedly: minting a fresh token per call would invalidate the one an
   * in-flight request is already carrying, so a background poll racing a save would
   * make the save fail — a self-inflicted version of the bug being fixed.
   *
   * A token is minted only when there is not already a usable one — absent, or not
   * ours, or bound to a different handle. That case is a client whose double-submit
   * pair is ALREADY broken and whose mutations are already failing, so replacing it
   * strictly improves matters rather than invalidating anything that worked.
   */
  ensureCsrf(): string | null;
  /** Retire both cookies. Called on logout and logout-all. */
  clear(): void;
}

export function sessionCookie(req: FastifyRequest, reply: FastifyReply): SessionCookie {
  return {
    issue(handle: string, expiresAt: Date): string {
      // Signed and bound to this handle, not a bare random value — see
      // `generateCsrfToken`.
      const csrfToken = generateCsrfToken(handle);
      // Seconds until the session's ceiling, floored at one so a cookie is always
      // actually set — `maxAge: 0` is a delete instruction, which would leave the
      // client with no credential rather than a short-lived one.
      const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

      void reply.setCookie(SESSION.COOKIE_NAME, handle, {
        // Script on the page cannot read it. The whole point.
        httpOnly: true,
        // Withheld from cross-site POSTs, which is the shape a CSRF attempt takes,
        // but still sent on top-level navigation — `strict` would make an admin
        // arriving from a link find their session apparently gone. Defence in depth
        // behind the CSRF token, not a replacement for it.
        sameSite: 'lax',
        // Never crosses plaintext HTTP. Off in development because localhost has no
        // TLS, and `config.isProduction` is the only switch that decides it.
        secure: config.isProduction,
        // Every route authenticates from this cookie now.
        path: SESSION.COOKIE_PATH,
        // ═══ THE CEILING, NOT THE IDLE DEADLINE ═════════════════════════════
        //
        // The handle survives every rotation — only the tokens inside the record
        // change — so scoping the cookie to a refresh generation's lifetime would
        // delete a credential that is still perfectly good. The ceiling is the one
        // clock the handle actually shares: nothing extends it, and reaching it means
        // the full three-factor ceremony again.
        //
        // The idle deadline is enforced server-side by `isUnusable`, which is where
        // it belongs. A browser cannot be trusted to expire a credential on time, and
        // a cookie that outlives an idle-expired session just presents a dead handle
        // and collects a 401 with a reason on it — which is the spec's behaviour.
        maxAge,
      });

      // The same lifetime as its partner, deliberately. A CSRF cookie outliving the
      // session cookie protects nothing; one expiring first would fail the
      // double-submit check on a request that should have succeeded.
      void reply.setCookie(CSRF.COOKIE_NAME, csrfToken, csrfCookieOptions(maxAge));

      return csrfToken;
    },

    read(): string | null {
      return cookieValue(req, SESSION.COOKIE_NAME);
    },

    ensureCsrf(): string | null {
      const handle = cookieValue(req, SESSION.COOKIE_NAME);
      // A bearer caller has no ambient credential, so there is no cross-site request
      // to forge and `assertCsrf` never asks them for a token — see the method note
      // in `authenticate`. Reporting one would invite a non-browser client to start
      // sending a header nothing checks.
      if (handle === null) return null;

      const existing = cookieValue(req, CSRF.COOKIE_NAME);
      // `csrfTokenMatches` and not merely "is present": the same check `assertCsrf`
      // will apply. Echoing back a value that would fail verification would report a
      // token the client cannot actually use, which is worse than reporting none —
      // it looks like recovery and mutations keep failing.
      //
      // It also means a cookie planted by a sibling subdomain is not laundered into
      // a valid one here. Such a value fails the HMAC, so this mints a real token
      // over the top of it rather than blessing it.
      if (existing !== null && csrfTokenMatches(existing, handle)) return existing;

      const csrfToken = generateCsrfToken(handle);
      // ─── The repair's lifetime, and why it is the CEILING ──────────────────
      //
      // `issue` knows the session's exact `reauthenticateAt` because it is minting
      // the session. Here there is only a live request, and the remaining life of
      // the handle is not on it — so this uses the absolute ceiling, which is the
      // longest any session can have.
      //
      // Erring LONG is the safe direction, and the asymmetry is the reason to be
      // explicit about it. A CSRF cookie that outlives its session cookie protects
      // nothing and authorises nothing — it is an inert value whose partner is gone.
      // One that expires FIRST fails the double-submit check on requests that should
      // have succeeded, which is the very failure this method exists to end.
      void reply.setCookie(CSRF.COOKIE_NAME, csrfToken, csrfCookieOptions(SESSION.ABSOLUTE_TTL_SECONDS));
      return csrfToken;
    },

    clear(): void {
      void reply.clearCookie(SESSION.COOKIE_NAME, { path: SESSION.COOKIE_PATH });
      void reply.clearCookie(CSRF.COOKIE_NAME, { path: CSRF.COOKIE_PATH });
    },
  };
}

/**
 * The CSRF cookie's attributes, in ONE place.
 *
 * Two call sites write this cookie now — the sign-in that mints a session, and the
 * repair in `ensureCsrf` — and they must agree on every flag. A second literal is
 * how `secure` or `sameSite` ends up set on one path and not the other, which is a
 * difference nothing would fail on until it mattered. Only `maxAge` varies, so only
 * `maxAge` is a parameter.
 *
 * NOT httpOnly, and that is the mechanism rather than an oversight: a same-origin
 * page reads this one to echo it back in a header. It authorises nothing on its own
 * — it proves only that the request came from a page on our origin, which is
 * precisely what an attacker's page cannot arrange. A cross-origin panel cannot read
 * it at all, which is what `ensureCsrf` exists to answer.
 */
function csrfCookieOptions(maxAge: number): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: false,
    sameSite: 'lax',
    // Never crosses plaintext HTTP. Off in development because localhost has no TLS.
    secure: config.isProduction,
    path: CSRF.COOKIE_PATH,
    maxAge,
  };
}

export function cookieValue(req: FastifyRequest, name: string): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const value = cookies?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
