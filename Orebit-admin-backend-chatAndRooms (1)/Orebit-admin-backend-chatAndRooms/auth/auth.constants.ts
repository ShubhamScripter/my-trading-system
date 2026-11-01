import type { RateLimit } from '../redis';
import { config } from '../src/config';

/**
 * Product configuration for the admin auth flow.
 *
 * This is in code rather than in `.env` on purpose. These are not deployment
 * coordinates, they are product policy — the kind of value a founder or a risk
 * team changes on a Tuesday afternoon. Env vars would make each change a deploy;
 * this file makes each change a reviewable diff, and one that a test can assert
 * against.
 *
 * Anything read at request time belongs here. Anything secret belongs in env.
 *
 * ─── The one exception, and the fence around it ────────────────────────────
 *
 * Three session clocks below accept a NON-PRODUCTION env override, because the
 * inactivity timeout is the one value here that cannot be reviewed by reading it —
 * it has to be watched, against a real frontend, and thirty minutes per attempt is
 * long enough that the honest alternative is somebody editing this file locally and
 * eventually committing it. `src/config.ts` refuses to boot if any override is set
 * in production, and `assertSessionClocksAreCoherent` below refuses a combination
 * that would produce a misleading test. Every other value in this file is code only.
 */

export const OTP = {
  /** Six digits. Short enough to retype from a phone, and the attempt cap rather
   *  than the length is what makes guessing infeasible: 5 tries against 10^6. */
  LENGTH: 6,
  TTL_SECONDS: 10 * 60,
  /** Wrong guesses allowed before the code is dead and must be re-sent. */
  MAX_ATTEMPTS: 5,
  RESEND_COOLDOWN_SECONDS: 60,
  /** Codes per login attempt. Caps the cost of one abandoned sign-in being used
   *  as a free email relay. */
  MAX_SENDS: 5,
} as const;

/** Product policy for email addresses. */
export const EMAIL = {
  MIN_LENGTH: 3,
  /**
   * 254 characters — RFC 5321 Section 4.5.3.1.3 maximum length for a forward path.
   */
  MAX_LENGTH: 254,
} as const;

/** Password policy. */
export const PASSWORD = {
  MIN_LENGTH: 8,
  /** Bound request size and keep passwords within the supported policy range. */
  MAX_LENGTH: 20,
  /** Lowercase, uppercase, digit, and special character are all required. */
  MIN_CHARACTER_CLASSES: 4,
} as const;

/**
 * ═══ AN OVERRIDE NEVER APPLIES UNDER TEST ══════════════════════════════════
 *
 * The three clocks below read a non-production env override (see the header). This
 * is the fence that keeps that knob out of the SUITE, which asserts the COMMITTED
 * policy: session.dboperation.spec.ts pins the thirty-minute window, the SQL that
 * binds it, and the worked examples derived from it.
 *
 * The fence is needed because Vitest loads `.env` into `process.env`, so a
 * developer running a one-minute window locally would otherwise turn fifteen of
 * those cases red — with failures that say nothing about whatever they were
 * actually changing. Pinning a policy value is only useful if the pin cannot be
 * moved by a local convenience.
 *
 * Gated on `NODE_ENV=test`, which tests/setup.ts assigns at top level before any
 * import of src/config.ts can run — the same mechanism every other value in the
 * suite already depends on.
 */
function localOverride(value: number | undefined): number | undefined {
  return config.isTest ? undefined : value;
}

/**
 * ═══ THE IDLE WINDOW, MEASURED FROM A STORED TIMESTAMP ═════════════════════
 *
 * The deadline is `AdminSession.lastActiveAt + INACTIVITY_TIMEOUT_SECONDS`. One
 * window, one anchor, and the anchor is a column rather than the instant a request
 * happened to arrive.
 *
 *   last_active_at 10:05 → expires 10:35
 *   last_active_at 10:10 → expires 10:40
 *
 * ═══ WHY THE FIVE-MINUTE STAGE IS GONE ═════════════════════════════════════
 *
 * This used to be TWO constants summed into one 35-minute window: a five-minute
 * grace, then a thirty-minute timer. That reading is superseded. The five minutes
 * are now `ACTIVITY_WRITE_INTERVAL_SECONDS` — how often the activity column is
 * WRITTEN — and the requirement is explicit that a write optimisation must not
 * become extra idle time. So `35 * 60` became `30 * 60`, measured from the stored
 * value rather than from now.
 *
 * The consequence, stated rather than discovered: because the column lags real
 * activity by up to the write interval, an admin working continuously has an
 * effective window of 25-30 minutes rather than 35. Expiring EARLY is the safe
 * direction — the alternative is the compounding the requirement forbids.
 *
 * Declared here rather than inside `SESSION` because that is a single `as const`
 * object literal, and an entry in one cannot reference another.
 */
const INACTIVITY_TIMEOUT_SECONDS = localOverride(config.SESSION_IDLE_SECONDS) ?? 30 * 60;

/** See `ACTIVITY_WRITE_INTERVAL_SECONDS` below for what this is and is not. */
const ACTIVITY_WRITE_INTERVAL_SECONDS =
  localOverride(config.SESSION_ACTIVITY_WRITE_INTERVAL_SECONDS) ?? 5 * 60;

/** See `ACCESS_TTL_SECONDS` below. Hoisted for the same reason as the timeout: an
 *  entry in a single `as const` literal cannot reference another. */
const ACCESS_TTL_SECONDS = localOverride(config.SESSION_ACCESS_TTL_SECONDS) ?? 15 * 60;

/** The ceiling. Deliberately NOT overridable — twelve hours is short enough to sit
 *  through in a test if anyone ever needs to, and it is the one clock whose whole
 *  purpose is that nothing moves it. */
const ABSOLUTE_TTL_SECONDS = 12 * 60 * 60;

/**
 * ═══ THREE CLOCKS THAT ONLY WORK IN RELATION TO EACH OTHER ═════════════════
 *
 * Asserted at import, so a bad combination is a boot failure rather than a strange
 * afternoon. The values are constants in every deployment and overridable only
 * outside production, which means this can only ever fire for a developer who has
 * just set one — exactly when the explanation is worth reading.
 *
 *   access < idle       below the idle window there is nothing left to refresh: the
 *                       access token would outlive the session it belongs to, and
 *                       the rotation path — the one this backend now drives itself —
 *                       would never be exercised at all.
 *
 *   idle < absolute     above the ceiling the sliding clock makes the ceiling
 *                       unreachable, and the twelve-hour re-authentication that the
 *                       three-factor ceremony exists to force never happens.
 *
 *   write ≤ idle / 2    THE ONE THAT IS NOT OBVIOUS, and the reason this function
 *                       exists rather than being left to tests/auth/jwt.spec.ts,
 *                       which already pins the first two.
 *
 *                       `SessionDbOperation.touch` only writes when the row is older
 *                       than the write interval, so `last_active_at` lags real
 *                       activity by up to that much and the effective window for a
 *                       continuously-working admin is `idle - write`. Shorten the
 *                       idle window alone — the obvious edit, and the one anybody
 *                       reaching for these overrides will try first — and the
 *                       interval ends up ABOVE it: `touch` can then never fire
 *                       before `expires_at` passes, so the session dies on schedule
 *                       no matter how active the admin is.
 *
 *                       That failure is invisible in the shape a tester is looking
 *                       at. The logout happens, on time, and looks correct — while
 *                       the half most worth testing, that activity extends the
 *                       session, has silently stopped working. Halving is the bound
 *                       that keeps at least half the window intact; production sits
 *                       at a sixth.
 */
function assertSessionClocksAreCoherent(): void {
  const problems: string[] = [];

  if (ACCESS_TTL_SECONDS >= INACTIVITY_TIMEOUT_SECONDS) {
    problems.push(
      `  SESSION_ACCESS_TTL_SECONDS (${ACCESS_TTL_SECONDS}) must be below the idle window` +
        ` (${INACTIVITY_TIMEOUT_SECONDS}), or an access token outlives its own session`,
    );
  }

  if (INACTIVITY_TIMEOUT_SECONDS >= ABSOLUTE_TTL_SECONDS) {
    problems.push(
      `  SESSION_IDLE_SECONDS (${INACTIVITY_TIMEOUT_SECONDS}) must be below the absolute` +
        ` ceiling (${ABSOLUTE_TTL_SECONDS}), or the ceiling can never be reached`,
    );
  }

  if (ACTIVITY_WRITE_INTERVAL_SECONDS * 2 > INACTIVITY_TIMEOUT_SECONDS) {
    problems.push(
      `  SESSION_ACTIVITY_WRITE_INTERVAL_SECONDS (${ACTIVITY_WRITE_INTERVAL_SECONDS}) must be at` +
        ` most half the idle window (${INACTIVITY_TIMEOUT_SECONDS}), or activity is written too` +
        ` rarely to extend the session and an active admin is logged out anyway`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Incoherent session clocks:\n${problems.join('\n')}`);
  }
}

assertSessionClocksAreCoherent();

export const SESSION = {
  ACCESS_TTL_SECONDS,
  /**
   * ═══ TWO CLOCKS, AND ONLY ONE OF THEM SLIDES ═══════════════════════════════
   *
   * Twelve hours against thirty days on the consumer backend. The whole point of
   * the three-factor ceremony is that reaching an admin session is expensive. A
   * thirty-day refresh token would undo that: a stolen one buys a month of access
   * without ever presenting a password, an email code or a second factor. Twelve
   * hours means at most one working day, and an admin signs in again the next
   * morning — a cost this population can carry and a consumer population could not.
   *
   * Twelve hours PER REFRESH, however, is not twelve hours. That was the bug: every
   * rotation set `expiresAt = now + 12h`, so a panel left open in a tab — or any
   * client refreshing on a timer, which is every well-behaved one — pushed the wall
   * forward faster than it approached. The three-factor ceremony was nominally a
   * daily cost and actually a once-ever cost, which is the opposite of the design.
   *
   * So the lifetime is two clocks:
   *
   *   ABSOLUTE_TTL_SECONDS  the immutable ceiling, stamped ONCE into
   *                         `AdminSession.reauthenticateAt` by the three-factor
   *                         sign-in and copied byte-for-byte into every child
   *                         generation. Nothing recomputes it, so no sequence of
   *                         refreshes can move it. Reaching it means the full
   *                         ceremony again: password + email OTP + MFA.
   *
   *   INACTIVITY_TIMEOUT_SECONDS
   *                         the sliding window, and the only one ACTIVITY extends.
   *                         `SessionDbOperation.touch` sets `lastActiveAt = now()`
   *                         and `expiresAt = min(lastActiveAt + this,
   *                         reauthenticateAt)` on an eligible request — so an
   *                         abandoned session dies thirty minutes later, and an
   *                         active one still cannot outlive the ceiling.
   *
   * A REFRESH extends neither. `rotate` copies the parent's `expiresAt` AND its
   * `lastActiveAt` verbatim, because a token the backend renews on its own schedule
   * is not the admin doing something — see the note on `rotate` in
   * services/session.service.ts. It used to recompute the deadline here, which meant
   * background refresh was the only thing keeping a session alive; that is the bug
   * the split fixed.
   *
   * Thirty minutes is comfortably longer than the fifteen-minute access token, so an
   * admin actually working never meets it. It is short enough that a browser closed
   * without logging out stops being a live session within the hour.
   */
  ABSOLUTE_TTL_SECONDS,
  /**
   * The idle window, measured from `AdminSession.lastActiveAt`.
   *
   * Its two readers (`SessionService.issue` and `SessionDbOperation.touch`) consume
   * this same constant, so they cannot drift out of agreement about what the window
   * is. `tests/auth/persistence/session.dboperation.spec.ts` asserts the SQL binds
   * this exact value, which is what would catch a partial change.
   *
   * Must stay strictly between `ACCESS_TTL_SECONDS` and `ABSOLUTE_TTL_SECONDS`, both
   * pinned by tests/auth/jwt.spec.ts: below the access token there would be nothing to
   * refresh, and above the ceiling the sliding clock would make the ceiling
   * unreachable.
   */
  INACTIVITY_TIMEOUT_SECONDS,
  /** How long a revoked session id is remembered in the cache. Exactly the access
   *  token's lifetime — past that the token is expired anyway, so remembering the
   *  revocation longer buys nothing. Bound to the constant rather than repeating its
   *  value, so that equality stays true when the access TTL is shortened locally. */
  REVOCATION_CACHE_SECONDS: ACCESS_TTL_SECONDS,

  /**
   * ═══ MINIMUM GAP BETWEEN ACTIVITY WRITES FOR ONE SESSION ═══════════════════
   *
   * A write optimisation, and ONLY that. It is not grace, it is not a second
   * deadline, and it must never be added to `INACTIVITY_TIMEOUT_SECONDS` — the
   * deadline is `lastActiveAt + timeout`, full stop. See the header of this file for
   * why the old five-minute stage is gone.
   *
   * Without it every authenticated request would UPDATE the same row, turning a
   * read-mostly table into a write-per-request one. With it there is roughly one
   * write per five minutes per active session.
   *
   * ─── Enforced by the DATABASE, not by a cache ─────────────────────────────
   *
   * This value is bound into `touch`'s WHERE clause, so the row itself decides
   * whether a write is due. That is what makes concurrent requests safe without a
   * lock, and it replaced a Redis cooldown that could suppress a write the database
   * would have allowed — see `SessionDbOperation.touch`.
   *
   * The cost is that `lastActiveAt` lags real activity by up to this much, so a
   * session can expire up to five minutes earlier than the admin's true last
   * request. Early is the safe direction.
   */
  ACTIVITY_WRITE_INTERVAL_SECONDS,

  /**
   * ═══ HOW EARLY A STORED ACCESS TOKEN IS REPLACED ═══════════════════════════
   *
   * The browser no longer refreshes; the backend does it mid-request, on the
   * browser's behalf. So this is not a client's polling interval — it is the margin
   * that keeps a refresh from racing the expiry it exists to prevent.
   *
   * Thirty seconds does two jobs. It covers the round trip of a rotation (a
   * transaction plus two signatures) so a token is never handed to `verifyAccessToken`
   * after expiring in flight. And it is what makes the lock below cheap: a request
   * that cannot get the lock still holds a token valid for up to thirty more seconds,
   * so it proceeds on that rather than waiting — see `resolve` in
   * security/bff.session.ts.
   */
  ACCESS_REFRESH_SKEW_SECONDS: 30,

  /**
   * How long one session's refresh may hold its lock.
   *
   * ─── Why a lock at all, when the database already has a CAS ────────────────
   *
   * `SessionDbOperation.rotate` is a compare-and-swap, and redis/lock.ts's own
   * header argues — correctly, for every caller it had in mind — that this makes a
   * lock unnecessary. It does not apply here, and the reason is worth spelling out
   * because the cheaper version looks right.
   *
   * `SessionDbOperation.rotate` is a compare-and-swap, and redis/lock.ts's own header
   * argues that a CAS makes a lock unnecessary. The lock is still here because
   * concurrent requests on one session reach `rotate` ROUTINELY under the BFF —
   * refresh is automatic and unprompted — and letting them race costs a wasted
   * transaction and a noisy log line each time.
   *
   * ═══ WHAT THIS TTL DOES NOT BOUND, AND WHY THAT IS NOW SAFE ════════════════
   *
   * This comment used to read "comfortably longer than a transaction plus two
   * signatures". That is true of the MEDIAN — about a millisecond locally, about
   * forty under a pessimistic model of a remote database — and false of the BOUND.
   * `rotate`'s own transaction is configured at `maxWait: 5_000` + `timeout: 10_000`,
   * and contains two statements that can each wait `lock_timeout = 3s`. Fifteen
   * seconds against five.
   *
   * So the lock CAN lapse mid-rotation and a second owner CAN appear. That was F10,
   * and its blast radius was a revoked family: the loser of the resulting CAS went
   * straight to `handleReuse`, so ordinary slowness — a logout holding the family row,
   * pool contention — signed the admin out and logged credential theft.
   *
   * It is deliberately NOT fixed by raising this number. Raising it above the bound
   * would mean a holder killed mid-rotation blocks every refresh on that session for
   * the full TTL, and every waiter (bounded at `REFRESH_WAIT_MS`) answering 503 for
   * that whole time — trading a benign path for a worse outage. Instead the CAS loser
   * REPAIRS: the database already guarantees exactly one child, so the loser looks at
   * what committed rather than assuming theft. See `SessionService.recoverRotation`
   * and `ROTATION_RECOVERY_WINDOW_SECONDS`.
   *
   * Five seconds, then, for what it is actually good for: long enough that the common
   * case is single-flight, short enough that a dead holder blocks nothing for long.
   * The relationship between this and the rotation bound is asserted in
   * tests/auth/security/bff.lock.spec.ts, so neither can drift silently again.
   */
  REFRESH_LOCK_SECONDS: 5,

  /**
   * ═══ HOW LONG A REQUEST WAITS FOR SOMEONE ELSE'S REFRESH ═══════════════════
   *
   * Only one request may rotate — the refresh token is one-use — so the others have
   * to be told the answer rather than turned away. This is how long they will wait
   * to be told before giving up.
   *
   * It used to be zero: a single re-read, no wait, and a 401 if the holder had not
   * finished. That signed out admins whose sessions were in perfect health, on a race
   * whose window is the length of one database transaction.
   *
   * ─── Why one second ────────────────────────────────────────────────────────
   *
   * Measured, not guessed. The whole refresh critical path — verify the refresh JWT,
   * load the row, run the rotation transaction, re-read the admin, sign two ES256
   * tokens, write the Redis record — is about 1 ms against a local Postgres, and
   * about 40 ms under a pessimistic model of a remote one (5 ms round trip, eight
   * round trips). A second is ~25x the pessimistic case.
   *
   * It deliberately does NOT cover the pathological case where the rotation blocks on
   * the session family's row lock for up to its own `lock_timeout` of 3 s. That only
   * happens when a logout holds that lock — in which case the refresh is about to
   * fail anyway, and a transient refusal followed by a clean `session_revoked` is the
   * right sequence rather than a long stall.
   *
   * ─── Why it must stay under REFRESH_LOCK_SECONDS ───────────────────────────
   *
   * A waiter that outlived the lock would be waiting on a holder that no longer
   * exists — the lock's TTL having already released it to someone else — so its
   * patience would buy nothing. Pinned by a test.
   *
   * The wait is a BOUNDED BACKOFF, not a poll: roughly 25/50/100/200/400 ms, so at
   * most a handful of reads, and in the ordinary case exactly one — the holder
   * finishes in about a millisecond, so the first check already finds the answer.
   * That is what answers the objection the old single-re-read design was built on,
   * which was that a waiting request thread is how a pool gets exhausted.
   */
  REFRESH_WAIT_MS: 1000,

  /**
   * ═══ HOW LONG AN INTERRUPTED ROTATION STAYS REPAIRABLE ═════════════════════
   *
   * A rotation commits in PostgreSQL and is then published to the Redis BFF record.
   * When that publication is interrupted, the durable store has moved on and the
   * cache has not: the record still names the PARENT generation and holds its
   * already-spent refresh token. Presenting that token used to read as theft, so a
   * single dropped cache write revoked the whole family and logged a false
   * credential-theft warning.
   *
   * This is how long the repair window stays open — measured from the parent's
   * `rotated_at`, so it is the age of the interrupted rotation and not of anything a
   * caller controls.
   *
   * ─── Why two minutes ──────────────────────────────────────────────────────
   *
   * Long enough that the retry which follows a `503` recovers, and that an admin who
   * comes back to a tab a minute later does too. Short enough that the window is a
   * window rather than a policy.
   *
   * ─── It is the tunable, NOT the guarantee ─────────────────────────────────
   *
   * Two other bounds close the repair path independently of this one, which is why
   * the exact value is not load-bearing:
   *
   *   parent-of-tip   recovery requires the presented generation to be the IMMEDIATE
   *                   parent of the family's live tip. One further rotation and it
   *                   stops matching, whatever this constant says.
   *   idle deadline   the tip's own `expires_at` must still be in the future. A gap
   *                   longer than the inactivity timeout ends the session on its own,
   *                   and the answer is `token_expired` rather than a repair.
   *
   * So shortening this only makes an interrupted publication less forgiving. It
   * cannot make it less safe, and lengthening it cannot outlive the idle deadline.
   */
  ROTATION_RECOVERY_WINDOW_SECONDS: 120,

  /**
   * ═══ THE BROWSER HOLDS AN OPAQUE HANDLE, NOT A TOKEN ═══════════════════════
   *
   * This cookie used to carry the refresh JWT itself, under the name
   * `orebit_admin_refresh`. It now carries a random handle that names a server-side
   * record holding BOTH tokens — see auth/security/bff.session.ts.
   *
   * ─── What that changes, and what it does not ───────────────────────────────
   *
   * It does not change the token model. The access JWT is still what authenticates
   * a request, `verifyAccessToken` still verifies it, `assertLive` still checks the
   * session row, and `SessionService.rotate` still rotates a refresh token against
   * the same family and the same reuse detection. All of that now happens on the
   * server's side of the boundary instead of the browser's.
   *
   * What it changes is what a compromised page can read. httpOnly already kept
   * script away from the refresh token; the ACCESS token was in the response body
   * and therefore in JavaScript by necessity, because it had to go in an
   * `Authorization` header. A handle needs no header, so nothing has to be readable
   * any more, and an XSS on the panel steals a value that is useless off-origin.
   *
   * ─── Why the path is NO LONGER narrow ─────────────────────────────────────
   *
   * `/auth/session` was correct while exactly one route read this cookie. Now every
   * route authenticates from it, so it must be sent on every route: `'/'`.
   *
   * That widening is what makes `CSRF` below mandatory rather than belt-and-braces.
   * A root-scoped ambient credential means every mutating route is a
   * cookie-authenticated state change, so the token is checked for every unsafe
   * method rather than on one endpoint — see `assertCsrf` in security/guards.ts.
   *
   * ─── Why `lax` and not `strict` ────────────────────────────────────────────
   *
   * `strict` withholds the cookie on any cross-site request INCLUDING top-level
   * navigation, so an admin arriving at the panel from a link or a redirect would
   * find their session apparently gone until they navigated once more. `lax` still
   * withholds it from cross-site POSTs, which is the shape a CSRF attempt takes.
   *
   * `lax` alone is not the CSRF defence — it is defence in depth behind the token.
   */
  COOKIE_NAME: 'orebit_admin_session',
  COOKIE_PATH: '/',
  /**
   * Bytes of entropy in the handle. 32, matching `STEP_UP.SECRET_BYTES`, because it
   * is the same class of value: the only thing standing between a stranger and a
   * live admin session. base64url of 32 bytes is 43 characters.
   *
   * It is not hashed at rest. Unlike `stepUpSecretHash` there is no database row to
   * protect — the handle IS the Redis key, and a key cannot be looked up by its own
   * digest without storing the digest instead, which just renames the problem. What
   * the record protects is its CONTENTS; see `BFF_SESSION_KEY` in src/config.ts.
   */
  HANDLE_BYTES: 32,
} as const;

/**
 * ═══ CSRF, FOR EVERY ROUTE THAT MUTATES ════════════════════════════════════
 *
 * Authenticating from a root-scoped cookie makes EVERY mutating route a
 * cookie-authenticated state change — the browser now attaches the credential
 * without the page asking — so each one needs a token the attacker's page cannot
 * read. Doing the cookie half without this half would trade an XSS exposure for a
 * CSRF exposure, which is not an improvement.
 *
 * This used to guard one route, because one route read a cookie. The check moved to
 * `authenticate()` in security/guards.ts when the cookie went root-scoped: one place
 * that runs for every unsafe method, which is the only arrangement a new controller
 * cannot forget to opt into.
 *
 * ─── Double-submit, and why that is enough here ────────────────────────────
 *
 * The value is set in a NON-httpOnly cookie and echoed in a header. An attacker's
 * page can cause the cookie to be sent but cannot read it to populate the header,
 * because reading it cross-origin is what the same-origin policy forbids. The
 * server just checks the two match.
 *
 * The usual objection to double-submit is that it falls to an attacker who can
 * write cookies for the site — a subdomain XSS, say. That is a real limitation and
 * it is bounded here: the cookie is `Secure` in production so it cannot be
 * injected over plaintext, `ADMIN_APP_URL` is a single origin, and the alternative
 * — a server-side synchroniser token — needs per-session server state for a route
 * that already has a signed token in it.
 *
 * Deliberately NOT httpOnly. The page has to read this one to send it back; that
 * is the entire mechanism. It is not a credential on its own — it authorises
 * nothing and proves only that the request came from a page on our origin.
 */
export const CSRF = {
  COOKIE_NAME: 'orebit_admin_csrf',
  HEADER_NAME: 'x-csrf-token',
  /** Matches the session cookie's scope exactly — the two are set and cleared
   *  together, and a CSRF cookie sent on fewer routes than the credential it guards
   *  would fail the check on requests that should have succeeded. */
  COOKIE_PATH: '/',
  /**
   * The random half of the token, before the signature is appended.
   *
   * The token is `nonce.HMAC(pepper, nonce:handle)` — see `generateCsrfToken` in
   * auth.utility.ts for why it is signed rather than a bare random value. The nonce
   * is what makes two tokens issued for the same handle differ; the signature is
   * what makes a token nobody issued unusable.
   */
  NONCE_BYTES: 32,
} as const;

/**
 * The partially-authenticated login attempt.
 *
 * The value that identifies it is the one thing standing between a stranger who
 * has stolen a password and a stranger who has stolen a session, so it is
 * treated like a credential: high entropy, short-lived, hashed at rest, and
 * nulled the moment it is spent.
 *
 * ─── It travels in the body now, as `loginId` ──────────────────────────────
 *
 * `COOKIE_NAME`, `COOKIE_PATH` and `HEADER_NAME` used to live here. They are gone
 * with `security/stepup.cookie.ts`: `POST /auth/login` returns the value as
 * `loginId` and every later step sends it back in the request body. The argument
 * for and against that move is on `loginIdSchema` in dto/common.dto.ts.
 *
 * What stays here is what was never about transport — how long the ceremony may
 * take, and how much entropy the value carries.
 */
export const STEP_UP = {
  /**
   * How long the whole ceremony may take, from password to second factor.
   *
   * Ten minutes is comfortably longer than reading an email and opening an
   * authenticator app, and short enough that an abandoned attempt is not a
   * half-open door left standing. It deliberately outlives the OTP's own TTL by
   * nothing — a code that expires with two minutes left on the attempt can still
   * be resent within it.
   */
  TTL_SECONDS: 10 * 60,
  /**
   * Bytes of entropy in the secret. 32 is far past guessable, and this value is
   * the only thing standing between a stranger and a half-authenticated admin
   * sign-in.
   *
   * `loginIdSchema` derives its expected length from this number rather than
   * hard-coding 43, so changing it here cannot leave the parser validating the old
   * width.
   */
  SECRET_BYTES: 32,
} as const;

/**
 * ═══ THE BROWSER'S OWN RATE-LIMIT BUCKET ═══════════════════════════════════
 *
 * An opaque id for the client, so `POST /auth/login` can meter per BROWSER and not
 * only per account and per IP.
 *
 * ─── What this is NOT ──────────────────────────────────────────────────────
 *
 * It is not a credential and it is not an attacker bound. Anyone can clear a
 * cookie, and clearing it yields a fresh bucket — so an attacker grinding passwords
 * is stopped by `LOGIN_FAILURE_BY_IP` and the durable per-account counter exactly as
 * they would be without this, and nothing here should be read as tightening that.
 *
 * ─── What it IS, which is worth having on its own ──────────────────────────
 *
 * The other login buckets are SHARED, and none of them can say which client spent
 * them. That leaves two real failures, neither of them exotic:
 *
 *   the account   `LOCKOUT.MAX_FAILED_ATTEMPTS` is 10 consecutive failures, and it
 *                 is DURABLE and ESCALATING — ten costs an hour, and a second lock
 *                 inside the strike memory suspends the account until a super admin
 *                 rules on it. So one browser looping on a stale saved password can
 *                 walk an admin all the way into a manual review. The admin did
 *                 nothing; a background tab did it to them.
 *   the office    `LOGIN_FAILURE_BY_IP` is 8 across every admin behind one egress.
 *                 One client burning it locks out the colleagues sharing that IP.
 *
 * A per-device bucket charged FIRST bounds what one client can take out of either:
 * at six it is refused before it spends a slot in the shared IP bucket, and well
 * before it reaches the account's ten. The ceilings are unchanged; what changes is
 * that one browser can no longer reach them alone. This is the same composition
 * `reauthBySession` has under the per-admin bucket — a tighter inner limit whose job
 * is to stop one caller draining a shared outer one.
 *
 * ─── It meters FAILURES, not attempts ──────────────────────────────────────
 *
 * This bucket was originally charged on every password attempt, alongside per-email
 * and per-IP buckets that were too. Those were replaced by failure-only counters, and
 * this one moved with them; `LOGIN_FAILURE_BY_DEVICE` carries the full argument. The
 * short version: what it guards against counts consecutive FAILURES, so failures were
 * always the only attempts relevant to it, and charging successes only meant refusing
 * an admin who signed in seven times in a quarter of an hour.
 *
 * ─── Why a random value rather than `deviceFingerprintOf` ──────────────────
 *
 * There is already a device fingerprint on `ClientContext`, and it is deliberately
 * unfit for this: it is derived from `User-Agent` + `Accept-Language`, so it is both
 * forgeable and COLLIDING — every admin on the same browser build shares one value.
 * Keying a limiter on it would put a whole office in one bucket, which is the
 * problem this is meant to solve, and would let anyone spend a colleague's budget by
 * copying two headers. It stays what its docblock says it is: a risk signal that
 * never gates access.
 *
 * A random id has neither property. It cannot be guessed, so no one can pin another
 * browser to an exhausted bucket, and it cannot collide, so two clients are never
 * accidentally metered as one.
 *
 * ─── Taken from the consumer backend, with three deliberate differences ────
 *
 * `../Orebit-backend` already has this cookie — same name shape, same 32-byte
 * base64url value, same mint-on-first-use, same "validated so a hand-edited cookie
 * cannot inject an arbitrary grouping key". It is reused rather than reinvented, and
 * `deviceCookie` in security/device.cookie.ts keeps its signature.
 *
 * What differs here, and why:
 *
 *   name      `orebit_admin_device`, not `orebit_device`. Every cookie in this
 *             service is `orebit_admin_*`, and the two services can be served from
 *             one parent domain — sharing a cookie name across them would have one
 *             overwrite the other's.
 *   path      `/auth/login`, not `/auth`. There it groups a browser's sessions and
 *             is needed wherever sessions are minted; here exactly one rate limiter
 *             reads it, so it follows the refresh cookie's precedent of scoping to
 *             the route that uses it.
 *   sameSite  `strict`, not `lax`, matching `STEP_UP` for its reason: the consumer
 *             flow has an OAuth redirect to survive and this one has no third-party
 *             redirect at all, so there is nothing to accommodate.
 *
 * The PURPOSE differs too, and that is worth being explicit about: there it groups
 * tabs so one logout can revoke them together, here it is a rate-limit bucket.
 * Neither authenticates anything, which is what makes one value fit both jobs.
 */
export const DEVICE = {
  COOKIE_NAME: 'orebit_admin_device',
  COOKIE_PATH: '/auth/login',
  /** 32 bytes, base64url — 43 characters. The consumer backend's size, kept so the
   *  two services issue the same shape; far past guessable either way. */
  ID_BYTES: 32,
  /**
   * A year, as on the consumer side. Long on purpose: a bucket that resets whenever
   * the cookie expires is a bucket an honest client loses track of, and there is
   * nothing sensitive to age out — the value names a browser and proves nothing
   * about it.
   */
  MAX_AGE_SECONDS: 365 * 24 * 60 * 60,
} as const;

/**
 * TOTP, per RFC 6238.
 *
 * ═══ `WINDOW: 0` — THE CURRENT STEP AND NOTHING ELSE ═══════════════════════
 *
 * A code is accepted only while the authenticator is still displaying it. The
 * instant the app rolls over to the next code, the previous one is refused:
 *
 *   current step   → ACCEPT
 *   previous step  → REJECT
 *   next step      → REJECT
 *
 * There is NO grace period for an expired code, and that is a product decision
 * rather than a default we inherited.
 *
 * ─── What this replaced, and why the old reasoning does not survive ─────────
 *
 * This was `WINDOW: 1`, which accepted the immediately preceding and following
 * steps to absorb clock skew between the server and the phone. RFC 6238 §5.2
 * permits that, and the argument for it was honest: a code typed slowly, or a
 * handset a few seconds out, still works.
 *
 * The cost was that ONE code was arithmetically valid across three steps — 90
 * seconds of wall clock, 30 of them after the authenticator had already replaced
 * it. `claimTotpStep` bounded the damage to a single use, but a code observed
 * over a shoulder or off a shared screen and never submitted by its owner stayed
 * spendable for up to a minute and a half. For a surface where every factor
 * proof authorises an admin session or a write, the 30 seconds of skew comfort
 * were not worth the 60 seconds of extra exposure.
 *
 * ═══ THIS MAKES THE SERVER CLOCK AN OPERATIONAL DEPENDENCY ═════════════════
 *
 * Stated plainly because it is the real cost of the change, and because the
 * tempting fix for it is the thing that must not happen.
 *
 * With no window there is nothing left to absorb a drifting clock. A server
 * running more than a few seconds off will refuse correct codes from correctly
 * synchronised phones — and it will do so intermittently, worst near a step
 * boundary, which is the hardest shape to diagnose from a support ticket.
 *
 * So the host must run NTP (`systemd-timesyncd`, `chrony`, or the platform's own
 * time service; every managed container runtime supplies one). If codes start
 * being refused in bulk, CHECK THE CLOCK — do not reintroduce a window. A
 * verification window cannot fix a broken clock, it can only hide one while
 * widening every code's lifetime for every admin. See the README's
 * load-bearing-rules section.
 */
export const TOTP = {
  STEP_SECONDS: 30,
  DIGITS: 6,
  /**
   * Steps accepted either side of the current one. ZERO — see the header.
   *
   * Kept as a named constant rather than inlined so the policy lives in exactly
   * one place and `tests/auth/totp.spec.ts` can pin it. Raising it is a security
   * change, not a tuning knob: every step added extends every code's life by 30
   * seconds in each direction and multiplies the guess surface to match.
   */
  WINDOW: 0,
  /** Bytes in a generated secret. 20 is the SHA-1 block size RFC 4226 assumes,
   *  and what every authenticator app expects. */
  SECRET_BYTES: 20,
  /** Shown in the authenticator app's account list. */
  ISSUER: 'OREBiT Admin',
} as const;

export const PASSKEY = {
  /**
   * How long a WebAuthn challenge stays valid.
   *
   * Two minutes: long enough for a fingerprint prompt, a security-key touch, or
   * hunting for a phone, and short enough that a captured challenge is worthless
   * by the time anyone could use it. Single-use regardless — the challenge is
   * read with `take`, which deletes as it reads.
   */
  CHALLENGE_TTL_SECONDS: 2 * 60,
  /** Ceiling on how many passkeys one admin may register. Not a security
   *  boundary — a bound on `allowCredentials`, which ships to the browser on
   *  every authentication. */
  MAX_PER_ADMIN: 10,
} as const;

/**
 * How many wrong second-factor attempts one login attempt may make.
 *
 * Counted on the `AdminLoginAttempt` row rather than only in Redis, so the cap
 * survives a cache flush. Five against a six-digit TOTP is the same arithmetic as
 * the email OTP: 5 tries against 10^6, with the attempt itself expiring in ten
 * minutes regardless.
 */
export const MFA = {
  MAX_ATTEMPTS: 5,

  /**
   * ═══ HOW LONG A PENDING TOTP ENROLLMENT STAYS COMPLETABLE ══════════════════
   *
   * An unconfirmed `AdminTotpFactor` row is a ceremony in progress: a secret the
   * server generated, showed once as a QR code, and is waiting to see proved. It
   * had no expiry at all, and that is half of F06.
   *
   * The row has no `expiresAt` column and does not need one — `createdAt` is the
   * ceremony's start instant, so the deadline is `createdAt + this`, computed by
   * the two readers. Nothing is stored that could disagree with it.
   *
   * ─── Why an expiry is a security property and not housekeeping ─────────────
   *
   * `totp-confirm` requires only a bearer, so without a deadline a secret minted
   * in one session stays confirmable from any later session of that admin,
   * forever. That is an indefinitely valid path to replacing the account's second
   * factor using a secret chosen at a moment nobody remembers. Fifteen minutes
   * makes it a ceremony; unbounded made it a latent credential.
   *
   * ─── Why fifteen minutes, and why it MUST exceed STEP_UP.TTL_SECONDS ───────
   *
   * Long enough to scan a QR code, install an app, and type a six-digit number
   * without the ceremony dying under someone who is simply being careful.
   *
   * And strictly greater than `STEP_UP.TTL_SECONDS` (ten minutes), which is the
   * hard requirement rather than the comfort one. The sign-in enrollment path
   * creates a pending row at `totp-enroll` and proves it at `totp-verify`, both
   * inside one login attempt — so if this were the shorter of the two, a login
   * attempt could outlive the enrollment it is carrying and an admin enrolling for
   * the first time would be refused by a deadline they could not see. Lower this
   * below ten minutes and that becomes a lockout on the first-run path.
   */
  ENROLLMENT_TTL_SECONDS: 15 * 60,
} as const;

/**
 * ═══ PER-ACTION RE-AUTHENTICATION ══════════════════════════════════════════
 *
 * Every mutating request in the admin panel must carry a fresh second-factor
 * proof. The proof is not sent with the mutation itself — the admin proves once at
 * `POST /2fa {action:'reauth-verify'}` and receives a SINGLE-USE ticket, which the
 * mutation presents in the `X-Elevation-Ticket` header.
 *
 * ─── Why a ticket rather than the assertion itself ──────────────────────────
 *
 * Putting a WebAuthn assertion in every mutation body would mean every DTO in
 * every future admin module grows a credential field, and every one of them could
 * forget to check it. A ticket keeps the credential in one header, verified by one
 * guard, and leaves mutation payloads about their own subject.
 *
 * ─── Why passkeys are the intended factor ───────────────────────────────────
 *
 * `claimTotpStep` lets a TOTP step be claimed exactly once, and an authenticator
 * emits new digits only every 30 seconds — so per-mutation TOTP caps the product
 * at one save per half minute. A passkey assertion signs a fresh challenge every
 * time and has no such ceiling. TOTP is still ACCEPTED here, but only so an admin
 * who has not yet enrolled a passkey can reach the action that enrolls one.
 */
export const ELEVATION = {
  /**
   * How long a ticket stays spendable.
   *
   * Sixty seconds: long enough to cover the round trip between proving and saving,
   * short enough that a ticket captured from a log or a proxy is worthless by the
   * time anyone could use it. Single-use regardless — the guard reads it with
   * `take`, which deletes as it reads.
   */
  TICKET_TTL_SECONDS: 60,
  /** The header a mutating request presents its ticket in. */
  HEADER_NAME: 'x-elevation-ticket',
  /** Bytes of entropy in a ticket. It stands between a stolen access token and a
   *  write, so it is sized like the step-up secret rather than like an id. */
  TICKET_BYTES: 32,
} as const;

/**
 * ═══ THE LOCKOUT LADDER ════════════════════════════════════════════════════
 *
 * Two rungs and a memory, rather than one flat wait.
 *
 * The flat version — ten wrong passwords, fifteen minutes, repeat forever — bounds
 * the RATE of guessing and nothing else. An attacker who is willing to wait simply
 * waits: ninety-six lockouts a day, a thousand guesses, indefinitely, and nobody is
 * ever told. The account's own history is erased between attempts because
 * `failedAttempts` resets to zero as each lock is applied.
 *
 * So the second lock is a different event from the first:
 *
 *   1st lock   ten consecutive wrong passwords → one hour. A wait, not a decision.
 *              This is the branch a real admin who forgot their password reaches,
 *              and an hour is a cost they can absorb without anyone being paged.
 *   2nd lock   ten more, inside STRIKE_MEMORY_SECONDS → the account comes OUT OF
 *              SERVICE and a human decides. No wait restores it. Every session is
 *              revoked, every in-flight sign-in is retired, and a super admin sees it
 *              in `GET /admins/login-reviews`.
 *
 * That second rung is the point of the whole structure: it converts an attack that
 * was merely slow into one that is *visible*, and it does so on the account the
 * attacker chose rather than on a rate limit they can pace around.
 */
export const LOCKOUT = {
  /** Consecutive wrong passwords before the credential locks. */
  MAX_FAILED_ATTEMPTS: 10,
  /**
   * The first lock, in seconds.
   *
   * An hour rather than the fifteen minutes this used to be. Fifteen minutes is a
   * speed bump for something automated and an annoyance for a real admin; an hour is
   * a genuine cost to the first and, because the second lock no longer produces a
   * wait at all, a bound the honest case reaches at most once.
   */
  DURATION_SECONDS: 60 * 60,
  /**
   * How long a strike is remembered.
   *
   * Thirty days, and the length is doing real work in both directions. Too short and
   * the second rung is unreachable — an attacker locks the account, sleeps through
   * the window, and every lock is a first offence forever, which is the flat policy
   * again with extra steps. Too long and an admin who had one bad afternoon a year
   * ago gets taken out of service for a second bad afternoon, with a human summoned
   * to rule on a coincidence.
   *
   * A month is comfortably longer than any plausible attack pause and comfortably
   * shorter than "forever".
   */
  STRIKE_MEMORY_SECONDS: 30 * 24 * 60 * 60,
} as const;

/**
 * What happens after too many rejected captcha tokens from one IP.
 *
 * The threshold and window are `LIMITS.CAPTCHA_FAILURE_BY_IP`; this is the
 * consequence of crossing them. Separate from `LIMITS` because it is not a
 * `RateLimit` — a rate limit refuses and reports one window, this serves a wait
 * that gets longer each time the same IP comes back.
 */
export const CAPTCHA = {
  /**
   * The wait after each trip, in order. The last rung repeats forever.
   *
   * Escalating rather than flat because the two populations this has to separate
   * behave differently over time. Somebody who fumbles a puzzle once waits a
   * minute and never notices; something grinding tokens trips repeatedly and is
   * pushed to an hour, which is the difference between a nuisance and a cost.
   * A flat window lets that second caller pace itself and continue indefinitely.
   */
  BLOCK_LADDER_SECONDS: [60, 5 * 60, 15 * 60, 60 * 60, 24 * 60 * 60],
  /**
   * How long a rung is remembered.
   *
   * ─── This is deliberately EQUAL to the top rung, not longer ────────────────
   *
   * It used to be comfortably longer than the longest rung (an hour), and the
   * comment here said so, because a strike count that expires with the block means
   * every penalty is the first one again and the ladder never escalates.
   *
   * The fifth rung is twenty-four hours, so that headroom is gone: an IP that serves
   * a full day-long block finds its strike count expiring at almost exactly the
   * moment the block lifts, and starts again at sixty seconds.
   *
   * Kept at twenty-four hours anyway, as a product decision, and the consequence is
   * recorded here rather than discovered later: a patient attacker can cycle the top
   * rung indefinitely, paying one day per cycle. What makes that acceptable is that
   * this is not the defence — the provider's own verdict on every token is, and it
   * still runs. This ladder exists to stop somebody burning our siteverify quota, and
   * one attempt per day does not burn a quota.
   *
   * If that trade ever stops looking right, the fix is to raise this above the top
   * rung (48h), not to shorten the rung.
   */
  STRIKE_TTL_SECONDS: 24 * 60 * 60,
} as const;

/**
 * Rate limits.
 *
 * The `onError` decision for each of these — deny or allow when Redis is down —
 * is at the call site, not here, because it depends on whether that path has a
 * durable backstop. See `OnCacheError` in redis/cache.ts.
 *
 * Every number here is tighter than the consumer backend's equivalent, for one
 * reason: the legitimate population is a handful of known people, so there is no
 * shared-NAT office full of users to accommodate. A limit that would be hostile
 * to consumers is barely noticeable to five admins.
 */
export const LIMITS = {
  /**
   * ═══ THE FLOOD CEILING ══════════════════════════════════════════════════════
   *
   * Every password attempt from one IP, successful or not.
   *
   * This is the only login limiter charged on the SUCCESS path, and it is set high
   * enough that no human reaches it: sixty attempts in fifteen minutes is four a
   * minute, sustained. It is not trying to stop guessing — the three buckets below do
   * that — it is stopping one address from making this endpoint do argon2 work
   * thousands of times, which is a resource question rather than a credential one.
   *
   * Replaced the old `LOGIN_BY_IP` (20 per 15m, charged on every attempt), which
   * conflated the two jobs and did neither well: low enough to be reachable by a
   * busy office behind one NAT, high enough that a distributed attempt sailed past.
   */
  LOGIN_FLOOD_BY_IP: { limit: 60, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * ═══ THE SAME JOB, ONE ROUTE LATER ══════════════════════════════════════════
   *
   * Every attempt to turn a `loginId` into a live attempt row, from one IP.
   *
   * ─── Why this is NOT `LOGIN_FLOOD_BY_IP` ──────────────────────────────────
   *
   * That bucket is sized for argon2 — sixty in fifteen minutes, because each unit
   * costs ~50ms of hashing. `LoginService.resolve` costs one indexed lookup on a
   * digest plus one primary-key read, which is three orders of magnitude cheaper,
   * so the two belong at very different heights.
   *
   * More importantly, sharing the key would recreate the exact conflation
   * `LOGIN_FLOOD_BY_IP` was written to remove. One honest ceremony resolves five to
   * seven times — verify-email, any `state` read, passkey-challenge,
   * passkey-verify — so five admins signing in once from a shared office address
   * would spend most of a bucket that exists to bound password hashing. The limit
   * would become reachable by legitimate use, which is the failure the comment
   * above describes.
   *
   * ─── What this is actually for ────────────────────────────────────────────
   *
   * A resource bound on an unauthenticated database round trip, and nothing more.
   * It is not an anti-guessing control and must not be tightened as if it were:
   * the value being presented is 256 bits from a CSPRNG, so guessing is not the
   * threat and no limit meaningfully changes that. Moving the credential out of the
   * cookie did not widen this surface either — the old cookie port already accepted
   * the same value in a header, so an anonymous caller could always POST one.
   *
   * 120 per fifteen minutes is roughly twenty full ceremonies from one address in
   * one window: unreachable by the real population, and far below what an attacker
   * would need for anything.
   */
  LOGIN_RESOLVE_BY_IP: { limit: 120, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * ═══ FAILURES ONLY, AND WHY THAT IS THE WHOLE CHANGE ════════════════════════
   *
   * Wrong passwords from one IP, across all addresses. A correct password costs
   * nothing here.
   *
   * The previous design charged `LOGIN_BY_EMAIL` and `LOGIN_BY_IP` on every attempt,
   * which meant an admin signing in normally spent from the same budget an attacker
   * did. Two bad consequences followed. A legitimate admin working through a few
   * sign-ins could be refused for reasons that had nothing to do with anyone
   * misbehaving; and, worse, the limits had to be set loose enough to accommodate
   * that, which is exactly the looseness an attacker was operating inside.
   *
   * Metering only failures decouples the two populations, and eight is then a
   * genuinely tight number: this is a handful of known people, so an IP producing
   * eight wrong admin passwords in a quarter of an hour is not having a bad day.
   */
  LOGIN_FAILURE_BY_IP: { limit: 8, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * ═══ WRONG PASSWORDS FROM ONE BROWSER ═══════════════════════════════════════
   *
   * The innermost login bucket and deliberately the tightest, keyed on the
   * `orebit_admin_device` cookie — see `DEVICE` above for what that id is, why it is
   * a random server-minted value rather than `ClientContext.deviceFingerprint`, and
   * what it explicitly does not claim.
   *
   * ─── The failure it exists to prevent, which the ladder made worse ─────────
   *
   * A background tab replaying a stale saved password. The per-account counter is
   * DURABLE and now ESCALATING: ten consecutive failures earns a one-hour lock, and a
   * second lock inside `LOCKOUT.STRIKE_MEMORY_SECONDS` suspends the account outright
   * and summons a super admin.
   *
   * So the original argument for this bucket — one client must not be able to walk an
   * admin who did nothing wrong into a durable lockout — got materially stronger when
   * the ladder landed. Before, a misconfigured browser cost its owner fifteen minutes.
   * Now it can cost them their account until a human intervenes.
   *
   * ─── Six, and it must stay strictly below MAX_FAILED_ATTEMPTS ─────────────
   *
   * At ten it would be reached at the same moment as the lockout it exists to keep
   * one browser away from, which is no protection at all. Six is comfortably above
   * the number of times someone mistypes a password they know; an admin who needs a
   * seventh try in fifteen minutes is not remembering it, and the recovery path for
   * that is an operator rather than a larger bucket.
   *
   * ─── Charged on FAILURES only, unlike the version this replaces ───────────
   *
   * It was originally charged on every attempt, alongside a per-email and a per-IP
   * bucket that were too. Those are gone for the reason above this entry, and this
   * one moved with them: a successful sign-in must not spend a budget, or an admin
   * legitimately signing in seven times in a quarter of an hour is refused by the
   * mechanism meant to protect them.
   *
   * Nothing about its protective role is lost by the move. The thing it guards
   * against — the durable lockout — counts CONSECUTIVE FAILURES, so failures are the
   * only attempts that were ever relevant to it. It is still charged first among the
   * failure buckets, so a client that has spent its six is refused without also
   * spending a slot in the IP's shared eight.
   *
   * Cleared on a successful password, which the shared IP bucket deliberately is not:
   * this names one browser rather than everyone behind an address, so a correct
   * password is real evidence the streak was that client fumbling.
   */
  LOGIN_FAILURE_BY_DEVICE: { limit: 6, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * Failed CAPTCHA verifications per IP. Only a provider rejection or a token
   * that fails our hostname/action/score checks consumes this bucket; a provider
   * outage must never count against a user.
   */
  CAPTCHA_FAILURE_BY_IP: { limit: 10, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * ═══ TWO ROLLING QUOTAS ON SIGN-IN CODES, AND WHY BOTH ══════════════════════
   *
   * Both keyed on the ACCOUNT rather than the attempt, so abandoning a sign-in and
   * starting a new one does not reset either — which is what stops the per-attempt
   * counter (`OTP.MAX_SENDS`) from being bypassed by simply opening a new attempt.
   *
   * They replace a single 5-per-HOUR bucket, which was wrong in both directions at
   * once. Against an abuser it was loose: five codes an hour is a hundred and twenty a
   * day, to a mailbox, forever. Against a real admin it was tight in the worst
   * possible place — the window (60 minutes) outlived the attempt that spent it
   * (`STEP_UP.TTL_SECONDS`, 10 minutes), so five failed sends during a brief SMTP
   * outage refused them codes for the remaining ~55 minutes, well after the outage was
   * over, on an account whose only way in is that emailed code.
   *
   * The short quota governs the burst; the daily quota governs the total.
   *
   *   SHORT  five in fifteen minutes. Sized to the sign-in ceremony itself: the
   *          per-attempt budget is five and `STEP_UP.TTL_SECONDS` is ten minutes, so
   *          this cannot refuse a code inside an attempt that has budget left. It
   *          bounds how fast someone can restart attempts to keep sending.
   *   DAILY  fifty in twenty-four hours. Ten full sign-in ceremonies. Nobody signs in
   *          ten times a day and burns every resend doing it, so this is unreachable
   *          by use and reachable only by abuse.
   *
   * ─── Charged at ENQUEUE, refunded on terminal failure ──────────────────────
   *
   * Since delivery moved to the durable queue, the outcome is not known at request
   * time — so both are charged optimistically when the job is enqueued, and the WORKER
   * refunds them if all four delivery attempts fail. That inverts the old
   * charge-after-success ordering, and it is the only arrangement available: a limit
   * that must be checked before the send, against a result that arrives afterwards,
   * leaves nothing but a refund.
   *
   * A REJECTED recipient is still charged, and the asymmetry is deliberate — see
   * `OtpQueueService`. The relay answered; the address is the problem, and an address
   * that can never receive must not buy unlimited retries.
   */
  LOGIN_OTP_SHORT: { limit: 5, windowSeconds: 15 * 60 } satisfies RateLimit,
  LOGIN_OTP_DAILY: { limit: 50, windowSeconds: 24 * 60 * 60 } satisfies RateLimit,
  /**
   * Second-factor proofs offered on `POST /2fa` by one admin.
   *
   * The sign-in path inherits `MFA.MAX_ATTEMPTS` from the login attempt row, but
   * the management and re-auth paths have no attempt to charge — so without this
   * an admin holding an access token could grind codes against a pending
   * enrollment whose secret does not rotate between guesses.
   *
   * Matched to `MFA.MAX_ATTEMPTS` so the two surfaces answer the same way.
   */
  TWO_FACTOR_PROOF_BY_ADMIN: { limit: 5, windowSeconds: 15 * 60 } satisfies RateLimit,
  /**
   * Re-authentication proofs from ONE session.
   *
   * Deliberately TIGHTER than the per-admin ceiling it sits under. That ordering is
   * the whole point: a single session exhausting the account's whole budget is the
   * failure this exists to prevent, so one session must not be able to reach the
   * account limit on its own.
   *
   * Three rather than five, over the same window, so an admin re-authenticating
   * legitimately in one tab has room to fumble a TOTP code twice and still has two
   * account slots left for their other sessions.
   */
  REAUTH_BY_SESSION: { limit: 3, windowSeconds: 15 * 60 } satisfies RateLimit,
} as const;
