import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { config } from '../src/config';
import { randomBase32, randomDigits, safeEqual } from '../src/utils/public.utils';
import { CONTINUATION, CSRF, OTP, PUBLIC_CODE, REFERRAL, SESSION, USERNAME } from './auth.constants';
import type { ClientContext, PublicUser, RefreshContext } from './auth.types';

/**
 * Pure helpers scoped to `auth/`. No I/O, no injection, no database — which is
 * what makes the identifier-generation rules directly testable.
 */

// ─── normalisation ──────────────────────────────────────────────────────────

/**
 * Lowercase and trim. Nothing more.
 *
 * Notably it does NOT strip Gmail's dots or `+tags`. Those are Gmail conventions,
 * not email semantics — `a.b@fastmail.com` and `ab@fastmail.com` are different
 * mailboxes — so canonicalising them would merge unrelated accounts on every
 * other provider. One address, one account; the user's provider decides what
 * routes where.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}


// ─── hashing ────────────────────────────────────────────────────────────────

/**
 * The namespace a hash belongs to. Every peppered hash declares one, and the tag
 * is mixed into the digest, so the same plaintext hashes differently depending on
 * what it is *for*.
 *
 * This is not decoration. Without a tag, one construction serving two namespaces
 * means a value lifted from one column verifies against the other — an OTP row and
 * a continuation-secret row become interchangeable.
 */
type HashDomain =
  | 'otp'
  | 'continuation'
  | 'device'
  /**
   * The signature on the device cookie — deliberately NOT `device`.
   *
   * `device` produces `ClientContext.deviceKey`, which is the form persisted on
   * `trusted_devices`. Signing with the same domain would make the cookie's
   * signature byte-identical to the stored key, so anyone who could read that table
   * could mint a valid cookie for any device in it. Domain separation is what keeps
   * "the thing in the database" and "the thing that proves the cookie is ours" from
   * being the same secret.
   */
  | 'device-sig'
  | 'csrf'
  /** A printable single-use 2FA recovery code. Its own domain and not `otp`: both
   *  are short strings a person types, and a value lifted from `recovery_codes`
   *  must not verify against a live `verification_challenges` row. */
  | 'recovery'
  /**
   * The `loginId` naming an in-flight sign-in. Its own domain for the same reason
   * `continuation` has one — it is a bearer handle to a server-side row, and the
   * two must not be interchangeable.
   *
   * ─── Why the tag says `mfa` and the value is called `loginId` ─────────────
   *
   * The handle used to be minted only when a second factor was owed, and it was
   * called `mfaToken` then. It now names the WHOLE flow, from the first real login
   * request onward, and the wire name changed with it. This tag did not,
   * deliberately.
   *
   * The tag is mixed into the digest, so renaming it would not be a rename: every
   * `login_attempts.token_hash` written under the old tag would stop matching, and
   * every sign-in in flight at deploy would fail. That is a real cost for no
   * security gain — the tag's job is to separate this namespace from the others,
   * which it does whatever it is called. The admin service made the same choice
   * for the same value, keeping `stepUpSecretHash` at rest after `loginId` became
   * the public name.
   */
  | 'mfa'
  /**
   * The token mailed to an address an email change released, authorising the account
   * to be restored to it or redirected away from the address that replaced it.
   *
   * Its own domain and emphatically NOT `recovery`, which is a 2FA backup code. The two
   * are the closest pair in this union — both are single-use, both recover an account,
   * both are hashed and stored — and that is exactly why they must not share a
   * construction. A backup code verifying against a `retained_emails` row would let a
   * printed sheet of paper move somebody's account to a new address.
   */
  | 'email-recovery';

/**
 * sha256 of a domain tag, the value, and the pepper.
 *
 * Not argon2, for two different reasons that happen to reach the same answer:
 *
 *   `otp`           a 6-digit code has ~20 bits of entropy, so no work factor
 *                   makes it resistant to an offline attack against a stolen
 *                   database. What protects it is the short lifetime and the
 *                   attempt cap. The hash's narrower job is to keep the plaintext
 *                   out of the row, so a leaked backup or a logged query does not
 *                   hand over live codes — and to stay cheap enough that
 *                   verification is not its own DoS vector.
 *   `continuation`  the secret has 256 bits, so there is nothing to brute-force
 *                   and a work factor would only add latency to every step of the
 *                   flow.
 *
 * In both cases the pepper is what stops a stolen database from being attacked
 * with a precomputed table.
 *
 * The `:` separator keeps the tag unambiguous: without it, domain `a` + value `bc`
 * and domain `ab` + value `c` would produce the same digest. A literal separator is
 * safe here because `HashDomain` is a closed union and no member contains one.
 *
 * A plain equality lookup on a `continuation` hash is safe — no constant-time
 * compare needed — because the comparison happens inside a B-tree index probe on a
 * value the attacker cannot influence incrementally. An `otp` hash is compared with
 * `safeEqual` because that comparison happens in application code against a value
 * the attacker supplies a guess for.
 */
export function pepperedHash(value: string, domain: HashDomain): string {
  return createHash('sha256')
    .update(`${domain}:${value}${config.PASSWORD_PEPPER}`)
    .digest('hex');
}

// ─── one-time codes ─────────────────────────────────────────────────────────

export function generateOtp(): string {
  return randomDigits(OTP.LENGTH);
}

// ─── registration continuation ──────────────────────────────────────────────

/**
 * The secret that identifies an in-flight registration — `signupId` on the wire.
 *
 * `randomBytes` rather than a uuid: this is a bearer credential, not an
 * identifier, and it should read as one. base64url so it survives a JSON body,
 * a URL and a header without escaping — it used to travel in the `orebit_reg`
 * cookie, and the encoding outlived the transport because it costs nothing.
 *
 * Also used for the OAuth `linkToken`, which is the same kind of value: a
 * short-lived opaque handle to server-side state, resolved by its hash.
 */
export function generateContinuationSecret(): string {
  return randomBytes(CONTINUATION.SECRET_BYTES).toString('base64url');
}

// ─── session handle ─────────────────────────────────────────────────────────

/**
 * The opaque value a browser holds in `orebit_session`, naming a server-side record
 * that holds both tokens.
 *
 * `randomBytes` rather than a uuid, and 32 of them rather than 16: this is the only
 * thing standing between an attacker and somebody's session, so it is a full 256 bits
 * with no structure to guess at. A UUIDv7 would be worse on both counts — half the
 * entropy, and a timestamp in the high bits narrowing the search for one minted at a
 * known moment.
 *
 * base64url so it survives a cookie value and a Redis key without escaping.
 */
export function generateSessionHandle(): string {
  return randomBytes(SESSION.HANDLE_BYTES).toString('base64url');
}

// ─── CSRF ───────────────────────────────────────────────────────────────────

/**
 * A CSRF token for one session handle: `<nonce>.<signature>`.
 *
 * Signed rather than a bare random value, and bound to the handle rather than
 * standing alone, because the attacker this defends against is same-site: another
 * orebit.io subdomain can write cookies for the parent domain, so it could otherwise
 * set both halves of a plain double-submit pair itself. Signing means a valid pair can
 * only come from a server that holds the pepper.
 *
 * ─── Why the handle and not the refresh token ──────────────────────────────
 *
 * It used to be the refresh token, because that was the credential the browser held.
 * It no longer holds one: the refresh token is sealed server-side and rotates roughly
 * every fifteen minutes without the client noticing, so a token bound to it would go
 * stale on a schedule nothing on the page can observe. The handle is the browser's
 * credential now, and it is also the one value that survives every rotation — which
 * is what lets this token stay valid for the life of the session.
 *
 * The handle is hashed, never embedded, so a readable cookie cannot be read back into
 * the credential it guards. See `CSRF` in auth.constants.ts for what this does and
 * does not defend.
 */
export function generateCsrfToken(handle: string): string {
  const nonce = randomBytes(CSRF.NONCE_BYTES).toString('base64url');
  return `${nonce}.${csrfSignature(nonce, handle)}`;
}

/** Does this token belong to this session handle? */
export function csrfTokenMatches(token: string, handle: string): boolean {
  const separator = token.indexOf('.');
  // A nonce of zero length, or no separator at all, is not a token this issued.
  if (separator <= 0) return false;

  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Constant-time, like every other comparison here against an attacker-supplied
  // value: the caller controls what it sends and can vary it one byte at a time.
  return safeEqual(signature, csrfSignature(nonce, handle));
}

/**
 * ═══ THE MESSAGE HAS TO SAY WHERE THE NONCE ENDS ════════════════════════════
 *
 * `pepperedHash` already documents this exact hazard for its own tag: domain `a` +
 * value `bc` and domain `ab` + value `c` would digest identically, and it is safe
 * there only because `HashDomain` is a closed union whose members contain no `:`.
 *
 * This call site had no such guarantee. It signed `${nonce}:${handle}`, and while a
 * GENERATED nonce is base64url and cannot contain `:`, the nonce reaching verification
 * is not generated — `csrfTokenMatches` slices it out of the token the caller sent, so
 * it is whatever the client put before the first `.`. With one `:` free to appear in
 * that half, `("a:b", "c")` and `("a", "b:c")` are the same message and therefore the
 * same signature: one authenticated string standing for two different bindings.
 *
 * ─── The framing, and why it is injective ──────────────────────────────────
 *
 * The nonce is length-prefixed, so the message names its own split point:
 *
 *     <length of nonce in decimal> : <nonce> : <handle>
 *
 * Recovering the pair is deterministic — read digits to the first `:` for L, take the
 * next L characters as the nonce, skip one `:`, and everything after is the handle.
 * Two distinct pairs cannot meet: if the nonce lengths differ the decimal prefixes
 * differ, and they are self-delimiting because digits are never `:` (`12:…` and
 * `1:2:…` diverge at the second character); if the lengths agree the nonce occupies
 * the same span, so any difference in either field survives into the message.
 *
 * ─── Latent, and what the format change costs ──────────────────────────────
 *
 * Not reachable today. To exploit it an attacker needs a signature the server ISSUED
 * over a re-splittable message, and the server only ever signs a random base64url
 * nonce against a base64url handle — exactly one `:`, in exactly one place. They
 * cannot choose the nonce in an issued signature, nor obtain a handle containing `:`.
 *
 * Changing the framing invalidates CSRF cookies already in browsers, and that is
 * deliberately not versioned: the token is ephemeral and the recovery path already
 * exists. `ensureCsrf` re-verifies the cookie it finds and mints a replacement when it
 * does not match, which is precisely what an old-format value now does. The cost is
 * one `csrf_invalid` on an unsafe request made between the deploy and that refresh —
 * whose documented remedy is to re-read the token, which triggers the refresh.
 */
function csrfSignature(nonce: string, handle: string): string {
  return pepperedHash(`${nonce.length}:${nonce}:${handle}`, 'csrf');
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
 *
 * Exported for callers that need the class WITHOUT a `ClientContext`. Building one
 * with `clientContextOf` is the usual way to get it, but that requires a device id
 * and the routes that mint one do so by issuing a cookie — a side effect a route
 * that only wants to label a notification email should not have. `src/settings/`
 * is that caller.
 */
export function ipClassOf(ip: string): string {
  if (ip.includes(':')) {
    const hextets = expandIpv6(ip);
    if (hextets === null) return ip;

    // An IPv4-mapped address (`::ffff:203.0.113.5`) is an IPv4 client arriving on
    // a dual-stack socket, which is how Node reports one by default. Classifying
    // it as IPv6 produced `ffff:203.0.113.5::/48` — the *entire address*, so every
    // such client looked like its own network and the function did the opposite of
    // its job for the most common case there is.
    const mapped = ipv4Mapped(hextets);
    if (mapped !== null) return ipClassOf(mapped);

    // First three hextets is a /48, the usual site allocation.
    return `${hextets.slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * An IPv6 address as exactly eight normalised hextets, or null if it is not one.
 *
 * Expanding `::` is the whole point. Dropping it — which a `split(':')` and a
 * filter for empties does — collapses `2001:db8::1` to `2001:db8:1`, so it reports
 * the /48 of the genuinely different site `2001:db8:1::`. Two unrelated networks
 * then share a class, and the same address written two legal ways produces two.
 */
function expandIpv6(ip: string): string[] | null {
  // A zone index (`fe80::1%eth0`) is local scope and never part of the address.
  const address = (ip.split('%')[0] ?? '').toLowerCase();
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const head = (halves[0] ?? '').split(':').filter((part) => part !== '');
  const tail = halves.length === 2 ? (halves[1] ?? '').split(':').filter((p) => p !== '') : [];

  // `::ffff:203.0.113.5` writes its last 32 bits as a dotted quad rather than two
  // hextets. Widen it before counting, or the address comes up one group short and
  // the octets get read as hex.
  const last = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1];
  if (last !== undefined && last.includes('.')) {
    const octets = last.split('.').map((octet) => Number(octet));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const widened = [
      (((octets[0] as number) << 8) | (octets[1] as number)).toString(16),
      (((octets[2] as number) << 8) | (octets[3] as number)).toString(16),
    ];
    if (tail.length > 0) tail.splice(-1, 1, ...widened);
    else head.splice(-1, 1, ...widened);
  }

  const filler = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (filler < 0) return null;

  const hextets = [...head, ...Array<string>(halves.length === 2 ? filler : 0).fill('0'), ...tail];
  // Leading zeros are stripped so `2001:0db8:…` and `2001:db8:…` — the same
  // address — cannot yield two different classes.
  return hextets.map((part) => part.replace(/^0+(?=.)/, ''));
}

/** The dotted-quad inside `::ffff:a.b.c.d`, or null. */
function ipv4Mapped(hextets: string[]): string | null {
  const prefixIsZero = hextets.slice(0, 5).every((part) => part === '0');
  if (!prefixIsZero || hextets[5] !== 'ffff') return null;

  const high = Number.parseInt(hextets[6] ?? '', 16);
  const low = Number.parseInt(hextets[7] ?? '', 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * True for a current device key — `pepperedHash(secret, 'device')`, 64 hex.
 *
 * The length test discriminates three eras of this column without a migration:
 * 32 hex was the old sha256(user-agent | accept-language) tag, 43 base64url was a
 * brief plaintext-cookie form, and 64 hex is the peppered hash. Only the last may
 * be grouped on — the first was coarse enough that two devices could share it,
 * and the second is a secret that should never have been at rest. Anything else
 * falls back to family-scoped logout, which is correct for all of them.
 */
export function isDeviceKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * When a session whose last activity was `from` should expire.
 *
 * Whichever is later: the idle window measured from `from`, or the device's trust
 * window. The three-line body is doing more than it looks:
 *
 *   - Inside the trust window, `rememberUntil` is later and wins, so the user
 *     survives it with zero activity.
 *   - Once it has passed, `from + idle` is later and wins automatically. There is
 *     no expiry branch and no cleanup job — a stale `rememberUntil` simply stops
 *     mattering, which is why nothing has to go back and null it out.
 *   - With no trust at all, it is always `from + idle`.
 *
 * ─── Why `from` is a parameter and not always now ───────────────────────────
 *
 * Because `expiresAt` IS the idle deadline, and the idle clock starts at the last
 * authenticated request rather than at the last time this function was called.
 * Defaulting to now is right for `issue` (a login is activity) and for `touch` (a
 * request is activity), and wrong for `rotate` — a refresh is a client keeping its
 * tokens fresh, not a person using the product. Passing `session.lastUsedAt` there
 * is what stops a background refresher renewing the window forever, which is
 * precisely what it used to do.
 */
export function sessionExpiry(rememberUntil: Date | null, from: Date = new Date()): Date {
  const idle = new Date(from.getTime() + SESSION.IDLE_TIMEOUT_SECONDS * 1000);
  if (rememberUntil === null) return idle;
  return rememberUntil > idle ? rememberUntil : idle;
}

/**
 * A short human label for a device, for the "trusted devices" list.
 *
 * Coarse on purpose. This exists so a user scanning the list can tell which row
 * is the laptop and which is the phone before revoking one; it is not analytics
 * and never affects a decision, so a handful of substring checks beats a
 * user-agent parsing dependency that needs updating every browser release.
 */
export function deviceLabel(userAgent: string | null): string | null {
  if (userAgent === null) return null;

  const ua = userAgent.toLowerCase();
  // Order matters: every mobile UA also contains a desktop OS token, and Edge and
  // Chrome both claim to be Safari.
  const os = ua.includes('iphone')
    ? 'iPhone'
    : ua.includes('ipad')
      ? 'iPad'
      : ua.includes('android')
        ? 'Android'
        : ua.includes('mac os')
          ? 'Mac'
          : ua.includes('windows')
            ? 'Windows'
            : ua.includes('linux')
              ? 'Linux'
              : null;

  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('opr/')
      ? 'Opera'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('chrome')
          ? 'Chrome'
          : ua.includes('safari')
            ? 'Safari'
            : null;

  if (os === null && browser === null) return null;
  return [browser, os].filter((part) => part !== null).join(' on ').slice(0, 80);
}

/** Truncated to the column width rather than rejected — an over-long UA is odd,
 *  not a reason to refuse a login. */
function truncateUserAgent(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  return userAgent.length > 256 ? userAgent.slice(0, 256) : userAgent;
}

export function clientContextOf(
  ip: string,
  userAgent: string | null,
  deviceId: string,
  /** Cloudflare's country for this request, already gated by `cloudflareCountry`.
   *  Defaulted so every existing call site keeps compiling and simply records null,
   *  which is the correct value on a deployment that is not behind Cloudflare. */
  country: string | null = null,
): ClientContext {
  return {
    ip,
    ipClass: ipClassOf(ip),
    country,
    deviceId,
    // Derived here and nowhere else, so the plaintext secret and its stored form
    // can never disagree. `deviceId` stays on the context because trusting a
    // device needs the secret itself; everything persisted uses the key.
    deviceKey: pepperedHash(deviceId, 'device'),
    userAgent: truncateUserAgent(userAgent),
  };
}

/**
 * The narrower context a server-side refresh runs with — see `RefreshContext`.
 *
 * Built here rather than in `guards.ts` so `ipClassOf` and the user-agent truncation
 * stay in one place. The two contexts must agree about both: `ipClass` and `userAgent`
 * are written onto the child generation by a rotation and onto the first generation by
 * a sign-in, and a second derivation of either is a second answer that could differ —
 * which would make a session look like it had moved networks on a refresh.
 *
 * Takes the device KEY already derived, not a raw id, because the caller read it from
 * a cookie without minting one and has no raw secret to offer. `null` is a legitimate
 * value here and the type says so.
 */
export function refreshContextOf(
  ip: string,
  userAgent: string | null,
  deviceKey: string | null,
  /** See `clientContextOf`. Null on every deployment that does not trust Cloudflare. */
  country: string | null = null,
): RefreshContext {
  return {
    ipClass: ipClassOf(ip),
    country,
    deviceKey,
    userAgent: truncateUserAgent(userAgent),
  };
}

// ─── user identifiers ───────────────────────────────────────────────────────

/** The part before the `@`, or the whole string if there is none. */
export function emailLocalPart(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

/** Lookup key for case-insensitive public and referral codes. */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

/** `OREBiT` plus eight Crockford base32 characters. */
export function generatePublicCode(): string {
  return `${PUBLIC_CODE.PREFIX}${randomBase32(PUBLIC_CODE.RANDOM_LENGTH)}`;
}

export function generateReferralCode(): string {
  return randomBase32(REFERRAL.CODE_LENGTH);
}

function sanitiseUsernameSeed(seed: string): string {
  const collapsed = seed
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return collapsed.slice(0, USERNAME.MAX_LENGTH);
}

/**
 * Candidate usernames in preference order for collision-safe allocation.
 *
 * Every candidate satisfies `USERNAME.DEFAULT_MIN_LENGTH`, which is what an account
 * created without Premium is entitled to. That floor moved from 3 to 7 when usernames
 * became user-changeable, and this is one of the two paths it binds — a generated name
 * the owner could not legally re-choose would be an odd thing to hand them.
 *
 * The fallback threshold moved with it rather than staying at 3, so a seed of `jo` or
 * `ada` now lands on the neutral name for the reason it always did: below the floor
 * there is no stem worth showing, and padding one out with digits produces a username
 * that looks like a mistake rather than like a default.
 */
export function generateUsernameCandidates(seed: string, count: number): string[] {
  let stem = sanitiseUsernameSeed(seed);
  if (stem.length < USERNAME.DEFAULT_MIN_LENGTH) {
    // Derived rather than fixed at 4 so the fallback cannot silently fall under the
    // floor if that floor is ever raised again — the prefix is 6 characters, so today
    // this is 4 and the result is 10.
    const digits = Math.max(4, USERNAME.DEFAULT_MIN_LENGTH - USERNAME.FALLBACK_PREFIX.length);
    stem = `${USERNAME.FALLBACK_PREFIX}${randomDigits(digits)}`;
  }

  const candidates = [stem];
  const suffixLength = 4;
  const room = Math.max(USERNAME.DEFAULT_MIN_LENGTH, USERNAME.MAX_LENGTH - suffixLength);
  const base = stem.slice(0, room);

  while (candidates.length < count) {
    const candidate = `${base}${randomDigits(suffixLength)}`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }

  return candidates;
}

/** Converts a database user into the explicit public user projection. */
export function toPublicUser(user: User, hasPassword: boolean): PublicUser {
  return {
    publicCode: user.publicCode,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    country: user.countryDeclared,
    referralCode: user.referralCode,
    hasPassword,
    registeredAt: user.registeredAt,
    avatarUrl: user.avatarUrl ?? null,
  };
}
