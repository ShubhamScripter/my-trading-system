import { z } from 'zod';
import { CAPTCHA_PROVIDERS, type CaptchaProvider } from './captcha/captcha.types';

/**
 * Environment parsing. One schema, parsed once at import, exported frozen.
 *
 * Everything here is a secret or an infrastructure coordinate. Product
 * configuration — OTP lifetimes, attempt caps, cooldowns, password policy, the
 * TOTP window — deliberately lives in auth/auth.constants.ts instead, because a
 * deploy should never be the mechanism for changing a cooldown.
 *
 * Parsing at import means a missing secret fails the process at boot with the
 * variable's name, not at 3am on the first request that happens to need it.
 */

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * One entry of `TRUSTED_PROXIES`: an IPv4/IPv6 address, either with a `/prefix`
 * or without, or one of the three subnet names `proxy-addr` understands.
 *
 * Deliberately a loose shape check rather than a full address parse. What it has
 * to catch is the mistake that matters — `true`, `1`, a hostname, a URL — because
 * `proxy-addr` compiles this list lazily and an unparseable entry becomes a 500
 * on every request instead of a boot failure. Whether `999.1.1.1` is a real
 * address is left to proxy-addr; whether the value is the right KIND of thing is
 * settled here.
 */
const PROXY_ENTRY = /^(?:loopback|linklocal|uniquelocal|[0-9a-fA-F:.]+(?:\/\d{1,3})?)$/;

/** Split, trim, drop blanks. Shared by the validator and the resolved value below
 *  so the two cannot disagree about what an entry is. */
function splitProxies(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 32 raw bytes, base64. Used for keys where the length is the security
 *  parameter, so it is checked here rather than where the key is consumed. */
const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64')
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must decode to exactly 32 bytes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ADMIN_APP_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1),
  /**
   * The Prisma connection-pool ceiling, applied as `connection_limit` on the
   * resolved `databaseUrl` below.
   *
   * It has to be applied explicitly, because Prisma's own default is
   * `num_physical_cpus * 2 + 1` and it reads that CPU count from the HOST rather
   * than from the container's cgroup limit. On a large node that is a pool sized
   * for hardware this process cannot use, multiplied by every replica, pointed at
   * one Postgres `max_connections`.
   *
   * Deliberately NOT applied to `DATABASE_DIRECT_URL`: that one is for
   * `prisma migrate`, which wants a direct connection and no pooling.
   */
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),

  /**
   * The DURABLE Redis instance — `redis-durable` in docker-compose.yml, port 6380.
   *
   * A second URL rather than a second logical database on the first, and the split is
   * load-bearing. `REDIS_URL` points at an instance configured `--save "" --appendonly
   * no --maxmemory-policy allkeys-lru`: everything on it is reconstructible and is
   * evicted freely under memory pressure. The OTP queue is neither. A sign-in code
   * silently evicted under load is a code that never arrives, and since the emailed
   * code is a mandatory second factor with no recovery flow behind it, that is an
   * admin locked out by a cache eviction.
   *
   * Two logical DBs on one instance would not help: `maxmemory-policy` and AOF are
   * server-wide, and a `FLUSHALL` aimed at the cache takes every DB with it.
   */
  REDIS_DURABLE_URL: z.string().min(1),

  // 32 chars is the floor, not a stylistic preference: this is the argon2id
  // secret parameter, and a short value silently weakens every password hash.
  //
  // Length is all that can be checked here. The two things that actually matter
  // about this value are combination rules and live in `load()` below: the
  // .env.example placeholder is refused in production, and the reason it has to be
  // caught BEFORE the first seed is that this value CANNOT BE ROTATED afterwards.
  PASSWORD_PEPPER: z.string().min(32),

  // The ES256 signing key: a base64-encoded PKCS#8 PEM of an EC P-256 private
  // key. One key signs both token types; what separates an access token from a
  // refresh token is the `aud` claim, not the key — see auth/security/jwt.ts.
  //
  // Validated for *shape* only. Whether the bytes are an EC key on the right
  // curve is settled in jwt.ts, which is where the crypto already lives; this
  // file stays free of crypto imports and does what the rest of it does.
  JWT_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),

  // AES-256-GCM key for TOTP secrets at rest. Unlike every other secret in this
  // file its length is enforced exactly, because AES-256 takes a 32-byte key and
  // a shorter value is not a weaker key — it is a runtime crash on the first
  // enrollment. Failing here means failing at boot instead.
  TOTP_SECRET_KEY: base64Key32,

  /**
   * AES-256-GCM key for queued OTP job payloads at rest.
   *
   * ─── Why a queued job is encrypted at all ──────────────────────────────────
   *
   * Because the job carries the CODE. Everywhere else in this service a one-time code
   * exists only as a peppered digest (`AdminChallenge.codeHash`) — the plaintext is
   * generated, emailed and forgotten inside one request. A queue breaks that: the code
   * has to survive in storage until a worker sends it, which is the first time a live
   * credential is written down anywhere. Encrypting it means a dump of `redis-durable`
   * — a far softer target than Postgres, with AOF files sitting in a volume — does not
   * hand over every in-flight sign-in code.
   *
   * Its own key rather than reusing `TOTP_SECRET_KEY`: those secrets have opposite
   * lifetimes (a TOTP secret lives for years, a queued code for ninety seconds), so
   * they should be rotatable independently. Reusing one key would make rotating it a
   * decision about both.
   *
   * Exactly 32 bytes, enforced here rather than at the call site, because AES-256 with
   * a short key is not a weaker cipher — it is a runtime crash on the first send.
   */
  OTP_QUEUE_KEY: base64Key32,

  /**
   * AES-256-GCM key for the refresh token held in a browser session record at rest.
   *
   * ─── Why the record is encrypted at all ────────────────────────────────────
   *
   * Because the browser no longer holds the refresh token — the backend does, on the
   * browser's behalf, keyed by the opaque `orebit_admin_session` handle. That moves a
   * twelve-hour grant of admin access out of a cookie and into Redis, which is the
   * softer of the two stores this service writes to: an AOF file in a volume rather
   * than a Postgres instance. Sealing it means a dump of that volume does not hand
   * over the ability to mint access tokens for every signed-in admin.
   *
   * The access token in the same record is NOT sealed. It lives fifteen minutes and
   * `assertLive` refuses it the moment its session is revoked, so the thing worth
   * protecting is the credential that outlives both — the same reasoning
   * `OTP_QUEUE_KEY` applies to a queued code versus the rest of its job.
   *
   * Its own key rather than reusing `OTP_QUEUE_KEY` or `TOTP_SECRET_KEY`, for the
   * reason recorded above: these three secrets have different lifetimes and must be
   * rotatable independently.
   *
   * Exactly 32 bytes, enforced at boot, because AES-256 with a short key is not a
   * weaker cipher — it is a runtime crash on the first sign-in.
   */
  BFF_SESSION_KEY: base64Key32,

  // No scheme, no port — the registrable domain only. A passkey is bound to the
  // RP ID it was registered under, so this is effectively permanent per
  // environment. The regex rejects the two mistakes people actually make.
  WEBAUTHN_RP_ID: z
    .string()
    .min(1)
    .refine((v) => !v.includes('://'), 'must not include a scheme')
    .refine((v) => !v.includes(':'), 'must not include a port'),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Orebit Admin'),

  // One site-key/secret pair per provider, and ANY NUMBER may be live at once.
  // A provider counts as live when its SECRET is set: the secret is what makes
  // verification possible, so anything else would advertise a provider whose
  // tokens the server could not check.
  //
  // Site keys are public by design — they ship to the browser. They live here
  // rather than in the frontend's own env so the server stays the single
  // authority on which providers are live; two copies would drift and every
  // verification would start failing.
  CAPTCHA_TURNSTILE_SITE_KEY: z.string().default(''),
  CAPTCHA_TURNSTILE_SECRET: z.string().default(''),
  CAPTCHA_RECAPTCHA_V2_SITE_KEY: z.string().default(''),
  CAPTCHA_RECAPTCHA_V2_SECRET: z.string().default(''),
  CAPTCHA_RECAPTCHA_V3_SITE_KEY: z.string().default(''),
  CAPTCHA_RECAPTCHA_V3_SECRET: z.string().default(''),
  CAPTCHA_HCAPTCHA_SITE_KEY: z.string().default(''),
  CAPTCHA_HCAPTCHA_SECRET: z.string().default(''),
  CAPTCHA_ALLOWED_HOSTNAMES: z.string().default(''),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
  CAPTCHA_RECAPTCHA_V3_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),

  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().min(1),

  /**
   * A second relay, tried when the primary will not take a message.
   *
   * Optional and off by default — `smtpBackupEnabled` below is what turns it on.
   * It exists because the emailed code is a MANDATORY second factor here and there
   * is no recovery flow behind it: a primary outage is not "codes are slow", it is
   * "no admin can sign in", with nothing to fall back to.
   *
   * Only an UNREACHABLE primary falls through to this. A rejected recipient does
   * not — see `MailService.send`.
   */
  SMTP_BACKUP_HOST: z.string().default(''),
  SMTP_BACKUP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_BACKUP_USER: z.string().default(''),
  SMTP_BACKUP_PASSWORD: z.string().default(''),

  /**
   * Proxies whose `X-Forwarded-For` is believed, as comma-separated CIDRs or IPs.
   * Empty — the default — trusts nobody and treats the socket address as the
   * client.
   *
   * A list rather than a boolean, deliberately. `trustProxy: true` trusts every
   * hop, which makes `proxy-addr` return the LEFTMOST XFF entry — the one the
   * client wrote. Since every rate limit and the whole captcha ladder are keyed on
   * that value, a boolean in the permissive position lets a caller pick a fresh
   * bucket per request. The resolved value is `trustedProxies` below.
   */
  TRUSTED_PROXIES: z
    .string()
    .default('')
    .refine(
      (v) => splitProxies(v).every((entry) => PROXY_ENTRY.test(entry)),
      'must be a comma-separated list of IPs or CIDRs (or loopback/linklocal/uniquelocal)',
    ),

  /**
   * Serve the browsable API reference at /docs.
   *
   * No default here on purpose — the resolved value is `docsEnabled` below, which
   * falls back to "on everywhere except production". A full description of an
   * admin authentication API is a map of its doors: useful to a developer, and
   * useful to someone probing it. Opting production IN has to be a deliberate act.
   */
  DOCS_ENABLED: bool.optional(),

  /**
   * ═══ OBJECT STORAGE — CLOUDFLARE R2 ═══════════════════════════════════════
   *
   * Where country flag assets are written and read from. R2 speaks the S3 API, so
   * these are ordinary S3 coordinates and `@aws-sdk/client-s3` is the client.
   *
   * All five default to '' rather than being required, so a developer with no bucket
   * can still boot, run the test suite and work on every other surface. `r2Enabled`
   * below is the resolved gate, and `load()` REFUSES TO BOOT in production when it is
   * false — the same shape `captchaEnabled` uses, and for the same reason: a storage
   * backend that silently is not there would turn every upload into a 503 discovered
   * by an operator rather than by a deploy.
   */

  /**
   * The S3 API host — `https://<account-id>.r2.cloudflarestorage.com`.
   *
   * NOT a public URL and never returned to a client. Objects are not readable from
   * here without a signature; `R2_PUBLIC_BASE_URL` is the one that serves them.
   */
  R2_ENDPOINT: z.string().url().or(z.literal('')).default(''),

  /** The bucket holding `countries/{ISO}/round.webp` and `.../square.webp`. */
  R2_BUCKET: z.string().default(''),

  R2_ACCESS_KEY_ID: z.string().default(''),

  /**
   * The liveness test for the whole feature — see `r2Enabled`. Never logged, never
   * placed in an error, never returned by any route.
   */
  R2_SECRET_ACCESS_KEY: z.string().default(''),

  /**
   * Where the bucket is served to the public: an r2.dev address or, preferably, a
   * custom domain in front of it.
   *
   * SEPARATE FROM `R2_ENDPOINT` on purpose, and the single most common way to
   * misconfigure this: the S3 endpoint authenticates every request and will not serve
   * a browser. Stored image KEYS are joined onto this at read time, which is what makes
   * a CDN move a config change instead of an UPDATE over every row.
   *
   * Validated as https-only, with no userinfo, query or fragment, in
   * src/country/country.storage.ts — a base URL carrying its own query string would
   * silently break the `?v=` cache-buster appended to it.
   */
  R2_PUBLIC_BASE_URL: z.string().url().or(z.literal('')).default(''),


  /**
   * ═══ SESSION CLOCK OVERRIDES — NON-PRODUCTION ONLY ═════════════════════════
   *
   * The session clocks are product policy and live in auth/auth.constants.ts, for
   * the reason that file's header gives: changing one should be a reviewable diff,
   * not an env var somebody set on a Tuesday. These three exist anyway, and for
   * exactly one job — making the inactivity logout observable by hand against a
   * running frontend. Nobody waits thirty minutes twice to watch a session expire,
   * so the real alternative to this is developers editing the constants locally and
   * occasionally committing the edit.
   *
   * `load()` REFUSES TO BOOT if any of them is set with NODE_ENV=production, which
   * is what makes them safe to ship. Unset — the normal case, and every test run —
   * the committed constants are used unchanged.
   *
   * Three rather than one because the clocks are COUPLED. Shortening the idle
   * window alone leaves the activity write interval above it, `touch` can then
   * never fire, and the session expires on schedule no matter how actively the
   * admin is clicking — a test that looks like it passes while proving nothing.
   * auth.constants.ts asserts the relationships and refuses a combination that
   * would lie in that way.
   */
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().optional(),
  SESSION_ACTIVITY_WRITE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  SESSION_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().optional(),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }

  const env = parsed.data;

  // Checked here rather than in the schema because these are *combination*
  // rules: each depends on the value of another variable.

  if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST === '') {
    throw new Error('Invalid environment:\n  SMTP_HOST: required when MAIL_TRANSPORT=smtp');
  }

  // The console transport prints one-time codes to the log. That is exactly what
  // makes it useful in development and unacceptable anywhere else.
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'console') {
    throw new Error(
      'Invalid environment:\n  MAIL_TRANSPORT: console is not permitted in production',
    );
  }

  // ═══ A SHORTENED SESSION CLOCK MUST NOT REACH PRODUCTION ═══════════════════
  //
  // Same shape of guard as the placeholder pepper below, and for a similar reason:
  // the dangerous value is one that works perfectly and silently weakens the thing
  // it configures. A two-minute idle window is invisible in a deploy log and looks
  // like an application bug from the outside. Every offender is named at once
  // rather than the first, so a misconfigured environment is fixed in one pass.
  const sessionOverrides = (
    [
      'SESSION_IDLE_SECONDS',
      'SESSION_ACTIVITY_WRITE_INTERVAL_SECONDS',
      'SESSION_ACCESS_TTL_SECONDS',
    ] as const
  ).filter((name) => env[name] !== undefined);

  if (env.NODE_ENV === 'production' && sessionOverrides.length > 0) {
    throw new Error(
      `Invalid environment:\n  ${sessionOverrides.join(', ')}: session clock overrides are for` +
        ' local testing only and must not be set in production. The committed values in' +
        ' auth/auth.constants.ts are the policy — change them there, in a reviewable diff.',
    );
  }

  /**
   * ═══ THE PLACEHOLDER PEPPER MUST NOT REACH PRODUCTION ══════════════════════
   *
   * `.env.example` ships a 44-character placeholder, which sails through
   * `min(32)`. A known pepper removes exactly the protection argon2id's `secret`
   * parameter exists to provide: it is what stops a stolen `admin_credentials`
   * table from being attacked offline with commodity hardware, and a value published
   * in this repository is not a secret.
   *
   * Caught at BOOT rather than by review, and specifically at boot BEFORE the first
   * `db:seed`, because the pepper cannot be rotated afterwards. It is argon2's
   * `secret`, not a salt — every stored hash is only verifiable with this exact
   * value, so changing it invalidates every admin password at once. There is
   * no self-service password recovery route, so an operator who discovers this
   * after seeding production has no remedy short of re-seeding.
   *
   * Compared against a list rather than one string, so the obvious near-misses fail
   * too. Not a substring or entropy check: this refuses KNOWN values, and pretending
   * to judge the quality of an unknown one would be theatre.
   */
  const KNOWN_PLACEHOLDER_PEPPERS = [
    'change-me-to-a-random-32-plus-character-secret',
    'change-me-to-a-random-32-plus-character-secret!',
    'test-pepper-that-is-long-enough-to-pass-validation',
  ];

  if (env.NODE_ENV === 'production' && KNOWN_PLACEHOLDER_PEPPERS.includes(env.PASSWORD_PEPPER)) {
    throw new Error(
      'Invalid environment:\n' +
        '  PASSWORD_PEPPER: this is the .env.example placeholder and is public.\n' +
        '    It is argon2id\'s `secret` parameter, so a known value removes the\n' +
        '    protection it exists to provide against an offline attack on a stolen\n' +
        '    credential table.\n' +
        '    Generate one with:  openssl rand -base64 36\n' +
        '    Set it BEFORE the first `npm run db:seed`. It CANNOT be rotated after\n' +
        '    an admin exists — every stored password hash is only verifiable with\n' +
        '    this exact value, so changing it locks out every admin at once.',
    );
  }

  // Which providers are live. The SECRET is the test, because the secret is what
  // makes verification possible — a provider with only a site key would be
  // advertised to the login page and then refuse every token it produced.
  //
  // Order follows CAPTCHA_PROVIDERS so the list a page renders is stable across
  // restarts rather than depending on env iteration order.
  // A Record rather than an array literal, so adding a provider to
  // CAPTCHA_PROVIDERS without giving it an env pair here fails the BUILD. An
  // array would compile fine and leave the new provider permanently unconfigurable.
  const captchaEnv: Record<CaptchaProvider, readonly [siteKey: string, secret: string]> = {
    TURNSTILE: [env.CAPTCHA_TURNSTILE_SITE_KEY, env.CAPTCHA_TURNSTILE_SECRET],
    RECAPTCHA_V2: [env.CAPTCHA_RECAPTCHA_V2_SITE_KEY, env.CAPTCHA_RECAPTCHA_V2_SECRET],
    RECAPTCHA_V3: [env.CAPTCHA_RECAPTCHA_V3_SITE_KEY, env.CAPTCHA_RECAPTCHA_V3_SECRET],
    HCAPTCHA: [env.CAPTCHA_HCAPTCHA_SITE_KEY, env.CAPTCHA_HCAPTCHA_SECRET],
  };

  const captchaProviders = CAPTCHA_PROVIDERS.filter(
    (provider) => captchaEnv[provider][1] !== '',
  ).map((provider) => ({ provider, siteKey: captchaEnv[provider][0] }));

  /**
   * Whether object storage is actually usable.
   *
   * Keyed on the SECRET, like `captchaEnabled` and `smtpBackupEnabled`: a bucket name
   * left in an env file cannot make the feature look configured when nothing can
   * authenticate to it.
   */
  const r2Enabled =
    env.R2_SECRET_ACCESS_KEY !== '' &&
    env.R2_ACCESS_KEY_ID !== '' &&
    env.R2_BUCKET !== '' &&
    env.R2_ENDPOINT !== '';

  // Checked here rather than in the schema because these are combination rules — a
  // partially configured bucket is the failure mode worth catching, since each
  // individual value is legitimately absent when the feature is off.
  const r2Values = [
    ['R2_ENDPOINT', env.R2_ENDPOINT],
    ['R2_BUCKET', env.R2_BUCKET],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
  ] as const;

  const r2Missing = r2Values.filter(([, value]) => value === '').map(([name]) => name);

  if (r2Missing.length > 0 && r2Missing.length < r2Values.length) {
    throw new Error(
      `Invalid environment:\n  ${r2Missing.join(', ')}: required once any other R2_* value` +
        ' is set — a half-configured bucket fails at the first upload, not at boot',
    );
  }

  // Serving an object needs a PUBLIC base URL, which the S3 endpoint is not. Without
  // it every stored key would resolve to nothing and the API would return null image
  // URLs for images that exist.
  if (r2Enabled && env.R2_PUBLIC_BASE_URL === '') {
    throw new Error(
      'Invalid environment:\n  R2_PUBLIC_BASE_URL: required when R2 is configured —' +
        ' R2_ENDPOINT is the authenticated S3 API and cannot serve images to a browser',
    );
  }

  if (env.NODE_ENV === 'production') {
    if (captchaProviders.length === 0) {
      throw new Error(
        'Invalid environment:\n  CAPTCHA_<PROVIDER>_SECRET: at least one captcha provider' +
          ' must be configured in production',
      );
    }

    // A live provider the browser cannot render is worse than one that is off:
    // `step: 'start'` would offer it and the widget would fail to mount.
    const unrenderable = captchaProviders
      .filter(({ siteKey }) => siteKey === '')
      .map(({ provider }) => `CAPTCHA_${provider}_SITE_KEY`);

    if (unrenderable.length > 0) {
      throw new Error(
        `Invalid environment:\n  ${unrenderable.join(', ')}: required in production because` +
          ' the matching secret is set',
      );
    }
 
    // Country flag images are served to every client that renders a country list, so a
    // production boot without a bucket would be a feature that 503s rather than one
    // that is off. Refused here for `captchaProviders`' reason.
    if (!r2Enabled) {
      throw new Error(
        'Invalid environment:\n  R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,' +
          ' R2_SECRET_ACCESS_KEY: object storage must be configured in production',
      );
    }
  }

  // Prisma resolves `_prisma_migrations` against the schema named by this
  // parameter. Without it this service and the main backend share one history
  // table and each reads the other's migrations as drift. Checked at boot rather
  // than left to `db:migrate`, because the failure it produces there is
  // confusing and arrives after something has already been written.
  for (const name of ['DATABASE_URL', 'DATABASE_DIRECT_URL'] as const) {
    if (!/[?&]schema=admin(&|$)/.test(env[name])) {
      throw new Error(
        `Invalid environment:\n  ${name}: must carry ?schema=admin — this service owns the` +
          ` \`admin\` Postgres schema and needs its own Prisma migration history`,
      );
    }
  }

  // ═══ ONE AUTHORITY FOR THE POOL SIZE ═══════════════════════════════════════
  //
  // `PG_POOL_MAX` is it. A `connection_limit` written into the URL as well would
  // be a second one, and the two can disagree — so rather than picking a silent
  // winner, this refuses. The failure an operator gets is a boot error naming both
  // places, which is the same contract the `?schema=admin` check above provides.
  if (/[?&]connection_limit=/.test(env.DATABASE_URL)) {
    throw new Error(
      'Invalid environment:\n' +
        '  DATABASE_URL: must not carry `connection_limit` — PG_POOL_MAX is the single\n' +
        '    authority for the pool size and is applied to this URL at boot. Remove the\n' +
        '    parameter and set PG_POOL_MAX instead, so there is one number to change.',
    );
  }

  /**
   * `DATABASE_URL` with the pool ceiling applied. This is what `PrismaService`
   * connects with; nothing should read the raw `DATABASE_URL` for a connection.
   *
   * Appended as a string rather than rebuilt through `URL`, so the userinfo — which
   * may carry a percent-encoded password — is never re-serialised. The URL always
   * has a query string already (`?schema=admin` is enforced above), but the
   * separator is still chosen rather than assumed.
   */
  const databaseUrl = `${env.DATABASE_URL}${env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=${env.PG_POOL_MAX}`;

  const trustedProxies: string[] = splitProxies(env.TRUSTED_PROXIES);

  const captchaAllowedHostnames = [
    ...new Set(
      [new URL(env.ADMIN_APP_URL).hostname, ...env.CAPTCHA_ALLOWED_HOSTNAMES.split(',')]
        .map((hostname) => hostname.trim().toLowerCase())
        .filter((hostname) => hostname.length > 0),
    ),
  ];

  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    /**
     * The connection string `PrismaService` actually uses: `DATABASE_URL` plus the
     * `connection_limit` that `PG_POOL_MAX` names. Prefer this over the raw
     * `DATABASE_URL` anywhere a pooled client is being constructed.
     */
    databaseUrl,
    /** Explicit DOCS_ENABLED wins; otherwise on everywhere but production. */
    docsEnabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    /**
     * Whether captcha verification actually runs.
     *
     * False when NO provider has a secret, which is what makes local development
     * workable without a provider account. Production cannot reach this state —
     * the check above refuses to boot with an empty provider list — so there is no
     * configuration in which this silently disables a live defence.
     */
    captchaEnabled: captchaProviders.length > 0,
    /** Every live provider and its public site key, in `CAPTCHA_PROVIDERS` order. */
    captchaProviders,
    /** Hostnames whose provider-issued captcha tokens may be accepted. */
    captchaAllowedHostnames,
    /** Decoded once at boot; every TOTP encrypt/decrypt reuses this buffer. */
    totpSecretKey: Buffer.from(env.TOTP_SECRET_KEY, 'base64'),
    /** Decoded once at boot; every OTP job envelope is sealed and opened with it. */
    otpQueueKey: Buffer.from(env.OTP_QUEUE_KEY, 'base64'),
    /** Decoded once at boot; every browser session record's refresh token is sealed
     *  and opened with it. */
    bffSessionKey: Buffer.from(env.BFF_SESSION_KEY, 'base64'),
    /**
     * Whether a second relay is built at all.
     *
     * Gated on the transport as well as the host, so a `SMTP_BACKUP_HOST` left in
     * an env file cannot quietly dial out while `MAIL_TRANSPORT=console` claims
     * nothing is being sent.
     */
    /**
     * Whether country flag uploads and public image URLs work at all.
     *
     * False only outside production — `load()` refuses to boot a production process
     * without a bucket. The upload route reports `country_image_storage_unavailable`
     * when this is false, rather than constructing a client that cannot sign.
     */
    r2Enabled,
    smtpBackupEnabled: env.MAIL_TRANSPORT === 'smtp' && env.SMTP_BACKUP_HOST !== '',
    /**
     * What `trustProxy` is set to in src/main.ts: the parsed list, or `false` when
     * none is configured.
     *
     * `false` rather than an empty array, because Fastify reads `[]` as a list that
     * trusts nothing but still enables XFF resolution, whereas `false` disables the
     * lookup entirely. Same outcome, one fewer moving part.
     */
    trustedProxies: trustedProxies.length > 0 ? trustedProxies : false,
  });
}

export type Config = ReturnType<typeof load>;

export const config: Config = load();
