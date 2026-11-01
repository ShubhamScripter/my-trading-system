import 'reflect-metadata';
/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic module boundary under intentional RED. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  encodeWalletQueryCursor,
  walletQueryFingerprint,
} from '../wallet-core.cursor.js';

const PRINCIPAL = {
  adminId: '01950000-0000-7000-8000-000000000001',
  sessionId: '01950000-0000-7000-8000-000000000002',
  role: 'SUPER_ADMIN',
} as const;
const AUDIT_CONTEXT = {
  actor: {
    kind: 'ADMIN', actorId: PRINCIPAL.adminId, sessionId: PRINCIPAL.sessionId,
    requestId: '01950000-0000-7000-8000-000000000003',
    ipAddress: '127.0.0.1', deviceId: 'local-device',
  },
} as const;
process.env.TSX_TSCONFIG_PATH = resolve(__dirname, '../../../..', 'tsconfig.json');
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1', privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
Object.assign(process.env, {
  NODE_ENV: 'test', ADMIN_APP_URL: 'http://127.0.0.1:3002',
  DATABASE_URL: 'postgresql://admin:x@127.0.0.1/admin?schema=admin',
  DATABASE_DIRECT_URL: 'postgresql://owner:x@127.0.0.1/admin?schema=admin',
  REDIS_URL: 'redis://127.0.0.1:1', REDIS_DURABLE_URL: 'redis://127.0.0.1:1',
  PASSWORD_PEPPER: 'p'.repeat(32),
  JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
  TOTP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  OTP_QUEUE_KEY: Buffer.alloc(32, 11).toString('base64'),
  BFF_SESSION_KEY: Buffer.alloc(32, 13).toString('base64'),
  WEBAUTHN_RP_ID: 'localhost', SMTP_FROM: 'wallet-test@orebit.invalid',
});

async function load(path: string): Promise<Record<string, any> | undefined> {
  return import(path).catch(() => undefined) as Promise<Record<string, any> | undefined>;
}

const routeContract = [
  ['bootstrap', '/', RequestMethod.GET, 'WALLET_CORE_READ', false],
  ['chains', 'chains', RequestMethod.GET, 'WALLET_CORE_READ', false],
  ['update', '/', RequestMethod.PATCH, 'WALLET_CORE_CONFIGURE', true],
  ['history', 'history', RequestMethod.GET, 'WALLET_CORE_READ', false],
  ['catalogue', 'provider-catalogue', RequestMethod.GET, 'WALLET_CORE_IMPORT', false],
  ['catalogueCoins', 'provider-catalogue/coins', RequestMethod.GET, 'WALLET_CORE_IMPORT', false],
  ['refreshCatalogue', 'provider-catalogue/refresh', RequestMethod.POST, 'WALLET_CORE_IMPORT', false],
  ['uploadLogo', 'logos', RequestMethod.POST, 'WALLET_CORE_CONFIGURE', true],
  ['updatePreferences', 'preferences', RequestMethod.PATCH, 'WALLET_CORE_READ', false],
] as const;

describe('Wallet Core Admin HTTP metadata boundary', () => {
  it('declares exactly the nine unmounted methods under the approved controller path', async () => {
    const routes = await load('../wallet-core.routes.js');
    assert.ok(routes?.WalletCoreRoutes);
    const Route = routes.WalletCoreRoutes;
    assert.equal(Reflect.getMetadata(PATH_METADATA, Route), 'v1/admin/wallet/core');
    for (const [name, path, method] of routeContract) {
      const handler = Route.prototype[name];
      assert.equal(typeof handler, 'function', name);
      assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path, name);
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), method, name);
    }
    const routeMethods = Object.getOwnPropertyNames(Route.prototype)
      .filter((name) => name !== 'constructor');
    assert.deepEqual(routeMethods.sort(), routeContract.map(([name]) => name).sort());
  });

  it('requires permissions but no elevation until site-wide save confirmation is integrated', async () => {
    const [routes, filter, elevation] = await Promise.all([
      load('../wallet-core.routes.js'),
      load('../wallet-core.filter.js'),
      load('../../../2fa/elevation.js'),
    ]);
    assert.ok(routes?.WalletCoreRoutes);
    assert.ok(routes.WalletCorePermissionGuard);
    assert.ok(typeof routes.WALLET_CORE_PERMISSION_METADATA === 'symbol');
    for (const [name, , , permission] of routeContract) {
      const handler: (...args: any[]) => any = routes.WalletCoreRoutes.prototype[name];
      assert.equal(Reflect.getMetadata(routes.WALLET_CORE_PERMISSION_METADATA, handler),
        permission, name);
      assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, handler),
        [routes.WalletCorePermissionGuard], name);
      assert.equal(Reflect.getMetadata(elevation?.ELEVATION_ACTION, handler),
        undefined, name);
    }
    assert.deepEqual(Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA, routes.WalletCoreRoutes,
    ), [filter?.WalletCoreExceptionFilter]);
    const source = await readFile(resolve(__dirname, '../wallet-core.routes.ts'), 'utf8');
    assert.doesNotMatch(source, /\bPublic\b|@Public\s*\(/);
  });
});

describe('Wallet provider catalogue query boundary', () => {
  it('maps renamed catalogue query fields to the existing internal cursor contract', async () => {
    const dto = await load('../wallet-core.dto.js');
    const chainFilter = { sortBy: 'providerChainId', sortDirection: 'asc' };
    const coinFilter = { providerChainId: '42', sortBy: 'providerCoinId', sortDirection: 'asc' };
    const chainCursor = encodeWalletQueryCursor('PROVIDER_CHAIN',
      walletQueryFingerprint(chainFilter), ['7', '42', '42']);
    const coinCursor = encodeWalletQueryCursor('PROVIDER_COIN',
      walletQueryFingerprint(coinFilter), ['7', '99', '42', '99']);
    assert.deepEqual(dto?.walletProviderCataloguePageQuerySchema.parse({}),
      { sortBy: 'providerChainId', sortDirection: 'asc', limit: 50 });
    assert.deepEqual(dto?.walletProviderCataloguePageQuerySchema.parse({
      cursor: chainCursor, limit: '25',
    }), { cursor: chainCursor, sortBy: 'providerChainId', sortDirection: 'asc', limit: 25 });
    assert.deepEqual(dto?.walletProviderCataloguePageQuerySchema.parse({
      blockchainCatalogueChainId: '42', cursor: coinCursor, limit: '25',
    }), { providerChainId: '42', cursor: coinCursor, sortBy: 'providerCoinId',
      sortDirection: 'asc', limit: 25 });
    for (const invalid of [
      { blockchainCatalogueChainId: '0' }, { blockchainCatalogueChainId: 42 },
      { blockchainCatalogueChainId: '42', cursor: chainCursor },
      { providerChainId: '42' }, { sortBy: 'providerCoinId' },
      { cursor: coinCursor }, { raw: true },
    ]) assert.throws(() => dto?.walletProviderCataloguePageQuerySchema.parse(invalid));
  });

  it('accepts only revision-pinned flat coin-chain cursor pages on the dedicated endpoint', async () => {
    const dto = await load('../wallet-core.dto.js');
    const filter = { sortBy: 'providerCoinId', sortDirection: 'asc' };
    const coinCursor = encodeWalletQueryCursor('PROVIDER_COIN',
      walletQueryFingerprint(filter), ['7', '99', '42', '99']);
    assert.deepEqual(dto?.walletProviderCatalogueCoinsPageQuerySchema.parse({
      sortBy: 'blockchainCatalogueCoinId', cursor: coinCursor, limit: '100',
    }), { cursor: coinCursor, sortBy: 'providerCoinId', sortDirection: 'asc', limit: 100 });
    for (const invalid of [
      { cursor: encodeWalletQueryCursor('PROVIDER_CHAIN',
        walletQueryFingerprint(filter), ['7', '42', '42']) },
      { blockchainCatalogueChainId: '0' }, { providerChainId: '42' },
      { sortBy: 'providerCoinId' }, { limit: 101 }, { extra: true },
    ]) assert.throws(() => dto?.walletProviderCatalogueCoinsPageQuerySchema.parse(invalid));
  });
});

describe('Wallet public reference response boundary', () => {
  it('projects bootstrap and catalogue entities with only the renamed public keys', async () => {
    const references = await load('../wallet-core.http-references.js');
    assert.ok(references?.toPublicWalletBootstrap);
    assert.ok(references?.toPublicProviderCataloguePage);
    const providerReference = { provider: 'COINGECKO', providerAssetId: 'bitcoin',
      providerSymbol: 'BTC', network: 'bitcoin', address: 'native' };
    const chain = { id: 'chain', providerChainId: '42', blockchainReference: 'bitcoin-mainnet',
      shortName: 'BTC', name: 'Bitcoin', isEvm: false, logo: null, availableFor: 'BOTH',
      desiredState: 'ON', effectiveState: 'ON', maintenancePinned: false, provider: {} };
    const binding = { id: 'binding', chainId: 'chain', chainShortName: 'BTC',
      providerCoinId: '99', blockchainReference: 'bitcoin-native', isToken: false,
      tokenContractAddress: null, blockchainPrecision: 8, desiredState: 'ON',
      effectiveState: 'ON', maintenancePinned: false, provider: {}, hotWalletAddresses: [],
      coldWalletAddresses: [], stakingWalletAddresses: [] };
    const bootstrap = references.toPublicWalletBootstrap({ currentRevision: '7', settings: {},
      configuration: {}, chains: [chain], currencies: { items: [{ id: 'currency', symbol: 'BTC',
        name: 'Bitcoin', providerReferences: [providerReference], bindings: [binding] }],
        nextCursor: 'currency-next' }, activeAlerts: {}, lastReconciliation: null, viewer: {} });
    assert.deepEqual(bootstrap.chains[0], { id: 'chain', blockchainCatalogueChainId: '42',
      blockchainRequestReference: 'bitcoin-mainnet', shortName: 'BTC', name: 'Bitcoin',
      isEvm: false, logo: null, availableFor: 'BOTH', desiredState: 'ON', effectiveState: 'ON',
      maintenancePinned: false, provider: {} });
    assert.deepEqual(bootstrap.currencies.items[0].priceProviderReferences, [providerReference]);
    assert.equal('providerReferences' in bootstrap.currencies.items[0], false);
    assert.deepEqual(bootstrap.currencies.items[0].bindings[0], {
      id: 'binding', chainId: 'chain', chainShortName: 'BTC',
      blockchainCatalogueCoinId: '99', blockchainRequestReference: 'bitcoin-native',
      isToken: false, tokenContractAddress: null, blockchainPrecision: 8,
      desiredState: 'ON', effectiveState: 'ON', maintenancePinned: false, provider: {},
      hotWalletAddresses: [], coldWalletAddresses: [], stakingWalletAddresses: [],
    });
    assert.deepEqual(references.toPublicProviderCataloguePage({ revision: '7', items: [{
      providerChainId: '42', providerCoinId: '99', currencyName: 'Bitcoin', tokenAddress: null,
      isBaseCurrency: true, isStake: false, blockchainPrecision: 8, providerState: 'ACTIVATED',
      refreshedAt: '2026-09-11T00:00:00.000Z', revision: '7',
    }], nextCursor: 'next' }).items[0], {
      blockchainCatalogueChainId: '42', blockchainCatalogueCoinId: '99',
      currencyName: 'Bitcoin', tokenAddress: null, isBaseCurrency: true, isStake: false,
      blockchainPrecision: 8, providerState: 'ACTIVATED',
      refreshedAt: '2026-09-11T00:00:00.000Z', revision: '7',
    });
  });
});

async function serviceFixture(overrides: Record<string, unknown> = {}) {
  const [service, audit] = await Promise.all([
    load('../wallet-core.service.js'),
    load('../../../admin-audits/admin-audit.writer.service.js'),
  ]);
  assert.ok(service?.WalletCoreService);
  const calls: Array<readonly unknown[]> = [];
  const client = { query: async (sql: string) => {
    calls.push(['query', sql]);
    if (/SELECT.*timezone/is.test(sql)) return { rows: [{
      timezone: 'UTC', revision: 7,
    }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const ports = {
    authorization: { require: async (...args: unknown[]) => { calls.push(['authorize', ...args]); } },
    bootstrap: { bootstrap: async (...args: unknown[]) => {
      calls.push(['bootstrap', ...args]); return { currentRevision: '7' };
    }, chainPage: async (...args: unknown[]) => {
      calls.push(['chainPage', ...args]); return { items: [], nextCursor: null };
    } },
    writer: { updateAtomically: async (...args: unknown[]) => {
      calls.push(['update', ...args]); return { outcome: 'PUSHED', configurationId:
        '01950000-0000-7000-8000-000000000004', revision: '8', status: 'LIVE',
        appliedAt: '2026-09-05T09:00:00.000Z' };
    } },
    history: { history: async (...args: unknown[]) => {
      calls.push(['history', ...args]); return { items: [], nextCursor: null };
    } },
    provider: {
      chains: async (...args: unknown[]) => {
        calls.push(['chains', ...args]); return { revision: '7', items: [], nextCursor: null };
      },
      coins: async (...args: unknown[]) => {
        calls.push(['coins', ...args]); return { revision: '7', items: [], nextCursor: null };
      },
      allCoins: async (...args: unknown[]) => {
        calls.push(['allCoins', ...args]); return { revision: '7', items: [{
          providerCoinId: '99', currencyName: 'USDT', tokenAddress: '0xtoken',
          blockchainPrecision: 18, isBaseCurrency: false, isStake: false,
          providerState: 'ACTIVATED',
          chain: { providerChainId: '42', name: 'BNB Smart Chain', shortName: 'BSC',
            isEvm: true, providerState: 'ACTIVATED' },
        }], nextCursor: null };
      },
      refresh: async (...args: unknown[]) => {
        calls.push(['refresh', ...args]); return { revision: '8', itemCount: 1 };
      },
      recordFailure: async (...args: unknown[]) => { calls.push(['recordFailure', ...args]); },
    },
    blockchain: { fetchCompleteCatalogue: async () => {
      calls.push(['fetch']); return { chains: [], coins: [], decodedBytes: 2 };
    } },
    identity: { nextUuidV7: () => {
      calls.push(['identity']); return '01950000-0000-7000-8000-000000000009';
    } },
    processor: { process: async (input: Buffer) => {
      calls.push(['process', input]); return { content: Buffer.from('webp'), sourceFormat: 'PNG',
        width: 300, height: 300, bytes: 4 };
    } },
    storage: {
      putWebp: async (...args: unknown[]) => { calls.push(['put', ...args]); },
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
      calls.push(['audit', ...args]); return { id: AUDIT_CONTEXT.actor.requestId, replayed: false };
    } },
    ...overrides,
  };
  const moduleRef = await Test.createTestingModule({ providers: [
    service.WalletCoreService,
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
  ] }).compile();
  return { service: moduleRef.get(service.WalletCoreService) as any, calls, ports, client };
}

describe('Wallet Core service orchestration boundary', () => {
  it('forwards bootstrap/history/configuration and dispatches both catalogue page modes', async () => {
    const fixture = await serviceFixture();
    await fixture.service.bootstrap(PRINCIPAL, { limit: 2 });
    await fixture.service.chains(PRINCIPAL, { limit: 7 });
    await fixture.service.history(PRINCIPAL, { limit: 3 });
    await fixture.service.update(PRINCIPAL, { action: 'PUSH' }, AUDIT_CONTEXT);
    await fixture.service.catalogue(PRINCIPAL, { limit: 4 });
    await fixture.service.catalogue(PRINCIPAL, { providerChainId: '42', limit: 5 });
    const flat = await fixture.service.catalogueCoins(PRINCIPAL, { limit: 6 });
    assert.deepEqual(fixture.calls.slice(0, 7), [
      ['bootstrap', { limit: 2 }, { adminId: PRINCIPAL.adminId }],
      ['chainPage', { limit: 7 }],
      ['history', { limit: 3 }], ['update', { action: 'PUSH' }, AUDIT_CONTEXT],
      ['chains', { limit: 4 }], ['coins', '42', { limit: 5 }], ['allCoins', { limit: 6 }],
    ]);
    assert.deepEqual(flat.items[0].chain, {
      providerChainId: '42', name: 'BNB Smart Chain', shortName: 'BSC',
      isEvm: true, providerState: 'ACTIVATED',
    });
    assert.equal('providerChainId' in flat.items[0], false);
  });

  it('creates the catalogue event key before fetch and records closed provider failure', async () => {
    const fixture = await serviceFixture();
    await fixture.service.refreshCatalogue(PRINCIPAL, AUDIT_CONTEXT);
    assert.deepEqual(fixture.calls.slice(0, 2).map((call) => call[0]), ['identity', 'fetch']);
    const refresh = fixture.calls.find((call) => call[0] === 'refresh');
    assert.ok(refresh);
    assert.deepEqual(refresh.slice(1, 3), [
      { chains: [], coins: [], decodedBytes: 2 }, AUDIT_CONTEXT,
    ]);
    assert.equal(refresh[3], '01950000-0000-7000-8000-000000000009');

    const [clientErrors, walletErrors] = await Promise.all([
      load('../blockchain-admin.client.js'), load('../wallet-core.errors.js'),
    ]);
    const failed = await serviceFixture({ blockchain: {
      fetchCompleteCatalogue: async () => {
        throw new clientErrors!.WalletCatalogueClientError('TIMEOUT');
      },
    } });
    await assert.rejects(() => failed.service.refreshCatalogue(PRINCIPAL, AUDIT_CONTEXT),
      walletErrors!.WalletProviderUnavailable);
    assert.deepEqual(failed.calls.find((call) => call[0] === 'recordFailure'),
      ['recordFailure', 'TIMEOUT']);
  });

  it('audits normalized logo facts and deletes the object when audit cannot commit', async () => {
    const fixture = await serviceFixture();
    const result = await fixture.service.uploadLogo(PRINCIPAL, Buffer.from('png'), AUDIT_CONTEXT);
    const put = fixture.calls.find((call) => call[0] === 'put');
    const audit = fixture.calls.find((call) => call[0] === 'audit');
    assert.ok(put && audit);
    assert.match(String(put[1]), /^[0-9a-f]{64}\.webp$/);
    assert.deepEqual(put[2], Buffer.from('webp'));
    assert.deepEqual(result, { objectKey: put[1],
      url: `https://assets.test.invalid/wallet/${String(put[1])}` });
    assert.equal(audit[1], fixture.client);
    assert.deepEqual(audit[2], {
      domain: 'WALLET_CORE', action: 'LOGO.UPLOADED', eventKey: `wallet-logo:${String(put[1])}`,
      actor: AUDIT_CONTEXT.actor, subject: { type: 'LOGO_ASSET', id: put[1] },
      reason: 'wallet-logo-upload', before: { stored: false },
      after: { stored: true, mediaType: 'image/webp', width: 300, height: 300, bytes: 4 },
      metadata: { sourceFormat: 'PNG' },
    });

    const failingAudit = { appendWithTransaction: async () => { throw new Error('AUDIT_DOWN'); } };
    const failed = await serviceFixture({ audit: failingAudit });
    await assert.rejects(() => failed.service.uploadLogo(
      PRINCIPAL, Buffer.from('png'), AUDIT_CONTEXT,
    ));
    assert.equal(failed.calls.some((call) => call[0] === 'delete'), true);
  });

  it('rejects an invalid direct timezone mutation with the Wallet preference error', async () => {
    const [fixture, errors] = await Promise.all([
      serviceFixture(), load('../wallet-core.errors.js'),
    ]);
    await assert.rejects(() => fixture.service.updatePreferences(
      PRINCIPAL, { timezone: 'Mars/Olympus' }, AUDIT_CONTEXT,
    ), errors!.WalletPreferenceInvalid);
  });
});

describe('Wallet Core isolated module boundary', () => {
  it('composes Auth, audit, multipart and pool close without a 2FA dependency', async () => {
    const [source, index, multipart] = await Promise.all([
      readFile(resolve(__dirname, '../wallet-core.module.ts'), 'utf8'),
      readFile(resolve(__dirname, '../index.ts'), 'utf8'),
      load('@fastify/multipart'),
    ]);
    assert.ok(multipart?.default);
    assert.doesNotMatch(source, /AdminAuditHistoryModule|AdminAuditDatabase|admin-audit\.history|admin-audits\/index/);
    assert.doesNotMatch(source, /TwoFactorModule/);
    assert.match(source, /import \{ AuthModule \} from ['"]\.\.\/\.\.\/\.\.\/auth\/auth\.module\.js['"]/);
    assert.match(source,
      /import \{ AdminAuditWriterModule \} from ['"]\.\.\/\.\.\/admin-audits\/admin-audit\.writer\.module\.js['"]/);
    assert.match(source, /imports:\s*\[AuthModule, AdminAuditWriterModule, WalletCoreRequestLimitModule\]/);
    assert.match(source, /useFactory:\s*\(admins: AdminDbOperation\)\s*=>\s*new DatabaseBackedWalletAuthorization\(admins\)/);
    assert.match(source, /inject:\s*\[AdminDbOperation\]/);
    assert.match(source, /controllers:\s*\[WalletCoreRoutes\]/);
    assert.match(source, /onModuleDestroy\(\): Promise<void> \{ return this\.database\.close\(\); \}/);
    assert.match(source, /register\(multipart,[\s\S]*fileSize:\s*1_048_576[\s\S]*files:\s*1[\s\S]*fields:\s*0[\s\S]*parts:\s*1/);
    assert.match(index, /export \{ WalletCoreModule \} from ['"]\.\/wallet-core\.module\.js['"]/);
  });
});
