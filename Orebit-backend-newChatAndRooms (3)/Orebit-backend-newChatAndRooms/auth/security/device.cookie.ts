// Imported for its side effect: @fastify/cookie declaration-merges `cookies` onto
// FastifyRequest and `setCookie` onto FastifyReply.
import '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../src/config';
import { safeEqual } from '../../src/utils/public.utils';
import { DEVICE } from '../auth.constants';
import { pepperedHash } from '../auth.utility';

/** The id half we issue: 32 random bytes, base64url. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  path: DEVICE.COOKIE_PATH,
  maxAge: DEVICE.MAX_AGE_SECONDS,
} as const;

/**
 * ═══ THE SIGNED DEVICE COOKIE ═══════════════════════════════════════════════
 *
 * A stable, opaque browser-profile identifier. It has two jobs, and the second one
 * is why this file changed.
 *
 * The original job: grouping independently minted sessions from one browser's tabs
 * so a normal logout can revoke them together. For that, the cookie only had to be
 * *stable* — a client that threw it away and invented a new one hurt nobody but
 * itself, so validating the shape was enough.
 *
 * The new job: carrying a rate-limit bucket. The policy meters registration starts,
 * login-code requests and OAuth ceremonies per device precisely because a per-IP
 * limit cannot separate the many legitimate users behind one office, campus or
 * carrier NAT from each other. That only works if a caller cannot choose its own
 * bucket — and under the old shape-only check it could: any 43-character base64url
 * string was accepted, so `Math.random()` in a loop was an unlimited supply of fresh
 * device quotas and every per-device limit in the policy was decorative.
 *
 * ─── What signing does and does not buy ─────────────────────────────────────
 *
 * It makes the id unforgeable, so the only device ids in circulation are ones this
 * server issued. It does NOT make the cookie a credential: it still proves nothing
 * about who is calling, and nothing here may ever be used to authenticate. A caller
 * can still *discard* the cookie and be issued a fresh one, so a device quota alone
 * is not a boundary — it is one term in a combination, which is exactly how the
 * policy frames it.
 *
 * What it stops is the cheap version of that attack. Discarding the cookie costs a
 * round trip and yields one new bucket at a time; forging them costs nothing and
 * yields as many as the attacker cares to generate.
 *
 * ─── Format ─────────────────────────────────────────────────────────────────
 *
 * `<id>.<signature>`, the same shape as the CSRF token in `auth.utility.ts` and for
 * the same reason — the readable half is what the server needs, and the trailing
 * half is what proves the server wrote it.
 */

function signature(deviceId: string): string {
  return pepperedHash(deviceId, 'device-sig');
}

/**
 * The id inside a cookie value, or null if it was not issued by us.
 *
 * Shape first, then signature: the regex is a cheap rejection for garbage, and there
 * is no point spending a hash on a value that cannot be one of ours. The signature
 * comparison is constant-time for the usual reason — the caller controls the value
 * and can vary it one byte at a time.
 */
function verified(value: string | undefined): string | null {
  if (value === undefined) return null;

  const separator = value.indexOf('.');
  // No separator at all is the pre-signing format. Those cookies are not upgraded in
  // place, because there is nothing to upgrade: an unsigned value is exactly what an
  // attacker would send, so trusting one to re-sign it would keep the hole open
  // under a new name. They are rejected and reissued, which costs every returning
  // browser one new device id, once.
  if (separator <= 0) return null;

  const deviceId = value.slice(0, separator);
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;

  return safeEqual(value.slice(separator + 1), signature(deviceId)) ? deviceId : null;
}

/**
 * Return the device id for this browser, issuing one if there is not a valid one.
 *
 * Always returns an id — a request with no usable cookie gets a fresh device rather
 * than an error, because there is no version of this that should fail a login.
 */
export function deviceCookie(req: FastifyRequest, reply: FastifyReply): string {
  const existing = verified(req.cookies?.[DEVICE.COOKIE_NAME]);
  if (existing !== null) return existing;

  const deviceId = randomBytes(DEVICE.ID_BYTES).toString('base64url');
  void reply.setCookie(DEVICE.COOKIE_NAME, `${deviceId}.${signature(deviceId)}`, COOKIE_OPTIONS);
  return deviceId;
}

/**
 * The device KEY for this browser if it already has a valid cookie, and null
 * otherwise. Never issues one.
 *
 * ═══ WHY A READ-ONLY READER HAD TO EXIST ═══════════════════════════════════
 *
 * `deviceCookie` above is the only way anything used to get a device id, and it
 * ISSUES one as a side effect. That is right for the routes that call it: a sign-in or
 * a registration is exactly the moment to give a browser its identifier, and returning
 * an id unconditionally is what keeps a missing cookie from failing a login.
 *
 * It is wrong for `AuthGuard`. Refresh moved server-side, so the guard now rotates
 * sessions — and `SessionService.rotate` needs a device key, because `honourTrust`
 * compares it against the session row to decide whether a trusted device's remember-me
 * window survives the rotation. Without a key at all, every trusted session would
 * quietly lose its seven-day window on its first background refresh.
 *
 * But a guard must not emit a `Set-Cookie` while authenticating. It runs on every
 * route including reads, it runs before any handler has decided what the response is,
 * and a guard that mints browser identity as a side effect of checking a token is a
 * guard nobody would expect to do that. So this reads and does not write.
 *
 * ─── Null is a real answer, not a failure ────────────────────────────────
 *
 * A browser that has cleared its cookies, or a non-browser client, genuinely has no
 * device. Callers must handle it rather than substitute anything: an empty string
 * would compare unequal to every stored fingerprint — silently withdrawing trust —
 * and would then be written onto the child generation. See `RefreshContext`, and the
 * two places that answer it: `SessionService.honourTrust` and
 * `SessionDbOperation.rotate`.
 *
 * Returns the KEY rather than the raw id, because that is all a refresh needs. The raw
 * id is only required to CREATE a trust record, which no guarded request does — and
 * not handing it out is one fewer place the secret travels.
 */
export function readDeviceKey(req: FastifyRequest): string | null {
  const deviceId = verified(req.cookies?.[DEVICE.COOKIE_NAME]);
  return deviceId === null ? null : pepperedHash(deviceId, 'device');
}
