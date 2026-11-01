import type { QuotaEntry, RateLimit } from '../redis';
import { describeIssue, policySchema } from './limits.schema';

/**
 * ═══ THE RATE-LIMIT POLICY ══════════════════════════════════════════════════
 *
 * Every quota in the approved OREBiT User Authentication Rate-Limit Policy, in one
 * place, read through one accessor.
 *
 * ─── Why this is separate from auth.constants.ts ────────────────────────────
 *
 * `auth.constants.ts` holds product policy that a founder or a risk team changes on
 * a Tuesday — password length, token lifetimes, how many recovery codes to print.
 * Its values are read directly, as constants, and that is right for them.
 *
 * These are different in one specific way: the policy document requires them to
 * become *protected admin configuration* — versioned, audited, bounded, and
 * propagated to every API and worker instance without a deploy. That cannot be a
 * `const` anyone imports, because the value has to be able to change under a running
 * process.
 *
 * So the values live behind `policy()`. Today it returns a frozen default and costs
 * one property access. When the settings engine lands, `applyPolicyOverrides` is what
 * it calls, and not one call site changes. The seam is the whole point of the file:
 * putting it in now is cheap, and retrofitting it across forty call sites later is
 * not.
 *
 * ─── Why an accessor rather than a Nest provider ────────────────────────────
 *
 * A settings engine is asynchronous — it reads a table, watches for invalidation —
 * but a rate-limit check is on the request path and must not be. The resolution is
 * the same one every configuration system reaches: the engine maintains an in-memory
 * snapshot and swaps it atomically, and readers see a synchronous value that is at
 * most one invalidation stale. `policy()` is that read. Making it an injectable would
 * buy nothing and would put DI plumbing into pure functions like `ipClassOf`.
 */

/**
 * Several quotas are "N per hour AND M per rolling day", and both must pass.
 *
 * One value rather than two constants, because they are one decision: a reviewer
 * changing the hourly allowance needs the daily one in front of them, and two
 * separate constants are two places for them to drift apart. `QuotaService.consumeAll`
 * takes the whole set and charges it atomically — see the note there on why the pair
 * cannot be two round trips.
 */
export type RateLimitSet = readonly RateLimit[];

/**
 * Pair a quota set with the keys that hold it, ready for `QuotaService.consumeAll`.
 *
 * The keys are separate values because the hourly and daily halves of one budget live
 * under different names — see the `:day` twins in `redis/keys.ts` — and a sliding log
 * answers exactly one window length. Pairing them here rather than at each call site
 * keeps the order of the rules and the order of the keys under one assertion instead
 * of thirty.
 *
 * Throws on a length mismatch, which can only be a programming error: a set of two
 * rules given one key would silently enforce half the policy, and the half it dropped
 * would be whichever the author cared about least to check.
 */
export function quotaSet(rules: RateLimitSet, ...keys: readonly string[]): QuotaEntry[] {
  if (rules.length !== keys.length) {
    throw new Error(`quotaSet: ${rules.length} rules but ${keys.length} keys`);
  }
  return rules.map((rule, index) => ({ key: keys[index] as string, rule }));
}

/** Seconds, named so the tables below read as the policy document does. */
const SECOND = 1;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The approved values.
 *
 * Grouped by the policy document's own sections so a reviewer can hold the two side
 * by side. Anything here that duplicates a value in `auth.constants.ts` is a
 * transitional state: Phase 3 moves the call site onto this accessor and deletes the
 * constant, so there is never a period where two live values disagree.
 */
export const DEFAULTS = {
  /**
   * ─── the global safety net ────────────────────────────────────────────────
   *
   * Checked before any per-endpoint quota, so a caller hammering the service is
   * refused before it costs a database resolution, an argon2 hash, or a provider
   * call. This is step 2 of the policy's required OTP processing order, and it is
   * the only limit that applies to endpoints nobody thought to meter individually.
   */
  GLOBAL: {
    /** Unauthenticated traffic per IP. */
    PUBLIC_BY_IP: { limit: 60, windowSeconds: 1 * MINUTE } satisfies RateLimit,
    /** Authenticated traffic per IP — higher, because one NAT is one IP and its
     *  users have already proved who they are. */
    AUTHED_BY_IP: { limit: 300, windowSeconds: 1 * MINUTE } satisfies RateLimit,
    AUTHED_BY_ACCOUNT: { limit: 120, windowSeconds: 1 * MINUTE } satisfies RateLimit,
    /** The same account over ten seconds. Bounds the SHAPE of the traffic, which is
     *  what separates a person using the product from a loop that lost its guard. */
    BURST_BY_ACCOUNT: { limit: 30, windowSeconds: 10 * SECOND } satisfies RateLimit,
  },

  /**
   * ─── registration ─────────────────────────────────────────────────────────
   *
   * The tight per-IP value is the policy's own flagged risk, and it is implemented
   * as approved rather than softened here: offices, universities, hotels, VPNs and
   * mobile carriers put many legitimate users behind one address. What makes it
   * survivable is the device quota beside it, which separates those users from each
   * other — and that only works because the device cookie is signed. The policy also
   * asks for distinct-devices-per-IP to be tracked so this number can be revisited
   * with evidence rather than with anecdote.
   */
  REGISTRATION: {
    START_BY_EMAIL: [
      { limit: 4, windowSeconds: 1 * HOUR },
      { limit: 10, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,
    START_BY_IP: [
      { limit: 4, windowSeconds: 1 * HOUR },
      { limit: 10, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,
    START_BY_DEVICE: [
      { limit: 10, windowSeconds: 1 * HOUR },
      { limit: 24, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,
    /**
     * Codes actually EMAILED to one address, across every attempt for it.
     *
     * Keyed on the recipient rather than the registration, which is the fix for the
     * loophole that made restarting a signup reset the allowance. Charged only once
     * the mail queue has accepted the job, so a caller is never billed for a message
     * that was refused before it existed.
     */
    OTP_MAIL_BY_RECIPIENT: [
      { limit: 5, windowSeconds: 1 * HOUR },
      { limit: 20, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,
    /**
     * Referral-code lookups from one in-flight registration.
     *
     * Not in the approved table — it bounds an endpoint the table does not name — but
     * it is a rate limit, so it belongs under the same bounds, validation and audit as
     * the rest. What it stops is the referral endpoint being used to enumerate valid
     * codes: the check is unauthenticated by necessity, since the account does not
     * exist yet.
     */
    REFERRAL_CHECK: { limit: 20, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── credential changes ───────────────────────────────────────────────────
   *
   * Codes emailed to an account that is ALREADY signed in — setting a first password,
   * and changing an existing credential. Neither appears in the approved table, which
   * covers the unauthenticated doors; both are metered for the same reason those are,
   * so they live here rather than in `auth.constants.ts` where nothing could bound or
   * audit them.
   *
   * Tighter than the login-code budget on purpose: a user signing in may legitimately
   * need several codes across a session of bad connectivity, whereas changing a
   * credential is a deliberate act performed once. Five an hour covers a mistyped code
   * and a resend, and bounds a caller holding a stolen access token who would otherwise
   * use this as a mail cannon aimed at the account's own address.
   */
  CREDENTIAL: {
    /** The `set` action's emailed code — authenticated, so per account rather than
     *  per IP. A session is not a licence to send unlimited mail. */
    SET_CODE_BY_ACCOUNT: { limit: 5, windowSeconds: 1 * HOUR } satisfies RateLimit,
    /** Codes for changing a factor or a credential. */
    OTP_BY_ACCOUNT: { limit: 5, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── the password setting ─────────────────────────────────────────────────
   *
   * `src/settings/password/` owns three operations over one credential: create it
   * (`set`), replace it knowing the current one (`reset`), and replace it without
   * (`forgot`).
   *
   * ─── Why these are not covered by what already exists ─────────────────────
   *
   * Three things bound this surface today and none of them bounds the ATTEMPT:
   *
   *   `CREDENTIAL.OTP_BY_ACCOUNT` meters SENDING a code, five an hour. It says
   *   nothing about how many times a held code may be presented alongside a
   *   password guess.
   *
   *   `Credential.failedAttempts` is the durable lockout ladder, and it is the
   *   real defence on `reset` — but it only counts WRONG passwords. A caller who
   *   knows the password, or who is on the `set`/`forgot` paths where no password
   *   is presented, never touches it.
   *
   *   `MFA.REAUTH_FAIL_BY_SESSION` is keyed on the session and guards
   *   `POST /auth/2fa`. It is not charged by this route at all.
   *
   * So an authenticated caller holding one emailed code could sit on `reset`
   * guessing passwords until the ladder locked the account — which is itself the
   * damage, since locking an account out is a denial of service a stolen access
   * token should not be able to inflict. `MFA.REAUTH_FAIL_BY_SESSION` documents
   * exactly this hole on its own route.
   *
   * ─── Keyed on the ACCOUNT, not the session ────────────────────────────────
   *
   * For `SECURITY_SETTINGS.DISABLE_BY_ACCOUNT`'s reason: every one of these three
   * either sweeps the account's other sessions or creates the credential that
   * authenticates them, so a caller metered per session could reset their own
   * budget by signing in again. What is being guessed on the `reset` path is an
   * account-scoped secret.
   *
   * ─── Charged on ENTRY, and one bucket for all three ───────────────────────
   *
   * Entry, because a caller who abandons the request mid-flight has still cost an
   * argon2 hash and a database round trip — the discipline `PAYMENT_PIN.ENABLE_BY_ACCOUNT`
   * and `SECURITY_SETTINGS.DISABLE_BY_ACCOUNT` both state.
   *
   * ONE bucket rather than three, for `PAYMENT_PIN.VERIFY_BY_ACCOUNT`'s reason: a
   * per-action key would hand a caller thirty attempts per window while the limit
   * still read ten, and an attacker picks whichever action is cheapest regardless
   * of what the other two are keyed on.
   *
   * Ten per hour: a real person mistypes a code, requests another, and gets it
   * wrong once more — well inside ten — while ten is far too few to walk the
   * lockout ladder or grind a password. Deliberately looser than
   * `CREDENTIAL.OTP_BY_ACCOUNT` (5/hr), which is the tighter ceiling in practice
   * because every one of these operations needs a code that bucket has to have
   * sent.
   */
  PASSWORD: {
    /** Attempts at `set`, `reset` and `forgot` together, per account, on entry. */
    UPDATE_BY_ACCOUNT: { limit: 10, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── the security settings surfaces ──────────────────────────────────────
   *
   * `src/settings/` owns turning a second factor on and off as a SETTING: passkey
   * sign-in, and the authenticator app. Enabling either costs an emailed code, which
   * `CREDENTIAL.OTP_BY_ACCOUNT` already bounds. These two bound the disable side,
   * whose four alternative proof paths are what make it worth metering separately
   * from `MFA.REAUTH_FAIL_BY_SESSION`.
   *
   * ─── Why BOTH surfaces charge the SAME buckets ────────────────────────────
   *
   * Neither ceiling below is about which screen a request came from, and giving each
   * surface its own bucket would quietly double both of them:
   *
   *   `DISABLE_BY_ACCOUNT` is the only bound on guesses against a BACKUP CODE, and
   *   there is no durable backstop behind it. A backup code is an account-scoped
   *   secret and the same one satisfies either surface's `backup-code` path, so two
   *   buckets would hand an attacker ten guesses per fifteen minutes instead of five.
   *
   *   `KYC_REVERIFY_BY_ACCOUNT` is a hard ceiling on IMAGE REVERIFICATIONS — a
   *   third-party call, and a user being asked to photograph themselves. Two buckets
   *   would make a documented "twice a month" mean four times a month, which is the
   *   kind of drift a ceiling exists to prevent.
   *
   * Hence one section, named for the surfaces rather than for one of them. It was
   * `BIOMETRICS` while passkeys were the only screen; a section name that describes
   * half its callers is the defect the note on `DISABLE_BY_ACCOUNT` below complains
   * about in `MFA.REAUTH_FAIL_BY_SESSION`.
   */
  SECURITY_SETTINGS: {
    /**
     * Disable ATTEMPTS, per account, across BOTH surfaces — charged on entry, not on
     * failure.
     *
     * Named for what it does, unlike `MFA.REAUTH_FAIL_BY_SESSION`, which is charged
     * on entry despite its name. Entry is the right moment here and costs nothing in
     * practice: a successful disable turns the setting off, so there is no second
     * successful call for the budget to refuse.
     *
     * Keyed on the ACCOUNT rather than the session. Disabling sweeps every other
     * session, so a caller metered per session could reset their own budget by
     * signing in again — and what is being guessed on the cheapest path is a backup
     * code, which is an account-scoped secret.
     */
    DISABLE_BY_ACCOUNT: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,

    /**
     * KYC image reverifications, per account, across BOTH surfaces: `[daily, monthly]`.
     *
     * The one disable path that costs a third-party check and asks a user to
     * photograph themselves, so it is the one path with a hard ceiling rather than a
     * rate. Ordered tight-to-wide like every other set here.
     *
     * The monthly window is at `BOUNDS.MAX_WINDOW_SECONDS`, which is the longest a
     * sliding log may express. A cooldown longer than thirty days would need a
     * Postgres-backed timestamp instead — see the note on `BOUNDS`.
     */
    KYC_REVERIFY_BY_ACCOUNT: [
      { limit: 1, windowSeconds: 1 * DAY },
      { limit: 2, windowSeconds: 30 * DAY },
    ] satisfies RateLimitSet,

    /**
     * Deletion requests, per account.
     *
     * Tight, because there is no legitimate reason to reach this more than once: a
     * successful delete revokes every session, so a second call needs a whole new
     * sign-in and a whole new elevation ticket. The budget is really bounding a caller
     * who is failing — spending tickets against an account whose state keeps refusing
     * them — rather than one who is succeeding.
     *
     * Keyed on the ACCOUNT for `DISABLE_BY_ACCOUNT`'s reason, and more sharply: this
     * action ends every session, so a caller metered per session could reset their own
     * budget by signing in again.
     */
    DELETE_ACCOUNT_BY_ACCOUNT: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,

    /**
     * Reactivation, on the PUBLIC route: `[per address, per IP]`.
     *
     * ─── Why neither of these is keyed on an account ───────────────────────────
     *
     * Because the route is unauthenticated and must answer identically for an address
     * that has an account and one that does not. A budget keyed on a resolved `userId`
     * would be charged only when an account existed, turning throttling into an
     * existence oracle for anyone willing to send two requests. Both of these are
     * charged for every request, including the ones that resolve nothing. See
     * `KEYS.rate.accountReactivationByEmail`.
     *
     * The per-address limit is generous, because the legitimate user of this flow is
     * someone locked out and possibly panicking, who will retry. The per-IP limit is
     * the one that bounds an enumeration sweep: an attacker walking a list of addresses
     * never hits the per-address bucket, because the address changes every time.
     *
     * Ordered tight-to-wide like every other set here.
     */
    REACTIVATE_BY_EMAIL: { limit: 5, windowSeconds: 1 * HOUR } satisfies RateLimit,
    REACTIVATE_BY_IP: { limit: 20, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── the payment PIN ──────────────────────────────────────────────────────
   *
   * Its own section rather than a fourth entry in `SECURITY_SETTINGS`, because the
   * two surfaces above ration proofs of a factor and these ration something else
   * entirely: guesses at a six-digit secret, and how often a user may change it.
   * Folding them together would put a keyspace argument next to a mail-cost one.
   *
   * ─── Every key here is the ACCOUNT, and none is the session ────────────────
   *
   * The PIN is account state, so a caller metered per session could reset any of
   * these by signing in again — and on the `pin` verification path what is being
   * guessed is an account-scoped secret with a keyspace of one million. The same
   * argument `SECURITY_SETTINGS.DISABLE_BY_ACCOUNT` makes about backup codes.
   */
  PAYMENT_PIN: {
    /**
     * Enable attempts, charged on entry.
     *
     * Enabling costs an emailed code, which `CREDENTIAL.OTP_BY_ACCOUNT` already
     * bounds at five an hour — so this is not the mail budget. It bounds the
     * attempts themselves, each of which costs an argon2 hash, and it means a caller
     * holding a stolen access token cannot sit on this endpoint. Entry rather than
     * failure costs nothing in practice: a successful enable turns the setting on,
     * so there is no second successful call for the budget to refuse.
     */
    ENABLE_BY_ACCOUNT: { limit: 5, windowSeconds: 1 * HOUR } satisfies RateLimit,

    /**
     * Verification attempts, across ALL THREE methods, charged on entry.
     *
     * This is the only bound on guesses against the PIN itself. Six digits is a
     * keyspace of one million, which sounds large and is not: at five attempts per
     * fifteen minutes an attacker gets roughly 480 guesses a day, or one chance in
     * about 2,000 per day of a run. Nothing durable backstops it — unlike a password,
     * which has `Credential.lockedUntil` in Postgres behind the Redis quota — so the
     * window is deliberately the tightest in this file.
     *
     * ONE bucket for `pin`, `authenticator` and `passkey`, not three. A per-method key
     * would hand a caller fifteen guesses per fifteen minutes while the limit still
     * read "5 per 15 minutes", and the method a guesser picks is `pin` regardless of
     * what the other two are keyed on. Exactly the defect the note on
     * `SECURITY_SETTINGS` warns about.
     */
    VERIFY_BY_ACCOUNT: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,

    /**
     * PIN changes, per account: the product's "X updates per Y time".
     *
     * Charged through `QuotaService.consumeAll` rather than `CacheService.consume`,
     * which is the interesting part and the reason it is not simply a third entry
     * alongside the two above:
     *
     *   ROLLING, not fixed-window. A fixed window anchored at the first hit admits
     *   2 x limit across a boundary — three changes in the last minute of one day and
     *   three more in the first minute of the next. For a "three a day" that a user
     *   reads as a promise, six in two minutes is the limit not meaning what it says.
     *
     *   DURABLE store. A ceiling that a cache restart resets is not a ceiling, which
     *   is the same reason `KYC_REVERIFY_BY_ACCOUNT` is durable.
     *
     *   AN HONEST `Retry-After`. The sliding log knows when the oldest change ages
     *   out, so a refused user is told how long to wait rather than a window length
     *   rounded up — which for a 24-hour window is the difference between a usable
     *   message and a useless one.
     *
     * A bare `RateLimit` rather than a `RateLimitSet`, because it is one rule and the
     * call site builds its own single-entry list the way `SessionService.rateLimitRefresh`
     * does. If a second window is ever added — a monthly ceiling over the daily one —
     * this becomes a set and the call site moves to `quotaSet`.
     */
    UPDATE_BY_ACCOUNT: { limit: 3, windowSeconds: 1 * DAY } satisfies RateLimit,

    /**
     * How long a verified challenge stays spendable.
     *
     * Five minutes rather than the elevation ticket's sixty seconds, and the
     * difference is what happens between minting and spending. An elevation ticket is
     * spent by the next request; this one is spent after the user has read a "choose
     * a new PIN" screen, typed six digits, and typed them again to confirm. A minute
     * would refuse a legitimate user reaching for a password manager.
     *
     * Still short: the challenge is single-use and account-bound, so the window is
     * how long a leaked one is worth something, not how long an authorisation lasts.
     */
    CHALLENGE_TTL_SECONDS: 5 * MINUTE,
  },

  /**
   * ─── changing the account's email address ─────────────────────────────────
   *
   * Its own section rather than an extension of `SECURITY_SETTINGS`, because what is
   * being rationed is different in kind: not proofs of a factor, but MAIL SENT TO
   * ADDRESSES THE ACCOUNT DOES NOT OWN, and how often the account's primary identifier
   * may move.
   *
   * ─── The one that is not account-keyed, and why ───────────────────────────
   *
   * Every other budget in this file that meters outbound mail is keyed on
   * `user.emailLower` — the account's own address, which until now was always the
   * recipient too. An email change breaks that identity: the caller names the
   * destination. Inside a five-an-hour account allowance that turns an authenticated
   * endpoint into a low-volume mail cannon aimed at anybody, which is precisely the
   * hole `REGISTRATION.OTP_MAIL_BY_RECIPIENT` was written to close for signup.
   * `OTP_MAIL_BY_RECIPIENT` below is that same defence, and it is keyed on the
   * DESTINATION.
   */
  EMAIL_CHANGE: {
    /** Changes started, charged on entry. Bounds the ceremony itself; the mail it
     *  causes is bounded separately and per recipient. */
    START_BY_ACCOUNT: { limit: 5, windowSeconds: 1 * HOUR } satisfies RateLimit,

    /**
     * Codes re-sent INSIDE a ceremony that has already started.
     *
     * Its own bucket rather than `START_BY_ACCOUNT`, which it used to share, because
     * the two meter different things and sharing made the documented design
     * unreachable: `CHALLENGE_TTL_SECONDS` below is deliberately long "so a resend
     * fits inside one ceremony rather than forcing a restart", and a resend that
     * spends a start slot forces exactly the restart it was lengthened to avoid.
     *
     * The arithmetic is what made it a real ceiling rather than a theoretical one. A
     * failed verification spends the emailed codes before the factor is proved — it
     * has to, or a wrong code becomes a probe for whether the factor proof would have
     * passed — so recovering from one mistyped authenticator code costs two resends.
     * Out of a five-an-hour budget already holding the start, two mistakes locked the
     * account out of its own change for an hour.
     *
     * Six, so a three-target ceremony can be re-sent twice. Not unbounded, and not
     * relying on this number alone: `OTP_MAIL_BY_RECIPIENT` is the control that stops
     * a resend loop being aimed at somebody else's mailbox, and it is keyed on the
     * DESTINATION precisely so an account-keyed budget does not have to be.
     */
    RESEND_BY_ACCOUNT: { limit: 500, windowSeconds: 1 * HOUR } satisfies RateLimit,

    /** Verification attempts, across every method. One bucket, for the reason
     *  `PAYMENT_PIN.VERIFY_BY_ACCOUNT` gives: a per-method key would multiply the
     *  budget while the limit still read "5 per 15 minutes". */
    VERIFY_BY_ACCOUNT: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,

    /**
     * Completed changes, per account: the product's "X changes per Y time".
     *
     * Rolling and DURABLE, for `PAYMENT_PIN.UPDATE_BY_ACCOUNT`'s reasons — a fixed
     * window admits twice the budget across a boundary, and a ceiling a cache restart
     * resets is not a ceiling.
     *
     * The window is deliberately EQUAL to `EMAIL.RETENTION_DAYS`, and that equality is
     * load-bearing rather than tidy: one retention per change, at most two changes per
     * window, means at most one previous address is ever live at a change — which is
     * what makes three `ChallengePurpose` values enough. `EmailChangeService` asserts
     * the invariant and refuses to start rather than silently verifying fewer
     * addresses if the two numbers are ever changed apart.
     *
     * Charged on SUCCESS rather than on entry, unlike everything else here. This is a
     * product cap on how often the identifier moves, not an anti-abuse bound — those
     * are the two buckets above — so a failed ceremony must not spend one of two
     * monthly changes.
     */
    CHANGE_BY_ACCOUNT: { limit: 2, windowSeconds: 30 * DAY } satisfies RateLimit,

    /** Codes actually mailed to one DESTINATION address, across every account that
     *  names it. See the section note. */
    OTP_MAIL_BY_RECIPIENT: [
      { limit: 3, windowSeconds: 1 * HOUR },
      { limit: 10, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,

    /**
     * Recovery attempts from one network, charged on entry.
     *
     * Keyed on the IP and not the account, because at entry there IS no account: the
     * recovery route is reachable without a session — that is its whole purpose, since
     * a change sweeps every session and the address being recovered cannot sign in.
     * The account only becomes known once the ticket resolves, which is where
     * `RECOVER_BY_TOKEN` takes over.
     */
    RECOVER_BY_IP: { limit: 10, windowSeconds: 1 * HOUR } satisfies RateLimit,

    /** Verification attempts against one resolved recovery ticket. The per-account
     *  bound, applied as soon as there is an account to bound. */
    RECOVER_BY_TOKEN: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,

    /**
     * How long an in-flight change stays completable.
     *
     * Six times the payment-PIN challenge, because the user is not reading a screen and
     * typing — they are opening two or three different mailboxes, one of which may
     * deliver to spam. Longer than `OTP.TTL_SECONDS` on purpose, so a resend fits
     * inside one ceremony rather than forcing a restart.
     */
    CHALLENGE_TTL_SECONDS: 30 * MINUTE,
  },

  /**
   * ─── changing the account's username ──────────────────────────────────────
   *
   * Two buckets, neither of which is the free-change allowance.
   *
   * That allowance — N changes per M days, after which a change costs money — is
   * counted in POSTGRES, from `username_reservations.created_at`, inside the change's
   * own transaction. It is not here and must not be moved here. Every other quota in
   * this file bounds a cost we pay (mail, a provider call, argon2) or a guess we must
   * not permit; this one decides whether to charge the USER, and a sliding log that a
   * Redis restart resets would hand out free changes. The reservation rows are already
   * one-per-change and durable, so counting them is both cheaper and authoritative.
   *
   * What IS here is the pair of flood ceilings, and they are deliberately three orders
   * of magnitude apart because the two endpoints are not comparable.
   */
  USERNAME: {
    /**
     * The live availability probe, called on a ~300 ms debounce WHILE THE USER TYPES.
     *
     * 120 a minute is two a second sustained, which is generous on purpose: a debounced
     * field cannot legitimately exceed it, and a user who backspaces through a long
     * name should never see their own typing refused. Charged with `'allow'` — nothing
     * is spent by a check, and Postgres still decides who owns a name, so a Redis
     * outage must degrade this endpoint's metering rather than the endpoint.
     */
    CHECK_BY_ACCOUNT: { limit: 120, windowSeconds: 1 * MINUTE } satisfies RateLimit,

    /**
     * Attempts at the mutation, charged on entry and with `'deny'`.
     *
     * Ten an hour against an allowance of two per thirty days looks slack until you
     * notice what it is for: it is not the allowance, it is the bound on how many
     * advisory-locked transactions one caller can start. Most attempts here are
     * REFUSALS — the name was taken between the check and the save — and those cost a
     * lock and a transaction while consuming no allowance at all, so without this a
     * caller could hammer the write path for free.
     */
    UPDATE_BY_ACCOUNT: { limit: 10, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── the anti-phishing code ───────────────────────────────────────────────
   *
   * One bucket for `set`, `change` and `replace` together, charged on entry with
   * `'deny'`.
   *
   * ─── Why one bucket and not three ─────────────────────────────────────────
   *
   * `PAYMENT_PIN.VERIFY_BY_ACCOUNT`'s reason, which applies to every multi-action
   * route in this file: a per-action key would hand a caller thirty attempts per hour
   * while the number here still read ten, and an attacker picks whichever action is
   * cheapest regardless of what the other two are keyed on. Here the cheapest is
   * `replace`, which needs no `currentCode` at all.
   *
   * ─── What this bucket is actually for ─────────────────────────────────────
   *
   * NOT anti-guessing. There is no secret to guess: `change` compares a `currentCode`,
   * but `replace` performs the same write without one, so grinding the comparison buys
   * an attacker nothing they cannot already have. This is a flood ceiling on a route
   * that writes to `users` and spends an emailed code, and it is charged on entry
   * because a caller who abandons the request mid-flight has still cost a database read
   * and an AES open.
   *
   * Ten an hour, copied from `PASSWORD.UPDATE_BY_ACCOUNT`. In practice the binding
   * ceiling is `CREDENTIAL.OTP_BY_ACCOUNT` at five an hour, because every operation
   * here needs a code that bucket has to have sent first — so this is the looser of the
   * two by design, exactly as the password surface arranges it. No product value was
   * established for this number; see the note in the plan.
   */
  ANTI_PHISHING: {
    /** Attempts at `set`, `change` and `replace` together, per account, on entry. */
    UPDATE_BY_ACCOUNT: { limit: 10, windowSeconds: 1 * HOUR } satisfies RateLimit,
  },

  /**
   * ─── password login ───────────────────────────────────────────────────────
   *
   * Three buckets for one endpoint, charged at three different moments. The split is
   * the correctness fix: a failure quota charged on entry is not a failure quota, and
   * it punished users for signing in successfully. See the note in `redis/keys.ts`.
   */
  PASSWORD_LOGIN: {
    /** Every call, on entry. Bounds the work, says nothing about the outcome. */
    FLOOD_BY_IP: { limit: 60, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    /** Charged only after a wrong password is CONFIRMED. Cleared by a success. */
    FAIL_BY_ACCOUNT: { limit: 5, windowSeconds: 10 * MINUTE } satisfies RateLimit,
    /** The same per IP — one caller working through many accounts. NOT cleared by a
     *  success: one correct password says nothing about the other attempts. */
    FAIL_BY_IP: { limit: 24, windowSeconds: 10 * MINUTE } satisfies RateLimit,
    /** Identifiers that resolve to nothing — the signature of enumeration rather
     *  than of guessing. */
    UNKNOWN_BY_IP: { limit: 30, windowSeconds: 15 * MINUTE } satisfies RateLimit,
  },

  /**
   * ─── the login flow itself ────────────────────────────────────────────────
   *
   * ═══ REMOVED: `START_BY_IP` and `START_BY_DEVICE` ═════════════════════════
   *
   * They existed for exactly one release, and only because `POST /auth/login
   * {step:'start'}` did: that request presented no credential, wrote a row, and
   * had no limiter of its own, so it needed two.
   *
   * There is no such request now. A `LoginAttempt` is opened by the first REAL
   * login operation, and each of the three that can be first already charges a
   * limiter keyed on the same caller BEFORE the row is written:
   *
   *   `password`      `PASSWORD_LOGIN.FLOOD_BY_IP` — 60 per IP per 15 minutes,
   *                   charged on entry. And the row is opened later still, only
   *                   after the password verifies, so a wrong guess writes none.
   *   `otp-request`   `LOGIN_OTP.REQUEST_BY_IDENTIFIER` + `_BY_IP` + `_BY_DEVICE`,
   *                   all `deny`, all charged before anything else happens.
   *   `oauth-start`   `OAUTH.START_BY_IP` + `START_BY_DEVICE`, both `deny`.
   *
   * Keeping the old pair on top would bill one request twice for one write, which
   * is a real cost: the tighter of the two ceilings would start refusing sign-ins
   * that the endpoint's own limiter was sized to allow.
   *
   * ─── Why this is not weaker than before the whole migration ───────────────
   *
   * Worth stating because "we deleted a rate limit" reads badly on its own. Before
   * any of this, `password` also wrote a `LoginAttempt` — `challengeFor` created
   * one whenever a second factor was owed — and the only thing bounding that write
   * was `FLOOD_BY_IP`, exactly as now. The pair being removed guarded an endpoint
   * that no longer exists, not a write that still does.
   *
   * The one honest difference is that `FLOOD_BY_IP` is `allow` on cache failure,
   * so a Redis outage leaves row creation on the password path bounded only by
   * Postgres. That was true before this migration began, for the same reason it is
   * true now: the durable backstop is `Credential.failedAttempts` / `lockedUntil`,
   * and failing closed here would take sign-in down for everyone to prevent a
   * bounded number of short-lived rows.
   */
  LOGIN_FLOW: {
    /**
     * Every attempt to turn a `loginId` into a live row, from one IP.
     *
     * Deliberately separate from the credential buckets and deliberately generous:
     * one honest sign-in resolves the handle several times — password, then the
     * second factor, plus any `state` read in between — so a limit sized for
     * credential attempts would refuse ordinary use. What this stops is a caller
     * grinding guessed handles against the hash lookup, which is a different
     * activity with a different natural rate.
     *
     * `allow` on cache failure. It guards a read whose real defence is 256 bits of
     * entropy, so failing closed during an outage would break every in-flight
     * sign-in to prevent an attack that is not feasible anyway.
     */
    RESOLVE_BY_IP: { limit: 120, windowSeconds: 15 * MINUTE } satisfies RateLimit,
  },

  /**
   * ─── durable lockout ──────────────────────────────────────────────────────
   *
   * Postgres-backed, not Redis-backed, and the policy requires it to survive a cache
   * loss — which is exactly when brute force is most attractive.
   *
   * The ladder is what changed. A flat fifteen minutes lets a patient caller run
   * ninety-six lockout cycles a day against one account forever; escalating to an
   * hour and then to a day makes the third offence cost a hundred times the first,
   * while a real person who has genuinely forgotten their password waits the same
   * fifteen minutes they always did. The last rung repeats.
   */
  LOCKOUT: {
    MAX_FAILED_ATTEMPTS: 10,
    LADDER_SECONDS: [15 * MINUTE, 1 * HOUR, 1 * DAY] as readonly number[],
    /**
     * How long a strike is remembered.
     *
     * Longer than the longest rung, or the ladder resets between penalties and every
     * lock is the first one again — the same defect the CAPTCHA strike counter had.
     */
    STRIKE_TTL_SECONDS: 7 * DAY,
  },

  /**
   * ─── login email OTP ──────────────────────────────────────────────────────
   *
   * Request quotas apply even when no account exists, so the endpoint cannot be used
   * to tell the difference. The mail budget is charged separately and only when the
   * queue accepts a job — the policy's distinction between "asked for a code" and
   * "cost us a code".
   */
  LOGIN_OTP: {
    REQUEST_BY_IDENTIFIER: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    REQUEST_BY_IP: { limit: 20, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    REQUEST_BY_DEVICE: { limit: 8, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    MAIL_BY_ACCOUNT: [
      { limit: 5, windowSeconds: 15 * MINUTE },
      { limit: 25, windowSeconds: 1 * DAY },
    ] satisfies RateLimitSet,
  },

  /** ─── MFA, passkeys, and re-authentication ────────────────────────────── */
  MFA: {
    /** The whole ceremony, first factor to second. */
    CEREMONY_TTL_SECONDS: 15 * MINUTE,
    PROOF_ATTEMPTS: 5,
    PASSKEYS_PER_ACCOUNT: 5,
    /** Challenges one ceremony may mint. Above the proof cap deliberately — asking
     *  for a challenge is not a guess, and a reloaded tab or a switch from platform
     *  authenticator to security key legitimately costs one. */
    PASSKEY_CHALLENGES_PER_CEREMONY: 6,
    PASSKEY_CHALLENGE_TTL_SECONDS: 2 * MINUTE,
    /** FAILED re-auth proofs per session. */
    REAUTH_FAIL_BY_SESSION: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    /**
     * SUCCESSFUL elevation tickets per session.
     *
     * The companion to the failure bucket above, and not redundant with it: a caller
     * who holds the password can re-prove it at will and is never refused by a
     * failure quota, so without this a stolen access token is an unlimited supply of
     * single-use permits.
     */
    ELEVATION_ISSUED_BY_SESSION: { limit: 20, windowSeconds: 1 * HOUR } satisfies RateLimit,
    ELEVATION_TICKET_TTL_SECONDS: 60 * SECOND,
    RECOVERY_CODE_COUNT: 10,
  },

  /** ─── OAuth ───────────────────────────────────────────────────────────── */
  OAUTH: {
    START_BY_IP: { limit: 30, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    START_BY_DEVICE: { limit: 20, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    /** Tighter than start, because this is the leg that spends a provider token
     *  exchange. Invalid state/provider/purpose/device combinations count too. */
    CALLBACK_BY_IP: { limit: 10, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    CALLBACK_BY_DEVICE: { limit: 10, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    LINK_BY_ACCOUNT: { limit: 15, windowSeconds: 1 * HOUR } satisfies RateLimit,
    /** Failed confirmations — the shape of someone grinding `linkToken` values
     *  rather than attaching their own account. */
    LINK_FAIL_BY_ACCOUNT: { limit: 5, windowSeconds: 15 * MINUTE } satisfies RateLimit,
    STATE_TTL_SECONDS: 10 * MINUTE,
    PENDING_TTL_SECONDS: 30 * MINUTE,
  },

  /**
   * ─── CAPTCHA ──────────────────────────────────────────────────────────────
   *
   * The rungs are unchanged. What changes is the memory: twelve hours measured from
   * the NEWEST strike, not the first. Anchoring to the first strike let a sustained
   * campaign wait out the window and start again at rung one indefinitely, which is
   * an escalation ladder that never escalates.
   */
  CAPTCHA: {
    FAILURES_BY_IP: { limit: 10, windowSeconds: 5 * MINUTE } satisfies RateLimit,
    BLOCK_LADDER_SECONDS: [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 1 * HOUR] as readonly number[],
    STRIKE_TTL_SECONDS: 12 * HOUR,
  },

  /**
   * ─── sessions ─────────────────────────────────────────────────────────────
   *
   * The lifetimes here already match the policy and are held in
   * `auth.constants.ts SESSION`; only the quotas are new. Two refresh windows
   * because a tight one alone refuses a legitimate burst of concurrent tabs, and a
   * loose one alone lets a spinning client run all day just under the cap.
   */
  SESSION: {
    REFRESH_SHORT: { limit: 10, windowSeconds: 10 * MINUTE } satisfies RateLimit,
    REFRESH_HOURLY: { limit: 30, windowSeconds: 1 * HOUR } satisfies RateLimit,
    /** Logout, logout-all, revoke, trust and untrust together — the same kind of
     *  state-changing session administration, and nobody legitimately does ten in a
     *  minute. Charged against the session FAMILY, so refreshing does not reset it. */
    ADMIN_BY_FAMILY: { limit: 10, windowSeconds: 1 * MINUTE } satisfies RateLimit,
  },
};

export type Policy = typeof DEFAULTS;

/**
 * Make a policy object unwriteable, all the way down.
 *
 * ─── Why runtime freezing rather than `as const` ────────────────────────────
 *
 * `as const` would give the same protection through the type system and nothing at
 * runtime — and it would type every value as its own literal, so `FLOOD_BY_IP.limit`
 * would be the type `60` rather than `number`. A settings engine assigning 120 to it
 * would then be a type error, which is precisely backwards for the one value in this
 * file that is *meant* to change.
 *
 * Freezing inverts that. The type says "a number, which may change"; the runtime says
 * "not through this reference". Callers get a value they cannot corrupt by accident,
 * and the only supported way to change one is `applyPolicyOverrides`, which validates
 * first.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * The live values.
 *
 * `let`, and the only mutable binding in this file, because that is what the seam
 * requires: a settings engine has to be able to swap the snapshot under a running
 * process. Nothing outside `applyPolicyOverrides` may write it.
 */
let active: Policy = deepFreeze(DEFAULTS);

/**
 * Read the current policy.
 *
 * Call it at the point of use rather than destructuring it into a module constant —
 * a value captured at import time would survive an override and silently keep
 * enforcing the old number, which is the one failure mode this indirection exists to
 * prevent.
 */
export function policy(): Policy {
  return active;
}

/**
 * Bounds every configurable value must respect, whatever a settings engine says.
 *
 * The policy asks for "safe bounds", and this is where the phrase earns its keep: an
 * operator — or a bug in the engine, or a bad migration — must not be able to set a
 * limit to zero and lock every user out of the product, or to a million and turn the
 * quota off without anyone noticing. A value outside these is rejected and the
 * previous one stands.
 */
export const BOUNDS = {
  MIN_LIMIT: 1,
  MAX_LIMIT: 100_000,
  MIN_WINDOW_SECONDS: 1,
  /** Thirty days. A window longer than this is a ban, and a ban is a different
   *  mechanism with different review requirements. */
  MAX_WINDOW_SECONDS: 30 * DAY,
} as const;

/** Either a policy that passed every check, or the reasons it did not. */
export type PolicyValidation =
  | { readonly ok: true; readonly policy: Policy }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Check a candidate policy WITHOUT changing anything.
 *
 * ─── Why this is separate from committing it ────────────────────────────────
 *
 * Because the two have different failure consequences, and folding them together made
 * one of them unrecoverable. `activate` used to validate-and-swap, then persist — so a
 * failed transaction left THIS instance enforcing a policy that no other instance had,
 * that no audit row described, and that nobody could look up afterwards to find out
 * what the limits had briefly been.
 *
 * Split, the ordering that makes that impossible is available: validate, persist, and
 * only then swap. A configuration goes live only after it is durable, and a failure at
 * any step leaves every instance on the policy they were already agreeing on.
 *
 * Deliberately all-or-nothing rather than per-value: a half-applied policy is a
 * configuration nobody wrote and nobody reviewed, and it is worse than either the old
 * one or the new one.
 *
 * The audit record the policy requires — actor, old value, new value, time — belongs
 * to the caller that owns the change, not here. This function's whole responsibility
 * is deciding whether what was handed to it is a policy at all.
 */
export function validatePolicy(next: unknown): PolicyValidation {
  const parsed = policySchema().safeParse(next);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map(describeIssue) };
  }
  return { ok: true, policy: parsed.data as Policy };
}

/**
 * Swap the live policy. Only ever called with something `validatePolicy` accepted.
 *
 * Frozen on the way in, so what goes live cannot be mutated afterwards by whoever
 * built it — the caller's object and the active policy are the same reference.
 *
 * The assignment itself is the atomic part: readers hold no reference across it
 * because `policy()` is called at the point of use, so no request can see half of one
 * policy and half of another.
 */
export function commitPolicy(validated: Policy): void {
  active = deepFreeze(validated);
}

/**
 * Validate and, if it passes, commit. Returns the reasons it refused, empty when it
 * accepted.
 *
 * The one-step form, for callers with nothing to do between the two — tests, and
 * loading an already-persisted policy at boot. A caller that must persist first wants
 * `validatePolicy` and `commitPolicy` separately; see `RateLimitPolicyService`.
 */
export function applyPolicyOverrides(next: unknown): readonly string[] {
  const result = validatePolicy(next);
  if (!result.ok) return result.problems;
  commitPolicy(result.policy);
  return [];
}

/** Restore the shipped defaults. For tests, and for an operator backing out a bad
 *  configuration without a deploy. */
export function resetPolicy(): void {
  active = DEFAULTS;
}
