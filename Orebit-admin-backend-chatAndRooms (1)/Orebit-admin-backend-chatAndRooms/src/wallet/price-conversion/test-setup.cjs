const { join } = require('node:path');
const Module = require('node:module');

process.env.NODE_PATH = join(__dirname, 'node_modules');
Module.Module._initPaths();

const jwtKey = Buffer.from(`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`).toString('base64');

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '3002',
  LOG_LEVEL: 'fatal',
  ADMIN_APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://orebit:orebit@127.0.0.1:1/unused_admin_test?schema=admin',
  DATABASE_DIRECT_URL: 'postgresql://orebit:orebit@127.0.0.1:1/unused_admin_test?schema=admin',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_DURABLE_URL: 'redis://127.0.0.1:1',
  PASSWORD_PEPPER: 'test-pepper-that-is-long-enough-to-pass-validation',
  JWT_PRIVATE_KEY: jwtKey,
  TOTP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  OTP_QUEUE_KEY: Buffer.alloc(32, 11).toString('base64'),
  BFF_SESSION_KEY: Buffer.alloc(32, 13).toString('base64'),
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Orebit Admin Test',
  MAIL_TRANSPORT: 'console',
  SMTP_FROM: 'admin-no-reply@orebit.test',
  TRUST_PROXY: 'false',
  DOCS_ENABLED: 'false',
});
