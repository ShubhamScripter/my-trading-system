import { createHash } from 'node:crypto';

/**
 * THE key registry. Every Redis key used anywhere in the service is built by a
 * function in this file — no inline key strings, anywhere.
 *
 * Two reasons this is a hard rule rather than a style preference. Namespaces stay
 * greppable, so "what writes this key" is answerable; and collisions become
 * impossible to introduce by accident, which is otherwise exactly what happens
 * when two features independently decide on `otp:<email>`.
 *
 * Naming: `<domain>:<subject>:<qualifier>`. Anything derived from user input is
 * hashed rather than interpolated raw — an email in a key would otherwise be
 * readable to anyone with `KEYS *`, and a `:` inside the value would let a caller
 * forge a neighbouring key.
 */

/** Truncated sha256 — enough to make collisions irrelevant at this cardinality,
 *  short enough to keep keys readable in `redis-cli --scan`. */
function tag(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export const KEYS = {
  // ─── rate limits ──────────────────────────────────────────────────────────
  //
  // Fixed-window counters. The window length and the cap live in
  // auth/auth.constants.ts; this file only names the bucket.
  rate: {
    /**
     * ═══ THREE LOGIN BUCKETS: ONE CEILING, TWO FAILURE COUNTERS ══════════════
     *
     * These replace a `rate:login:email:` / `rate:login:ip:` / `rate:login:device:`
     * trio that was charged on EVERY password attempt. Metering successes alongside
     * failures meant a legitimate admin spent from the same budget an attacker did,
     * which forced the limits loose enough to accommodate normal use — and that
     * looseness was exactly the room an attacker operated in.
     *
     * The per-EMAIL bucket is gone entirely. It had two jobs and neither survives:
     * capping guesses against one account is now the durable
     * `AdminCredential.failedAttempts` counter, which enforces with Redis down and
     * escalates to a manual review; and hiding whether an address exists is now the
     * dummy-argon2 timing mask plus charging the failure buckets on the unknown-email
     * path. A Redis counter keyed on an address the caller supplies could do neither.
     *
     * The per-DEVICE bucket survives, and is the one that matters most — see below.
     */
    /** Every password attempt from one IP, successful or not. A resource ceiling,
     *  not a credential one — see `LIMITS.LOGIN_FLOOD_BY_IP`. */
    loginFloodByIp: (ip: string) => `rate:login:flood:ip:${tag(ip)}`,
    /**
     * Attempts to resolve a `loginId` into a live sign-in, from one IP.
     *
     * Its own bucket rather than a share of `loginFloodByIp`, and the reason is on
     * `LIMITS.LOGIN_RESOLVE_BY_IP`: the flood ceiling is sized for argon2 work, and
     * one honest ceremony resolves five to seven times. Folding them together would
     * make the flood ceiling reachable by a few admins signing in normally — which
     * is precisely the conflation that key was created to undo — and would leave
     * `rate:login:flood:ip:` no longer meaning "password attempts" the way this file
     * says it does.
     *
     * Charged on `POST /auth/login` past the password step AND on the four sign-in
     * actions of `POST /2fa`, because both routes reach the same resolver.
     */
    loginResolveByIp: (ip: string) => `rate:login:resolve:ip:${tag(ip)}`,
    /** WRONG passwords from one IP. Never charged by a success, and never cleared by
     *  one either: the bucket is shared across accounts, so letting one valid
     *  credential wipe it would hand an attacker who holds one a reset lever. */
    loginFailureByIp: (ip: string) => `rate:login:fail:ip:${tag(ip)}`,
    /**
     * ═══ WRONG PASSWORDS FROM ONE BROWSER ════════════════════════════════════
     *
     * Keyed on the `orebit_admin_device` cookie — a random, server-minted id — and
     * NOT on `ClientContext.deviceFingerprint`. That distinction is load-bearing and
     * is argued at length on `DEVICE` in auth/auth.constants.ts: the fingerprint is
     * derived from `User-Agent` + `Accept-Language`, so it both COLLIDES (every admin
     * on the same browser build shares one value, which would put a whole office in
     * one bucket) and is FORGEABLE (anyone could spend a colleague's budget by
     * copying two headers). A random id has neither property.
     *
     * ─── The failure it exists to prevent ──────────────────────────────────
     *
     * A background tab replaying a stale saved password. The per-account counter is
     * durable and escalating — ten consecutive failures is a one-hour lock, and a
     * second lock inside the strike memory SUSPENDS the account and summons a super
     * admin. So without this bucket one misconfigured client can walk an admin who
     * did nothing wrong all the way into a manual review.
     *
     * Charged FIRST among the failure buckets and capped strictly below
     * `LOCKOUT.MAX_FAILED_ATTEMPTS`, so a looping client is refused here — at six —
     * long before it can reach the durable lockout or drain the IP's shared eight.
     *
     * UNLIKE the IP bucket this one IS cleared on a successful password: it names one
     * browser rather than everyone behind an address, so a correct password is real
     * evidence that the streak was that client fumbling rather than someone guessing.
     *
     * What this deliberately does NOT claim: an attacker clears the cookie and gets a
     * fresh bucket every request. They are bounded by the IP failure bucket and the
     * durable account counter, exactly as they would be without this.
     */
    loginFailureByDevice: (deviceId: string) => `rate:login:fail:device:${tag(deviceId)}`,
    /**
     * Sign-in codes emailed for one account: the burst quota and the daily total.
     *
     * Two keys rather than one because they are two different questions with two
     * different windows, and the file's whole rule is that a key names one bucket.
     * Both keyed on the account rather than the attempt, so starting a fresh attempt
     * does not reset the budget.
     *
     * These replace `rate:login-otp:send:`, a single 5-per-hour bucket whose window
     * outlived the ten-minute attempt that spent it — so five failed sends during a
     * short SMTP outage refused an admin codes for the rest of the hour, long after
     * the outage was fixed, on an account whose only way in is that code.
     */
    loginOtpShort: (emailLower: string) => `rate:login-otp:short:${tag(emailLower)}`,
    loginOtpDaily: (emailLower: string) => `rate:login-otp:daily:${tag(emailLower)}`,
    /**
     * The resend cooldown for login codes.
     *
     * Its own qualifier, and that is load-bearing: a cooldown and a fixed-window
     * counter are different mechanisms with different TTLs. Sharing one key
     * between them makes `cooldownRemaining` read the counter's window as a live
     * cooldown, so the first request sets the key and every request after it —
     * including the one that set it — declines to send.
     */
    loginOtpCooldown: (emailLower: string) => `rate:login-otp:cooldown:${tag(emailLower)}`,
    /**
     * Second-factor proofs offered on POST /2fa by one admin.
     *
     * Keyed on the admin rather than the IP: the thing being guessed is that
     * admin's code, and an attacker who can change IP would otherwise reset the
     * budget. The sign-in path does not use this — it charges the login attempt
     * row via `MFA.MAX_ATTEMPTS`, which survives a cache flush.
     */
    twoFactorProofByAdmin: (adminId: string) => `rate:2fa-proof:admin:${tag(adminId)}`,
    /**
     * Re-authentication proofs offered from ONE session.
     *
     * The session dimension the account bucket above cannot provide. Charged
     * alongside it, not instead of it: they bound different things, and each is
     * the other's blind spot.
     *
     * Per-ADMIN alone means one session can spend the whole account's budget, so an
     * attacker holding a single stolen session locks the real admin out of
     * re-authenticating in every other session — a denial-of-service lever handed
     * to whoever gets in first. Per-LOGIN alone means an attacker who can open
     * sessions gets a fresh budget per session. Charging both leaves the account
     * ceiling intact while stopping one login from consuming all of it.
     *
     * ═══ THE LOGIN, NOT THE REFRESH GENERATION ═══════════════════════════════
     *
     * This was keyed on `principal.sessionId` — the refresh GENERATION — and that
     * made the per-session cap meaningless. A generation is replaced on every token
     * rotation, so the bucket moved with it: "three attempts per fifteen minutes"
     * was really three per generation, and a caller who can force a rotation (by
     * letting the access token approach expiry, or by driving the refresh endpoint)
     * got a fresh budget on demand. The account bucket was the only real bound left.
     *
     * Keyed on the family, the budget now persists for the life of the login, which
     * is what the comment above always claimed it did. This is a TIGHTENING: a user
     * who genuinely fumbles codes across a rotation reaches the cap sooner than
     * before, and that is the correct behaviour rather than a regression.
     */
    reauthByLogin: (familyId: string) => `rate:reauth:login:${tag(familyId)}`,
  },

  // ─── captcha penalties ────────────────────────────────────────────────────
  //
  // Three keys, one IP, because they answer three different questions and have
  // three different lifetimes. Folding any two together is the collision this
  // file exists to prevent.
  captcha: {
    /**
     * Rejected tokens from this IP in the current window.
     *
     * Not a `consume` bucket: exceeding it does not refuse the request, it starts
     * a penalty on the ladder below. A success deletes it outright.
     */
    failures: (ip: string) => `captcha:failures:ip:${tag(ip)}`,
    /**
     * An active penalty. Its TTL *is* the remaining wait, which is what lets the
     * refusal report an honest `retryAfterSeconds` without storing a deadline.
     */
    block: (ip: string) => `captcha:block:ip:${tag(ip)}`,
    /**
     * How many times this IP has tripped the limit — the rung it is standing on.
     *
     * Outlives both of the others on purpose. If it expired with the block, every
     * penalty would be the first one again and the escalation would never
     * escalate: an attacker would simply serve the shortest wait forever.
     */
    strikes: (ip: string) => `captcha:strikes:ip:${tag(ip)}`,
  },

  // ─── second factor ────────────────────────────────────────────────────────
  mfa: {
    /**
     * The in-flight WebAuthn challenge for one login attempt.
     *
     * Held server-side and read with `take`, which deletes as it reads — that is
     * what makes it single-use, and single-use is what stops a captured assertion
     * from being replayed. Keyed on the login attempt rather than on the admin,
     * so two concurrent sign-ins cannot consume each other's challenge.
     *
     * The stored value carries the challenge AND the mode it was issued for
     * (`register` | `authenticate`). The mode being server-side is what lets one
     * verify step serve both flows without letting a client choose which
     * verification path runs against it.
     */
    passkeyChallenge: (attemptId: string) => `mfa:passkey-challenge:${attemptId}`,

    /**
     * The registration challenge for a passkey added from the MANAGEMENT surface
     * (`POST /2fa`), as opposed to one added mid-sign-in.
     *
     * A separate namespace from `passkeyChallenge`, and keyed on the LOGIN rather
     * than a login attempt, because there is no attempt here — the caller is
     * already signed in. Sharing the namespace would mean a challenge issued by one
     * flow could be redeemed by the other's verify step, which is exactly the sort
     * of cross-flow substitution the stored `mode` exists to prevent.
     *
     * Login-keyed rather than admin-keyed so two browsers enrolling at once cannot
     * consume each other's challenge. Not GENERATION-keyed: a rotation between the
     * challenge and its verify step would otherwise orphan the challenge and answer
     * `passkey_challenge_invalid` mid-ceremony. Two tabs of ONE browser already
     * shared this namespace before the change — they share one BFF record and so one
     * generation — so nothing about tab isolation moves.
     */
    passkeyEnrollChallenge: (familyId: string) => `mfa:passkey-enroll:${tag(familyId)}`,

    /**
     * The challenge for a RE-AUTHENTICATION assertion — the proof a signed-in
     * admin gives before a mutating request.
     *
     * A third namespace rather than reusing either of the two above, for the same
     * reason they are separate from each other: a challenge issued for one purpose
     * must not be redeemable by another's verify step. Keyed on the LOGIN, for the
     * reasons given on `passkeyEnrollChallenge` — a background rotation must not
     * orphan a challenge the admin is halfway through answering.
     *
     * `tag()`-hashed now, like every other user-adjacent key in this file. It was
     * the one exception, putting a raw identifier in the keyspace where a Redis
     * error argument or a `KEYS` scan could surface it. Not a secret — `GET
     * /auth/me` returns the family id — but the redaction discipline from F05 is
     * worth being uniform about rather than case-by-case.
     */
    reauthChallenge: (familyId: string) => `mfa:reauth-challenge:${tag(familyId)}`,
  },

  /**
   * ═══ ELEVATION TICKETS ════════════════════════════════════════════════════
   *
   * A spent-once permit to perform ONE mutating request, issued after a fresh
   * second-factor proof and presented in `X-Elevation-Ticket`.
   *
   * Keyed on the TICKET, not on the session, and this is the load-bearing choice.
   * Keyed on the session, the value would be "this session is elevated" — a flag
   * that stays true for its whole TTL and authorises any number of writes, which
   * is a time window rather than a per-action proof. Keyed on the ticket, the
   * guard reads it with `take` and the permit is gone: one proof, one write.
   *
   * The stored VALUE is the session id, so a ticket minted by one session cannot
   * be spent by another that somehow obtained it.
   */
  elevation: {
    ticket: (token: string) => `elevation:ticket:${tag(token)}`,
  },

  /**
   * ═══ THE DURABLE OTP QUEUE ════════════════════════════════════════════════
   *
   * The ONLY keys in this file that do not live on the cache instance. Everything
   * else here is on `redis-cache`, which docker-compose runs with `--save ""
   * --appendonly no --maxmemory-policy allkeys-lru` — reconstructible state, evicted
   * freely under pressure. These live on `redis-durable` (AOF everysec, noeviction),
   * because a queued job that is silently evicted is a sign-in code that never
   * arrives, and the emailed code is a mandatory second factor with nothing behind it.
   *
   * ─── Four keys, because a reliable queue needs four states ─────────────────
   *
   *   delayed     ZSET, score = the epoch-ms the job becomes due. Holds retries
   *               waiting out their backoff. A sorted set rather than N timers
   *               because the schedule has to survive a restart.
   *   active      LIST, jobs due now. Workers block on this.
   *   processing  LIST, jobs a worker has taken but not finished. This is the key
   *               that makes the queue reliable rather than merely durable: a worker
   *               moves a job here ATOMICALLY as it claims it, so a process killed
   *               mid-send leaves the job visible here rather than vanishing between
   *               the pop and the send.
   *   job         The AES-256-GCM envelope itself, keyed by job id. The lists and the
   *               set carry only ids, so the payload is written once and never
   *               duplicated across queue states.
   *
   * The job id is NOT hashed by `tag()`, unlike every user-derived value above. It is
   * a server-generated UUIDv7 that discloses nothing and is never supplied by a
   * caller, and it has to be greppable in `redis-cli --scan` when a code goes missing.
   */
  otpQueue: {
    delayed: () => `otp:queue:delayed`,
    active: () => `otp:queue:active`,
    processing: () => `otp:queue:processing`,
    job: (jobId: string) => `otp:queue:job:${jobId}`,
  },

  // ─── session revocation ───────────────────────────────────────────────────
  //
  // A revoked session id, cached for the access token's lifetime. AuthGuard reads
  // this instead of the database on every request: an access token lives fifteen
  // minutes, so a revocation only has to be remembered for fifteen minutes for
  // logout to be effective, and after that the token is expired anyway.
  session: {
    revoked: (sessionId: string) => `session:revoked:${sessionId}`,

    // There is deliberately no `lastUsed` throttle key any more.
    //
    // `session:last-used:<id>` was a `SET NX EX` that gated the activity write, and it
    // was cheaper than what replaced it — it spared the database round trip on most
    // requests. It was also the wrong authority: this cache is allowed to lose
    // writes, so the key could suppress a write the row was due for, letting a cache
    // decide a session's deadline. The interval now lives in `touch`'s WHERE clause,
    // where the row adjudicates it atomically. See auth/persistence/session.dboperation.ts.
  },

  // ─── the browser's session record ─────────────────────────────────────────
  //
  // What the `orebit_admin_session` cookie's handle names: the access and refresh
  // tokens the backend holds on the browser's behalf. See auth/security/bff.session.ts.
  //
  // The handle is NOT hashed by `tag()`, for the same reason the OTP job id above is
  // not: it is a server-minted 32-byte CSPRNG value that discloses nothing and is
  // never derived from anything a caller supplies, so hashing would buy no privacy
  // and cost the ability to find a record with `redis-cli --scan` when a session
  // misbehaves.
  //
  // ─── That argument is about PRIVACY, and it does not cover LOGGING ─────────
  //
  // "Discloses nothing" is true and is the wrong axis. The handle is a BEARER
  // CREDENTIAL — see `generateSessionHandle`, which calls it "the only thing standing
  // between a stranger and a live admin session". It does not need to disclose
  // anything, because holding it IS authentication. So it is safe in a key, where it
  // is compared, and unsafe in a LOG, where it is retained, shipped and searchable.
  //
  // The keys therefore stay as they are and the redaction happens at the logging
  // boundary instead — see `redactKey` below.
  bff: {
    session: (handle: string) => `bff:session:${handle}`,
    /**
     * Held while one session's tokens are being rotated.
     *
     * `lock:` rather than `bff:`, matching the convention the consumer backend uses
     * for its single-flight keys — the prefix says what the value IS, and this one is
     * a mutex rather than a record.
     */
    refreshLock: (handle: string) => `lock:bff-refresh:${handle}`,
  },
} as const;

/**
 * Key prefixes whose remainder is a live credential and must never be logged.
 *
 * A list rather than a rule, because it should be impossible to add a
 * secret-bearing key without deciding about this — `grep` for this constant and the
 * decision is right there. Everything else in `KEYS` already routes its variable
 * part through `tag()`, so this is the complete set.
 */
const SECRET_KEY_PREFIXES = ['bff:session:', 'lock:bff-refresh:'] as const;

/**
 * A key that is safe to put in a log line.
 *
 * For the handle-bearing keys, the credential is replaced by its `tag()` fingerprint;
 * every other key is returned untouched, byte for byte.
 *
 * ═══ WHY A FINGERPRINT AND NOT `[redacted]` ════════════════════════════════════
 *
 * Because the diagnostic value of logging the key at all is being able to line up
 * several failures as belonging to ONE session. `[redacted]` throws that away and
 * makes every failure look identical. The fingerprint is a truncated sha256 — it
 * cannot be turned back into a handle and cannot be replayed, but it is stable, so
 * "these six errors are the same session" is still answerable.
 *
 * It is deliberately the same `tag()` the rest of this file uses, so there is one
 * notion of "the safe form of a value" rather than two.
 */
export function redactKey(key: string): string {
  for (const prefix of SECRET_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return `${prefix}${tag(key.slice(prefix.length))}`;
  }
  return key;
}
