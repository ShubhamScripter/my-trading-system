// Imported for its side effect: @fastify/cookie declaration-merges `cookies` onto
// FastifyRequest and `setCookie`/`clearCookie` onto FastifyReply. Without this
// import the plugin works at runtime but the types are absent.
import '@fastify/cookie';
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
 * The reason is the half the old arrangement could not fix. `httpOnly` already kept
 * script away from the refresh token, but the ACCESS token was returned in the
 * response body and therefore lived in JavaScript by necessity: it had to go into an
 * `Authorization` header, so the page had to be able to read it. An XSS stole a
 * working credential. A handle needs no header, so nothing has to be readable, and
 * what an XSS can now lift is a value that authorises nothing off our origin.
 *
 * ─── The two cookies are a pair, and the pair is cryptographically joined ──
 *
 * `issue` sets both, `slide` extends both and `clear` clears both, deliberately in
 * one place: a session cookie without its CSRF companion is a cookie-authenticated
 * state change with no CSRF defence, which is worse than what it replaced. Keeping
 * them in one file makes forgetting one of them impossible rather than merely
 * unlikely.
 *
 * They are also joined in the value itself. The CSRF token is
 * `nonce.pepperedHash(nonce:handle)`, not a bare random string, so it is verifiable
 * as ours and verifiable as belonging to THIS session. Unsigned double-submit — which
 * is what this was — is defeated by a sibling subdomain that can write a cookie on the
 * parent domain, because writing does not require reading. See `generateCsrfToken` in
 * auth/auth.utility.ts, and `assertCsrf` in security/guards.ts for where the check now
 * runs.
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
   * Takes no deadline. See `MAX_AGE_SECONDS` below for why the lifetime is a constant
   * here and slid by `slide` rather than derived from the session being minted.
   */
  issue(handle: string): string;
  /** The handle the client presented, or null. */
  read(): string | null;
  /**
   * ═══ KEEPING A LIVE SESSION'S COOKIES ALIVE ══════════════════════════════
   *
   * Re-set both cookies with their EXISTING values and a fresh `maxAge`. A no-op when
   * the caller did not authenticate by cookie.
   *
   * ─── Why this method exists here and not in the admin service ────────────
   *
   * Because that service has an absolute ceiling and this one does not. There, the
   * cookie is scoped to a fixed twelve hours that nothing extends, so setting it once
   * at sign-in is exactly right. Here `Session.expiresAt` slides: `touch` pushes it
   * forward on every burst of activity, with no ceiling above it, so a session that is
   * used every day never ends.
   *
   * Set once and never again, the cookie would therefore become the ceiling — and a
   * user who opens the app daily would be signed out on day seven for no reason
   * anybody chose. That is a change to session policy, which is precisely what this
   * migration is not allowed to make. Before it, the cookie slid for free: the client
   * asked for a refresh and got a new `Set-Cookie` with it. Refresh moved
   * server-side, so the slide has to move with it.
   *
   * ─── Why it must NOT mint a new CSRF token ───────────────────────────────
   *
   * The values are re-sent unchanged, and that is the whole care of this method. A
   * fresh token would invalidate the one an in-flight request is already carrying, so
   * a background poll racing a save would make the save fail — a self-inflicted
   * version of the bug `ensureCsrf` exists to fix. Sliding a cookie is a statement
   * about its lifetime, not about its contents.
   */
  slide(): void;
  /**
   * ═══ CSRF RECOVERY FOR A CLIENT ON ANOTHER ORIGIN ════════════════════════
   *
   * The token this client must echo, WITHOUT rotating a good one. Null when the caller
   * did not authenticate by cookie.
   *
   * ─── The gap this closes ──────────────────────────────────────────────────
   *
   * `issue` returns the token so sign-in can put it in the response body, and that
   * was the only way to ever learn it. It is enough for a page served from the API's
   * own origin, which can read `orebit_csrf` with script and does not need to be told
   * — but that is not this deployment. `config.WEB_APP_URL` is a separate origin and
   * `corsOptions` sets `credentials: true` for it, so the app legitimately lives on
   * another host.
   *
   * There, the cookie is unreadable: it is host-only for the API, and reading another
   * origin's cookie is exactly what the same-origin policy forbids. So a RELOAD or a
   * new tab leaves the page authenticated — the browser still attaches both cookies —
   * and with no way to populate `x-orebit-csrf`. Every mutation and the logout would
   * return 403 until the user signed in again, which is the one flow that hands the
   * token over.
   *
   * The cookie still ARRIVES on the request; only the client cannot read it. So the
   * server reads it and reports it, and the browser's copy is left exactly as it is.
   *
   * ─── Read, don't rotate ───────────────────────────────────────────────────
   *
   * A valid token is returned unchanged and NO `Set-Cookie` is emitted. That is the
   * whole of the common path and it is what makes this safe on a route a client may
   * call repeatedly: minting a fresh token per call would invalidate the one an
   * in-flight request is already carrying, so a background poll racing a save would
   * make the save fail.
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

/**
 * ═══ THE COOKIE'S LIFETIME IS A CONSTANT, AND `slide` IS WHY THAT WORKS ════
 *
 * `REMEMBER_ME_SECONDS` — seven days — is the longest window any session can be
 * granted in one go, and it is deliberately NOT the session's own `expiresAt`.
 *
 * Scoping the cookie to `expiresAt` looks more precise and is worse in both
 * directions. Too short: an untrusted session's deadline is twenty-four hours out at
 * sign-in, so a browser that came back on day two would present nothing, and a user
 * who had been active throughout would still be signed out — because the handle
 * survives every rotation and only the tokens inside the record change, so there is
 * no per-generation lifetime for it to track. Too long is the other half: a cookie
 * scoped to a trusted device's `rememberUntil` after that trust was revoked would
 * outlive its own authority.
 *
 * A constant plus a slide gets the useful property of both: the cookie is present for
 * as long as the browser keeps being used, and its ABSENCE is meaningless as
 * authorisation — the server decides, every request, against `assertLive` and the
 * record's own TTL.
 *
 * ─── A cookie outliving its session is the correct direction ──────────────
 *
 * The idle deadline is enforced server-side, which is where it belongs. A browser
 * cannot be trusted to expire a credential on time, and a cookie that outlives an
 * idle-expired session just presents a dead handle and collects a 401 with a reason
 * on it — which is better than presenting nothing, because "no cookie at all" and
 * "your session ran out" are different answers and only the second is true. See
 * `explainSessionEnd`.
 */
const MAX_AGE_SECONDS = SESSION.REMEMBER_ME_SECONDS;

const sessionCookieOptions = {
  // Script on the page cannot read it. The whole point.
  httpOnly: true,
  // Withheld from cross-site POSTs, which is the shape a CSRF attempt takes, but
  // still sent on top-level navigation — `strict` would make a user arriving from a
  // link find their session apparently gone. Defence in depth behind the CSRF token,
  // not a replacement for it.
  sameSite: 'lax',
  // Never crosses plaintext HTTP. Off in development because localhost has no TLS,
  // and `config.isProduction` is the only switch that decides it.
  secure: config.isProduction,
  // Every route authenticates from this cookie now.
  path: SESSION.COOKIE_PATH,
  maxAge: MAX_AGE_SECONDS,
} as const;

/**
 * The CSRF cookie's attributes, in ONE place.
 *
 * Three call sites write this cookie — the sign-in that mints a session, the slide,
 * and the repair in `ensureCsrf` — and they must agree on every flag. A second literal
 * is how `secure` or `sameSite` ends up set on one path and not the other, which is a
 * difference nothing would fail on until it mattered.
 *
 * NOT httpOnly, and that is the mechanism rather than an oversight: a same-origin page
 * reads this one to echo it back in a header. It authorises nothing on its own — it
 * proves only that the request came from a page that could read our cookie, which is
 * precisely what an attacker's page cannot arrange. A cross-origin client cannot read
 * it at all, which is what `ensureCsrf` exists to answer.
 *
 * The same lifetime as its partner, deliberately. A CSRF cookie outliving the session
 * cookie protects nothing; one expiring first would fail the double-submit check on a
 * request that should have succeeded.
 */
const csrfCookieOptions = {
  httpOnly: false,
  sameSite: 'lax',
  secure: config.isProduction,
  path: CSRF.COOKIE_PATH,
  maxAge: MAX_AGE_SECONDS,
} as const;

/** Bind the port to one request/response pair. */
export function sessionCookie(req: FastifyRequest, reply: FastifyReply): SessionCookie {
  return {
    issue(handle: string): string {
      // Signed and bound to this handle, not a bare random value — see
      // `generateCsrfToken`.
      const csrfToken = generateCsrfToken(handle);

      void reply.setCookie(SESSION.COOKIE_NAME, handle, sessionCookieOptions);
      void reply.setCookie(CSRF.COOKIE_NAME, csrfToken, csrfCookieOptions);

      return csrfToken;
    },

    read(): string | null {
      return cookieValue(req, SESSION.COOKIE_NAME);
    },

    slide(): void {
      const handle = cookieValue(req, SESSION.COOKIE_NAME);
      // A bearer caller has no cookie to extend, and a page that reached here without
      // one is not authenticated by cookie either.
      if (handle === null) return;

      void reply.setCookie(SESSION.COOKIE_NAME, handle, sessionCookieOptions);

      // Only if it is actually there. Re-setting an absent CSRF cookie would mean
      // writing `undefined`; minting a replacement is `ensureCsrf`'s job and is a
      // decision this method must not make silently, because it would invalidate a
      // token an in-flight request may be carrying.
      const csrfToken = cookieValue(req, CSRF.COOKIE_NAME);
      if (csrfToken !== null) {
        void reply.setCookie(CSRF.COOKIE_NAME, csrfToken, csrfCookieOptions);
      }
    },

    ensureCsrf(): string | null {
      const handle = cookieValue(req, SESSION.COOKIE_NAME);
      // A bearer caller has no ambient credential, so there is no cross-site request
      // to forge and `assertCsrf` never asks them for a token — see the note in
      // `authenticate`. Reporting one would invite a non-browser client to start
      // sending a header nothing checks.
      if (handle === null) return null;

      const existing = cookieValue(req, CSRF.COOKIE_NAME);
      // `csrfTokenMatches` and not merely "is present": the same check `assertCsrf`
      // will apply. Echoing back a value that would fail verification would report a
      // token the client cannot actually use, which is worse than reporting none — it
      // looks like recovery and mutations keep failing.
      //
      // It also means a cookie planted by a sibling subdomain is not laundered into a
      // valid one here. Such a value fails the hash, so this mints a real token over
      // the top of it rather than blessing it.
      if (existing !== null && csrfTokenMatches(existing, handle)) return existing;

      const csrfToken = generateCsrfToken(handle);
      void reply.setCookie(CSRF.COOKIE_NAME, csrfToken, csrfCookieOptions);
      return csrfToken;
    },

    clear(): void {
      // Only `path` is passed, and that is correct rather than incomplete: `domain` is
      // never set on the way in, so the browser matched these cookies host-only and
      // `clearCookie` has to describe them the same way to delete rather than to
      // create a second, differently-scoped pair.
      void reply.clearCookie(SESSION.COOKIE_NAME, { path: SESSION.COOKIE_PATH });
      void reply.clearCookie(CSRF.COOKIE_NAME, { path: CSRF.COOKIE_PATH });
    },
  };
}

/**
 * One cookie value, or null.
 *
 * Exported because `guards.ts` reads both cookies without wanting the reply-bound
 * port — a guard that held a `FastifyReply` would be a guard that could set cookies,
 * which is a capability it should not have on the authentication path.
 *
 * An empty string is null: a cleared cookie can arrive as one, and treating it as a
 * present-but-empty handle would send it to Redis as a lookup.
 */
export function cookieValue(req: FastifyRequest, name: string): string | null {
  const value = req.cookies?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
