import { Logger } from '@nestjs/common';

/**
 * Test environment.
 *
 * Assigned at TOP LEVEL, before any import of `src/config.ts` can run. That file
 * parses `process.env` at import time and throws on anything missing, so setting
 * these inside a `beforeAll` would be too late — the throw happens while the
 * module graph is still loading.
 *
 * Values are fixed rather than random so a failure is reproducible, and they are
 * deliberately valid-but-useless: a real-shaped EC key that signs nothing of
 * value, a 32-byte AES key of zeros.
 */

/** A throwaway P-256 private key, PKCS#8 PEM, base64. Generated for tests only. */
const TEST_JWT_KEY = Buffer.from(
  `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`,
).toString('base64');

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3002';
process.env['LOG_LEVEL'] = 'fatal';
process.env['ADMIN_APP_URL'] = 'http://localhost:3000';

process.env['DATABASE_URL'] = 'postgresql://orebit:orebit@localhost:5432/orebit_test?schema=admin';
process.env['DATABASE_DIRECT_URL'] =
  'postgresql://orebit:orebit@localhost:5432/orebit_test?schema=admin';

process.env['REDIS_URL'] = 'redis://localhost:6379';
// The durable instance. No spec connects to either — the services under test take
// doubled clients — but `src/config.ts` parses at import and refuses to load without
// it, so the value has to exist before the module graph does.
process.env['REDIS_DURABLE_URL'] = 'redis://localhost:6380';

process.env['PASSWORD_PEPPER'] = 'test-pepper-that-is-long-enough-to-pass-validation';
process.env['JWT_PRIVATE_KEY'] = TEST_JWT_KEY;
process.env['TOTP_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
// A different fill byte from the TOTP key, deliberately: a spec that confused the two
// would pass against identical keys and fail in production against distinct ones.
process.env['OTP_QUEUE_KEY'] = Buffer.alloc(32, 11).toString('base64');
// A third distinct fill byte, for the same reason as the second.
process.env['BFF_SESSION_KEY'] = Buffer.alloc(32, 13).toString('base64');

process.env['WEBAUTHN_RP_ID'] = 'localhost';
process.env['WEBAUTHN_RP_NAME'] = 'Orebit Admin Test';

// No CAPTCHA_<PROVIDER>_SECRET for any provider: `config.captchaEnabled` is
// therefore false and the verifier short-circuits, which is what lets a login
// spec exercise the flow without stubbing an HTTP call to Cloudflare. The specs
// that care about captcha behaviour drive CaptchaService directly instead.
//
// Site keys without secrets are deliberate: a provider counts as live only when
// its SECRET is set, so these leave the provider list empty.
process.env['CAPTCHA_TURNSTILE_SITE_KEY'] = 'test-site-key';

process.env['MAIL_TRANSPORT'] = 'console';
process.env['SMTP_FROM'] = 'admin-no-reply@orebit.test';

// No R2_* values: `config.r2Enabled` is therefore false, which is what lets the
// country specs run without a bucket or a network. Setting only SOME of them would
// fail the combination rule in src/config.ts and take down every spec at import, so
// they are all absent rather than partially stubbed. The specs that care drive the
// storage port directly through a double.

// Empty: trust no proxy, so `req.ip` is the socket address. A spec that wants to
// exercise X-Forwarded-For resolution has to set this itself.
process.env['TRUSTED_PROXIES'] = '';
process.env['DOCS_ENABLED'] = 'false';

// Nest's logger writes to stdout on module init and would bury the reporter's
// output. Overridden rather than silenced globally so a spec that wants to assert
// on a log line still can, by installing its own spy.
Logger.overrideLogger({
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
  fatal: () => undefined,
});
