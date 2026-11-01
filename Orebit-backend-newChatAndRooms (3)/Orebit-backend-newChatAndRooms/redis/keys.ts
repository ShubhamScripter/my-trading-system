import { createHmac } from 'node:crypto';
import { config } from '../src/config';

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
 * hashed rather than interpolated raw — an email or a username in a key would
 * otherwise be readable to anyone with `KEYS *`, and a `:` inside the value would
 * let a caller forge a neighbouring key.
 */

/**
 * Truncated HMAC-SHA256 — enough to make collisions irrelevant at this cardinality,
 * short enough to keep keys readable in `redis-cli --scan`.
 *
 * ─── Why keyed rather than a plain hash ─────────────────────────────────────
 *
 * This was `createHash('sha256')`, and hashing alone does not do what the comment
 * above claims it does. The inputs are emails, usernames and IP addresses — a
 * dictionary, not a secret — so anyone holding a Redis dump can confirm that a given
 * address is in it by hashing that address themselves. The digest hides nothing it
 * was meant to hide.
 *
 * An HMAC moves the derivation behind a value that is not in the dump. Confirming an
 * address now needs `RATE_LIMIT_KEY_SECRET` as well, which lives in the process
 * environment rather than in Redis — so a leaked cache stops being a membership
 * oracle over the whole user base.
 *
 * The key is held as one buffer rather than re-read per call; `createHmac` is cheap,
 * but this runs on every rate-limited request and there is no reason to pay for the
 * lookup.
 */
const TAG_KEY = config.rateLimitKeySecret;

function tag(value: string): string {
  return createHmac('sha256', TAG_KEY).update(value).digest('hex').slice(0, 32);
}

export const KEYS = {
  // ─── the global safety net ────────────────────────────────────────────────
  //
  // The outermost ceiling, checked before any per-endpoint quota so a caller
  // hammering the service is refused before it costs a resolution, a hash, or a
  // provider call. Separate from `rate` because these are not about any one
  // endpoint: they bound the whole authentication surface per caller.
  global: {
    /** Unauthenticated traffic, per IP. */
    publicByIp: (ip: string) => `global:public:ip:${tag(ip)}`,
    /** Authenticated traffic, per IP. Higher than the public ceiling: one office
     *  NAT is one IP, and its users have already proved who they are. */
    authedByIp: (ip: string) => `global:authed:ip:${tag(ip)}`,
    /** Authenticated traffic, per account, over a minute. */
    authedByAccount: (userId: string) => `global:authed:account:${tag(userId)}`,
    /**
     * The same account over ten seconds.
     *
     * Its own bucket rather than a tighter version of the one above, because the
     * two answer different questions. A minute-long ceiling permits a caller to
     * spend its whole allowance instantly and then idle; this one bounds the SHAPE
     * of the traffic, which is what separates a person using the product from a
     * loop that has lost its retry guard.
     */
    burstByAccount: (userId: string) => `global:burst:account:${tag(userId)}`,
  },

  // ─── rate limits ──────────────────────────────────────────────────────────
  //
  // The window length and the cap live in auth/auth.constants.ts; this file only
  // names the bucket.
  //
  // ─── On the `:day` twins ──────────────────────────────────────────────────
  //
  // Several quotas are "N per hour AND M per rolling day". They are two keys, not
  // one, because a sliding log answers exactly one window length — and they are
  // charged in ONE `QuotaService.consumeAll` call so the pair is still a single
  // atomic decision. Naming the second one explicitly rather than deriving it with
  // a suffix keeps both greppable, which is the rule this whole file exists for.
  rate: {
    registerStartByIp: (ip: string) => `rate:register-start:ip:${tag(ip)}`,
    registerStartByIpDaily: (ip: string) => `rate:register-start:ip:day:${tag(ip)}`,
    registerStartByEmail: (emailLower: string) => `rate:register-start:email:${tag(emailLower)}`,
    registerStartByEmailDaily: (emailLower: string) =>
      `rate:register-start:email:day:${tag(emailLower)}`,
    /**
     * Registration starts from one signed browser.
     *
     * The bucket that makes the tight per-IP limit survivable. An office, a
     * university or a carrier NAT is one IP and many people, so the IP quota alone
     * either blocks legitimate users or is set so loose it stops nobody. A device
     * quota separates those two populations — but only because the cookie carrying
     * it is signed and cannot be minted by the client. See `device.cookie.ts`.
     */
    registerStartByDevice: (deviceKey: string) => `rate:register-start:device:${tag(deviceKey)}`,
    registerStartByDeviceDaily: (deviceKey: string) =>
      `rate:register-start:device:day:${tag(deviceKey)}`,

    /**
     * Registration codes actually EMAILED to one address, across every attempt.
     *
     * Keyed on the recipient and nothing else, which is the entire point. The budget
     * used to live on `Registration.otpSentCount`, so abandoning an attempt and
     * starting a new one for the same address handed the caller a fresh allowance —
     * an unbounded mail relay reachable by anyone willing to call `start` again.
     * A recipient key has no attempt to reset with.
     */
    registerOtpMail: (emailLower: string) => `rate:register-otp-mail:${tag(emailLower)}`,
    registerOtpMailDaily: (emailLower: string) => `rate:register-otp-mail:day:${tag(emailLower)}`,

    otpResend: (registrationId: string) => `rate:otp-resend:reg:${registrationId}`,
    /** Short critical-section lease for one registration OTP replacement. */
    otpResendLock: (registrationId: string) => `lock:otp-resend:reg:${registrationId}`,
    loginByIdentifier: (identifier: string) => `rate:login:id:${tag(identifier.toLowerCase())}`,
    loginByIp: (ip: string) => `rate:login:ip:${tag(ip)}`,

    /**
     * ─── request, failure, unknown: three buckets, one endpoint ─────────────
     *
     * `POST /auth/login` charges all three, at three different moments, and keeping
     * them apart is a correctness fix rather than bookkeeping.
     *
     * The endpoint used to charge one bucket on entry, before the password had been
     * checked. So a user typing their own password correctly spent the same quota as
     * an attacker guessing — sign in eleven times in a quarter of an hour and the
     * service locked out the person it was protecting. A failure quota has to be
     * charged after a failure is CONFIRMED, or it is not a failure quota.
     */

    // REMOVED: `loginStartByIp`, `loginStartByDevice` and their `:day` twins.
    //
    // They bucketed `POST /auth/login {step:'start'}`, a request that no longer
    // exists. The row it used to write is now written by whichever real login
    // operation comes first, and each of those already meters the same caller —
    // see the note on `LOGIN_FLOW` in auth/limits.ts. Deleted rather than left
    // declared: an unused key here reads as a bucket something is charging.
    /**
     * Attempts to turn a `loginId` into a live flow row, from one IP.
     *
     * Not one of the credential buckets below, and sized far above them on purpose:
     * one honest sign-in resolves its handle several times — the first factor, the
     * second, and any state read between them — so metering it at credential rates
     * would refuse ordinary use. What it bounds is a caller grinding guessed handles
     * against the hash lookup.
     */
    loginResolveByIp: (ip: string) => `rate:login-resolve:ip:${tag(ip)}`,

    /** Every call, charged on entry. The flood ceiling — it bounds the work the
     *  endpoint does, and says nothing about whether any of it succeeded. */
    loginFloodByIp: (ip: string) => `rate:login-flood:ip:${tag(ip)}`,
    /** Charged only once a wrong password has been confirmed. Cleared outright by a
     *  successful sign-in, because the streak this bounds has demonstrably ended. */
    loginFailByAccount: (userId: string) => `rate:login-fail:account:${tag(userId)}`,
    /** The same, per IP: one caller working through many accounts. NOT cleared by a
     *  success — one correct password says nothing about the other attempts. */
    loginFailByIp: (ip: string) => `rate:login-fail:ip:${tag(ip)}`,
    /**
     * Attempts against identifiers that resolve to nothing.
     *
     * Its own bucket because it is the signature of enumeration rather than of
     * guessing: a person mistypes their own address occasionally, a scanner walks a
     * list and misses almost every time.
     */
    loginUnknownByIp: (ip: string) => `rate:login-unknown:ip:${tag(ip)}`,
    /** Requests to `mode: otp-request` for one identifier string. The endpoint
     *  guard — it bounds resolution of identifiers that match nothing, and is NOT
     *  the send budget. */
    loginOtpByIdentifier: (identifier: string) =>
      `rate:login-otp:id:${tag(identifier.toLowerCase())}`,
    /** The same endpoint per IP and per signed browser. An identifier bucket alone
     *  meters one address at a time, so a caller walking a list of addresses pays
     *  nothing; these two are what bound the caller rather than the target. */
    loginOtpByIp: (ip: string) => `rate:login-otp:ip:${tag(ip)}`,
    loginOtpByDevice: (deviceKey: string) => `rate:login-otp:device:${tag(deviceKey)}`,
    /**
     * Login codes actually emailed to one account.
     *
     * Keyed on the account's email rather than on whatever identifier the caller
     * typed, so email, username and public code draw on one bucket instead of
     * three — and so every path that sends a code pays the same counter.
     */
    loginOtpSendByAccount: (emailLower: string) => `rate:login-otp:send:${tag(emailLower)}`,
    /** The rolling-day half of the same budget. Charged in the same atomic call as
     *  the short window above, and held on the DURABLE instance — a cache flush
     *  must not hand every address a fresh day's worth of mail. */
    loginOtpSendByAccountDaily: (emailLower: string) =>
      `rate:login-otp:send:day:${tag(emailLower)}`,

    /**
     * Password attempts against one resolved ACCOUNT.
     *
     * The companion to `loginByIdentifier`, not a replacement for it. That one is
     * keyed on whatever string was typed, so it still bounds resolution work for
     * identifiers matching nothing — but it also means one account is reachable as
     * an email, a username and a public code, each drawing its own ten attempts.
     * This closes that by metering the account once resolution has found it.
     */
    loginByAccount: (emailLower: string) => `rate:login:account:${tag(emailLower)}`,
    /**
     * The resend cooldown for login codes.
     *
     * Its own qualifier, and that is load-bearing: a cooldown and a fixed-window
     * counter are different mechanisms with different TTLs, and this used to share
     * `loginOtpByIdentifier` with the counter. `cooldownRemaining` then read the
     * counter's hour-long window as a live cooldown, so the first request set the
     * key and every request after it — including the one that set it — declined to
     * send. Sharing a key between two mechanisms is the collision this file exists
     * to prevent.
     */
    loginOtpCooldown: (emailLower: string) => `rate:login-otp:cooldown:${tag(emailLower)}`,
    /** Serializes challenge replacement and its cooldown for one recipient. */
    loginOtpLock: (emailLower: string) => `lock:login-otp:${tag(emailLower)}`,
    passwordForgotByEmail: (emailLower: string) => `rate:password-forgot:email:${tag(emailLower)}`,
    passwordForgotByIp: (ip: string) => `rate:password-forgot:ip:${tag(ip)}`,
    /** Reset attempts per IP. There is deliberately no per-email companion — see
     *  the comment on `PasswordService.reset`. */
    passwordResetByIp: (ip: string) => `rate:password-reset:ip:${tag(ip)}`,
    /**
     * `set`, `reset` and `forgot` attempts on `POST /settings/security/password`,
     * per ACCOUNT, sharing ONE bucket.
     *
     * Keyed on `userId` rather than `emailLower` — unlike the two `passwordForgot*`
     * keys above, which meter an ANONYMOUS door where the address is all the caller
     * has offered. This surface is authenticated, so the account is known for
     * certain, and an email change mid-window must not hand the caller a fresh
     * budget. See `policy().PASSWORD.UPDATE_BY_ACCOUNT`.
     */
    passwordUpdateByAccount: (userId: string) => `rate:password-update:account:${tag(userId)}`,
    referralCheck: (registrationId: string) => `rate:referral-check:reg:${registrationId}`,
    /** The provider redirect and the callback that returns from it. Separate
     *  buckets because they are separate endpoints with separate costs — the
     *  callback is the one that spends a Google token exchange. */
    oauthStartByIp: (ip: string) => `rate:oauth-start:ip:${tag(ip)}`,
    oauthCallbackByIp: (ip: string) => `rate:oauth-callback:ip:${tag(ip)}`,
    /** Both legs per signed browser as well as per IP. The callback is the leg worth
     *  metering twice: it spends a provider token exchange, so an IP-only bucket is
     *  a shared allowance a single abusive browser behind a NAT can drain. */
    oauthStartByDevice: (deviceKey: string) => `rate:oauth-start:device:${tag(deviceKey)}`,
    oauthCallbackByDevice: (deviceKey: string) => `rate:oauth-callback:device:${tag(deviceKey)}`,
    /** Attaching a provider, per account. Keyed on the user id rather than the IP:
     *  the caller is authenticated here, so the account is the thing worth
     *  metering and a NAT should not pool with strangers. */
    oauthLinkByAccount: (userId: string) => `rate:oauth-link:account:${tag(userId)}`,
    /**
     * FAILED link confirmations, per account.
     *
     * The attempt bucket above bounds how often a caller may link; this bounds how
     * often they may get it wrong, which is the shape of someone grinding
     * `linkToken` values rather than attaching their own Google account. Separate
     * for the same reason the login buckets are: a user who links successfully
     * should not be spending the quota that exists to catch someone who cannot.
     */
    oauthLinkFailByAccount: (userId: string) => `rate:oauth-link-fail:account:${tag(userId)}`,
    /**
     * The one live link ceremony for (account, provider).
     *
     * Not a counter — a mutex. Two concurrent link ceremonies for the same provider
     * mean two pending identities racing to attach, and the loser's `linkToken`
     * outlives the write it was minted for.
     */
    oauthLinkCeremony: (userId: string, provider: string) =>
      `oauth:link-ceremony:${tag(`${userId}:${provider}`)}`,

    /**
     * WebAuthn challenges minted for one half-authenticated sign-in.
     *
     * Keyed on the ATTEMPT, not the user or the IP, because that is the unit an
     * `mfaToken` holder can spend: the token names one attempt and nothing else.
     *
     * Separate from the attempt's own `attempts` counter on purpose, and the
     * distinction is the point. Requesting a challenge is not a guess at a
     * credential — no assertion has been offered — so charging it against the
     * five-guess cap would let a client lock itself out by rendering a login form
     * twice. But it is not free either: unbounded, it is an unmetered path to
     * building options and writing a Redis record. One counter meters the ceremony,
     * the other meters the cryptography.
     */
    mfaPasskeyChallengeByAttempt: (attemptId: string) =>
      `rate:mfa-passkey-challenge:attempt:${tag(attemptId)}`,

    /**
     * Re-authentication attempts for one session.
     *
     * `POST /auth/2fa {action:'reauth-verify'}` is bearer-only, and on an account
     * with no factor it compares the account PASSWORD — which charges
     * `Credential.failedAttempts` and can therefore lock the account out. Without a
     * limit here, a stolen access token is enough to do that, and nothing else
     * bounded it: `cache.consume` was not used anywhere in src/2fa.
     */
    reauthBySession: (sessionId: string) => `rate:reauth:session:${tag(sessionId)}`,

    /**
     * Credential-change codes emailed to one account.
     *
     * Keyed on the account rather than the session, because the cost being bounded is
     * OUTBOUND MAIL and a caller with several sessions must not get several budgets.
     * Same reasoning as `loginOtpSendByAccount`.
     */
    credentialOtpByAccount: (emailLower: string) =>
      `rate:credential-otp:account:${tag(emailLower)}`,

    /**
     * Attempts to disable a second factor from `src/settings/`, per account.
     *
     * Keyed on the account and not the session, deliberately, and it is the one
     * limiter in this file where that choice is about the OUTCOME rather than the
     * cost: a successful disable revokes every other session, so a caller metered
     * per session could reset their own budget by signing in again. The secrets
     * being guessed — backup codes — belong to the account too.
     *
     * ONE key for BOTH surfaces — passkeys and the authenticator app — and that is
     * the point rather than an economy. The cheapest path on either surface guesses
     * the same account-scoped backup code, so a second key would double the guess
     * budget while both limits still read "5 per 15 minutes". Do not add a
     * per-surface variant; see `SECURITY_SETTINGS` in auth/limits.ts.
     */
    securitySettingsDisableByAccount: (userId: string) =>
      `rate:security-disable:account:${tag(userId)}`,

    /**
     * KYC image reverifications, per account, over the day and the month.
     *
     * The `:day` twin convention, and see the note above it for why the second key
     * is spelled out rather than derived. Charged in ONE `consumeAll` against the
     * DURABLE store: a ceiling of two a month that a cache restart resets is not a
     * ceiling, and this is the only disable path with a third-party cost behind it.
     *
     * Shared by both settings surfaces for the same reason the key above is: the
     * ceiling rations image reverifications, not screens.
     */
    kycReverifyByAccount: (userId: string) => `rate:kyc-reverify:account:${tag(userId)}`,
    kycReverifyByAccountMonthly: (userId: string) =>
      `rate:kyc-reverify:account:month:${tag(userId)}`,

    /**
     * The three payment-PIN budgets, all keyed on the ACCOUNT.
     *
     * None of them may be keyed on the session or the family. The PIN is account
     * state, so a caller metered per session resets their own budget by signing in
     * again — and on the `pin` verification path what is being guessed is an
     * account-scoped secret. See `PAYMENT_PIN` in auth/limits.ts.
     */
    paymentPinEnableByAccount: (userId: string) => `rate:payment-pin-enable:account:${tag(userId)}`,
    /**
     * Verification attempts across ALL THREE methods.
     *
     * The method is deliberately NOT in the key. A per-method key would triple the
     * guess budget against a six-digit secret while the limit still read "5 per 15
     * minutes" — the same trap `securitySettingsDisableByAccount` above documents for
     * the two factor surfaces. Do not add a per-method variant.
     */
    paymentPinVerifyByAccount: (userId: string) => `rate:payment-pin-verify:account:${tag(userId)}`,
    /** Successful PIN changes. A sliding log on the DURABLE store — see the note on
     *  `UPDATE_BY_ACCOUNT` for why a fixed window and a `burst` store both fail here. */
    paymentPinUpdateByAccount: (userId: string) => `rate:payment-pin-update:account:${tag(userId)}`,

    /**
     * ─── changing the account's email ───────────────────────────────────────
     *
     * The first four are account-keyed like every other post-account budget. The
     * fifth is not, and that is the interesting one.
     */
    emailChangeStartByAccount: (userId: string) => `rate:email-change-start:account:${tag(userId)}`,
    /** Resends inside a live ceremony. A key of its own rather than sharing the
     *  start budget — see `EMAIL_CHANGE.RESEND_BY_ACCOUNT` in auth/limits.ts. */
    emailChangeResendByAccount: (userId: string) =>
      `rate:email-change-resend:account:${tag(userId)}`,
    emailChangeVerifyByAccount: (userId: string) =>
      `rate:email-change-verify:account:${tag(userId)}`,
    /** Completed changes. Sliding log, DURABLE store, charged on success — see
     *  `EMAIL_CHANGE.CHANGE_BY_ACCOUNT` in auth/limits.ts. */
    emailChangeByAccount: (userId: string) => `rate:email-change:account:${tag(userId)}`,

    /** Deletion requests, per account — see `SECURITY_SETTINGS.DELETE_ACCOUNT_BY_ACCOUNT`
     *  in auth/limits.ts for why this is keyed on the account and not the session. */
    deleteAccountByAccount: (userId: string) => `rate:delete-account:account:${tag(userId)}`,

    /**
     * Reactivation codes mailed for one ADDRESS, and reactivation attempts from one IP.
     *
     * ═══ KEYED ON THE ADDRESS, NEVER ON A RESOLVED ACCOUNT ══════════════════
     *
     * Every other post-account budget in this file keys on `userId`, and this one must
     * not. `POST …/delete-account/reactivate` is public and answers identically whether
     * or not the address has an account — but a bucket keyed on a resolved `userId`
     * would only ever be charged when one WAS resolved, so an attacker could ask twice
     * and read the account's existence off whether the second request was throttled.
     * The meter would leak exactly what the response body is careful not to.
     *
     * Keyed on the address, both are charged for every request, including the ones that
     * resolve nothing. `tag` HMACs it, so a Redis dump does not confirm which addresses
     * have been tried.
     *
     * The IP bucket is the one that actually bounds an enumeration sweep, since an
     * attacker walking a list changes the address every request and would never hit the
     * per-address limit.
     */
    accountReactivationByEmail: (emailLower: string) =>
      `rate:account-reactivation:email:${tag(emailLower)}`,
    accountReactivationByIp: (ip: string) => `rate:account-reactivation:ip:${tag(ip)}`,

    /**
     * Codes mailed to one DESTINATION address, over the hour and the day.
     *
     * Keyed on the RECIPIENT and not on the account, which is the whole point and the
     * one place this feature departs from every other post-account budget in this file.
     * Those key on `user.emailLower` because until now the account's address and the
     * message's destination were always the same value. An email change breaks that:
     * the caller names the destination, so an account-keyed budget would meter how
     * often *this* account sends and say nothing about how much mail one stranger's
     * inbox receives from many accounts.
     *
     * The `:day` twin convention, as above. Same defence, same shape and same reasoning
     * as `registerOtpMail` — read the note there.
     */
    emailChangeOtpMail: (emailLower: string) => `rate:email-change-otp-mail:${tag(emailLower)}`,
    emailChangeOtpMailDaily: (emailLower: string) =>
      `rate:email-change-otp-mail:day:${tag(emailLower)}`,

    /**
     * Recovery attempts from one network.
     *
     * The only recovery bucket that can be charged on entry, because at entry there is
     * no account: the recovery route is reachable WITHOUT a session — deliberately, as
     * a completed change sweeps every session and the address being recovered cannot
     * sign in. An IP is the only subject available until the ticket resolves.
     */
    emailRecoverByIp: (ip: string) => `rate:email-recover:ip:${tag(ip)}`,
    /** Verification attempts against one resolved recovery ticket — the per-account
     *  bound, applied as soon as there is an account to bound. Keyed on the retention
     *  row rather than the token, so re-requesting cannot mint a fresh budget. */
    emailRecoverByRecord: (retainedEmailId: string) =>
      `rate:email-recover:record:${tag(retainedEmailId)}`,

    /**
     * ─── changing the account's username ────────────────────────────────────
     *
     * Two buckets, and the interesting thing about them is how far apart they are.
     *
     * `usernameCheckByAccount` meters an endpoint the client calls WHILE THE USER
     * TYPES — a debounced keystroke probe — so its ceiling is high and it fails OPEN.
     * Nothing is spent by a check: no mail, no code, no money, and Postgres is still
     * the thing that decides who owns a name. A Redis outage that made this refuse
     * would break typing to protect nothing.
     *
     * There is deliberately NO bucket for the free-change allowance. That one gates
     * money, so it is counted in Postgres from `username_reservations.created_at`
     * inside the change's own transaction — see `UsernameService.update`. A sliding
     * log on the durable instance would have matched `emailChangeByAccount`, and it is
     * the wrong tool here for one reason: losing the window costs the business a paid
     * change rather than costing a caller an extra attempt.
     */
    usernameCheckByAccount: (userId: string) => `rate:username-check:account:${tag(userId)}`,
    /** Attempts at the mutation itself. A flood ceiling on the transaction — the
     *  advisory lock and the unique index make a burst expensive, and this bounds how
     *  much of that expense one caller can cause. NOT the free-change allowance. */
    usernameUpdateByAccount: (userId: string) => `rate:username-update:account:${tag(userId)}`,

    /**
     * ─── the anti-phishing code ─────────────────────────────────────────────
     *
     * `set`, `change` and `replace` together. The ACTION is deliberately not in the
     * key: a per-action key would triple the ceiling while `policy().ANTI_PHISHING`
     * still read ten, and the action a flooder picks is `replace` — the one that needs
     * no `currentCode` — regardless of what the other two are keyed on. Same
     * construction and same reason as `paymentPinVerifyByAccount` above.
     *
     * Keyed on the ACCOUNT rather than the session: the route is authenticated, so the
     * account is known for certain, and a caller metered per session would reset their
     * own budget by refreshing a token.
     */
    antiPhishingUpdateByAccount: (userId: string) =>
      `rate:anti-phishing-update:account:${tag(userId)}`,

    /**
     * Elevation tickets SUCCESSFULLY issued to one session.
     *
     * `reauthBySession` above bounds failed proofs; this bounds successful ones, and
     * both are needed. A caller who holds the password and can therefore re-prove it
     * at will is never refused by a failure bucket, so without this one a stolen
     * access token on an account with no second factor is an unlimited supply of
     * single-use permits — which defeats the point of them being single-use.
     */
    elevationIssuedBySession: (sessionId: string) =>
      `rate:elevation-issued:session:${tag(sessionId)}`,

    /**
     * Refresh calls for one session, over the short window and the hour.
     *
     * A broken client that loops on refresh is the common case here, not an
     * attacker: two windows because a tight one alone would refuse a legitimate
     * burst of concurrent tabs, and a loose one alone would let a spinning client
     * run all day at just under the cap.
     */
    /**
     * ─── Keyed on the FAMILY, not the session ─────────────────────────────────
     *
     * These were `rate:refresh:session:<generation id>`, and that made them
     * unenforceable. A refresh rotates the session: the child row gets a NEW id and
     * inherits `familyId`, so every successful refresh landed in an empty bucket and
     * a client looping on refresh was never refused. The quota only ever bit a client
     * REPLAYING one generation — which reuse-detection already handles.
     *
     * `familyId` is the id of the first generation and is constant for the life of
     * the chain, so it is the only identifier here that a rotation cannot reset.
     */
    refreshByFamily: (familyId: string) => `rate:refresh:family:${tag(familyId)}`,
    refreshByFamilyHourly: (familyId: string) => `rate:refresh:family:hour:${tag(familyId)}`,

    /** Logout, logout-all, revoke, and trust changes for one session family. One
     *  bucket for all of them: they are the same kind of state-changing session
     *  administration, and nobody legitimately performs ten in a minute. Keyed on the
     *  family for the same reason as the two above. */
    sessionAdminByFamily: (familyId: string) => `rate:session-admin:family:${tag(familyId)}`,
  },

  // ─── captcha penalties ────────────────────────────────────────────────────
  //
  // Three keys, one IP, because they answer three different questions and have
  // three different lifetimes. Folding any two together is the same mistake the
  // login-OTP cooldown made — see the note on `loginOtpCooldown`.
  captcha: {
    /**
     * Rejected tokens from this IP in the current window.
     *
     * Not under `rate` any more, and not a `consume` bucket: exceeding it does
     * not refuse the request, it starts a penalty on the ladder below. A success
     * deletes it outright.
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

  // ─── session revocation ───────────────────────────────────────────────────
  //
  // A revoked session id, cached for the access token's lifetime. AuthGuard reads
  // this instead of the database on every request: an access token lives fifteen
  // minutes, so a revocation only has to be remembered for fifteen minutes for
  // logout to be effective, and after that the token is expired anyway.
  session: {
    revoked: (sessionId: string) => `session:revoked:${sessionId}`,
    /**
     * Throttle for the `lastUsedAt` write. Present = written recently enough.
     *
     * Keyed on the FAMILY, not the generation. A rotation mints a child with a new
     * session id, so a generation-keyed throttle found an empty bucket after every
     * refresh — and under the BFF, where refresh is automatic and unprompted, that
     * would mean the throttle effectively never applied. The family id is the id of
     * the first generation and never changes.
     */
    lastUsed: (familyId: string) => `session:last-used:${familyId}`,
  },

  // ─── the browser's session record ─────────────────────────────────────────
  //
  // The browser holds an opaque handle in `orebit_session`; this is where the record
  // it names lives. See auth/security/bff.session.ts.
  //
  // ─── Why the handle is tagged rather than interpolated raw ────────────────
  //
  // Because it is a bearer credential, unlike every other key component here. An
  // email in a key is a privacy problem; a handle in a key is the credential itself,
  // so a log line, a slow-query report or a `KEYS *` listing that included one would
  // hand over a live session. `tag()` is already this repo's answer for that and it
  // is keyed, so the mapping cannot be reversed by anyone without
  // `RATE_LIMIT_KEY_SECRET`.
  //
  // The envelope inside the record is still bound to the RAW handle as AES-GCM AAD —
  // see `seal` — so tagging the key costs nothing there: a record copied to another
  // handle remains unopenable regardless of how it was addressed.
  bff: {
    session: (handle: string) => `bff:session:${tag(handle)}`,
    /** Held for the duration of one in-request rotation, so that concurrent requests
     *  on one session do not both present the same refresh token — which reuse
     *  detection would read as theft. See `BffSessionService.refresh`. */
    refreshLock: (handle: string) => `lock:bff-refresh:${tag(handle)}`,
  },

  device: {
    /** The same throttle, for a trusted device's own `lastUsedAt`. */
    lastUsed: (deviceId: string) => `device:last-used:${deviceId}`,
  },

  // ─── oauth ────────────────────────────────────────────────────────────────
  //
  // The `state` parameter, held server-side and single-use. Storing it here
  // rather than signing it into the value is what makes it single-use: the
  // callback deletes it, so a replayed authorization code cannot be redeemed
  // twice.
  oauth: {
    state: (state: string) => `oauth:state:${tag(state)}`,
    /**
     * The `state` for a SETTINGS link ceremony, in its own namespace.
     *
     * ═══ WHY THIS IS NOT `state` WITH AN EXTRA FIELD ═══════════════════════
     *
     * A login callback and a link callback want opposite things from a state
     * entry. `OauthService.callback` resolves a linked identity into a SESSION;
     * `OauthService.completeLink` must never mint one. So the worst outcome is a
     * state minted by one flow being redeemed by the other, and separate key
     * namespaces make that unreachable rather than merely checked: a link state
     * is invisible to `cache.take(KEYS.oauth.state(...))` and a login state is
     * invisible to `cache.take(KEYS.oauth.linkState(...))`. Both simply miss, and
     * both answer `oauth_state_invalid`.
     *
     * A shared namespace plus a `purpose` field would have been the other option
     * and is worse for a specific reason: `callback` deliberately TOLERATES a
     * missing `loginAttemptId` on entries written by a previous deploy, so a
     * discriminator it did not know to look for would have been waved through by
     * the same tolerance. Separating the keyspace needs no change to `callback`
     * at all, which is the property worth having.
     */
    linkState: (state: string) => `oauth:link-state:${tag(state)}`,
    /**
     * A verified provider identity, parked between the callback and the user's
     * decision about what to do with it.
     *
     * Same reasoning as `state`, one step later: the authorization code has been
     * spent by the time this is written, so the identity cannot be recovered by
     * replaying anything. Holding it server-side is what lets the client carry an
     * opaque handle instead of a signed blob it could tamper with.
     */
    pending: (token: string) => `oauth:pending:${tag(token)}`,
  },

  // ─── email blocklist ──────────────────────────────────────────────────────
  //
  // ONE key holding the whole rule table, not a key per lookup. A per-address key
  // would barely ever hit — signup traffic is overwhelmingly distinct addresses —
  // and would make invalidation a scan. One hash makes a lookup a single `HMGET`
  // over the handful of candidates an address produces, and makes invalidation a
  // single `DEL`.
  blocklist: {
    /** Field = the rule's normalised value, field value = its `BlockedEmailKind`.
     *  The field NAME is the matched value, so nothing has to be stored twice. */
    rules: () => 'blocklist:rules',
    /** Single-flight guard for the rebuild. Held briefly so a cold cache under
     *  concurrent traffic loads the table once rather than once per request. */
    warming: () => 'blocklist:warming',
  },

  // ─── second factor ────────────────────────────────────────────────────────
  //
  // Both of these are short-lived single-use credentials, so both are written with
  // `set` and read with `take` (GETDEL) rather than with the flag helpers. See the
  // note on the fail-closed trio in redis/cache.ts: a swallowed miss here would
  // read as "that ticket was never issued", which is a security conclusion drawn
  // from an infrastructure fault.

  elevation: {
    /** A one-shot permit for one re-authenticated write. The value is the grant —
     *  `{sessionId, action}` — so a ticket cannot be moved between sessions or
     *  spent on an action it was not proved for. */
    ticket: (ticket: string) => `elevation:ticket:${tag(ticket)}`,
  },

  emailChange: {
    /**
     * The in-flight email change, keyed on the ACCOUNT rather than on a random id.
     *
     * That choice buys three things a random key cannot. One change in flight per
     * account, structurally — there is nowhere to put a second. `start` supersedes
     * cleanly, because a random key leaves nothing to find and delete. And `resend` can
     * read the record without destroying it, which `take` forbids.
     *
     * The id handed to the client lives INSIDE the value and is compared with
     * `safeEqual`, so the key being guessable costs nothing: knowing a user id does not
     * let you name their change.
     *
     * Read with `get` and cleared on success rather than read with `take` — the
     * opposite of `paymentPin.challenge` above, and deliberately. That challenge IS the
     * proof, so reading it has to spend it. This one is an envelope around codes that
     * are each single-use in Postgres, spent under their own compare-and-swap, so a
     * replayed verify finds them consumed. Using `take` here would instead burn the
     * whole ceremony on one mistyped digit.
     */
    pending: (userId: string) => `email-change:pending:${tag(userId)}`,
  },

  // ─── the username availability filter ─────────────────────────────────────
  //
  // A Bloom filter over every username that has ever been claimed or reserved, held as
  // a plain Redis BITMAP rather than with `BF.*` — this deployment runs `redis:7-alpine`
  // and has no RedisBloom module. See redis/username-bloom.ts.
  //
  // Nothing here is hashed, and that is not an oversight: these are two fixed keys with
  // no user input in them. The usernames themselves never appear in a key — they are
  // hashed into BIT POSITIONS inside the bitmap, which is a stronger form of the same
  // property `tag()` provides. A dump of this key is a few hundred kilobytes of bits
  // that cannot be reversed into the names that set them.
  //
  // Both live on the DURABLE instance. The cache instance is `allkeys-lru`, and a
  // filter evicted mid-flight would answer "definitely absent" for every username in
  // the product — turning the one Bloom result that is trusted without a database read
  // into a wrong answer. `noeviction` plus AOF is what makes the negative safe.
  username: {
    /** The bitmap. `generation` is in the key so a resize or a rebuild is a new key
     *  rather than a mutation of the one being read — readers finish on the old bitmap
     *  and the flag below is what moves them. */
    bloom: (generation: number) => `username:bloom:v${generation}`,
    /**
     * Present only once the bitmap has been fully populated from Postgres.
     *
     * THE correctness switch. Until it exists — a cold start, a half-finished warm-up,
     * a flushed instance — every check skips the filter and goes to Postgres. Without
     * it an empty bitmap would report every username "definitely absent", which is the
     * one failure mode a Bloom filter is not allowed to have.
     */
    bloomReady: (generation: number) => `username:bloom:ready:v${generation}`,
    /** Single-flight guard for the warm-up, so a cold start under concurrent traffic
     *  scans `users` once rather than once per instance. The `blocklist:warming`
     *  pattern. */
    bloomWarming: (generation: number) => `username:bloom:warming:v${generation}`,
  },

  paymentPin: {
    /**
     * A one-shot authorisation for ONE payment-PIN update or disable.
     *
     * The same construction as `elevation.ticket` above and read the same way, with
     * `take` — so the note on the fail-closed trio applies here too. The value is the
     * grant, `{userId, familyId, operation, method}`, so a challenge cannot be moved
     * to another account, spent from an unrelated login, or used for the operation it
     * was not verified for.
     *
     * `familyId` rather than `sessionId`, which is the one place this differs from
     * the elevation ticket. A ticket lives sixty seconds and is spent by the next
     * request; this lives five minutes while the user types a new PIN, and `sessionId`
     * changes on every refresh — so a token rotation mid-flow would refuse a
     * legitimate challenge. `familyId` is constant across rotations and still names
     * one login. Same reasoning as `refreshByFamily` above.
     *
     * Hashed like every other caller-supplied secret: the id we hand out never appears
     * in Redis, so a key dump cannot be replayed as a challenge.
     */
    challenge: (challengeId: string) => `payment-pin:challenge:${tag(challengeId)}`,
  },

  passkey: {
    /**
     * A WebAuthn challenge, keyed by the ceremony it belongs to.
     *
     * Server-side and single-use for the same reason the OAuth `state` is: the
     * whole point of a challenge is that it cannot be replayed, and a stateless
     * signed one would verify on every replay.
     *
     * `subject` is the user id for an authenticated ceremony (registering a new
     * passkey) and the login-attempt id for a sign-in — two namespaces would let a
     * challenge minted for one be spent on the other.
     *
     * ─── Why re-authentication has a THIRD namespace ───────────────────────
     *
     * There are three ceremonies, not two, and re-auth used to be folded onto
     * `registration` — so an `authenticate`-mode record was stored under a key
     * literally named `passkey:reg:`. The two have different credentials:
     * `reauth-challenge` needs only a bearer, while `passkey-add-challenge` needs a
     * bearer AND an elevation ticket. A plain bearer could therefore clobber a
     * pending enrollment challenge that had cost a ticket to obtain, and the
     * enrollment could clobber a pending reauth.
     *
     * Not an escalation — `mode` is written by us and checked on both verify paths,
     * so a collision surfaced as `PASSKEY_CHALLENGE_INVALID` — but it burnt a
     * single-use ticket and looked like a random failure. GETDEL made it worse:
     * either flow destroyed the other's record even on the matching-mode path.
     */
    registration: (userId: string) => `passkey:reg:${tag(userId)}`,
    reauth: (userId: string) => `passkey:reauth:${tag(userId)}`,
    authentication: (attemptId: string) => `passkey:auth:${tag(attemptId)}`,
  },

  // ─── the durable mail queue ───────────────────────────────────────────────
  //
  // These live on the DURABLE instance, not the cache — see `DurableRedisService`.
  // Fixed keys rather than functions: there is one queue, not one per subject, and a
  // per-subject stream would defeat the consumer group that makes crash recovery
  // work.
  //
  // Nothing here is hashed. `tag()` exists to keep user input out of key names, and
  // there is no user input in any of these.
  mail: {
    /**
     * The work stream. `XADD` to enqueue, `XREADGROUP` to claim, `XACK` to finish.
     *
     * A Stream rather than a List, and the reason is crash recovery. `BRPOPLPUSH` on
     * a list needs a second "processing" list plus a reaper that can tell a stalled
     * worker from a slow one. A consumer group keeps that bookkeeping itself: a
     * claimed-but-unacked message sits in the group's pending-entries list, and
     * `XAUTOCLAIM` hands it to another consumer after an idle timeout. A process
     * killed mid-send therefore loses nothing.
     */
    stream: () => 'mail:stream',
    /** One group across every app instance, so a message is delivered once rather
     *  than once per instance. */
    group: () => 'mail-workers',

    /**
     * Messages waiting for their backoff to elapse, scored by due time.
     *
     * A sorted set because Streams have no notion of a delay — `XADD` is immediately
     * readable. Re-adding a failed message straight to the stream would spin it
     * against a dead relay as fast as the worker can loop. So a failure parks the job
     * here with `score = now + backoff`, and `promoteDue` moves it back when it is
     * ready. The score IS the schedule, which is what makes "what is waiting and for
     * how long" answerable with one `ZRANGEBYSCORE`.
     */
    retry: () => 'mail:retry',

    /**
     * Messages that exhausted their attempts.
     *
     * Kept rather than dropped, and a Stream rather than a List so entries carry
     * their own ids and timestamps. This is the difference between "the code never
     * arrived" being answerable and being a shrug: a message here has a full attempt
     * history and the error that finally retired it.
     */
    dlq: () => 'mail:dlq',

    /**
     * Compensations owed for mail that will never be delivered.
     *
     * Its own Stream with its own consumer group, and that is the point rather than an
     * implementation detail. Dead-lettering used to retire the source message and THEN
     * run the undo list from memory, so a crash in between left a user charged for an
     * email that no longer existed anywhere — no pending entry, no retry, and nothing
     * that recorded a refund was owed.
     *
     * Writing the undo record in the SAME atomic step that retires the message makes
     * the debt durable before the message stops existing. The group then gives the
     * retry for free: a record is acked only once every compensation in it has been
     * settled, so an unsettled one stays pending and `XAUTOCLAIM` brings it back.
     */
    undo: () => 'mail:undo',
    undoGroup: () => 'mail-undo-workers',

    /**
     * A once-only claim on one compensation within one undo record.
     *
     * Retrying an undo means it can run twice, and not every handler is safe under
     * that: `cache.refund` is a `DECR` and `registration.refund-otp-send` decrements a
     * column, so a redelivery would hand back MORE than was taken — which for a mail
     * budget means free sends. Handlers that are naturally idempotent (`quota.refund`
     * is a `ZREM`, `cache.clear` a `DEL`) do not take a claim and simply retry.
     *
     * Claimed BEFORE the handler runs, so the bias is at-most-once: a crash mid-handler
     * loses that one refund rather than applying it twice. Losing it costs the user one
     * slot on a window that expires anyway; applying it twice is an exploitable
     * discount.
     */
    undoClaim: (jobId: string, index: number) => `mail:undo:claim:${tag(jobId)}:${index}`,
  },

  // ─── pub/sub channels ─────────────────────────────────────────────────────
  //
  // Not keys — nothing is stored under these — but they share the namespace and the
  // same collision argument, so they are registered here rather than inlined.
  //
  // A channel is only ever a HINT to re-read. Redis pub/sub is fire-and-forget: a
  // subscriber that is reconnecting when a message is published never sees it, and
  // nothing replays it. So every consumer of these must have an independent way to
  // converge — a slow poll, a re-read on `ready` — and must treat the message as
  // "check now" rather than as the change itself. Publishing the new value here would
  // be a value that some instances have and others do not.
  channel: {
    /**
     * Published after a new rate-limit policy version is durably active.
     *
     * The policy snapshot lives in per-process memory rather than in Redis, so unlike
     * the blocklist there is no shared key to delete: convergence has to be pushed.
     * `RateLimitPolicyService` keeps a slow poll underneath this for exactly the
     * fire-and-forget reason above.
     */
    rateLimitPolicy: () => 'invalidate:rate-limit-policy',
  },
} as const;
