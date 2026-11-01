import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic localhost module harness. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import { WalletLogoAssetRepository } from '../logo-asset.repository.js';
import { LocalWalletLogoStorage } from '../logo-storage.js';
import { ProviderCatalogueRepository } from '../provider-catalogue.repository.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS } from '../wallet-core.database.js';
import { WalletCoreHistoryRepository } from '../wallet-core.history-repository.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import { WALLET_CORE_DEFAULT_LOGO_PROCESSOR } from '../wallet-core.service.js';
import { WalletAuthorizationUnavailable } from '../wallet-core.errors.js';

const ID = '01950000-0000-7000-8000-000000000001';
const SESSION = '01950000-0000-7000-8000-000000000002';
const REQUEST = '01950000-0000-7000-8000-000000000003';
const USER_AGENT = 'OREBiT Wallet local test';
const ACCEPT_LANGUAGE = 'en-IN';
const PATH = '/v1/admin/wallet/core';
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const ENTITY = { chain: '01950000-0000-7000-8000-000000000101',
  currency: '01950000-0000-7000-8000-000000000102',
  binding: '01950000-0000-7000-8000-000000000103' } as const;
const sharp = createRequire(__filename)('sharp') as (input: unknown) => { png(): { toBuffer(): Promise<Buffer> } };
const settings = { globalDesiredState: 'ON', catalogueMode: 'ALL',
  reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
  reconciliationAlertPercent: '5.000', defaultCurrencyIds: [] } as const;
const pushedConfig = { settings, chains: [{ id: ENTITY.chain, blockchainCatalogueChainId: 990001,
  blockchainRequestReference: 'QA Chain',
  name: 'QA Chain', shortName: 'QAC', isEvm: true, availableFor: 'BOTH', desiredState: 'ON' }],
currencies: [{ id: ENTITY.currency, symbol: 'QACOIN', name: 'QA Coin',
  priceProviderReferences: ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'].map(provider => ({ provider,
    providerAssetId: `qa-${provider.toLowerCase()}`, providerSymbol: 'QACOIN' })), viewEnabled: true,
  geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH',
  listingKind: 'PERMANENT', showBeforeListing: false, premiumOperations: [], soOperations: [],
  postDelistOperations: [], desiredState: 'ON', maintenanceAudiences: [],
  showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{ id: ENTITY.binding,
    chainId: ENTITY.chain, blockchainCatalogueCoinId: 990002,
    blockchainRequestReference: 'QA Coin',
    isToken: false, blockchainPrecision: 18,
    desiredState: 'ON', hotWalletAddresses: [' 0xAbC '], coldWalletAddresses: ['0xDef'],
    stakingWalletAddresses: ['0xabc'] }] }] } as const;

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

export type QaAdminLiveApi = {
  baseUrl: string;
  tokens: Readonly<{ superAdmin: string; admin: string }>;
  calls: Array<readonly unknown[]>;
  query(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
};

async function startLocalApi(failAfterConnect = false): Promise<QaAdminLiveApi> {
  configureAuthEnvironment();
  const [routes, service, filter, auth, jwt, elevation, http, audit, multipart] =
    await Promise.all([
      load('../wallet-core.routes.js'),
      load('../wallet-core.service.js'), load('../wallet-core.filter.js'),
      load('../../../../auth/security/guards.js'), load('../../../../auth/security/jwt.js'),
      load('../../../2fa/elevation.js'), load('../../../http.js'),
      load('../../../admin-audits/admin-audit.writer.service.js'), load('@fastify/multipart'),
    ]);
  assert.ok(routes?.WalletCoreRoutes && service?.WalletCoreService
    && filter?.WalletCoreExceptionFilter);
  assert.ok(auth?.AuthGuard && jwt?.signAccessToken && elevation?.ElevationGuard
    && http?.ProblemJsonFilter && multipart?.default);
  const calls: Array<readonly unknown[]> = [];
  const spent = new Set<string>();
  const connectionString = process.env.WALLET_CORE_TEST_DATABASE_URL;
  assert.equal(connectionString, TEST_URL);
  const raw = new pg.Client({ connectionString,
    application_name: failAfterConnect ? 'qa-admin-live-failure' : 'qa-admin-live' });
  let logoRoot: string | undefined;
  let app: NestFastifyApplication | undefined;
  await raw.connect();
  try {
  const identity = (await raw.query(`SELECT current_database() database,current_user username,
    inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
  assert.deepEqual(identity, { database: 'orebit_wallet_core_test',
    username: 'orebit_wallet_core_test_owner', port: 5432, system_id: '7681719399426031650' });
  await raw.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  if (failAfterConnect) throw new Error('QA_SETUP_FAILURE_PROBE');
  let savepoint = 0;
  const client = { async query(sql: string, values?: readonly unknown[]) {
    calls.push(['query', sql]);
    if (sql === 'BEGIN') { savepoint += 1; return raw.query(`SAVEPOINT qa_admin_${savepoint}`); }
    if (/^SET TRANSACTION ISOLATION LEVEL /i.test(sql)) return { rows: [], rowCount: 0 };
    if (sql === 'COMMIT') return raw.query(`RELEASE SAVEPOINT qa_admin_${savepoint--}`);
    if (sql === 'ROLLBACK') return raw.query(`ROLLBACK TO SAVEPOINT qa_admin_${savepoint--}`);
    return raw.query(sql.replaceAll('admin.', 'admin_test.'), values as unknown[] | undefined);
  }, release() {} };
  const database = createValidatedWalletCoreTestDatabase({
    async connect() { return client; }, async end() {},
  }, WALLET_CORE_TEST_SCHEMAS);
  const auditWriter = new AdminAuditWriterService(new AdminAuditRepository());
  const identityPort = { nextUuidV7: () => '01950000-0000-7000-8000-000000000009' };
  logoRoot = await mkdtemp(join(tmpdir(), 'orebit-qa-admin-logo-'));
  const logoStorage = await LocalWalletLogoStorage.create({ root: logoRoot,
    publicBaseUrl: 'https://assets.test.invalid/wallet/' });
  const provider = new ProviderCatalogueRepository(database, auditWriter, identityPort);
  const repository = new WalletCoreRepository(database);
  const logoAssets = new WalletLogoAssetRepository(database);
  const ports = {
    authorization: { require: async (principal: { role: string }, permission: string) => {
      calls.push(['permission', permission]);
      if (principal.role !== 'SUPER_ADMIN') throw new WalletAuthorizationUnavailable();
    } },
    bootstrap: new WalletCoreBootstrapRepository(database, logoStorage),
    writer: new WalletCoreConfigurationWriter(repository, auditWriter, logoAssets),
    history: new WalletCoreHistoryRepository(database),
    provider,
    blockchain: { fetchCompleteCatalogue: async () => {
      calls.push(['fetch']); return { chains: [{ providerChainId: 990001, name: 'QA Chain',
        shortName: 'QAC', isEvm: true, state: 'ACTIVATED' }], coins: [{ providerChainId: 990001,
        providerCoinId: 990002, currencyName: 'QA Coin', tokenAddress: null,
        isBaseCurrency: true, isStake: true, blockchainPrecision: 18, state: 'ACTIVATED' }],
        decodedBytes: 256 };
    } },
    identity: { nextUuidV7: () => {
      calls.push(['identity']); return '01950000-0000-7000-8000-000000000009';
    } },
    processor: WALLET_CORE_DEFAULT_LOGO_PROCESSOR,
    storage: logoStorage,
    assets: logoAssets,
    database,
    audit: auditWriter,
  };
  const sessions = { assertLive: async () => undefined, touch: async () => undefined };
  const authGuard = new auth.AuthGuard(
    sessions, { resolve: async () => null }, new Reflector());
  const configurationTickets = new Set(['once', 'invalid-body', 'conflict', 'push']);
  const logoTickets = new Set([
    'logo', 'extra-logo', 'large-logo', 'wrong-type-logo', 'wrong-field-logo',
    'wrong-logo-scope',
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
  await adapter.getInstance().register(multipart.default, {
    limits: { fileSize: 1_048_576, files: 1, fields: 0, parts: 1 },
  });
  app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, { logger: false });
  app.useGlobalFilters(new http.ProblemJsonFilter());
  await app.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, calls,
    tokens: {
      superAdmin: jwt.signAccessToken({ adminId: ID, sessionId: SESSION, role: 'SUPER_ADMIN',
        ceilingAt: new Date(Date.now() + 60 * 60 * 1000) }).token,
      admin: jwt.signAccessToken({ adminId: ID, sessionId: SESSION, role: 'ADMIN',
        ceilingAt: new Date(Date.now() + 60 * 60 * 1000) }).token,
    },
    close: async () => {
      try { await app!.close(); }
      finally {
        try {
          await raw.query('ROLLBACK');
          const residue = await raw.query(`SELECT
            (SELECT count(*)::int FROM admin_test.admin_audit_events WHERE request_id=$1) audit,
            (SELECT count(*)::int FROM wallet_core_test.admin_preferences WHERE admin_id=$2) preference`,
          [REQUEST, ID]);
          assert.deepEqual(residue.rows[0], { audit: 0, preference: 0 });
        } finally { await raw.end(); await rm(logoRoot!, { recursive: true, force: true }); }
      }
    },
    query: async (sql, values) => (await client.query(sql, values)).rows,
  };
  } catch (error) {
    try { await raw.query('ROLLBACK'); } catch { /* setup may fail before BEGIN */ }
    await raw.end().catch(() => undefined);
    if (app) await app.close().catch(() => undefined);
    if (logoRoot) await rm(logoRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reusable OAS/runtime hook; callers must close it to trigger rollback and residue checks. */
export function startAdminLiveApiForQa(): Promise<QaAdminLiveApi> {
  if (!LIVE) throw new Error('QA_ADMIN_LIVE_GUARD');
  return startLocalApi();
}

let api: QaAdminLiveApi;
before(async () => { if (LIVE) api = await startLocalApi(); });
after(async () => { if (api) await api.close(); });

async function call(path: string, options: {
  method?: 'GET' | 'PATCH' | 'POST'; role?: 'superAdmin' | 'admin' | null;
  body?: unknown; elevation?: string;
} = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT, 'accept-language': ACCEPT_LANGUAGE, 'x-forwarded-for': '127.0.0.1',
  };
  const role = options.role === undefined ? 'superAdmin' : options.role;
  if (role !== null) headers.authorization = `Bearer ${api.tokens[role]}`;
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
  const body = await response.json() as { data?: unknown };
  assert.ok('data' in body);
  if (data !== undefined) assert.deepEqual(body, { data });
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

test('global Auth and permission guard protect every read while SUPER_ADMIN receives exact data', { skip: !LIVE }, async () => {
  await problem(await call(PATH, { role: null }), 401);
  await problem(await call(PATH, { role: 'admin' }), 403);
  const bootstrapResponse = await call(PATH + '?limit=2');
  const bootstrapBody = await bootstrapResponse.clone().json() as any;
  await success(bootstrapResponse, undefined);
  const historyResponse = await call(PATH + '/history?limit=20');
  const historyBody = await historyResponse.clone().json() as any;
  await success(historyResponse, undefined);
  if (process.env.QA_CAPTURE_RESPONSES === 'true') console.log(JSON.stringify({
    bootstrap: { live: bootstrapBody.data.configuration.live,
      lastReconciliation: bootstrapBody.data.lastReconciliation },
    historyNullActor: historyBody.data.items.find((item: any) => item.actor === null) ?? null,
  }));
});

test('setup failure rolls back and closes its PostgreSQL session', { skip: !LIVE }, async () => {
  await assert.rejects(() => startLocalApi(true), /QA_SETUP_FAILURE_PROBE/);
  const rows = await api.query(`SELECT count(*)::int count FROM pg_stat_activity
    WHERE application_name='qa-admin-live-failure'`);
  assert.equal(rows[0]!.count, 0);
});

test('configuration PATCH saves without elevation and maps invalid/conflict', { skip: !LIVE }, async () => {
  const current = await call(PATH);
  const revision = Number(((await current.json()) as any).data.currentRevision);
  const body = { action: 'PUSH', expectedRevision: revision, reason: 'Local apply.',
    changelogId: ID, config: { settings } };
  const saved = await call(PATH, { method: 'PATCH', body });
  const savedData = ((await saved.clone().json()) as any).data;
  await success(saved, undefined);
  assert.deepEqual((await api.query(`SELECT status::text,reason,changelog_id::text FROM
    wallet_core_test.configuration_changes WHERE id=$1`, [savedData.configurationId]))[0],
  { status: 'LIVE', reason: 'Local apply.', changelog_id: ID });
  assert.equal((await api.query(`SELECT count(*)::int count FROM admin_test.admin_audit_events
    WHERE event_key LIKE $1`, [`wallet:${savedData.configurationId}:%`]))[0]!.count, 1);
  await problem(await call(PATH, { method: 'PATCH', body }), 409);
  await problem(await call(PATH, { method: 'PATCH', body: { ...body, raw: true },
    elevation: 'invalid-body' }), 400);
  await problem(await call(PATH, { method: 'PATCH',
    body: { ...body, expectedRevision: 999 }, elevation: 'conflict' }), 409);
});

test('catalogue chain/per-chain/flat pages and refresh require IMPORT but no elevation', { skip: !LIVE }, async () => {
  const chains = await call(PATH + '/provider-catalogue?limit=2');
  await success(chains.clone(), undefined);
  const chainId = ((await chains.json()) as any).data.items[0]?.blockchainCatalogueChainId ?? '42';
  await success(await call(PATH + `/provider-catalogue?blockchainCatalogueChainId=${chainId}&limit=3`), undefined);
  await success(await call(PATH + '/provider-catalogue/coins?limit=4'), undefined);
  await success(await call(PATH + '/provider-catalogue/refresh', { method: 'POST' }), undefined);
  assert.deepEqual((await api.query(`SELECT provider_chain_id::text,name FROM
    wallet_core_test.provider_catalogue_chains WHERE provider_chain_id=990001`))[0],
  { provider_chain_id: '990001', name: 'QA Chain' });
  const existingChain = (await api.query(`SELECT id::text FROM wallet_core_test.chains
    WHERE provider_chain_id=990001`))[0];
  const configChainId = String(existingChain?.id ?? ENTITY.chain);
  const existingBinding = (await api.query(`SELECT id::text,currency_id::text FROM
    wallet_core_test.currencies WHERE chain_id=$1 AND provider_coin_id=990002`,
  [configChainId]))[0];
  const configCurrencyId = String(existingBinding?.currency_id ?? ENTITY.currency);
  const configBindingId = String(existingBinding?.id ?? ENTITY.binding);
  const config = { ...pushedConfig, chains: [{ ...pushedConfig.chains[0], id: configChainId }],
    currencies: [{ ...pushedConfig.currencies[0], id: configCurrencyId, bindings: [{
      ...pushedConfig.currencies[0].bindings[0], id: configBindingId, chainId: configChainId }] }] };
  const current = Number((await api.query('SELECT revision FROM wallet_core_test.wallet_settings WHERE id'))[0]!.revision);
  const pushed = await call(PATH, { method: 'PATCH', elevation: 'push', body: {
    action: 'PUSH', expectedRevision: current, reason: 'QA partial chain import',
    changelogId: ID, config } });
  assert.equal(pushed.status, 200, await pushed.clone().text());
  await success(pushed, undefined);
  assert.deepEqual(await api.query(`SELECT kind::text,wallet_address,address_identity FROM
    wallet_core_test.custody_addresses WHERE currency_chain_id=$1 ORDER BY kind`, [configBindingId]), [
    { kind: 'COLD', wallet_address: '0xDef', address_identity: '0xdef' },
    { kind: 'HOT', wallet_address: '0xAbC', address_identity: '0xabc' },
    { kind: 'STAKING', wallet_address: '0xabc', address_identity: '0xabc' },
  ]);
});

test('logo accepts exactly one streamed multipart file and audits normalized safe metadata', { skip: !LIVE }, async () => {
  const form = new FormData();
  const png = await sharp({ create: { width: 300, height: 300, channels: 4,
    background: { r: 20, g: 80, b: 160, alpha: 1 } } }).png().toBuffer();
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const response = await call(PATH + '/logos', { method: 'POST', body: form, elevation: 'logo' });
  const body = await response.json() as any;
  assert.equal(response.status, 200);
  assert.match(body.data.objectKey, /^[0-9a-f]{64}\.webp$/);
  const logoAudit = (await api.query(`SELECT after_json,metadata_json FROM admin_test.admin_audit_events
    WHERE action='LOGO.UPLOADED' AND subject_id=$1`, [body.data.objectKey]))[0]!;
  const logoAfter = logoAudit.after_json as Record<string, unknown>;
  assert.deepEqual(logoAudit.after_json, { stored: true, mediaType: 'image/webp',
    width: 300, height: 300, bytes: logoAfter.bytes });
  assert.equal((logoAudit.metadata_json as any).sourceFormat, 'PNG');

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

test('timezone preference is strict, unelevated, and audited with the request actor', { skip: !LIVE }, async () => {
  await success(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'Asia/Kolkata' },
  }), { timezone: 'Asia/Kolkata' });
  assert.equal((await api.query(`SELECT timezone FROM wallet_core_test.admin_preferences
    WHERE admin_id=$1`, [ID]))[0]!.timezone, 'Asia/Kolkata');
  assert.equal((await api.query(`SELECT count(*)::int count FROM admin_test.admin_audit_events
    WHERE action='ADMIN_TIMEZONE.UPDATED' AND request_id=$1`, [REQUEST]))[0]!.count, 1);
  await problem(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'Mars/Olympus' },
  }), 400, 'wallet_preference_invalid');
  await problem(await call(PATH + '/preferences', {
    method: 'PATCH', body: { timezone: 'UTC', extra: true },
  }), 400, 'wallet_preference_invalid');
  await success(await call(PATH + '/history?limit=20'), undefined);
});
