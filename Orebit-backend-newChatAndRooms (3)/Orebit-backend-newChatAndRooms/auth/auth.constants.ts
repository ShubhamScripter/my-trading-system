/**
 * Product configuration for the auth flow.
 *
 * This is in code rather than in `.env` on purpose. These are not deployment
 * coordinates, they are product policy — the kind of value a founder or a risk
 * team changes on a Tuesday afternoon. Env vars would make each change a deploy;
 * this file makes each change a reviewable diff, and one that a test can assert
 * against. When the database-backed settings engine lands, these become its
 * defaults and every reader goes through it instead.
 *
 * Anything read at request time belongs here. Anything secret belongs in env.
 */

export const OTP = {
  /** Six digits. Short enough to retype from a phone, and the attempt cap rather
   *  than the length is what makes guessing infeasible: 5 tries against 10^6. */
  LENGTH: 6,
  TTL_SECONDS: 10 * 60,
  /** Wrong guesses allowed before the code is dead and must be re-sent. */
  MAX_ATTEMPTS: 5,
  RESEND_COOLDOWN_SECONDS: 60,
  /** Codes per registration attempt. Caps the cost of a single abandoned signup
   *  being used as a free email relay. */
  MAX_SENDS: 5,
} as const;

export const PASSWORD = {
  MIN_LENGTH: 8,
  /** Bound password input to the 8–20 character product policy. */
  MAX_LENGTH: 20,
  /** Lowercase, uppercase, digit, and special character are all required. */
  MIN_CHARACTER_CLASSES: 4,
} as const;

export const SESSION = {
  ACCESS_TTL_SECONDS: 15 * 60,

  /**
   * How long a session survives WITHOUT use.
   *
   * Renamed from `REFRESH_TTL_SECONDS`, and the rename is the point: the old name
   * described a fixed lifetime, and every rotation minting a fresh full window
   * turned 30 days into "forever, for anyone who opens the app monthly". The
   * window still resets on activity — that half was always right — but it is now
   * short enough that walking away actually ends the session.
   *
   * A trusted device suspends this until `Session.rememberUntil`; see
   * `sessionExpiry` in auth.utility.ts.
   */
  IDLE_TIMEOUT_SECONDS: 24 * 60 * 60,

  /** How long "trust this device" holds a session open with zero activity. */
  REMEMBER_ME_SECONDS: 7 * 24 * 60 * 60,

  /** How long a revoked session id is remembered in the cache. Exactly the access
   *  token's lifetime — past that the token is expired anyway, so remembering the
   *  revocation longer buys nothing. */
  REVOCATION_CACHE_SECONDS: 15 * 60,

  /**
   * Minimum gap between `lastUsedAt` writes for one session.
   *
   * Tuning, not policy, so it stays hardcoded when the rest of this file moves to
   * the settings engine. Every authenticated request would otherwise write to the
   * same row, turning a read-mostly table into a write-per-request one to record a
   * timestamp nobody reads at second resolution.
   */
  LAST_USED_THROTTLE_SECONDS: 60,

  // ─── the browser's session record ───────────────────────────────────────────
  //
  // The browser holds an opaque handle naming a server-side record that holds both
  // tokens. See auth/security/bff.session.ts and auth/security/session.cookie.ts.

  /** Bytes of randomness in a session handle, base64url-encoded. The only thing
   *  standing between an attacker and somebody's session, so it is a full 256 bits
   *  rather than the 128 a UUID would give. */
  HANDLE_BYTES: 32,

  /**
   * How close to the stored access token's expiry a request triggers a refresh.
   *
   * Refresh is the backend's job now, so it has to happen slightly EARLY: a token
   * that expires while the request holding it is in flight would be refused by
   * `verifyAccessToken` a few milliseconds later. Thirty seconds is comfortably more
   * than any request here takes and comfortably less than the fifteen-minute token
   * life, so it neither cuts a request short nor rotates more often than necessary.
   */
  ACCESS_REFRESH_SKEW_SECONDS: 30,

  /**
   * How long one request may hold the refresh lock.
   *
   * The lock exists because `SessionService.rotate` treats two presentations of one
   * refresh token as theft and revokes the family. That is right for a client-driven
   * refresh; it is wrong here, where refresh is automatic and unprompted and two
   * concurrent requests on one session reach it as a matter of course. Without the
   * lock, ordinary concurrency would sign a user out.
   *
   * Five seconds: long enough for a rotation's two statements plus a slow round trip,
   * short enough that a crashed holder does not wedge the session for long. Note the
   * lock is best-effort rather than a guarantee — if its TTL lapses mid-rotation the
   * generation CAS still enforces one-use, and the loser is repaired rather than
   * accused. See `SessionService.recoverRotation`.
   */
  REFRESH_LOCK_SECONDS: 5,

  /**
   * Total time a request that lost the lock will wait for the holder's result.
   *
   * Only reached when the waiter's own token has already expired, so proceeding is
   * not an option and the alternative is a 401 on a session that is perfectly fine.
   * Strictly under `REFRESH_LOCK_SECONDS` so a waiter can never outlive the holder it
   * is waiting for; the backoff schedule in bff.session.ts sums to exactly this.
   */
  REFRESH_WAIT_MS: 1000,

  /**
   * How long after a rotation committed its interrupted publication may still be
   * repaired instead of read as a replay.
   *
   * See `SessionService.recoverRotation`. It bounds the repair to the window in which
   * a retry of the SAME request can plausibly arrive: a dropped Redis write is
   * retried by the next request, seconds later. A replayed token arriving minutes
   * afterwards falls outside it and is treated as theft, which is what keeps this a
   * repair path rather than an exception to reuse detection.
   */
  ROTATION_RECOVERY_WINDOW_SECONDS: 120,

  /**
   * The session cookie: an opaque handle, and the only credential a browser holds.
   *
   *  - `httpOnly` — the entire point. Script on the page cannot read it, and unlike
   *    the arrangement this replaced there is no longer an access token in a response
   *    body either, so an XSS can *use* the session while it runs but cannot lift
   *    anything that authorises a single request off our origin.
   *  - `sameSite: 'lax'` — withheld from cross-site POSTs, which is the shape a CSRF
   *    attempt takes, but still sent on top-level navigation. Defence in depth behind
   *    the CSRF token, not a replacement for it.
   *  - `secure` in production only — a secure cookie is dropped over plain HTTP,
   *    which would make local development fail silently.
   *  - `COOKIE_PATH: '/'` — every route authenticates from this cookie now, so it has
   *    to be sent on every route. `/auth/session` was correct only while exactly one
   *    endpoint read a credential.
   *  - the maxAge is `REMEMBER_ME_SECONDS`, and that is deliberate — see
   *    `sessionCookie.issue`.
   */
  COOKIE_NAME: 'orebit_session',
  COOKIE_PATH: '/',
} as const;

/**
 * ═══ THE CLOCKS ABOVE HAVE TO AGREE, AND A WRONG EDIT IS INVISIBLE ══════════
 *
 * Every value in `SESSION` is a literal in this file, so none of this can be broken
 * by a deployment — only by an edit. That is exactly the case worth a boot-time
 * refusal, because each relationship below fails SILENTLY: the service starts, the
 * happy path works, and the thing that stops working is a background mechanism
 * nobody is looking at.
 *
 *   access < idle          below the idle window there is nothing left to refresh:
 *                          the access token would outlive the session it belongs to.
 *
 *   idle ≤ remember-me     the session cookie and the Redis record are both scoped to
 *                          `REMEMBER_ME_SECONDS`, the longest life any session can
 *                          have. An idle window ABOVE it would mean a session the
 *                          database still considers live whose handle the browser has
 *                          already discarded — a logout nobody performed.
 *
 *   skew < access          a refresh skew at or above the token's own life makes
 *                          EVERY request due for refresh, so every request takes the
 *                          lock and rotates. The session still works; it just does a
 *                          database write per request and burns the refresh quota.
 *
 *   wait < lock            a waiter must never outlive the holder it is waiting for,
 *                          or it waits on a lock that has already lapsed and reports
 *                          `session_store_unavailable` for a rotation that finished.
 *
 *   throttle ≤ idle / 2    THE ONE THAT IS NOT OBVIOUS. `touch` only writes once per
 *                          throttle window, so `lastUsedAt` lags real activity by up
 *                          to that much and the effective window for a continuously
 *                          working user is `idle - throttle`. Shorten the idle window
 *                          alone — the obvious edit — and the throttle ends up above
 *                          it: `touch` can then never fire before `expiresAt` passes,
 *                          so the session dies on schedule no matter how active the
 *                          user is. The logout happens, on time, and looks correct,
 *                          while the half most worth having — that activity extends
 *                          the session — has stopped working.
 */
function assertSessionClocksAreCoherent(): void {
  const problems: string[] = [];

  if (SESSION.ACCESS_TTL_SECONDS >= SESSION.IDLE_TIMEOUT_SECONDS) {
    problems.push(
      `  ACCESS_TTL_SECONDS (${SESSION.ACCESS_TTL_SECONDS}) must be below IDLE_TIMEOUT_SECONDS` +
        ` (${SESSION.IDLE_TIMEOUT_SECONDS}), or an access token outlives its own session`,
    );
  }

  if (SESSION.IDLE_TIMEOUT_SECONDS > SESSION.REMEMBER_ME_SECONDS) {
    problems.push(
      `  IDLE_TIMEOUT_SECONDS (${SESSION.IDLE_TIMEOUT_SECONDS}) must not exceed` +
        ` REMEMBER_ME_SECONDS (${SESSION.REMEMBER_ME_SECONDS}), which is what the session cookie` +
        ` and the Redis record are scoped to`,
    );
  }

  if (SESSION.ACCESS_REFRESH_SKEW_SECONDS >= SESSION.ACCESS_TTL_SECONDS) {
    problems.push(
      `  ACCESS_REFRESH_SKEW_SECONDS (${SESSION.ACCESS_REFRESH_SKEW_SECONDS}) must be below` +
        ` ACCESS_TTL_SECONDS (${SESSION.ACCESS_TTL_SECONDS}), or every request rotates`,
    );
  }

  if (SESSION.REFRESH_WAIT_MS >= SESSION.REFRESH_LOCK_SECONDS * 1000) {
    problems.push(
      `  REFRESH_WAIT_MS (${SESSION.REFRESH_WAIT_MS}) must be below REFRESH_LOCK_SECONDS` +
        ` (${SESSION.REFRESH_LOCK_SECONDS}s), or a waiter outlives the holder it waits for`,
    );
  }

  if (SESSION.LAST_USED_THROTTLE_SECONDS * 2 > SESSION.IDLE_TIMEOUT_SECONDS) {
    problems.push(
      `  LAST_USED_THROTTLE_SECONDS (${SESSION.LAST_USED_THROTTLE_SECONDS}) must be at most half` +
        ` IDLE_TIMEOUT_SECONDS (${SESSION.IDLE_TIMEOUT_SECONDS}), or activity is written too` +
        ` rarely to extend the session and an active user is logged out anyway`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Incoherent session clocks:\n${problems.join('\n')}`);
  }
}

assertSessionClocksAreCoherent();

/**
 * Stable, opaque browser-profile identifier. It groups tabs on one device for
 * logout purposes; it is never used to authenticate a request.
 */
export const DEVICE = {
  COOKIE_NAME: 'orebit_device',
  COOKIE_PATH: '/auth',
  ID_BYTES: 32,
  MAX_AGE_SECONDS: 365 * 24 * 60 * 60,
} as const;

/**
 * MOVED: every CAPTCHA value is in `policy().CAPTCHA` — see auth/limits.ts.
 *
 *   BLOCK_LADDER_SECONDS -> policy().CAPTCHA.BLOCK_LADDER_SECONDS
 *   STRIKE_TTL_SECONDS   -> policy().CAPTCHA.STRIKE_TTL_SECONDS   (12h, not 24h)
 *   the failure threshold -> policy().CAPTCHA.FAILURES_BY_IP      (10/5min)
 *
 * The block here was declared and never imported, so `captcha.service.ts` was already
 * reading the policy — but the dead copy stated a 24-hour strike memory against the
 * approved 12, and a 15-minute failure window against the approved 5. A second set of
 * numbers in the file whose header calls itself "product policy" is a trap for whoever
 * reads it next, which is the whole reason it is deleted rather than corrected.
 */

/**
 * MOVED: the durable lockout is `policy().LOCKOUT` — see auth/limits.ts.
 *
 *   MAX_FAILED_ATTEMPTS -> policy().LOCKOUT.MAX_FAILED_ATTEMPTS
 *   DURATION_SECONDS    -> policy().LOCKOUT.LADDER_SECONDS
 *
 * Also declared and never imported. `DURATION_SECONDS` described a FLAT fifteen
 * minutes, which is the defect the approved ladder (15m, 1h, 24h) exists to fix: a
 * flat penalty lets a patient caller run ninety-six lockout cycles a day against one
 * account forever.
 */

export const REGISTRATION = {
  /**
   * Whole-attempt TTL.
   *
   * Thirty minutes rather than a day, and the reason is a product decision:
   * abandoning the flow means starting over, so there is nothing to keep a row
   * alive *for*. A long window would only mean two things accumulating — an email
   * address held in a half-claimed state, and an argon2 hash of a real password
   * sitting on `pendingPasswordHash` between the `credentials` and `country`
   * steps. Thirty minutes is comfortably longer than the flow takes and short
   * enough that neither piles up.
   */
  TTL_SECONDS: 30 * 60,
} as const;

/**
 * The secret that identifies an in-flight registration — `signupId` on the wire.
 *
 * ─── REMOVED: `COOKIE_NAME`, `HEADER_NAME`, `COOKIE_PATH` ───────────────────
 *
 * The secret used to travel in an httpOnly `orebit_reg` cookie scoped to
 * `/auth/register`, with `x-registration-token` as an alternate transport. Both
 * are gone; `start` returns the value in the response body as `signupId` and every
 * later step sends it back in the request body.
 *
 * What the cookie bought and this does not: script on the page could not read it,
 * and `sameSite: 'lax'` kept it off cross-site requests. Both are genuinely gone —
 * an XSS on the signup page can now lift a half-finished registration. It was
 * moved anyway, for reasons the cookie could not answer. Two tabs shared one
 * cookie, so a second signup silently clobbered the first. The value was
 * duplicated across two transports with the cookie silently winning, which is two
 * undocumented ways to name one flow. And the browser kept attaching it to every
 * request to `/auth/register` whether the step needed it or not.
 *
 * What still bounds it: `Registration.expiresAt` (30 minutes, `REGISTRATION`
 * below) is enforced on every read; the hash is nulled in the same statement that
 * completes the row, so a finished signup has no matchable handle; `STEP_REQUIRES`
 * gates every step on the registration's own state, so the secret authorises
 * nothing by itself; and CORS admits exactly one origin, so a cross-site page
 * cannot read a response to learn one.
 *
 * A client holds it in memory for the life of the signup. NOT in localStorage or
 * sessionStorage — persisting it turns a page-lifetime exposure into one that
 * outlives the tab, which is most of what the cookie was protecting against.
 */
export const CONTINUATION = {
  /** Bytes of entropy in the secret. 32 is far past guessable, and this value is
   *  the only thing standing between a stranger and someone else's verified
   *  registration. */
  SECRET_BYTES: 32,
} as const;

// REMOVED: `REFRESH_COOKIE`. The refresh token no longer reaches the browser in any
// form. It is sealed inside the server-side session record that `SESSION.COOKIE_NAME`
// names — see auth/security/bff.session.ts — so there is no cookie left to configure.
// Deleted rather than left unused: the next reader to reach for it would put a
// credential back in the browser.

/**
 * The CSRF token that accompanies the session cookie.
 *
 * Needed because a cookie credential is sent by the browser whether or not the
 * page meant to send it. Three layers already stand in the way of a *cross-site*
 * attacker — `sameSite: 'lax'`, a CORS origin pinned to WEB_APP_URL, and a JSON
 * content type that forces a preflight — and none of them say anything about a
 * *same-site* one: another orebit.io subdomain can both make same-site requests
 * and write cookies for the parent domain.
 *
 * So the token is signed rather than being a bare random double-submit pair. The
 * cookie holds `<nonce>.<signature>` where the signature is a peppered hash over
 * the nonce and the SESSION HANDLE it accompanies, and the client echoes the whole
 * value in the `HEADER_NAME` header. A subdomain that can write cookies still
 * cannot mint a pair that verifies, because it has neither the pepper nor the
 * handle — which is httpOnly and therefore unreadable to it.
 *
 * NOT httpOnly, and that is not an oversight: the client has to read this one to
 * echo it. It is not a credential — on its own it authenticates nothing, and the
 * handle it is bound to only ever appears here as a hash.
 *
 * ─── Why the path widened with the session cookie ──────────────────────────
 *
 * `/auth` was correct while exactly one endpoint checked a token. Every unsafe
 * method on every route is now a cookie-authenticated state change, so the check
 * moved into `AuthGuard` and the token has to be readable and sendable everywhere
 * the session cookie is. A CSRF cookie scoped narrower than the credential it
 * guards would simply be absent on most of the requests that need it.
 *
 * What it does not defend against: a same-site attacker who logs in as themselves
 * and writes BOTH cookies into someone else's browser, so that browser acts as the
 * attacker's session. That is login fixation rather than CSRF and it needs a defence
 * at the login route rather than here.
 */
export const CSRF = {
  COOKIE_NAME: 'orebit_csrf',
  HEADER_NAME: 'x-orebit-csrf',
  COOKIE_PATH: '/',
  NONCE_BYTES: 32,
} as const;

export const OAUTH = {
  /**
   * MOVED: both OAuth lifetimes are in `policy().OAUTH` — see auth/limits.ts.
   *
   *   STATE_TTL_SECONDS   -> policy().OAUTH.STATE_TTL_SECONDS    (10 minutes)
   *   PENDING_TTL_SECONDS -> policy().OAUTH.PENDING_TTL_SECONDS  (30 minutes)
   *
   * Declared in both places with the same numbers and read only from the policy, so
   * these two were inert. Same values, so nothing changes — but two live copies of one
   * decision is how the pairs above came to disagree.
   *
   * Why they are different from each other, which is worth keeping: `state` only has
   * to survive a redirect, while the pending identity has to survive a person
   * discovering they have forgotten their password, requesting a code, finding the
   * email, and coming back. A ten-minute window would strand exactly the user the
   * forgot-password branch exists to serve. Neither is a credential — the pending
   * value grants nothing without a successful login.
   */
  /**
   * Bytes of entropy in the PKCE `code_verifier`.
   *
   * 32 bytes is 43 base64url characters, which is exactly RFC 7636's minimum — the
   * spec's range is 43–128 characters, and the low end of it is already 256 bits.
   *
   * The verifier never leaves this server: we perform the token exchange ourselves,
   * so it is minted in `start`, parked in the `oauth:state` entry, and read back in
   * `callback`. The public-client dance where the browser holds it does not apply,
   * and neither does its weakness — there is no verifier in the page to steal.
   */
  PKCE_VERIFIER_BYTES: 32,
  /**
   * Refuse to finish an OAuth flow from a different /24 (or /48) than started it.
   *
   * ─── What this buys, and what it costs ─────────────────────────────────────
   *
   * Every OAuth handle — the `state`, and the `linkToken` that outlives it — is
   * parked server-side with the caller's `ipClass`. Checking it binds the half of
   * the flow that comes BACK to the half that went out, so a handle exfiltrated
   * from a log, a `Referer`, or shared browser history cannot be redeemed from
   * somewhere else.
   *
   * It is defence in depth rather than the primary control: PKCE already makes a
   * stolen authorization code unredeemable, and linking already needs a session and
   * an elevation ticket. This catches the case where those are not enough.
   *
   * The cost is real and worth stating: a phone that drops from wi-fi to mobile
   * data between starting a sign-in and returning from Google changes /24 and gets
   * refused. `ipClassOf` picks a prefix rather than an address precisely so that
   * ordinary movement inside one network does not trip this, but moving BETWEEN
   * networks still does. The refusal is recoverable — start again — and it is a
   * distinct error so a client can say so.
   *
   * A constant rather than a hardcoded `if`, because this is exactly the kind of
   * product-risk trade this file exists to make reviewable: flip it to `false` and
   * every check below degrades to a logged warning, in one line.
   */
  ENFORCE_IP_CLASS: true,
  /**
   * Bytes of entropy in the OIDC `nonce`.
   *
   * `state` and `nonce` look redundant and are not. `state` binds the CALLBACK to
   * the request we started — it is consumed before the code is exchanged, so it
   * catches a forged redirect. `nonce` binds the ID TOKEN to that same request, and
   * is checked after the exchange, so it catches a token that verifies perfectly
   * against Google's keys but was minted for somebody else's authorization.
   * Neither check subsumes the other.
   */
  NONCE_BYTES: 32,
} as const;

/**
 * ═══ THE SECOND FACTOR ══════════════════════════════════════════════════════
 *
 * Ported from Orebit-admin-backend, with one difference that shapes everything
 * below: here 2FA is OPT-IN. An admin must enrol; a user need never hear of this.
 * So every constant is sized for someone who set it up once and now meets it twice
 * a month, rather than for someone who meets it daily.
 */

/**
 * The in-flight sign-in — `loginId` on the wire.
 *
 * ─── It is the WHOLE sign-in now, not the gap between two factors ───────────
 *
 * This used to describe only the interval between the first factor and the
 * second, because that was the only part of a login with a server-side row. The
 * handle is minted by whichever real login operation comes FIRST — `password`,
 * `otp-request` or `oauth-start` — and the same value carries through the first
 * factor and the second to `POST /auth/2fa/verify`. See `LoginAttempt` in
 * db/schema.prisma.
 *
 * ─── REMOVED: `COOKIE_NAME`, `HEADER_NAME`, `COOKIE_PATH` ───────────────────
 *
 * They described an httpOnly `orebit_step` cookie and an `x-step-up-token` header
 * spanning `/auth/login` and `/auth/2fa`. Neither existed: nothing in this service
 * ever called `setCookie` with that name or read that header, and the only live
 * member of this object was `SECRET_BYTES`. `x-step-up-token` was allow-listed in
 * CORS for a mechanism that was never built.
 *
 * Deleted rather than left in place. A constant that documents a defence which
 * does not exist is worse than no constant — the next reader budgets for
 * protection they are not getting, and the honest description of where the handle
 * lives is "a field in the request body", with everything that implies.
 *
 * What bounds it: `LOGIN_FLOW.TTL_SECONDS` from `start`, re-stamped once to
 * `policy().MFA.CEREMONY_TTL_SECONDS` on the transition into FACTOR_REQUIRED;
 * `assertSameContext` pins it to the device fingerprint and IP class that opened
 * the flow; the hash is nulled in the same statement that completes the row; and
 * `LOGIN_STEP_REQUIRES` / `TWO_FACTOR_STATE_REQUIRES` gate every step on the row's
 * own state, so the handle authorises nothing by itself.
 */
export const STEP_UP = {
  /** Bytes of entropy in the secret. 32 is far past guessable, and this value is
   *  the only thing standing between a stranger and a half-authenticated sign-in. */
  SECRET_BYTES: 32,
} as const;

/**
 * The login flow as a whole, from the first real login request to a session.
 *
 * Separate from `STEP_UP` above, which now contributes only the handle's entropy,
 * because these two numbers answer different questions and are read at different
 * moments.
 */
export const LOGIN_FLOW = {
  /**
   * How long a flow may sit at `STARTED` or `OTP_SENT` before it is dead.
   *
   * Fifteen minutes. It has to cover reading an emailed sign-in code, which is the
   * slowest thing that happens before a first factor — the same reasoning behind
   * `OTP.TTL_SECONDS`, plus the time to switch to a mail client and back. It is
   * deliberately not longer: an abandoned flow is a row anyone can create, so the
   * ceiling is also what stops abandoned rows accumulating.
   *
   * ABSOLUTE, stamped once at `start`. Not a sliding window — a caller must not be
   * able to hold a flow open indefinitely by repeating a cheap step. The single
   * exception is the transition into `FACTOR_REQUIRED`, which re-stamps to the MFA
   * ceremony budget; that is a state change rather than a repeat, so it can happen
   * at most once per flow.
   */
  TTL_SECONDS: 15 * 60,
} as const;

/**
 * TOTP, per RFC 6238.
 *
 * `WINDOW: 1` accepts the step before and after the current one — ±30 seconds of
 * clock skew between the phone and this server. Wider would be friendlier and would
 * also widen the window in which a shoulder-surfed code is still live; the
 * `lastUsedStep` replay defence is what makes even that window single-use.
 */
export const TOTP = {
  STEP_SECONDS: 30,
  DIGITS: 6,
  WINDOW: 1,
  /** Bytes in a generated secret. 20 is the SHA-1 block size RFC 4226 assumes,
   *  and what every authenticator app expects. */
  SECRET_BYTES: 20,
  /** Shown in the authenticator app's account list. */
  ISSUER: 'OREBiT',
} as const;

/**
 * MOVED: both passkey constants are in `policy().MFA` — see auth/limits.ts.
 *
 *   CHALLENGE_TTL_SECONDS -> policy().MFA.PASSKEY_CHALLENGE_TTL_SECONDS
 *   MAX_PER_USER          -> policy().MFA.PASSKEYS_PER_ACCOUNT
 *
 * Both were declared in the policy AND read from here, so the configurable values
 * were inert. The reasoning for the numbers themselves moved across with them: two
 * minutes is long enough for a fingerprint prompt, a security-key touch, or hunting
 * for a phone, and short enough that a captured challenge is worthless; the per-account
 * ceiling is not a security boundary but a bound on `allowCredentials`, which ships to
 * the browser on every authentication.
 */

/**
 * Printable one-time codes, handed over when the first factor is confirmed.
 *
 * ─── Why these exist here and not in the admin service ──────────────────────
 *
 * The admin service has none, and is right not to: an admin enrols two kinds of
 * factor, so either recovers the other, and there is an IT team behind them. A
 * consumer typically enrols one authenticator on one phone. Losing it without these
 * means losing the account outright — email OTP is only the FIRST factor, so it
 * cannot let anyone back past the second.
 *
 * ─── What they are not ──────────────────────────────────────────────────────
 *
 * They satisfy the sign-in ceremony and nothing else. A recovery code must never
 * mint an elevation ticket, or a single sheet of paper would authorise removing the
 * real factor — which turns "I lost my phone" and "I stole your printout" into the
 * same event.
 */
export const RECOVERY_CODES = {
  /** MOVED: how many to print is `policy().MFA.RECOVERY_CODE_COUNT`. It was declared
   *  there and read here, so the configurable value was inert. Ten is the industry
   *  norm and lasts most people the life of the account. */

  /** Characters per code, Crockford base32 via `randomBase32`. Ten characters is
   *  50 bits — far past guessable, and the five-attempt cap bounds it anyway. */
  LENGTH: 10,
} as const;

/**
 * MOVED: the wrong-attempt cap is `policy().MFA.PROOF_ATTEMPTS` — see auth/limits.ts.
 *
 * It was `MFA.MAX_ATTEMPTS` here AND `MFA.PROOF_ATTEMPTS` there, with only this one
 * read at runtime, so the configurable value did nothing and changing it changed
 * nothing. Two live values for one decision is the state this file's own header warns
 * about; the duplicate is deleted rather than kept in sync.
 *
 * Counted on the attempt row rather than only in Redis, so the cap survives a cache
 * flush. Five against six digits is the same arithmetic as the email OTP: 5 tries
 * against 10^6, with the attempt itself expiring in ten minutes regardless.
 */
export const MFA = {
  /**
   * Refuse a second factor presented from a different device or network than the
   * first.
   *
   * ─── What this buys ────────────────────────────────────────────────────────
   *
   * The `loginId` is a bearer handle travelling in a JSON body, so it can be
   * copied. Without this check, a holder of one plus a phished code received a
   * session stamped with the ORIGINAL browser's device and network — inheriting that
   * browser's remember-me window and suppressing the new-device email, because
   * `deviceSeenBefore` was asked about the victim's device rather than theirs.
   *
   * The check now covers the WHOLE flow rather than only the second factor. The
   * handle exists from the moment the first factor opens the flow, so binding only
   * the last hop would leave the emailed-code step reachable with a copied handle
   * — which is the same defect one step earlier.
   *
   * ─── What it costs ─────────────────────────────────────────────────────────
   *
   * A user who moves between networks between entering their password and entering
   * their code is refused and must start again — wi-fi to mobile data is the real
   * case. `ipClassOf` compares a prefix rather than an address precisely so ordinary
   * movement inside one network does not trip it, and `MFA_CONTEXT_MISMATCH` is its
   * own error so a client can say which of the two things happened.
   *
   * A constant rather than a hardcoded `if`, for the same reason
   * `OAUTH.ENFORCE_IP_CLASS` is one: flip it to `false` and the check degrades to a
   * logged warning, in one line, with the signal intact.
   */
  ENFORCE_CONTEXT: true,
} as const;

/**
 * ═══ PER-ACTION RE-AUTHENTICATION ══════════════════════════════════════════
 *
 * Some writes need a fresh proof rather than merely a live session. The caller
 * proves a factor once at `POST /2fa {action:'reauth-verify'}` and receives a
 * SINGLE-USE ticket, which the write presents in the `HEADER_NAME` header.
 *
 * ─── Why a ticket rather than the credential itself ─────────────────────────
 *
 * Putting a proof in every sensitive request body would mean every DTO grows a
 * credential field and every one of them could forget to check it. A ticket keeps
 * the credential in one header, verified by one guard, and leaves payloads about
 * their own subject.
 *
 * ─── What needs one today ───────────────────────────────────────────────────
 *
 * Attaching an OAuth provider to an existing account, and changing which factors
 * exist. The first is the reason this landed: linking mints a credential that
 * outlives a password change, a session sweep and an email change, so it must not
 * be reachable with one factor — which is exactly what it used to be, riding as a
 * `linkToken` field on an ordinary login.
 */
export const ELEVATION = {
  /**
   * MOVED: how long a ticket stays spendable is
   * `policy().MFA.ELEVATION_TICKET_TTL_SECONDS`. It was declared there and read here,
   * so the configurable value was inert.
   *
   * Sixty seconds: long enough to cover the round trip between proving and writing,
   * short enough that a ticket captured from a log or a proxy is worthless by the
   * time anyone could use it. Single-use regardless — the guard reads it with
   * `take`, which deletes as it reads.
   */

  /**
   * The header a re-authenticated write presents its ticket in.
   *
   * A header, and it stays one — unlike the two flow handles, which moved into the
   * request body. The distinction is what each value identifies. `signupId` and
   * `loginId` name a FLOW, so they belong with the step that is being taken; a
   * ticket authorises one WRITE by an already-authenticated caller, and it rides
   * alongside whatever body that write happens to have rather than being a field
   * every such body has to declare.
   *
   * It is also emphatically not the `x-step-up-token` that CORS used to reserve.
   * That header was never implemented and its constants are gone; a ticket is a
   * different credential with a different holder — a fully-authenticated caller
   * with a session, not someone half way through proving who they are. One header
   * carrying both would make "which credential is this" a question the reader has
   * to answer from context, and every guard would have to reject the other kind by
   * hand. Same name as the admin service, for the same reason.
   */
  HEADER_NAME: 'x-elevation-ticket',
  /** Bytes of entropy in a ticket. It stands between a stolen access token and a
   *  write, so it is sized like the step-up secret rather than like an id. */
  TICKET_BYTES: 32,
} as const;

/**
 * The email blocklist cache.
 *
 * ─── Why this exists now, when the service argued against it ───────────────
 *
 * `BlocklistService` used to carry a comment explaining that a cache was not worth
 * it: the lookup is one indexed query against "a small table", and what a cache
 * would add is a staleness window on the one control where staleness is the whole
 * problem — an operator blocks a domain precisely because it is being abused right
 * now, and a sixty-second TTL means sixty more seconds of signups.
 *
 * The staleness objection is answered rather than accepted: invalidation is on the
 * WRITE — `BlocklistService.block` drops the cache as part of adding a rule — so a
 * newly blocked domain takes effect on the very next request. Nothing waits for a
 * TTL to notice it.
 *
 * ─── What this does NOT buy, measured ─────────────────────────────────────
 *
 * It is not a latency win, and the old comment's instinct about that was right.
 * Measured end to end on `POST /auth/register` against a local Postgres and a local
 * Redis: 33.6 ms warm versus 27.9 ms cold, over five requests each. That is noise,
 * and if anything the cache is on the wrong side of it.
 *
 * The reason is that the row count was never the problem. `findMatching` is an
 * equality probe on a unique index over at most three candidate values, so it costs
 * the same against 8,400 rules as against eighty, and the request is dominated by
 * argon2 and the other round trips either way.
 *
 * What it does buy is one fewer query per authentication attempt reaching Postgres
 * at all. That is a load argument rather than a latency one — it shows up when the
 * database is remote, pooled, or saturated, none of which is true on the machine
 * the numbers above came from. Anyone tempted to add a cache in front of another
 * indexed lookup here should read that as the caution it is.
 */
export const BLOCKLIST = {
  /**
   * How long the cached rule table lives without being invalidated.
   *
   * This is a backstop, not the freshness mechanism. Invalidation is what keeps the
   * cache correct; the TTL bounds how long a MISSED invalidation could matter — a
   * write path that forgets to invalidate costs an hour of staleness rather than
   * lasting until the next deploy. Long, because the correct case does not depend
   * on it and a short one would only mean reloading 8,400 rows more often.
   */
  TTL_SECONDS: 60 * 60,
  /** How long one process holds the rebuild guard. Just long enough to cover the
   *  load, so a crashed rebuild retries promptly rather than leaving the cache
   *  cold for a minute. */
  WARM_LOCK_SECONDS: 10,
} as const;

/**
 * MOVED: every rate limit is in `auth/limits.ts`, read through `policy()`.
 *
 * The `LIMITS` block that stood here was the second copy of the approved rate-limit
 * policy, and it disagreed with the approved table on almost every line it duplicated
 * — 20/hour registration starts per IP against 4/hour + 10/day, a 30/hour OAuth
 * callback ceiling against 10 per 15 minutes, a 1-hour login-OTP window against 15
 * minutes, ten passkey challenges per ceremony against six. All but three entries were
 * already unreferenced, so the service was enforcing the approved numbers and this file
 * was describing different ones to anyone who opened it.
 *
 * The three that were still live moved rather than being deleted, and are now bounded,
 * validated and audited like the rest:
 *
 *   CREDENTIAL_OTP_BY_ACCOUNT  -> policy().CREDENTIAL.OTP_BY_ACCOUNT
 *   PASSWORD_FORGOT_BY_EMAIL   -> policy().CREDENTIAL.SET_CODE_BY_ACCOUNT
 *   REFERRAL_CHECK             -> policy().REGISTRATION.REFERRAL_CHECK
 *
 * Nothing that meters a request belongs in this file any more. The `onError` decision
 * for each limit — deny or allow when Redis is down — stays at its call site, because
 * it depends on whether that path has a durable backstop. See `OnCacheError` in
 * redis/cache.ts.
 */

// ─── user identifiers ───────────────────────────────────────────────────────
//
// Product policy for user-owned identifiers. Here rather than in a module of its
// own because account creation lives in `services/user.service.ts` — the same
// reasoning that puts every other request-time policy value in this file.

/** Product policy for email addresses. */
export const EMAIL = {
  MIN_LENGTH: 3,
  /**
   * 254 characters — RFC 5321 Section 4.5.3.1.3 maximum length for a forward path.
   */
  MAX_LENGTH: 254,

  /**
   * How long an address released by an email change stays reserved.
   *
   * ─── What the window buys ─────────────────────────────────────────────────
   *
   * Two things, and they expire together on purpose. Nobody else may register the
   * address, so a user who changed by mistake — or whose account was taken over — can
   * still get it back. And the recovery ticket mailed to that address stays spendable,
   * which is the mechanism they get it back WITH.
   *
   * They must not be separable: a recovery window outliving the reservation would let
   * someone reclaim an address another account had meanwhile registered.
   *
   * ─── Why thirty days, and why it equals the change window ─────────────────
   *
   * Long enough to survive a holiday, which is the ordinary way someone fails to notice
   * for a fortnight. Short enough that an address is not withheld from the rest of the
   * world for a quarter.
   *
   * It is deliberately EQUAL to `EMAIL_CHANGE.CHANGE_BY_ACCOUNT`'s window in
   * auth/limits.ts, and that equality is load-bearing rather than a coincidence: with
   * one retention created per change and at most two changes per window, at most ONE
   * previous address can be live at the moment of any change. That is what makes three
   * `ChallengePurpose` values sufficient. Change one of the two numbers without the
   * other and `EmailChangeService` will refuse to start a change rather than silently
   * verify fewer addresses than the policy requires.
   *
   * Here rather than in `limits.ts` because it is not a rate limit — it is the lifetime
   * of a row, read once when the row is written.
   */
  RETENTION_DAYS: 30,

  /**
   * Bytes of entropy in a recovery token.
   *
   * Sized like the step-up secret and the elevation ticket rather than like an id: it
   * is the only thing standing between a stranger and pointing somebody else's account
   * at an address of their choosing. Mailed once, stored only as a peppered hash, and
   * spent under a compare-and-swap.
   */
  RECOVERY_TOKEN_BYTES: 32,
} as const;

/**
 * ═══ THE SECURITY COOLDOWN AFTER AN EMAIL CHANGE ════════════════════════════
 *
 * For this long after the account's active address moves, the other high-impact
 * security settings are frozen: the second factors, the recovery codes, the Payment
 * PIN and the password.
 *
 * ─── What it is actually defending ──────────────────────────────────────────
 *
 * A completed email change is the most powerful single event in this system. It moves
 * the address every other recovery path mails to, and it sweeps every session — so
 * whoever performed it signs back in against the NEW mailbox, and everything that is
 * authorised by "an emailed code plus a session" is suddenly authorised by a mailbox
 * they control. Without this window an attacker who reaches a change can, in the same
 * minute, set the password, enrol their own factor (collecting the account's first set
 * of recovery codes on the way), regenerate the codes and set a Payment PIN — after
 * which nothing the real owner still holds is worth anything.
 *
 * The freeze does not prevent the change. It buys the owner time to read the "did you
 * do this?" mail and spend the recovery ticket, which is the mechanism that undoes it.
 *
 * ─── Why twenty-four hours, and why NOT thirty days ─────────────────────────
 *
 * It is deliberately NOT `EMAIL.RETENTION_DAYS` and deliberately NOT
 * `EMAIL_CHANGE.CHANGE_BY_ACCOUNT`'s window, even though both are thirty days and
 * either would have been the shorter thing to write. Those two answer "how long may
 * nobody else register this address", and they are equal to each other for a reason
 * that has nothing to do with security freezes — see `RETENTION_DAYS`.
 *
 * Binding this to them would freeze a user's password for a month. That is worse than
 * useless: the owner who discovers a compromise is one of the people this would lock
 * out of their own remediation, and the attacker only has to wait. A day covers the
 * window in which a notification is actually read and acted on, and leaves the account
 * fully operable afterwards.
 *
 * Here rather than in `limits.ts` for `RETENTION_DAYS`' reason — it is not a rate
 * limit. Nothing is being counted; it is the lifetime of a state one column records.
 */
export const SECURITY_COOLDOWN = {
  /** How long after an email change the protected settings stay frozen. */
  AFTER_EMAIL_CHANGE_SECONDS: 24 * 60 * 60,
} as const;

/**
 * ═══ REMOVING A SOCIAL LOGIN IS DELAYED, NOT IMMEDIATE ══════════════════════
 *
 * A linked provider is a way into the account, and the request that removes one is
 * reachable by anyone holding a live session and the mailbox. So the removal is
 * announced and then waited out rather than applied: the owner gets an email naming
 * the date, and the link keeps working for the whole period. Whoever did not ask for
 * it has a week to notice, which an immediate unlink would not have given them.
 *
 * Seven days is the product's number. It is long enough that a notification sitting
 * unread over a holiday is still read in time, and short enough that someone who
 * genuinely wants the provider gone is not left explaining the wait.
 *
 * ─── Why nothing here is a deadline the sweep has to hit ────────────────────
 *
 * `unlink_at` is written once and read by a periodic sweep, so the link dies at some
 * point at or after the deadline rather than exactly on it. That looseness is
 * deliberate and safe — the delay is a notice period, not an expiry that grants
 * anything — and it is what lets the mechanism be an interval rather than a
 * scheduler this repository does not have.
 *
 * Here rather than in `limits.ts` for `RETENTION_DAYS`' reason: it is not a rate
 * limit. Nothing is counted; it is the lifetime of a state one column records.
 */
export const SOCIAL_UNLINK = {
  /** How long a requested unlink waits before it takes effect. */
  DELAY_DAYS: 7,
} as const;

/**
 * ═══ A DELETED ACCOUNT IS RECOVERABLE BEFORE IT IS PURGED ═══════════════════
 *
 * Deleting an account is the one settings action with nothing left to undo it from:
 * every other destructive change leaves the owner signed in and able to reverse it,
 * while this one ends every session it has. So the destruction is split in two. The
 * request moves `status` to `DELETED` and sweeps the sessions immediately — an account
 * the owner asked to delete must stop being usable at once, whoever asked — and the
 * data itself is not touched until `AccountPurgeSweeper` reaches the deadline.
 *
 * ─── Why the window is what makes reactivation possible at all ──────────────
 *
 * `deletedAt` stays NULL for the whole window, and that is load-bearing rather than
 * incidental. The partial unique indexes in db/sql/identity.sql are scoped
 * `WHERE deleted_at IS NULL`, so a row with it unset still HOLDS its email, username
 * and public code. Nobody else can register them, which is what guarantees a
 * reactivation inside the window can always succeed. Writing `deletedAt` at request
 * time instead would release the address the moment the request landed, and a user who
 * changed their mind on day two could find their own email already taken.
 *
 * The sweeper writes `deletedAt` at the deadline, and that single write is what makes
 * the deletion terminal: every lookup in `UserDbOperation` filters it, so the row stops
 * resolving, the indexes drop it, and the identifiers become claimable. There is no
 * path back from that state, which is why the window has to be generous enough to be
 * the only chance the owner needs.
 *
 * ─── Why thirty days ────────────────────────────────────────────────────────
 *
 * It matches `EMAIL.RETENTION_DAYS` and the username retention, and it matches them for
 * the reason stated there: long enough to survive a holiday, which is the ordinary way
 * somebody fails to notice that their account is gone. A deletion nobody asked for is
 * discovered by the owner trying to sign in, and that can easily be a fortnight later.
 *
 * Deliberately NOT `SOCIAL_UNLINK.DELAY_DAYS`. Seven days is a notice period during
 * which nothing has been taken away; this is a recovery window during which everything
 * already has been. The two numbers answer different questions and are free to differ.
 *
 * Here rather than in `limits.ts` for `RETENTION_DAYS`' reason: nothing is counted. It
 * is the lifetime of a state two columns record.
 */
export const ACCOUNT_DELETION = {
  /**
   * How long a deleted account can still be reactivated by its owner.
   *
   * The boundary is enforced server-side as `now < purgeAt` inside the reactivation's
   * conditional update, never by comparing a date the client supplied.
   */
  RECOVERY_DAYS: 30,
} as const;

/**
 * ═══ PRODUCT POLICY FOR USER-OWNED IDENTIFIERS ══════════════════════════════
 *
 * Until `src/settings/username/` landed, a username was allocated once at signup and
 * never seen again, so a single length band was all this needed. It is now a setting
 * the user changes, which adds three things: two length bands, two retention lengths,
 * and the fact that all of them are enforced against input rather than against a
 * string this service generated.
 *
 * ─── Why the minimum moved from 3 to 7, and what that does NOT do ───────────
 *
 * Seven is the product's default floor and two is what Premium buys — the whole
 * difference between the tiers. The old floor of three sat below both.
 *
 * Raising it does NOT invalidate anybody. These bind ALLOCATION and CHANGE — the two
 * paths that write a new username — and nothing reads them against a username already
 * stored. An account holding a five-character name from before keeps it, and only
 * meets the new floor if it chooses to change. The one exception is deliberate and
 * runs the other way: `UsernameComplianceService` lengthens a name that is short
 * BECAUSE Premium lapsed, which is the entitlement being withdrawn rather than a
 * policy being applied retroactively.
 *
 * ─── Why the retention pair is here and not in limits.ts ────────────────────
 *
 * `RETENTION_DAYS`' reason, one file over: nothing is being counted. These are the
 * lifetime of a row, read once when the row is written.
 */
export const USERNAME = {
  /**
   * The floor for a free account, and the length every auto-generated username must
   * clear. Raised from 3 — see above for why that renames nobody.
   */
  DEFAULT_MIN_LENGTH: 7,
  /**
   * The floor for a Premium account. Short usernames are the entitlement, so this is
   * the one number the tier actually changes.
   */
  PREMIUM_MIN_LENGTH: 2,
  MAX_LENGTH: 30,
  FALLBACK_PREFIX: "orebit",
  MAX_ALLOCATION_ATTEMPTS: 6,

  /**
   * How long the FIRST username released in a change sequence stays reserved.
   *
   * Thirty days, matching `EMAIL.RETENTION_DAYS`, and matching it on purpose: both
   * answer "how long may nobody else take this identifier", and a user who changes
   * both should not have to remember two windows.
   */
  RETENTION_DAYS: 30,
  /**
   * How long every SUBSEQUENT release stays reserved while the first is still live.
   *
   * The founder's "available again within a few minutes". Five, not zero: a released
   * username has to outlive the caches and in-flight reads that still believe the
   * account owns it, and zero would let a name be re-claimed inside the same second it
   * was given up.
   */
  RELEASE_SECONDS: 5 * 60,

  /** How many alternatives a refused availability check offers. */
  SUGGESTION_COUNT: 5,
  /** Distinct suffixes the Premium-expiry reconciler will try before giving up. */
  MAX_COMPLIANCE_ATTEMPTS: 6,
  /** Characters of random suffix appended when Premium lapses. */
  COMPLIANCE_SUFFIX_LENGTH: 5,
} as const;

export const PUBLIC_CODE = {
  PREFIX: "OREBiT",
  RANDOM_LENGTH: 8,
} as const;

export const REFERRAL = {
  CODE_LENGTH: 8,
} as const;

/**
 * ═══ THE SECURITY-RESTRICTION CLASSIFIER'S TUNING ══════════════════════════
 *
 * What counts as a "commonly used" IP or device, and how far back to look.
 *
 * ─── Why these are here and NOT Admin-configurable ────────────────────────
 *
 * The Admin configures POLICY — which features a trigger restricts, in which context,
 * for how long. These two numbers are not policy; they are the definition of the words
 * the policy is written in. Moving them into the database would mean an operator could
 * change what "commonly used" means without changing any policy, and every restriction
 * already applied would have been decided under a different definition than the one the
 * row appears to record.
 *
 * They also have no second source of truth: the policy tables do not carry them, so
 * nothing here can disagree with a stored value. That is the rule the restriction
 * policy itself follows in the other direction — Postgres is the only authority for
 * policy, and code is the only authority for these.
 *
 * `auth/limits.ts` is the precedent for a number that IS operator-tunable at runtime,
 * and the distinction is exactly this: a rate limit is a dial, a definition is not.
 */
export const RESTRICTION = {
  /**
   * How far back the classifier looks, in days.
   *
   * Thirty rather than ninety. `ip_class` is a /24 or /48, and a residential DHCP
   * lease or a carrier CGNAT pool reassigns one on a scale of days — so ninety days of
   * IP history is mostly a record of networks that no longer identify anyone, while
   * costing three times the index pages on a table that is never pruned. Device
   * history would tolerate a longer window, but a single window for all three signals
   * is one rule to reason about rather than three.
   */
  HISTORY_WINDOW_DAYS: 30,

  /**
   * Distinct calendar days a value must appear on before it counts as commonly used.
   *
   * TWO, not one and not three.
   *
   * One is disqualified by the requirement and by sense: the first sighting of a
   * device is the attack itself, so "seen before" would be satisfied by the session
   * the attacker is holding.
   *
   * Two is the weakest statement that excludes that — "used on at least one day other
   * than today". On a distinct-DAY denominator it is meaningfully stronger than it
   * sounds: it cannot be reached by using one device intensively for an afternoon, only
   * by coming back.
   *
   * What it buys is bounded and should be said plainly rather than discovered: a
   * patient attacker who signs in, waits a day and returns qualifies. Two days of
   * delay is the honest maximum claim for any rule built on session history.
   */
  COMMON_MIN_DAYS: 2,
} as const;
