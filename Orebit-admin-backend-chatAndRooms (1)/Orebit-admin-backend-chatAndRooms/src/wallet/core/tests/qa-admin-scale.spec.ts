import assert from 'node:assert/strict';
/* eslint-disable @typescript-eslint/no-explicit-any -- decoded live response boundary. */
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import { WalletCoreBootstrapRepository } from '../wallet-core.bootstrap-repository.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { createValidatedWalletCoreTestDatabase, WALLET_CORE_TEST_SCHEMAS,
  type WalletCorePool } from '../wallet-core.database.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';
import { WalletCoreService } from '../wallet-core.service.js';

const URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test' && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === URL;
const ID = { admin: '01960000-0000-7000-8000-000000000001',
  chain: '01960000-0000-7000-8000-000000000002',
  currency: '01960000-0000-7000-8000-000000000003',
  binding: '01960000-0000-7000-8000-000000000004',
  request: '01960000-0000-7000-8000-000000000005' } as const;
const PROVIDER_CHAIN = 9_906_001;
const PROVIDER_COIN = 9_906_002;
const LOGO_ASSETS = {
  async attachReferencedWithTransaction() {}, async reserve() {},
  async markUploadedWithTransaction() {}, async requestDeletion() {},
};

async function startHttp(service: WalletCoreService) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' } });
  Object.assign(process.env, { NODE_ENV: 'test', ADMIN_APP_URL: 'http://127.0.0.1:3002',
    DATABASE_URL: 'postgresql://admin:x@127.0.0.1/admin?schema=admin',
    DATABASE_DIRECT_URL: 'postgresql://admin_owner:x@127.0.0.1/admin?schema=admin',
    REDIS_URL: 'redis://127.0.0.1:1', REDIS_DURABLE_URL: 'redis://127.0.0.1:1',
    PASSWORD_PEPPER: 'p'.repeat(32),
    JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    TOTP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), WEBAUTHN_RP_ID: 'localhost',
    OTP_QUEUE_KEY: Buffer.alloc(32, 11).toString('base64'),
    BFF_SESSION_KEY: Buffer.alloc(32, 13).toString('base64'),
    SMTP_FROM: 'wallet-scale@orebit.invalid' });
  const [routes, auth, jwt, http] = await Promise.all([
    import('../wallet-core.routes.js'),
    import('../../../../auth/security/guards.js'), import('../../../../auth/security/jwt.js'),
    import('../../../http.js'),
  ]);
  const authorization = { require: async (principal: { role: string }) => {
    assert.equal(principal.role, 'SUPER_ADMIN'); } };
  const sessions = { assertLive: async () => undefined, touch: async () => undefined };
  const authGuard = new auth.AuthGuard(
    sessions as never, { resolve: async () => null } as never, new Reflector());
  const module = await Test.createTestingModule({ controllers: [routes.WalletCoreRoutes],
    providers: [routes.WalletCorePermissionGuard, Reflector,
      { provide: WalletCoreService, useValue: service },
      { provide: (await import('../wallet-core.service.js')).WALLET_CORE_AUTHORIZATION,
        useValue: authorization },
      { provide: auth.AuthGuard, useValue: authGuard },
      { provide: APP_GUARD, useExisting: auth.AuthGuard }],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({
    trustProxy: true, genReqId: () => ID.request }), { logger: false });
  app.useGlobalFilters(new http.ProblemJsonFilter());
  await app.init(); await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`,
    token: jwt.signAccessToken({ adminId: ID.admin, sessionId: ID.admin,
      role: 'SUPER_ADMIN', ceilingAt: new Date(Date.now() + 60 * 60 * 1000) }).token };
}

class MappedPool implements WalletCorePool {
  queryCount = 0;
  constructor(readonly pool: pg.Pool) {}
  async connect() {
    const client = await this.pool.connect();
    return { query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      this.queryCount += 1;
      const result = await client.query(sql.replaceAll('admin.', 'admin_test.'), values as unknown[] | undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    }, release: () => client.release() };
  }
  end() { return this.pool.end(); }
}

const address = (kind: string, index: number) =>
  `qa-${kind.toLowerCase()}-${String(index).padStart(5, '0')}`;

async function seed(pool: MappedPool, writer: WalletCoreConfigurationWriter): Promise<void> {
  const count = Number((await pool.pool.query(`SELECT count(*) FROM wallet_core_test.custody_addresses
    WHERE currency_chain_id=$1`, [ID.binding])).rows[0].count);
  if (count === 30_000) return;
  assert.equal(count, 0, 'QA_SCALE_FIXTURE_PARTIAL');
  if (process.env.QA_ADMIN_SCALE_ALLOW_SEED !== 'true') {
    throw new Error('QA_SCALE_FIXTURE_MISSING_READ_ONLY');
  }
  await pool.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_chains
    (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
    VALUES ($1,'QA Scale Chain','QASC',true,'ACTIVATED',1,clock_timestamp())
    ON CONFLICT (provider_chain_id) DO NOTHING`, [PROVIDER_CHAIN]);
  await pool.pool.query(`INSERT INTO wallet_core_test.provider_catalogue_currencies
    (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
     blockchain_precision,provider_state,revision,refreshed_at)
    VALUES ($1,$2,'QA Scale Coin',NULL,true,true,18,'ACTIVATED',1,clock_timestamp())
    ON CONFLICT (provider_chain_id,provider_coin_id) DO NOTHING`, [PROVIDER_CHAIN, PROVIDER_COIN]);
  const row = (await pool.pool.query(`SELECT revision,catalogue_mode::text,global_desired_state::text,
    include_treasury,include_collection,reconciliation_alert_percent::text,
    reconciliation_alert_basis::text
    FROM wallet_core_test.wallet_settings WHERE id`)).rows[0];
  const list = (kind: string) => Array.from({ length: 10_000 }, (_, index) => address(kind, index));
  const result = await writer.updateAtomically({ action: 'PUSH', expectedRevision: Number(row.revision),
    reason: 'Committed additive QA scale fixture',
    config: { settings: { globalDesiredState: row.global_desired_state,
      catalogueMode: row.catalogue_mode, reconciliationIncludeTreasury: row.include_treasury,
      reconciliationIncludeCollection: row.include_collection,
      reconciliationAlertPercent: row.reconciliation_alert_percent,
      reconciliationAlertBasis: row.reconciliation_alert_basis, defaultCurrencyIds: [] },
    chains: [{ id: ID.chain, providerChainId: PROVIDER_CHAIN,
      blockchainReference: 'QA Scale Chain', name: 'QA Scale Chain',
      shortName: 'QASC', isEvm: true, availableFor: 'BOTH', desiredState: 'ON' }],
    currencies: [{ id: ID.currency, symbol: 'QASCALE', name: 'QA Scale Coin',
      providerRefs: (['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'] as const).map(provider => ({ provider,
        providerAssetId: `qa-scale-${provider.toLowerCase()}`, providerSymbol: 'QASCALE' })), viewEnabled: false,
      geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH',
      listingKind: 'PERMANENT', showBeforeListing: false, premiumOperations: [], soOperations: [],
      postDelistOperations: [], desiredState: 'ON', maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{ id: ID.binding,
        chainId: ID.chain, providerCoinId: PROVIDER_COIN,
        blockchainReference: 'QA Scale Coin', isToken: false, blockchainPrecision: 18,
        desiredState: 'ON', hotWalletAddresses: list('HOT'), coldWalletAddresses: list('COLD'),
        stakingWalletAddresses: list('STAKING') }] }] } },
  { actor: { kind: 'ADMIN', actorId: ID.admin, sessionId: ID.admin, requestId: ID.request,
    ipAddress: '127.0.0.1', deviceId: 'qa-admin-scale' } });
  assert.equal(result.outcome, 'PUSHED');
  assert.equal(Number((await pool.pool.query(`SELECT count(*) FROM wallet_core_test.custody_addresses
    WHERE currency_chain_id=$1`, [ID.binding])).rows[0].count), 30_000);
}

const quantile = (values: number[], fraction: number) =>
  values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;

test('pooled Admin bootstrap returns all 30k addresses under bounded HTTP load', { skip: !LIVE }, async () => {
  const mapped = new MappedPool(new pg.Pool({ connectionString: URL, max: 8,
    application_name: 'qa-admin-scale' }));
  let http: Awaited<ReturnType<typeof startHttp>> | undefined;
  try {
  const dbIdentity = (await mapped.pool.query(`SELECT current_database() database,current_user username,
    inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
  assert.deepEqual(dbIdentity, { database: 'orebit_wallet_core_test',
    username: 'orebit_wallet_core_test_owner', port: 5432, system_id: '7681719399426031650' });
  const database = createValidatedWalletCoreTestDatabase(mapped, WALLET_CORE_TEST_SCHEMAS);
  const audit = new AdminAuditWriterService(new AdminAuditRepository());
  const writer = new WalletCoreConfigurationWriter(
    new WalletCoreRepository(database), audit, LOGO_ASSETS);
  await seed(mapped, writer);
  const logos = { publicUrl: (key: string) => `https://assets.test.invalid/${key}` };
  const bootstrap = new WalletCoreBootstrapRepository(database, logos);
  const service = new WalletCoreService(bootstrap, writer, {} as never, {} as never,
    {} as never, {} as never, {} as never, logos as never, LOGO_ASSETS as never, database, audit);
  http = await startHttp(service);
  const request = async () => {
    const started = performance.now();
    const response = await fetch(http!.base + '/v1/admin/wallet/core?limit=100',
      { headers: { authorization: `Bearer ${http!.token}` } });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, 200);
    const item = (JSON.parse(bytes.toString()) as any).data.currencies.items
      .find((currency: any) => currency.id === ID.currency);
    assert.ok(item);
    const binding = item.bindings.find((value: any) => value.id === ID.binding);
    assert.deepEqual([binding.hotWalletAddresses.length, binding.coldWalletAddresses.length,
      binding.stakingWalletAddresses.length], [10_000, 10_000, 10_000]);
    return { ms: performance.now() - started, bytes: bytes.length };
  };
  for (let index = 0; index < 10; index += 1) await request();
    for (const concurrency of [1, 4, 8]) {
      mapped.queryCount = 0;
      const rss = process.memoryUsage().rss; const cpu = process.cpuUsage();
      const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
      const started = performance.now(); let next = 0;
      const samples: Array<{ ms: number; bytes: number }> = [];
      const workers = Array.from({ length: concurrency }, async () => {
        while (next < 30) { next += 1; samples.push(await request()); }
      });
      const outcomes = await Promise.allSettled(workers);
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected');
      if (failed) throw failed.reason;
      const elapsed = performance.now() - started; loop.disable();
      const used = process.cpuUsage(cpu); const latency = samples.map(sample => sample.ms);
      console.log(JSON.stringify({ route: 'GET /v1/admin/wallet/core', concurrency,
        requests: samples.length, p50Ms: quantile(latency, .5), p95Ms: quantile(latency, .95),
        p99Ms: quantile(latency, .99), requestsPerSecond: samples.length * 1_000 / elapsed,
        responseBytes: samples[0]!.bytes, rssDeltaBytes: process.memoryUsage().rss - rss,
        cpuUserMicros: used.user, cpuSystemMicros: used.system,
        eventLoopP99Ms: loop.percentile(99) / 1e6, queryCount: mapped.queryCount }));
    }
  } finally { if (http) await http.app.close(); await mapped.end(); }
});
