import { createHash, randomBytes } from 'node:crypto';
import type { Admin } from '@prisma/client';
import { config } from '../src/config';
import { randomDigits, safeEqual } from '../src/utils/public.utils';
import { CSRF, DEVICE, OTP, SESSION, STEP_UP } from './auth.constants';
import type { ClientContext, PublicAdmin } from './auth.types';

/**
 * Pure helpers scoped to `auth/`. No I/O, no injection, no database — which is
 * what makes every rule in here directly testable.
 */

// ─── normalisation ──────────────────────────────────────────────────────────

/**
 * Lowercase and trim. Nothing more.
 *
 * Notably it does NOT strip Gmail's dots or `+tags`. Those are Gmail conventions,
 * not email semantics — `a.b@fastmail.com` and `ab@fastmail.com` are different
 * mailboxes — so canonicalising them would merge unrelated accounts on every
 * other provider. One address, one account; the provider decides what routes
 * where.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The part before the `@`, or the whole string if there is none. */
export function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

// ─── hashing ────────────────────────────────────────────────────────────────

/**
 * The namespace a hash belongs to. Every peppered hash declares one, and the tag
 * is mixed into the digest, so the same plaintext hashes differently depending on
 * what it is *for*.
 *
 * This is not decoration. Without a tag, one construction serving two namespaces
 * means a value lifted from one column verifies against the other — an OTP row
 * and a step-up-secret row become interchangeable.
 */
type HashDomain =
  | 'otp'
  | 'stepup'
  /** The CSRF token's signature. Its own domain so a CSRF token can never be
   *  presented as, or derived from, an OTP or a step-up secret. */
  | 'csrf';

/**
 * sha256 of a domain tag, the value, and the pepper.
 *
 * Not argon2, for two different reasons that happen to reach the same answer:
 *
 *   `otp`     a 6-digit code has ~20 bits of entropy, so no work factor makes it
 *             resistant to an offline attack against a stolen database. What
 *             protects it is the short lifetime and the attempt cap. The hash's
 *             narrower job is to keep the plaintext out of the row, so a leaked
 *             backup or a logged query does not hand over live codes — and to
 *             stay cheap enough that verification is not its own DoS vector.
 *   `stepup`  the secret has 256 bits, so there is nothing to brute-force and a
 *             work factor would only add latency to every step of the flow.
 *
 * In both cases the pepper is what stops a stolen database from being attacked
 * with a precomputed table.
 *
 * The `:` separator keeps the tag unambiguous: without it, domain `a` + value
 * `bc` and domain `ab` + value `c` would produce the same digest. A literal
 * separator is safe here because `HashDomain` is a closed union and no member
 * contains one.
 *
 * A plain equality lookup on a `stepup` hash is safe — no constant-time compare
 * needed — because the comparison happens inside a B-tree index probe on a value
 * the attacker cannot influence incrementally. An `otp` hash is compared with
 * `safeEqual` because that comparison happens in application code against a value
 * the attacker supplies a guess for.
 */
export function pepperedHash(value: string, domain: HashDomain): string {
  return createHash('sha256').update(`${domain}:${value}${config.PASSWORD_PEPPER}`).digest('hex');
}

// ─── CSRF ───────────────────────────────────────────────────────────────────

/**
 * ═══ WHY THE TOKEN IS SIGNED AND BOUND, NOT JUST RANDOM ════════════════════
 *
 * This used to be `randomBytes(32)` compared against itself — textbook
 * double-submit. That check answers one question: did the cookie and the header
 * carry the same value? It never asks whether we issued that value, or who for.
 *
 * The gap is not the same-origin policy, which holds. It is cookie WRITES, which
 * obey a different and much weaker rule: any sibling subdomain can set a cookie on
 * the parent domain. So `blog.orebit.io`, or anything that can inject a
 * `Set-Cookie` for `.orebit.io` — a stray CNAME, a compromised marketing site, a
 * vendor widget — can plant its own value in `orebit_admin_csrf`. It cannot READ
 * the admin's cookie, but with unsigned double-submit it does not need to: it
 * writes a value it already knows into the cookie and sends the same value in the
 * header. Both halves match, the check passes, and the admin's own refresh cookie
 * is what authenticates the request.
 *
 * Signing closes it. The token is `nonce.HMAC(pepper, nonce:handle)`, so a value we
 * did not mint cannot be forged without the pepper, and a value we minted for one
 * session does not verify against another's handle. An attacker writing a cookie now
 * has to produce a signature over a handle they cannot read — which is the property
 * double-submit only appeared to have.
 *
 * ─── It is bound to the session HANDLE, and what that costs ────────────────
 *
 * It used to be bound to the refresh token, which was the credential in the cookie
 * at the time. The credential is now the opaque handle — see `SESSION` in
 * auth.constants.ts — so that is what it binds to, and the binding property is
 * unchanged: an attacker still cannot sign over a value they cannot read.
 *
 * One property IS lost, and it is worth stating rather than discovering. The refresh
 * token rotated on every refresh, so the CSRF token rotated with it for free and a
 * captured pair went stale on the session's next use. A handle is stable for the life
 * of the session, so a captured pair now stays valid until the session ends. That is
 * accepted: the token's job is proving the request came from a page on our origin,
 * not proving freshness, and a captured pair requires having read the httpOnly
 * cookie — at which point the handle itself is the larger problem.
 */
export function generateCsrfToken(sessionHandle: string): string {
  const nonce = randomBytes(CSRF.NONCE_BYTES).toString('base64url');
  return `${nonce}.${csrfSignature(nonce, sessionHandle)}`;
}

/** Was this token minted by us, for this session handle? */
export function csrfTokenMatches(token: string, sessionHandle: string): boolean {
  const separator = token.indexOf('.');
  // A missing separator, or an empty nonce, is not a shape this ever produced.
  if (separator <= 0) return false;

  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Constant-time, like every other comparison here against a value the caller
  // supplies and can vary one byte at a time.
  return safeEqual(signature, csrfSignature(nonce, sessionHandle));
}

function csrfSignature(nonce: string, sessionHandle: string): string {
  return pepperedHash(`${nonce}:${sessionHandle}`, 'csrf');
}

// ─── one-time values ────────────────────────────────────────────────────────

export function generateOtp(): string {
  return randomDigits(OTP.LENGTH);
}

/** Digits only, with whitespace stripped — an admin pasting `123 456` from an
 *  authenticator app should not be told their code is wrong. */
export function normaliseCode(code: string): string {
  return code.replace(/\s+/g, '');
}

/**
 * The value the client holds to identify its in-flight sign-in.
 *
 * 32 bytes, base64url. This is the only thing standing between a stranger and a
 * half-authenticated admin session, so it is generated from a CSPRNG and never
 * derived from anything about the account.
 */
export function generateStepUpSecret(): string {
  return randomBytes(STEP_UP.SECRET_BYTES).toString('base64url');
}

/**
 * The handle the browser holds to name its server-side session record.
 *
 * Same construction and same size as the step-up secret above, because it is the
 * same class of value: the only thing standing between a stranger and a live admin
 * session. It replaces the refresh token in the cookie and, unlike that token,
 * carries no claims and means nothing to anyone who cannot reach our Redis.
 */
export function generateSessionHandle(): string {
  return randomBytes(SESSION.HANDLE_BYTES).toString('base64url');
}

// ─── device id ──────────────────────────────────────────────────────────────

/**
 * The opaque id that names one browser to the login rate limiter.
 *
 * Random rather than derived from anything about the request, and the reason is on
 * `DEVICE` in auth.constants.ts: a derived value collides across clients on the same
 * browser build and is forgeable by copying two headers, so it would both meter an
 * office as one client and let anyone spend a colleague's budget.
 */
export function generateDeviceId(): string {
  return randomBytes(DEVICE.ID_BYTES).toString('base64url');
}

/** base64url of exactly `DEVICE.ID_BYTES`, unpadded — 4 characters per 3 bytes,
 *  rounded up. Derived rather than written out so changing the byte count cannot
 *  leave the check validating the old length. */
const DEVICE_ID_LENGTH = Math.ceil((DEVICE.ID_BYTES * 4) / 3);
const DEVICE_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${DEVICE_ID_LENGTH}}$`);

/**
 * Is this a value we minted?
 *
 * Not a security check — the id authorises nothing, and a client is free to present
 * one we have never seen. It is a shape check, and it earns its place twice: a
 * caller sending junk (or a 4KB string) would otherwise get it hashed into a Redis
 * key on every request, and a client sending a value it MADE UP gets a fresh, valid
 * bucket rather than an anomaly — so anything malformed is discarded and replaced,
 * which keeps "one bucket per browser" true for every client that keeps its cookie.
 */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value);
}

// ─── client context ─────────────────────────────────────────────────────────

/** A repeated header arrives as an array; take the first. */
export function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * The /24 (IPv4) or /48 (IPv6) prefix of an address.
 *
 * The prefix rather than the address because it is compared across requests: a
 * mobile client's exact IP changes constantly within one carrier block, so a
 * full-address comparison would flag every legitimate session as a new location
 * and none of the actual relocations.
 */
function ipClassOf(ip: string): string {
  if (ip.includes(':')) {
    // IPv6 — first three hextets is a /48, the usual site allocation.
    const parts = ip.split(':').filter((p) => p !== '');
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * A coarse device tag from headers the browser sends anyway.
 *
 * This is not a fingerprint in the tracking sense and must not be mistaken for
 * one: it is trivially forgeable, and two people on the same laptop model and
 * browser version produce the same value. It is recorded so "this session came
 * from something that looks different" is answerable, and it never gates access.
 */
function deviceFingerprintOf(userAgent: string | null, acceptLanguage: string | null): string {
  return createHash('sha256')
    .update(`${userAgent ?? ''}|${acceptLanguage ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

/** Truncated to the column width rather than rejected — an over-long UA is odd,
 *  not a reason to refuse a sign-in. */
function truncateUserAgent(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  return userAgent.length > 256 ? userAgent.slice(0, 256) : userAgent;
}

export function clientContextOf(
  ip: string,
  userAgent: string | null,
  acceptLanguage: string | null,
): ClientContext {
  return {
    ip,
    ipClass: ipClassOf(ip),
    deviceFingerprint: deviceFingerprintOf(userAgent, acceptLanguage),
    userAgent: truncateUserAgent(userAgent),
  };
}

// ─── serialisation ──────────────────────────────────────────────────────────

/**
 * The explicit subset of an admin row that may cross the API boundary.
 *
 * Listed field by field rather than built by deleting sensitive keys, which is
 * the direction that fails safe: a new column added to `Admin` is absent from
 * responses until someone adds it here, rather than being exposed until someone
 * remembers to exclude it.
 */
export function toPublicAdmin(admin: Admin): PublicAdmin {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    emailVerified: admin.emailVerifiedAt !== null,
    mfaEnrolled: admin.mfaEnrolledAt !== null,
    createdAt: admin.createdAt,
  };
}
