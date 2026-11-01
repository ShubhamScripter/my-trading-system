import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic localhost module harness. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WalletConfigurationConflict, WalletLogoStorageUnavailable,
  WalletAuthorizationUnavailable } from '../wallet-core.errors.js';

const ID = '01950000-0000-7000-8000-000000000001';
const SESSION = '01950000-0000-7000-8000-000000000002';
const REQUEST = '01950000-0000-7000-8000-000000000003';
const USER_AGENT = 'OREBiT Wallet local test';
const ACCEPT_LANGUAGE = 'en-IN';
const PATH = '/v1/admin/wallet/core';
const providerCoin = {
  providerCoinId: '99', currencyName: 'USDT', tokenAddress: '0xtoken',
  blockchainPrecision: 18, isBaseCurrency: false, isStake: false, providerState: 'ACTIVATED',
  chain: { providerChainId: '42', name: 'BNB Smart Chain', shortName: 'BSC',
    isEvm: true, providerState: 'ACTIVATED' },
} as const;
const publicProviderCoin = {
  blockchainCatalogueCoinId: '99', currencyName: 'USDT', tokenAddress: '0xtoken',
  blockchainPrecision: 18, isBaseCurrency: false, isStake: false, providerState: 'ACTIVATED',
  chain: { blockchainCatalogueChainId: '42', name: 'BNB Smart Chain', shortName: 'BSC',
    isEvm: true, providerState: 'ACTIVATED' },
} as const;
const bootstrap = {
  currentRevision: '7',
  settings: {
    globalDesiredState: 'ON', catalogueMode: 'ALL', reconciliationIncludeTreasury: true,
    reconciliationIncludeCollection: false, reconciliationAlertPercent: '5',
    reconciliationAlertBasis: 'SIGNED',
    updatedAt: '2026-09-05T00:00:00.000000Z',
  },
  configuration: { live: null, scheduled: { items: [], total: 0 } },
  chains: [], currencies: { items: [], nextCursor: null }, activeAlerts: [],
  lastReconciliation: null,
  viewer: { displayTimezone: 'Asia/Kolkata' },
} as const;
const history = {
  items: [
    { category: 'CONFIGURATION', id: ID, createdAt: '2026-09-05T07:00:00.000000Z',
      actor: { kind: 'ADMIN', adminId: ID }, configuration: {
        id: ID, revision: '7', status: 'LIVE', reason: 'Local configuration.',
        changelogId: null, actorId: ID, effectiveAt: null,
        appliedAt: '2026-09-05T07:00:00.000000Z', createdAt: '2026-09-05T07:00:00.000000Z',
      } },
    { category: 'STATE', id: ID, createdAt: '2026-09-05T06:00:00.000000Z',
      actor: { kind: 'ADMIN', adminId: ID }, eventType: 'CHAIN.STATUS_CHANGED',
      subject: { type: 'CHAIN', id: ID }, fromState: 'ON', toState: 'MAINTAIN', reasonCode: null },
    { category: 'PROVIDER', id: ID, createdAt: '2026-09-05T05:00:00.000000Z',
      actor: null, eventType: 'PROVIDER_MAINTENANCE.ENTERED',
      subject: { type: 'CHAIN', id: ID }, fromState: 'ACTIVATED', toState: 'MAINTENANCE',
      beforeMaintenancePinned: null, afterMaintenancePinned: null },
    { category: 'ALERT', id: ID, createdAt: '2026-09-05T04:00:00.000000Z', actor: null,
      alertId: ID, alertCategory: 'CATALOGUE_REFRESH_FAILED', status: 'ACTIVE', currencyId: null },
    { category: 'RECONCILIATION', id: ID, createdAt: '2026-09-05T03:00:00.000000Z',
      actor: null, runId: ID, status: 'SUCCESS', scheduledFor: '2026-09-05T03:00:00.000000Z',
      completedAt: '2026-09-05T03:01:00.000000Z', currencyCount: 1, warningCount: 0,
      safeErrorCode: null },
    { category: 'FORFEITURE', id: ID, createdAt: '2026-09-05T02:00:00.000000Z',
      actor: null, executionId: ID, currencyId: ID, policyRevision: '7',
      status: 'COMPLETED', deadline: '2026-09-05T01:00:00.000000Z',
      processedCount: 1, skippedCount: 0, failedCount: 0, safeErrorCode: null },
    { category: 'JOB', id: ID, createdAt: '2026-09-05T01:00:00.000000Z', actor: null,
      jobName: 'wallet-test', scheduledFor: '2026-09-05T01:00:00.000000Z',
      status: 'SUCCESS', attemptCount: 1, processedCount: 1, failedCount: 0,
      safeErrorCode: null, leaseExpiresAt: null, finishedAt: '2026-09-05T01:01:00.000000Z' },
  ],
  nextCursor: null,
} as const;

function configureAuthEnvironment(): void {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  Object.assign(process.env, {
    NODE_ENV: 'test', ADMIN_APP_URL: 'http://127.0.0.1:3002',
    DATABASE_URL: 'postgresql://admin:x@127.0.0.1/admin?schema=admin',
    DATABASE_DIRECT_URL: 'postgresql://admin_owner:x@127.0.0.1/admin?schema=admin',
    REDIS_URL: 'redis://127.0.0.1:1', REDIS_DURABLE_URL: 'redis://127.0.0.1:1',
    PASSWORD_PEPPER: 'p'.repeat(32),
    JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    TOTP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    OTP_QUEUE_KEY: Buffer.alloc(32, 11).toString('base64'),
    BFF_SESSION_KEY: Buffer.alloc(32, 13).toString('base64'),
    WEBAUTHN_RP_ID: 'localhost', SMTP_FROM: 'wallet-test@orebit.invalid',
  });
}

async function load(path: string): Promise<Record<string, any> | undefined> {
  return import(path).catch(() => undefined) as Promise<Record<string, any> | undefined>;
}

type LocalApi = {
  baseUrl: string;
  tokens: Readonly<{ superAdmin: string; admin: string }>;
  calls: Array<readonly unknown[]>;
  close(): Promise<void>;
};

async function startLocalApi(): Promise<LocalApi> {
  configureAuthEnvironment();
  const [routes, service, filter, auth, jwt, elevation, http, audit, multipart, cookie] =
    await Promise.all([
      load('../wallet-core.routes.js'),
      load('../wallet-core.service.js'), load('../wallet-core.filter.js'),
      load('../../../../auth/security/guards.js'), load('../../../../auth/security/jwt.js'),
      load('../../../2fa/elevation.js'), load('../../../http.js'),
      load('../../../admin-audits/admin-audit.writer.service.js'), load('@fastify/multipart'),
      load('@fastify/cookie'),
    ]);
  assert.ok(routes?.WalletCoreRoutes && service?.WalletCoreService
    && filter?.WalletCoreExceptionFilter);
  assert.ok(auth?.AuthGuard && jwt?.signAccessToken && elevation?.ElevationGuard
    && http?.ProblemJsonFilter && multipart?.default && cookie?.default);
  const calls: Array<readonly unknown[]> = [];
  const spent = new Set<string>();
  const client = { query: async (sql: string) => {
    calls.push(['query', sql]);
    if (/SELECT.*timezone/is.test(sql)) {
      assert.match(sql, /FOR UPDATE OF settings/i);
      return { rows: [{ timezone: 'UTC', revision: 7 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const provider = {
    chains: async (query: unknown) => {
      calls.push(['chains', query]); return { revision: '7', items: [], nextCursor: null };
    },
    coins: async (chainId: string, query: unknown) => {
      calls.push(['coins', chainId, query]); return { revision: '7', items: [], nextCursor: null };
    },
    allCoins: async (query: unknown) => {
      calls.push(['allCoins', query]); return { revision: '7', items: [providerCoin], nextCursor: null };
    },
    refresh: async (...args: unknown[]) => {
      calls.push(['refresh', ...args]); return { revision: '8', itemCount: 1 };
    },
    recordFailure: async (...args: unknown[]) => { calls.push(['recordFailure', ...args]); },
  };
  const ports = {
    authorization: { require: async (principal: { role: string }, permission: string) => {
      calls.push(['permission', permission]);
      if (principal.role !== 'SUPER_ADMIN') throw new WalletAuthorizationUnavailable();
    } },
    bootstrap: { bootstrap: async (...args: unknown[]) => {
      calls.push(['bootstrap', ...args]); return bootstrap;
    } },
    writer: { updateAtomically: async (input: any, context: unknown) => {
      calls.push(['update', input, context]);
      if (input.expectedRevision === 999) throw new WalletConfigurationConflict(7);
      return { outcome: 'PUSHED', configurationId: ID, revision: '8', status: 'LIVE',
        appliedAt: '2026-09-05T09:00:00.000Z' };
    } },
    history: { history: async (query: unknown) => {
      calls.push(['history', query]); return history;
    } },
    provider,
    blockchain: { fetchCompleteCatalogue: async () => {
      calls.push(['fetch']); return { chains: [], coins: [], decodedBytes: 2 };
    } },
    identity: { nextUuidV7: () => {
      calls.push(['identity']); return '01950000-0000-7000-8000-000000000009';
    } },
    processor: { process: async (content: Buffer) => {
      if (content.equals(Buffer.from('service-failure'))) {
        throw new Error('PRIVATE_LOGO_SERVICE_FAILURE');
      }
      calls.push(['process', content]); return { content: content.equals(Buffer.from('storage-failure'))
        ? Buffer.from('storage-failure') : Buffer.from('webp'), sourceFormat: 'PNG',
        width: 300, height: 300, bytes: 4 };
    } },
    storage: {
      putWebp: async (...args: unknown[]) => {
        calls.push(['put', ...args]);
        if (Buffer.isBuffer(args[1]) && args[1].equals(Buffer.from('storage-failure'))) {
          throw new WalletLogoStorageUnavailable();
        }
      },
      delete: async (...args: unknown[]) => { calls.push(['delete', ...args]); },
      publicUrl: (key: string) => `https://assets.test.invalid/wallet/${key}`,
    },
    assets: {
      reserve: async (...args: unknown[]) => { calls.push(['reserve', ...args]); },
      markUploadedWithTransaction: async (...args: unknown[]) => {
        calls.push(['markUploaded', ...args]);
      },
      requestDeletion: async (...args: unknown[]) => { calls.push(['requestDeletion', ...args]); },
    },
    database: { schemas: { wallet: 'wallet_core_test', price: 'price_conversion_test',
      ledger: 'ledger_test', admin: 'admin_test' },
    transaction: async (work: (value: unknown) => Promise<unknown>) => work(client) },
    audit: { appendWithTransaction: async (...args: unknown[]) => {
      calls.push(['audit', ...args]); return { id: REQUEST, replayed: false };
    } },
  };
  const tokens = {
    superAdmin: jwt.signAccessToken({ adminId: ID, sessionId: SESSION, role: 'SUPER_ADMIN',
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000) }).token,
    admin: jwt.signAccessToken({ adminId: ID, sessionId: SESSION, role: 'ADMIN',
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000) }).token,
  };
  const sessions = { assertLive: async () => undefined, touch: async () => undefined };
  const authGuard = new auth.AuthGuard(
    sessions, { resolve: async (handle: string) => handle === 'valid-cookie'
      ? tokens.superAdmin : null }, new Reflector());
  const configurationTickets = new Set(['once', 'invalid-body', 'conflict']);
  const logoTickets = new Set([
    'logo', 'extra-logo', 'large-logo', 'wrong-type-logo', 'wrong-field-logo',
    'wrong-logo-scope', 'service-failure-logo', 'storage-failure-logo',
  ]);
  const elevationService = {
    spend: async (ticket: string | null, sessionId: string, action: string) => {
      const expected = ticket !== null && configurationTickets.has(ticket)
        ? 'wallet.core.configure' : ticket !== null && logoTickets.has(ticket)
          ? 'wallet.core.logo.upload' : null;
      if (ticket === null || spent.has(ticket) || sessionId !== SESSION || action !== expected) {
        throw new WalletAuthorizationUnavailable();
      }
      spent.add(ticket);
    },
  };
  const builder = Test.createTestingModule({
    controllers: [routes.WalletCoreRoutes],
    providers: [
      service.WalletCoreService, routes.WalletCorePermissionGuard,
      filter.WalletCoreExceptionFilter, Reflector,
      { provide: service.WALLET_CORE_AUTHORIZATION, useValue: ports.authorization },
      { provide: service.WALLET_CORE_BOOTSTRAP_REPOSITORY, useValue: ports.bootstrap },
      { provide: service.WALLET_CORE_CONFIGURATION_WRITER, useValue: ports.writer },
      { provide: service.WALLET_CORE_HISTORY_REPOSITORY, useValue: ports.history },
      { provide: service.WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY, useValue: ports.provider },
      { provide: service.WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT, useValue: ports.blockchain },
      { provide: service.WALLET_CORE_IDENTITY, useValue: ports.identity },
      { provide: service.WALLET_CORE_LOGO_PROCESSOR, useValue: ports.processor },
      { provide: service.WALLET_CORE_LOGO_STORAGE, useValue: ports.storage },
      { provide: service.WALLET_CORE_LOGO_ASSETS, useValue: ports.assets },
      { provide: service.WALLET_CORE_DATABASE, useValue: ports.database },
      { provide: audit?.ADMIN_AUDIT_PORT, useValue: ports.audit },
      { provide: auth.AuthGuard, useValue: authGuard },
      { provide: APP_GUARD, useExisting: auth.AuthGuard },
      { provide: elevation.ElevationGuard,
        useValue: new elevation.ElevationGuard(elevationService, new Reflector()) },
      { provide: elevation.ElevationService, useValue: elevationService },
    ],
  });
  const moduleRef = await builder.overrideGuard(elevation.ElevationGuard)
    .useValue(new elevation.ElevationGuard(elevationService, new Reflector())).compile();
  const adapter = new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024,
    genReqId: () => REQUEST });
  await adapter.getInstance().register(cookie.default);
  await adapter.getInstance().register(multipart.default, {
    limits: { fileSize: 1_048_576, files: 1, fields: 0, parts: 1 },
  });
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, { logger: false });
  app.useGlobalFilters(new http.ProblemJsonFilter());
  await app.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, calls,
    tokens,
    close: () => app.close(),
  };
}

let api: LocalApi;
before(async () => { api = await startLocalApi(); });
after(async () => { if (api) await api.close(); });

async function call(path: string, options: {
  method?: 'GET' | 'PATCH' | 'POST'; role?: 'superAdmin' | 'admin' | null;
  body?: unknown; elevation?: string; authorization?: string; cookie?: string;
} = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT, 'accept-language': ACCEPT_LANGUAGE, 'x-forwarded-for': '127.0.0.1',
  };
  const role = options.role === undefined ? 'superAdmin' : options.role;
  if (role !== null) headers.authorization = options.authorization ?? `Bearer ${api.tokens[role]}`;
  if (options.cookie) headers.cookie = `orebit_admin_session=${options.cookie}`;
  if (options.elevation) headers['x-elevation-ticket'] = options.elevation;
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers['content-type'] = 'application/json';
  }
  return fetch(api.baseUrl + path, {
    method: options.method ?? 'GET', headers,
    ...(options.body === undefined ? {} : {
      body: options.body instanceof FormData ? options.body : JSON.stringify(options.body),
    }),
  });
}

async function success(response: Response, data: unknown): Promise<void> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(await response.json(), { data });
}

async function problem(response: Response, status: number,
  type?: string): Promise<Record<string, unknown>> {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json/);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, status);
  assert.equal(body.requestId, REQUEST);
  if (type !== undefined) assert.equal(body.type, type);
  return body;
}

test('global Auth and permission guard protect every read while SUPER_ADMIN receives exact data', async () => {
  await problem(await call(PATH, { role: null }), 401);
  await problem(await call(PATH, { role: 'admin' }), 403);
  await success(await call(PATH + '?limit=2'), bootstrap);
  await success(await call(PATH + '/history?limit=7'), history);
  assert.deepEqual(history.items.map((item) => item.category),
    ['CONFIGURATION', 'STATE', 'PROVIDER', 'ALERT', 'RECONCILIATION', 'FORFEITURE', 'JOB']);
});

test('Wallet requires a valid Bearer bound to the cookie-authenticated principal', async () => {
  await problem(await call(PATH, { role: null, cookie: 'valid-cookie' }), 401,
    'unauthenticated');
  await problem(await call(PATH, { cookie: 'valid-cookie', authorization: 'Bearer invalid' }),
    401, 'token_invalid');
  await problem(await call(PATH, { cookie: 'valid-cookie',
    authorization: `Bearer ${api.tokens.admin}` }), 401, 'token_invalid');
});

test('configuration PATCH saves without elevation and maps invalid/conflict', async () => {
  const body = { action: 'PUSH', expectedRevision: 7, reason: 'Local apply.',
    config: { settings: { globalDesiredState: 'ON', catalogueMode: 'ALL',
      reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
      reconciliationAlertPercent: '5.000', defaultCurrencyIds: [] } } };
  await success(await call(PATH, { method: 'PATCH', body }), {
    outcome: 'PUSHED', configurationId: ID, revision: '8', status: 'LIVE',
    appliedAt: '2026-09-05T09:00:00.000Z',
  });
  await problem(await call(PATH, { method: 'PATCH', body: { ...body, raw: true },
    elevation: 'invalid-body' }), 400);
  const conflict = await problem(await call(PATH, { method: 'PATCH',
    body: { ...body, expectedRevision: 999 }, elevation: 'conflict' }), 409);
  assert.deepEqual(conflict.extra, { actualRevision: 7 });
});

test('catalogue chain/per-chain/flat pages and refresh require IMPORT but no elevation', async () => {
  await success(await call(PATH + '/provider-catalogue?limit=2'),
    { revision: '7', items: [], nextCursor: null });
  await success(await call(PATH + '/provider-catalogue?blockchainCatalogueChainId=42&limit=3'),
    { revision: '7', items: [], nextCursor: null });
  await success(await call(PATH + '/provider-catalogue/coins?limit=4'),
    { revision: '7', items: [publicProviderCoin], nextCursor: null });
  await success(await call(PATH + '/provider-catalogue/refresh', { method: 'POST' }),
    { revision: '8', itemCount: 1 });
  await problem(await call(PATH + '/provider-catalogue/refresh?force=true', { method: 'POST' }), 400);
  await problem(await call(PATH + '/provider-catalogue/refresh', {
    method: 'POST', body: { force: true },
  }), 400);
  assert.deepEqual(api.calls.filter((entry) => ['chains', 'coins', 'allCoins'].includes(String(entry[0]))),
    [['chains', { sortDirection: 'asc', limit: 2, sortBy: 'providerChainId' }],
      ['coins', '42', { sortDirection: 'asc', limit: 3, sortBy: 'providerCoinId' }],
      ['allCoins', { sortDirection: 'asc', limit: 4 }]]);
  assert.deepEqual(api.calls.filter((entry) => ['identity', 'fetch', 'refresh'].includes(String(entry[0])))
    .map((entry) => entry[0]), ['identity', 'fetch', 'refresh']);
});

test('logo accepts exactly one streamed multipart file and audits normalized safe metadata', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('png')], { type: 'image/png' }), 'logo.png');
  const response = await call(PATH + '/logos', { method: 'POST', body: form, elevation: 'logo' });
  const body = await response.json() as any;
  assert.equal(response.status, 200);
  assert.match(body.data.objectKey, /^[0-9a-f]{64}\.webp$/);
  const audit = api.calls.find((entry) => entry[0] === 'audit'
    && (entry[2] as any)?.action === 'LOGO.UPLOADED');
  assert.ok(audit);
  assert.deepEqual((audit[2] as any).after,
    { stored: true, mediaType: 'image/webp', width: 300, height: 300, bytes: 4 });

  const extra = new FormData();
  extra.append('file', new Blob([Buffer.from('a')], { type: 'image/png' }), 'a.png');
  extra.append('file', new Blob([Buffer.from('b')], { type: 'image/png' }), 'b.png');
  await problem(await call(PATH + '/logos', {
    method: 'POST', body: extra, elevation: 'extra-logo',
  }), 400);
  const oversized = new FormData();
  oversized.append('file', new Blob([Buffer.alloc(1_048_577)], { type: 'image/png' }), 'large.png');
  await problem(await call(PATH + '/logos', {
    method: 'POST', body: oversized, elevation: 'large-logo',
  }), 413);
  const wrongType = new FormData();
  wrongType.append('file', new Blob([Buffer.from('gif')], { type: 'image/gif' }), 'logo.gif');
  await problem(await call(PATH + '/logos', {
    method: 'POST', body: wrongType, elevation: 'wrong-type-logo',
  }), 400);
  const wrongField = new FormData();
  wrongField.append('logo', new Blob([Buffer.from('png')], { type: 'image/png' }), 'logo.png');
  await problem(await call(PATH + '/logos', {
    method: 'POST', body: wrongField, elevation: 'wrong-field-logo',
  }), 400);
});

test('logo service failures remain safe 500 responses outside multipart error mapping', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('service-failure')], {
    type: 'image/png',
  }), 'logo.png');
  const response = await call(PATH + '/logos', {
    method: 'POST', body: form, elevation: 'service-failure-logo',
  });
  const body = await problem(response, 500, 'internal_error');
  assert.equal(JSON.stringify(body).includes('PRIVATE_LOGO_SERVICE_FAILURE'), false);
});

test('logo storage failures return safe 503 and leave orphan metadata recoverable', async () => {
  const start = api.calls.length;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('storage-failure')], {
    type: 'image/png',
  }), 'logo.png');
  const body = await problem(await call(PATH + '/logos', {
    method: 'POST', body: form, elevation: 'storage-failure-logo',
  }), 503, 'wallet_logo_storage_unavailable');
  const attempt = api.calls.slice(start);
  assert.equal('detail' in (body as Record<string, unknown>), false);
  assert.equal(attempt.some((entry) => entry[0] === 'reserve'), true);
  assert.equal(attempt.some((entry) => entry[0] === 'requestDeletion'), true);
  assert.equal(attempt.some((entry) => entry[0] === 'audit'), false);
  assert.equal(attempt.some((entry) => entry[0] === 'markUploaded'), false);
});

test('timezone preference is strict, unelevated, and audited with the request actor', async () => {
  await success(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'Asia/Kolkata' },
  }), { timezone: 'Asia/Kolkata' });
  await problem(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'Mars/Olympus' },
  }), 400, 'wallet_preference_invalid');
  await problem(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'UTC', extra: true },
  }), 400, 'wallet_preference_invalid');
  const audit = api.calls.find((entry) => entry[0] === 'audit'
    && (entry[2] as any)?.action === 'ADMIN_TIMEZONE.UPDATED');
  assert.ok(audit);
  assert.deepEqual((audit[2] as any).subject, { type: 'ADMIN', id: ID });
  assert.deepEqual((audit[2] as any).before, { timezone: 'UTC' });
  assert.deepEqual((audit[2] as any).after, { timezone: 'Asia/Kolkata' });
  assert.deepEqual((audit[2] as any).metadata, { configurationRevision: 7 });
  assert.equal((audit[2] as any).actor.deviceId,
    createHash('sha256').update(`${USER_AGENT}|${ACCEPT_LANGUAGE}`).digest('hex').slice(0, 32));
});
