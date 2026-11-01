import { Logger } from '@nestjs/common';

/**
 * Global Vitest setup. Runs before every spec file, in the same module graph.
 *
 * ─── Why the environment is assigned here and not in a .env ─────────────────
 *
 * src/config.ts parses `process.env` at *import* time and throws on a missing
 * secret. Any spec that reaches db/client.ts, redis/, or auth/security/jwt.ts —
 * which is most of them, transitively — therefore fails at the import statement
 * rather than in a test, with an error that names an environment variable and
 * looks nothing like the code under test.
 *
 * setupFiles run before a spec's imports are evaluated, so assigning at the top
 * level of this file is what makes that import succeed. The values are fixed
 * rather than defaulted from the ambient environment on purpose: a developer
 * with a real DATABASE_URL exported in their shell must not have their tests
 * quietly point at it, and the signing keys have to be deterministic for a test
 * that signs a token in one place and verifies it in another.
 *
 * The two P-256 keys below are fixed fixtures rather than generated here, and
 * that is not laziness: setupFiles run once per spec *file*, so a generated pair
 * would differ between files and any fixture committed alongside a token would
 * stop verifying. They are also deliberately distinct from each other — a spec
 * asserting that a refresh token is refused where an access token belongs is
 * asserting something about two different keys, and would pass vacuously if the
 * same key were pasted twice.
 *
 * Nothing here connects to anything. The Postgres and Redis URLs exist to
 * satisfy the schema; PrismaService and RedisService only dial on
 * `onModuleInit`, which a unit spec never triggers.
 */

Object.assign(process.env, {
  NODE_ENV: 'test',
  TZ: 'UTC',
  LOG_LEVEL: 'error',

  WEB_APP_URL: 'https://app.example.test',

  DATABASE_URL: 'postgresql://test:test@localhost:5432/orebit_test',
  DATABASE_DIRECT_URL: 'postgresql://test:test@localhost:5432/orebit_test',
  REDIS_URL: 'redis://localhost:6379',

  PASSWORD_PEPPER: 'test-password-pepper-must-be-at-least-32-characters',

  JWT_PRIVATE_KEY:
    'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lCQVFRZ2dHaFZLaW12bXBiTTJoSUwKMk9JeG5DK0JiZitmWVBwQUtqV1FQV3lHZXplaFJBTkNBQVNDK0xzVTRZa29HMGNyYnZVVFBoaTVVdm44UHNtTgpIa3M1M3FRaCttTi95TUNsWVdpM21raXYrcDBzRWFnd2JuNVBmUEVseHRNSVg4Ly84VjVWSGNjSwotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==',

  MAIL_TRANSPORT: 'console',
  SMTP_FROM: 'noreply@app.example.test',

  // Exactly 32 bytes, base64 — `config.ts` enforces the length, because AES-256
  // takes a 32-byte key and a shorter one is a runtime crash rather than a weaker
  // key. A fixed fixture rather than a generated one for the same reason the
  // signing keys above are: setupFiles run once per spec FILE, so a generated key
  // would differ between files and a secret sealed in one could not be opened in
  // another.
  //
  // Obviously not a secret. It never leaves this process — nothing in the suite
  // connects to a database, so nothing sealed with it is ever written anywhere.
  TOTP_SECRET_KEY: 'dGVzdC10b3RwLWtleS0zMi1ieXRlcy1leGFjdGx5ISE=',

  // The HMAC key behind every rate-limit key — see `tag()` in redis/keys.ts. Fixed
  // for the same reason as the keys above: setupFiles run once per spec FILE, and a
  // generated value would make the key a spec derives differ from the key another
  // one asserts on. Required with no default in config.ts, so without this line
  // every spec fails at import rather than at the first limited request.
  RATE_LIMIT_KEY_SECRET: 'dGVzdC1yYXRlLWxpbWl0LWtleS0zMi1ieXRlcyEhISE=',

  // The AES-256-GCM key sealing the refresh token inside a browser's session record —
  // see `BffSessionService`. Fixed, and required with no default in config.ts, so its
  // absence has exactly the consequence the line above warns about: every spec whose
  // module graph reaches src/config.ts fails at the IMPORT with "Invalid environment",
  // naming a variable and looking nothing like the code under test. That is most of
  // them transitively — src/http.ts imports config on line 4, so anything touching
  // `ProblemException` is included.
  BFF_SESSION_KEY: 'dGVzdC1iZmYtc2Vzc2lvbi1rZXktMzItYnl0ZXMhISE=',

  // WEBAUTHN_RP_ID and WEBAUTHN_RP_NAME are deliberately absent: both carry
  // defaults in config.ts, so leaving them out is also a test that those defaults
  // are enough to boot.

  // Present so `config.googleEnabled` is true and OauthService is reachable at
  // all — the registry refuses an unconfigured provider before anything else runs,
  // so without these the only testable behaviour is "not configured". Nothing dials
  // Google: the specs cover `start` (which only builds a URL and writes to a doubled
  // cache) and the state check on `callback`, which refuses before any exchange.
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://app.example.test/auth/google/callback',

  // Telegram is the one added provider whose verification is fully testable with no
  // credentials and no network: it is an HMAC over a payload, so a spec can sign a
  // fixture with this very token and assert the check accepts it — and that a single
  // tampered byte is refused. The other three need a live authorization round trip,
  // which is why they are deliberately left unconfigured here.
  TELEGRAM_BOT_TOKEN: '123456:test-bot-token-not-a-real-one',
});

/**
 * Nest's Logger writes to stdout through its own transport, so a service that
 * logs on a *deliberately provoked* failure path — the username collision retry
 * in UserService, the 500 branch of ProblemJsonFilter — prints a stack trace on
 * an entirely passing run.
 *
 * A silent LoggerService rather than `overrideLogger([])` or `false`: those set
 * static log levels that the console instance only reads if it already exists,
 * and at this point in a Vitest run it does not. Replacing the sink itself is
 * the form that does not depend on that ordering. Assertions never read the log.
 */
Logger.overrideLogger({
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
});
