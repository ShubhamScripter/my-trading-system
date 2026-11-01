import { isIP } from 'node:net';
import { z } from 'zod';
import { CAPTCHA_PROVIDERS, type CaptchaProvider } from './captcha/captcha.types';

/**
 * Environment parsing. One schema, parsed once at import, exported frozen.
 *
 * Everything here is a secret or an infrastructure coordinate. Product
 * configuration — OTP lifetimes, attempt caps, cooldowns, password policy —
 * deliberately lives in auth/auth.constants.ts instead, because a deploy should
 * never be the mechanism for changing a cooldown. Those constants move to the
 * database settings engine when it lands; env vars could not.
 *
 * Parsing at import means a missing secret fails the process at boot with the
 * variable's name, not at 3am on the first request that happens to need it.
 */

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

/** Kept in sync with .env.example:24 — see the production check in `load()`. */
const PLACEHOLDER_PEPPER = 'change-me-to-a-random-32-plus-character-secret';

/** 32 raw bytes, base64. For keys where the length IS the security parameter, so
 *  it is checked here rather than where the key is consumed. */
const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64')
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must decode to exactly 32 bytes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_APP_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),

  /**
   * The DURABLE Redis instance — the mail queue lives here, and nothing else does.
   *
   * A second instance rather than a second database on the first, because the two
   * have opposite persistence requirements and one `redis.conf` cannot serve both.
   * `REDIS_URL` is a cache: `appendonly no`, `maxmemory 256mb`,
   * `maxmemory-policy allkeys-lru` — it is CONFIGURED to throw data away, which is
   * correct for rate-limit counters and wrong for a queued one-time code. This one is
   * `appendonly yes` with `appendfsync everysec` and `maxmemory-policy noeviction`, so
   * a queued message survives a restart and the server refuses writes rather than
   * silently evicting a job.
   *
   * Both are already in docker-compose (6379 and 6380); this is the variable that was
   * missing to reach the second one.
   *
   * Defaults to `REDIS_URL` when unset, which is deliberate and documented rather
   * than silent: a single-instance development machine keeps working, and
   * `MailQueue.onModuleInit` logs loudly that queued mail is only as durable as a
   * cache configured to evict it.
   */
  REDIS_DURABLE_URL: z.string().default(''),

  // 32 chars is the floor, not a stylistic preference: this is the argon2id
  // secret parameter, and a short value silently weakens every password hash.
  PASSWORD_PEPPER: z.string().min(32),

  // The ES256 signing key: a base64-encoded PKCS#8 PEM of an EC P-256 private key.
  // One key signs both token types; what separates an access token from a refresh
  // token is the `aud` claim, not the key — see auth/security/jwt.ts. Only the
  // private half lives here, and it is the only half configured anywhere: the
  // public point is computed in-process at boot because ECDSA verification needs
  // it, never stored and never handed out.
  //
  // Validated for *shape* only. Whether the bytes are an EC key on the right
  // curve is settled in jwt.ts, which is where the crypto already lives; this
  // file stays free of crypto imports and does what the rest of it does.
  JWT_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),

  // AES-256-GCM key for TOTP secrets at rest. Unlike every other secret in this
  // file its length is enforced EXACTLY, because AES-256 takes a 32-byte key and a
  // shorter value is not a weaker key — it is a runtime crash on the first
  // enrollment. Failing here means failing at boot instead.
  //
  // Rotating it orphans every enrolled authenticator: the ciphertext in
  // `totp_factors` can no longer be opened, and `openSecret` throws rather than
  // returning a wrong secret. That is the correct direction — a silent mis-decrypt
  // would reject every legitimate code with no indication why — but it means a
  // rotation is a migration, not a config change.
  TOTP_SECRET_KEY: base64Key32,

  /**
   * The TOTP key RING, as `{"<version>":"<base64 32 bytes>"}`.
   *
   * `TOTP_SECRET_KEY` above serves envelope versions 1 and 2 and cannot be rotated
   * without orphaning every enrolled authenticator. This is what makes rotation
   * possible: versions 3 and up take their key from here, `sealSecret` always uses
   * `TOTP_ACTIVE_KEY_VERSION`, and `needsReseal` re-encrypts each factor onto the
   * active key the next time its owner verifies a code. Rotating is therefore
   * "add a version, point the pointer at it, wait, drop the old key" rather than a
   * migration.
   *
   * Optional. Unset means no ring, and the active version must then be 1 or 2 —
   * which is exactly the pre-rotation state, so an existing deployment keeps working
   * without touching its environment.
   */
  TOTP_KEYS: z.string().default(''),

  /**
   * Which key `sealSecret` encrypts NEW secrets under. Cross-checked in `load()`:
   * it must name a key that actually exists, or every enrollment would crash.
   */
  TOTP_ACTIVE_KEY_VERSION: z.coerce.number().int().positive().default(2),

  /**
   * HMAC key for the rate-limit key registry — see `tag()` in redis/keys.ts.
   *
   * Those keys are derived from emails, identifiers and IP addresses. Under a plain
   * hash, anyone who can read a Redis dump can confirm whether a given address is in
   * it by hashing the address themselves: the input space is a dictionary, not a
   * secret, so the digest is only as private as the input is unguessable. An HMAC
   * makes the derivation depend on a value that is not in the dump.
   *
   * Required, with no default. A fallback to the unkeyed hash would leave the weak
   * path reachable in exactly the environment that forgot to set this.
   *
   * Rotating it re-namespaces every rate-limit and quota key at once, so every
   * counter starts from zero. That is a deliberate, one-time reset — not damage —
   * but it is a reason to rotate this on purpose rather than by accident.
   */
  RATE_LIMIT_KEY_SECRET: base64Key32,

  /**
   * AES-256-GCM key sealing the refresh token inside a browser's session record —
   * see `BffSessionService` in auth/security/bff.session.ts.
   *
   * The refresh token is a multi-day grant, so a dump of the Redis volume must not
   * hand it over. The handle the record is stored under is the envelope's AAD, which
   * is what stops a record being copied to another handle and opened there.
   *
   * Required, with no default: a fallback would mean the one environment that forgot
   * to set this is the one storing refresh tokens in the clear. Rotating it signs
   * everybody out — every sealed refresh token becomes unopenable — and nothing else,
   * because the record holds no other durable fact. That is an acceptable rotation,
   * unlike `TOTP_SECRET_KEY`, which is a migration.
   */
  BFF_SESSION_KEY: base64Key32,

  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().min(1),

  /**
   * A second relay, tried when the primary will not take a message.
   *
   * Optional and off by default — `smtpBackupEnabled` below is what turns it on,
   * following the `googleEnabled` precedent. It exists because email is the single
   * factor behind every account now that recovery is email-OTP login: a primary
   * outage is not "codes are slow", it is "nobody can sign in".
   */
  SMTP_BACKUP_HOST: z.string().default(''),
  SMTP_BACKUP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_BACKUP_USER: z.string().default(''),
  SMTP_BACKUP_PASSWORD: z.string().default(''),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),

  /**
   * ─── The four providers that are built but unverified ────────────────────
   *
   * Adapters exist for all of them (auth/oauth/) and none has been exercised
   * against live credentials. Every value below defaults to empty, and the
   * `*Enabled` flags at the bottom of this file are what decide whether a provider
   * is offered — an unconfigured one is refused with `oauth_provider_unsupported`
   * rather than failing inside an exchange. So shipping this costs nothing until
   * credentials are actually set.
   */

  /**
   * Apple. Four values rather than a client id and secret, because there IS no
   * static secret: Apple issues an EC private key and expects a short-lived ES256
   * assertion built from it. See `AppleAdapter.clientSecret`.
   *
   * `APPLE_CLIENT_ID` is the SERVICES id (e.g. `io.orebit.web`), not the app id —
   * a web sign-in uses the services identifier, and using the app id produces a
   * bare `invalid_client` from the token endpoint.
   */
  APPLE_CLIENT_ID: z.string().default(''),
  APPLE_TEAM_ID: z.string().default(''),
  APPLE_KEY_ID: z.string().default(''),
  /**
   * The `.p8` private key, base64-encoded.
   *
   * Base64 rather than the PEM verbatim, following `JWT_PRIVATE_KEY`. A PEM in an
   * env var has to survive newline escaping through a shell, a compose file and a
   * secret store, and the failure mode of getting that wrong is a key that parses
   * as garbage at the first sign-in. One encoding step removes the whole class.
   *
   * Shape only here; whether the bytes are a usable EC key is settled at the first
   * signature, in the adapter, which is where the crypto already lives.
   */
  APPLE_PRIVATE_KEY: z.string().default(''),
  APPLE_REDIRECT_URI: z.string().default(''),

  /** Facebook. `FACEBOOK_APP_SECRET` also keys `appsecret_proof` on the Graph call. */
  FACEBOOK_APP_ID: z.string().default(''),
  FACEBOOK_APP_SECRET: z.string().default(''),
  FACEBOOK_REDIRECT_URI: z.string().default(''),

  /** X. A confidential client — the secret goes in a Basic header, not the body. */
  X_CLIENT_ID: z.string().default(''),
  X_CLIENT_SECRET: z.string().default(''),
  X_REDIRECT_URI: z.string().default(''),

  /**
   * Telegram. One value, and no redirect URI: the callback URL is configured in
   * the bot's domain settings at Telegram rather than here, so there is nothing for
   * this service to compare a caller's value against.
   *
   * The bot token IS the signing secret — `SHA256(token)` keys the HMAC that
   * authenticates every Telegram login — so it is a credential of the same weight
   * as `JWT_PRIVATE_KEY`, not an identifier.
   */
  TELEGRAM_BOT_TOKEN: z.string().default(''),

  // WebAuthn relying-party identity. No scheme, no port — the registrable domain
  // only. A passkey is cryptographically BOUND to the RP ID it was registered
  // under, so changing this orphans every passkey already enrolled: it is
  // effectively permanent per environment, and the two refinements reject the two
  // mistakes people actually make when first setting it.
  WEBAUTHN_RP_ID: z
    .string()
    .min(1)
    .refine((v) => !v.includes('://'), 'must not include a scheme')
    .refine((v) => !v.includes(':'), 'must not include a port')
    .default('localhost'),
  /** Shown in the browser's passkey prompt. Cosmetic. */
  WEBAUTHN_RP_NAME: z.string().min(1).default('Orebit'),

  /**
   * One SITE KEY and one SECRET per provider.
   *
   * The site key is public by design — it ships to the browser either way — and is
   * held here so `GET /auth/captcha` can hand the login and registration pages the
   * key for whichever providers are live, instead of a second copy of this
   * deployment's configuration living in the frontend.
   *
   * The SECRET is what makes a provider live; see the derivation in `load()`.
   */
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

  /**
   * Comma-separated CIDRs of the proxies actually in front of this service.
   *
   * NOT a boolean. Fastify's `trustProxy: true` means "trust every hop", and what
   * it then returns is the *leftmost* `X-Forwarded-For` entry — the one the client
   * wrote. Since every rate limit here is keyed on `req.ip`, that setting hands
   * each caller their own private quota. Naming the proxies makes `proxy-addr`
   * walk inward from the right and stop at the first address we did not vouch for,
   * which is the only value in the chain the client could not choose.
   *
   * Empty (the default) means no proxy: trust the socket address alone.
   */
  TRUSTED_PROXIES: z.string().default(''),

  /**
   * Whether Cloudflare is the ingress, and its request headers may therefore be
   * believed.
   *
   * ═══ WHY THIS IS NOT DERIVED FROM `TRUSTED_PROXIES` ════════════════════════
   *
   * It is tempting to say "a non-empty proxy list means we are behind a proxy, so
   * trust the CF headers". That is wrong, and dangerously so. `TRUSTED_PROXIES`
   * establishes whose `X-Forwarded-For` decides `req.ip` — it says nothing about WHO
   * that proxy is. Behind a plain nginx, the operator has a perfectly correct
   * non-empty list, and a `CF-IPCountry` header written by the CLIENT passes straight
   * through nginx untouched and arrives looking exactly like Cloudflare's.
   *
   * The security-restriction evaluator reads country from that header. A caller who
   * can choose their own country can choose whether they look familiar, which is the
   * whole classification inverted by one forged header.
   *
   * So this is a separate, explicit declaration: "Cloudflare, specifically, is in
   * front of this process." Default OFF, like `TRUSTED_PROXIES` defaults to empty and
   * for the same reason — the failure of guessing wrong is silent.
   *
   * Enabling it is only correct when BOTH hold: Cloudflare is the ingress, AND
   * `TRUSTED_PROXIES` lists Cloudflare's published ranges (https://cloudflare.com/ips)
   * so `req.ip` is the real client rather than Cloudflare's edge.
   *
   * With it off, country is simply unknown — and unknown is never treated as "new",
   * so the evaluator degrades to IP and device evidence rather than misclassifying.
   */
  TRUST_CLOUDFLARE_HEADERS: bool.default('false'),

  /**
   * Serve the browsable API reference at /docs.
   *
   * No default here on purpose — the resolved value is `docsEnabled` below, which
   * falls back to "on everywhere except production". A full description of an
   * authentication API is a map of its doors: useful to a developer, and useful
   * to someone probing it. Opting production IN has to be a deliberate act.
   */
  DOCS_ENABLED: bool.optional(),
});

/**
 * ═══ THE PROXY LIST IS A TRUST BOUNDARY, SO IT GETS VALIDATED LIKE ONE ══════
 *
 * `@fastify/proxy-addr` names the ranges whose `X-Forwarded-For` we believe. Everything
 * in the service that refuses, meters or remembers a caller is keyed on the `req.ip`
 * that produces — every rate limit, the captcha penalty ladder, the login-attempt
 * device/network binding — so this string decides whether those controls act on an
 * address the client chose.
 *
 * It reached Fastify unvalidated. Three ways that went wrong, in increasing order of
 * how quietly:
 *
 *   MALFORMED — `proxy-addr` throws `invalid IP address: …` when Fastify compiles the
 *   list. That is a boot failure, so it was never a live hazard; it just arrived from
 *   inside a library, naming neither the variable nor the deployment that set it.
 *
 *   TOO BROAD — and this is the one that is silently dangerous. `proxy-addr` refuses a
 *   literal `0.0.0.0/0`, so "trust everything" cannot be written the obvious way — but
 *   `0.0.0.0/1` is accepted and is half the IPv4 internet, and a pair of `/1`s is the
 *   whole of it. Trust a range that contains the caller and `proxy-addr` walks the
 *   entire forwarded chain and hands back its LEFTMOST entry, which is the value the
 *   client wrote. Every per-IP control then meters a number the attacker picks.
 *
 *   EMPTY IN PRODUCTION — no error anywhere, and `trustProxy: false`. The socket
 *   address is used, which behind a load balancer is the balancer's, for everyone. Per
 *   IP limiting does not fail closed or open; it stops distinguishing callers at all,
 *   and one shared bucket looks exactly like a working rate limiter until someone
 *   tests it.
 *
 * ─── The breadth threshold, and why these numbers ──────────────────────────
 *
 * The one judgment call here. A proxy fleet is a handful of addresses or a provider's
 * published ranges, and those ranges are small: the widest block Cloudflare publishes
 * is a /12, and cloud load-balancer ranges are narrower still. A /8 is already sixteen
 * times wider than anything a real CDN asks you to trust, so anything shorter is a
 * misconfiguration rather than a deployment this service has. /32 for IPv6 is the same
 * judgment against a far larger space.
 *
 * Deliberately NOT a check that the union covers the whole internet: the dangerous
 * configuration is one that contains an arbitrary client, and a single over-wide entry
 * is already that.
 */
const NAMED_RANGES: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Shortest prefix a real proxy range is ever published with, per family. */
const MIN_PREFIX = { 4: 8, 6: 32 } as const;

/** The reason this entry is unusable, or null when it is fine. */
function trustedProxyProblem(entry: string, isProduction: boolean): string | null {
  // `proxy-addr`'s own vocabulary for the private ranges. All three are non-routable,
  // so they cannot contain an arbitrary internet client and need no breadth check.
  if (NAMED_RANGES.has(entry)) return null;

  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return `"${entry}" is not a valid IP address or CIDR`;

  if (slash === -1) return null; // A bare address is a single host: /32 or /128.

  const prefixText = entry.slice(slash + 1);
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    return `"${entry}" has an invalid prefix length (expected 0-${maxPrefix} for IPv${family})`;
  }

  // Breadth is a production rule only. A developer pointing at a wide range on a
  // laptop is not a trust boundary, and refusing it would be the kind of check that
  // gets worked around rather than fixed.
  if (isProduction && prefix < MIN_PREFIX[family === 4 ? 4 : 6]) {
    return (
      `"${entry}" trusts far too much of the internet (/${prefix} for IPv${family}); ` +
      `a trusted proxy range must be /${MIN_PREFIX[family === 4 ? 4 : 6]} or narrower, ` +
      'or the forwarded chain becomes client-controlled'
    );
  }

  return null;
}

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }

  const env = parsed.data;

  // Checked here rather than in the schema because it is a *combination* rule: an
  // SMTP host is required only when the SMTP transport is selected.
  if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST === '') {
    throw new Error('Invalid environment:\n  SMTP_HOST: required when MAIL_TRANSPORT=smtp');
  }

  // ─── the proxy trust boundary ────────────────────────────────────────────
  //
  // Parsed here rather than only in the returned object, because the value has to be
  // validated before anything is built from it. See `trustedProxyProblem`.
  const trustedProxies = env.TRUSTED_PROXIES.split(',')
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);

  const isProduction = env.NODE_ENV === 'production';

  // Syntax in every environment. This is not a new refusal — `proxy-addr` already threw
  // on these when Fastify compiled the list — it moves the failure to the place that
  // can name the variable, and ahead of anything else starting.
  for (const entry of trustedProxies) {
    const problem = trustedProxyProblem(entry, isProduction);
    if (problem !== null) {
      throw new Error(`Invalid environment:\n  TRUSTED_PROXIES: ${problem}`);
    }
  }

  // Empty is the correct default for a service reached directly, which is every
  // developer's laptop and every test run. In production it means `trustProxy: false`
  // and therefore the load balancer's address for every caller, which collapses every
  // per-IP control in the service into one shared bucket without erroring.
  if (isProduction && trustedProxies.length === 0) {
    throw new Error(
      'Invalid environment:\n  TRUSTED_PROXIES: required in production — list the CIDRs of the ' +
        'proxies in front of this service (e.g. your load balancer, or Cloudflare’s published ' +
        'ranges). Without it every per-IP rate limit keys on the proxy address and meters all ' +
        'traffic as one client.',
    );
  }

  // The console transport prints one-time codes to the log. That is exactly what
  // makes it useful in development and unacceptable anywhere else.
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'console') {
    throw new Error('Invalid environment:\n  MAIL_TRANSPORT: console is not permitted in production');
  }

  // `min(32)` cannot catch this one: the shipped placeholder is 46 characters, so
  // a deploy that copies .env.example unchanged passes validation and boots with a
  // pepper published in the repository. Since the pepper is argon2id's `secret`
  // parameter, a known value silently removes the protection it exists to add.
  if (env.NODE_ENV === 'production' && env.PASSWORD_PEPPER === PLACEHOLDER_PEPPER) {
    throw new Error(
      'Invalid environment:\n  PASSWORD_PEPPER: still the .env.example placeholder — generate a real secret',
    );
  }

  // The TOTP key ring, and the pointer into it.
  //
  // Built here rather than in the schema because the two variables constrain each
  // other: an active version naming a key that does not exist is a crash on the next
  // enrollment, and that has to fail at boot instead. Versions 1 and 2 are the
  // legacy envelope versions and are always served by TOTP_SECRET_KEY, so they are
  // seeded into the ring rather than special-cased at every read.
  const totpKeyRing = new Map<number, Buffer>();
  const legacyTotpKey = Buffer.from(env.TOTP_SECRET_KEY, 'base64');
  totpKeyRing.set(1, legacyTotpKey);
  totpKeyRing.set(2, legacyTotpKey);

  if (env.TOTP_KEYS !== '') {
    let ring: unknown;
    try {
      ring = JSON.parse(env.TOTP_KEYS);
    } catch {
      throw new Error('Invalid environment:\n  TOTP_KEYS: must be JSON');
    }
    if (typeof ring !== 'object' || ring === null || Array.isArray(ring)) {
      throw new Error('Invalid environment:\n  TOTP_KEYS: must be a JSON object of version -> base64 key');
    }
    for (const [rawVersion, rawKey] of Object.entries(ring)) {
      const version = Number(rawVersion);
      if (!Number.isInteger(version) || version < 3) {
        throw new Error(
          `Invalid environment:\n  TOTP_KEYS: "${rawVersion}" is not an integer version >= 3 ` +
            '(1 and 2 are the legacy envelope versions and are served by TOTP_SECRET_KEY)',
        );
      }
      const key = base64Key32.safeParse(rawKey);
      if (!key.success) {
        throw new Error(
          `Invalid environment:\n  TOTP_KEYS["${rawVersion}"]: ${key.error.issues[0]?.message ?? 'invalid key'}`,
        );
      }
      totpKeyRing.set(version, Buffer.from(key.data, 'base64'));
    }
  }

  if (!totpKeyRing.has(env.TOTP_ACTIVE_KEY_VERSION)) {
    throw new Error(
      `Invalid environment:\n  TOTP_ACTIVE_KEY_VERSION: ${env.TOTP_ACTIVE_KEY_VERSION} is not in the key ring ` +
        `(available: ${[...totpKeyRing.keys()].sort((a, b) => a - b).join(', ')})`,
    );
  }

  // Which providers are live. The SECRET is the test, because the secret is what
  // makes verification possible — a provider with only a site key would be
  // advertised to the login page and then refuse every token it produced.
  //
  // A Record rather than an array literal, so adding a provider to
  // CAPTCHA_PROVIDERS without giving it an env pair here fails the BUILD. An array
  // would compile fine and leave the new provider permanently unconfigurable.
  //
  // Order follows CAPTCHA_PROVIDERS so the list a page renders is stable across
  // restarts rather than depending on env iteration order. Same derivation as the
  // admin backend's, deliberately: the two services read the same toggle table, and
  // a difference here would make the same row mean different things.
  const captchaEnv: Record<CaptchaProvider, readonly [siteKey: string, secret: string]> = {
    TURNSTILE: [env.CAPTCHA_TURNSTILE_SITE_KEY, env.CAPTCHA_TURNSTILE_SECRET],
    RECAPTCHA_V2: [env.CAPTCHA_RECAPTCHA_V2_SITE_KEY, env.CAPTCHA_RECAPTCHA_V2_SECRET],
    RECAPTCHA_V3: [env.CAPTCHA_RECAPTCHA_V3_SITE_KEY, env.CAPTCHA_RECAPTCHA_V3_SECRET],
    HCAPTCHA: [env.CAPTCHA_HCAPTCHA_SITE_KEY, env.CAPTCHA_HCAPTCHA_SECRET],
  };

  const captchaProviders = CAPTCHA_PROVIDERS.filter(
    (provider) => captchaEnv[provider][1] !== '',
  ).map((provider) => ({ provider, siteKey: captchaEnv[provider][0] }));

  if (env.NODE_ENV === 'production') {
    // ALL FOUR secrets, not "at least one" as the admin requires. This service has
    // no `captchaEnabled` skip: `verify` always runs, so a missing secret here is
    // not a quieter deployment, it is an endpoint that 503s every token naming that
    // provider. Unchanged from before the toggle table existed.
    const missingSecrets = CAPTCHA_PROVIDERS.filter(
      (provider) => captchaEnv[provider][1] === '',
    ).map((provider) => `CAPTCHA_${provider}_SECRET`);

    if (missingSecrets.length > 0) {
      throw new Error(`Invalid environment:\n  ${missingSecrets.join(', ')}: required in production`);
    }

    // A live provider the browser cannot render is worse than one that is off:
    // `GET /auth/captcha` would offer it and the widget would fail to mount.
    const unrenderable = captchaProviders
      .filter(({ siteKey }) => siteKey === '')
      .map(({ provider }) => `CAPTCHA_${provider}_SITE_KEY`);

    if (unrenderable.length > 0) {
      throw new Error(
        `Invalid environment:\n  ${unrenderable.join(', ')}: required in production because` +
          ' the matching secret is set',
      );
    }
  }

  const captchaAllowedHostnames = [
    ...new Set(
      [new URL(env.WEB_APP_URL).hostname, ...env.CAPTCHA_ALLOWED_HOSTNAMES.split(',')]
        .map((hostname) => hostname.trim().toLowerCase())
        .filter((hostname) => hostname.length > 0),
    ),
  ];

  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    /** Explicit DOCS_ENABLED wins; otherwise on everywhere but production. */
    docsEnabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
    /**
     * Every live provider and its public site key, in `CAPTCHA_PROVIDERS` order.
     *
     * The ENV set — the widest this service will ever offer. What is actually
     * offered is this minus whatever an operator has disabled in
     * `admin.admin_captcha_providers`; see src/captcha/captcha.settings.ts.
     *
     * There is deliberately no `captchaEnabled` here, unlike the admin backend.
     * That flag exists there to let a developer sign in with no provider account,
     * and it gates a "skip verification" branch. This service has no such branch
     * and must not grow one: `verify` always runs.
     */
    captchaProviders,
    /** Google is offered only when both halves of the client are configured. */
    googleEnabled: env.GOOGLE_CLIENT_ID !== '' && env.GOOGLE_CLIENT_SECRET !== '',
    /**
     * Apple needs all four. A partial configuration is worse than none: the
     * authorization redirect would succeed and the failure would land at the token
     * exchange, after the user had already approved in Apple's dialog.
     */
    appleEnabled:
      env.APPLE_CLIENT_ID !== '' &&
      env.APPLE_TEAM_ID !== '' &&
      env.APPLE_KEY_ID !== '' &&
      env.APPLE_PRIVATE_KEY !== '',
    /** The `.p8` PEM, decoded once at boot. Every Apple exchange re-signs from it. */
    applePrivateKey: Buffer.from(env.APPLE_PRIVATE_KEY, 'base64').toString('utf8'),
    facebookEnabled: env.FACEBOOK_APP_ID !== '' && env.FACEBOOK_APP_SECRET !== '',
    xEnabled: env.X_CLIENT_ID !== '' && env.X_CLIENT_SECRET !== '',
    /** One value, so the flag is just its presence. */
    telegramEnabled: env.TELEGRAM_BOT_TOKEN !== '',
    /** Decoded once at boot; every TOTP seal/open reuses this buffer. */
    totpSecretKey: legacyTotpKey,
    /**
     * Envelope key version -> key. Versions 1 and 2 are `totpSecretKey`; 3 and up
     * come from `TOTP_KEYS`. `keyForVersion` in src/2fa/totp.ts reads exactly this.
     */
    totpKeyRing: totpKeyRing as ReadonlyMap<number, Buffer>,
    /** The version `sealSecret` writes. Guaranteed present in the ring — see `load()`. */
    totpActiveKeyVersion: env.TOTP_ACTIVE_KEY_VERSION,
    /** Decoded once at boot; `tag()` in redis/keys.ts HMACs every key with it. */
    rateLimitKeySecret: Buffer.from(env.RATE_LIMIT_KEY_SECRET, 'base64'),
    /** Decoded once at boot; every session-record seal/open in bff.session.ts uses it. */
    bffSessionKey: Buffer.from(env.BFF_SESSION_KEY, 'base64'),
    /**
     * The origin a passkey assertion must claim, derived from `WEB_APP_URL` rather
     * than configured separately. Two values that must agree — the RP ID is the
     * origin's registrable domain — are two values that can disagree, and the
     * failure mode is every passkey silently refusing to verify.
     */
    webauthnOrigin: new URL(env.WEB_APP_URL).origin,
    /** Hostnames whose provider-issued captcha tokens may be accepted. */
    captchaAllowedHostnames,
    /** A backup relay is configured, and the transport can use one. */
    smtpBackupEnabled: env.MAIL_TRANSPORT === 'smtp' && env.SMTP_BACKUP_HOST !== '',
    /** The durable instance, falling back to the cache — see `REDIS_DURABLE_URL`. */
    redisDurableUrl: env.REDIS_DURABLE_URL === '' ? env.REDIS_URL : env.REDIS_DURABLE_URL,
    /** False when the queue is sharing the cache instance, which is worth saying out
     *  loud at boot rather than discovering when a restart loses a code. */
    mailQueueIsDurable: env.REDIS_DURABLE_URL !== '',
    /** Proxy CIDRs to hand Fastify. Empty array = trust the socket address only, which
     *  `load` refuses in production. Validated above — see `trustedProxyProblem`. */
    trustedProxies,
    /**
     * Whether `CF-IPCountry` may be believed on this deployment.
     *
     * Requires BOTH the explicit declaration and a non-empty proxy list: with no
     * trusted proxy, `req.ip` is the socket address and nothing is in front of this
     * process to have written the header, so a `CF-IPCountry` arriving anyway was
     * written by the caller. Resolving the two flags together here means no caller has
     * to remember to check both.
     */
    trustCloudflareHeaders: env.TRUST_CLOUDFLARE_HEADERS && trustedProxies.length > 0,
  });
}

export type Config = ReturnType<typeof load>;

export const config: Config = load();
