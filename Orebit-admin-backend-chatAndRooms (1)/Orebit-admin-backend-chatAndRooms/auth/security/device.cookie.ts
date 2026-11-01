import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../src/config';
import { DEVICE } from '../auth.constants';
import { generateDeviceId, isDeviceId } from '../auth.utility';

/**
 * The cookie that names one browser to the login rate limiter.
 *
 * Lifted from `../Orebit-backend/auth/security/device.cookie.ts` — same signature,
 * same mint-on-first-use, same shape validation. See `DEVICE` in auth.constants.ts
 * for what was kept, the three attributes that differ, and why the consumer's
 * session-grouping id and this rate-limit bucket can be the same kind of value.
 *
 * ─── The one thing that makes this different from the other three cookies ──
 *
 * `orebit_admin_refresh` and `orebit_admin_csrf` both carry something the server
 * issued and will later VERIFY. This one carries nothing of the sort: no
 * server-side row, no signature, nothing to check it against. A client may present
 * an id we never minted, may clear it between requests, and may hold one forever —
 * all three are fine, because the value authorises nothing. It exists so one
 * rate-limit bucket can be attributed to one client.
 *
 * That is why this returns a plain string rather than the port interface its
 * neighbour exposes, and why there is no failure branch: `SessionCookie` is an
 * interface because a controller has to be able to `require()` a credential and get
 * an error when it is absent. Absence here is not a failure to report, it is a
 * browser we have not seen before — so it mints, and the caller always gets an id.
 *
 * Read `DEVICE` for what the bucket does and, more importantly, what it does not do:
 * an attacker clearing this cookie gets a fresh budget, and the shared per-email and
 * per-IP buckets are what bound them. This bounds how much of those shared budgets
 * any single client can spend.
 *
 * ─── Cookie attributes ─────────────────────────────────────────────────────
 *
 *  - `httpOnly` — nothing on the page needs to read it, and keeping it away from
 *    script means an XSS cannot quietly rotate it to hand itself a clean bucket.
 *    Weak on its own (the same XSS can just clear cookies), free to have.
 *  - `sameSite: 'strict'` — sign-in is posted by the panel to its own origin, so
 *    there is no cross-site navigation to accommodate.
 *  - `maxAge` — long, unlike every other cookie here. The others are credentials and
 *    die quickly by design; a bucket that forgets which browser it belongs to is
 *    just a bucket that resets.
 *  - `secure` in production, `path` scoped to the login route. As elsewhere.
 */
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: config.isProduction,
  path: DEVICE.COOKIE_PATH,
  maxAge: DEVICE.MAX_AGE_SECONDS,
} as const;

/**
 * The calling browser's id: the one it presented, or a freshly minted one set on the
 * response.
 *
 * Resolved once per request, at the route, and passed down as a value — so nothing
 * below the route can mint a second id and charge a second bucket for one attempt.
 */
export function deviceCookie(req: FastifyRequest, reply: FastifyReply): string {
  const presented = cookieValue(req, DEVICE.COOKIE_NAME);
  if (presented !== null && isDeviceId(presented)) return presented;

  // Nothing presented, or something malformed. Either way this is a client we cannot
  // attribute to an existing bucket, so it gets a new one. Re-setting on a malformed
  // value rather than passing it through keeps the key namespace to ids we minted,
  // and costs a client that sends junk nothing but a cookie.
  const minted = generateDeviceId();
  void reply.setCookie(DEVICE.COOKIE_NAME, minted, COOKIE_OPTIONS);
  return minted;
}

/** Fastify's `cookies` is populated by `@fastify/cookie`; typed defensively so a
 *  unit test can hand in a bare request object. Same shape as the helper in
 *  session.cookie.ts. */
function cookieValue(req: FastifyRequest, name: string): string | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const value = cookies?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
