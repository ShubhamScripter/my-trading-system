import 'reflect-metadata';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Body, Controller, Inject, Module, Patch, Post,
  type MiddlewareConsumer, type NestModule,
} from '../../../../node_modules/@nestjs/common/index.js';
import { HttpAdapterHost, NestFactory } from '../../../../node_modules/@nestjs/core/index.js';
import { FastifyAdapter, type NestFastifyApplication,
} from '../../../../node_modules/@nestjs/platform-fastify/index.js';
import { ProblemJsonFilter } from '../../../http.js';
import { walletCorePatchSchema } from '../wallet-core.dto.js';
import { WalletCoreRequestLimitModule } from '../wallet-core.request-limit.js';

const ROOT_LIMIT = 64 * 1024;
const PATCH_LIMIT = 16 * 1024 * 1024;
const uuid = (value: number) =>
  `01950000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const address = (prefix: string, value: number) =>
  `${prefix}-${value.toString(16)}`.padEnd(256, 'x');

function patchBody(targetBytes: number): string {
  const chainIds = Array.from({ length: 4 }, (_, index) => uuid(100 + index));
  const lists: string[][] = Array.from({ length: 8 }, () => []);
  const bindings = Array.from({ length: 4 }, (_, index) => ({ id: uuid(200 + index),
    chainId: chainIds[index]!,
    providerCoinId: index + 1, blockchainReference: `Limit Coin ${index}`,
    isToken: true, tokenContractAddress: `token-${index}`,
    blockchainPrecision: 18, desiredState: 'ON', hotWalletAddresses: lists[index * 2]!,
    coldWalletAddresses: lists[index * 2 + 1]!, stakingWalletAddresses: [] }));
  const body = { action: 'PUSH', expectedRevision: 0, reason: 'r', config: {
    chains: chainIds.map((id, index) => ({ id, providerChainId: index + 1,
      blockchainReference: `limit-chain-${index}`,
      name: `Limit Chain ${index}`, shortName: `LIMIT${index}`,
      isEvm: false, availableFor: 'BOTH', desiredState: 'ON' })),
    currencies: [{ id: uuid(300), symbol: 'LIMIT', name: 'Limit Coin',
      providerRefs: [], viewEnabled: false, geoCountryDeny: [], geoContinentDeny: [],
      accessLevel: 'ALL', availableFor: 'BOTH', listingKind: 'PERMANENT',
      showBeforeListing: false, premiumOperations: [], soOperations: [],
      postDelistOperations: [], desiredState: 'OFF', maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings }],
  } };
  let serialized = JSON.stringify(body);
  let count = Math.floor((targetBytes - Buffer.byteLength(serialized) - 300) / 259);
  for (let index = 0; index < count; index += 1) {
    const listIndex = index % lists.length;
    lists[listIndex]!.push(address(`L${listIndex}`, Math.floor(index / lists.length)));
  }
  serialized = JSON.stringify(body);
  while (Buffer.byteLength(serialized) > targetBytes) {
    lists[(--count) % lists.length]!.pop(); serialized = JSON.stringify(body);
  }
  const missing = targetBytes - Buffer.byteLength(serialized);
  assert.ok(missing >= 0 && missing <= 500);
  body.reason += 'r'.repeat(missing);
  serialized = JSON.stringify(body);
  assert.equal(Buffer.byteLength(serialized), targetBytes);
  const parsed = walletCorePatchSchema.safeParse(JSON.parse(serialized));
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  return serialized;
}

@Controller('v1/admin/wallet/core')
class RequestLimitController {
  @Patch('/') update(@Body() body: unknown) { return { received: body !== null }; }
  @Post('provider-catalogue/refresh') refresh(@Body() body: unknown) {
    return { received: body !== null };
  }
  @Patch('preferences') preferences(@Body() body: unknown) { return { received: body !== null }; }
}

@Module({})
class RootFrameworkRequestLimitModule implements NestModule {
  private readonly delegate: WalletCoreRequestLimitModule;
  constructor(@Inject(HttpAdapterHost) host: HttpAdapterHost) {
    this.delegate = new WalletCoreRequestLimitModule(host as never);
  }
  configure(consumer: MiddlewareConsumer): void { this.delegate.configure(consumer as never); }
}

@Module({ imports: [RootFrameworkRequestLimitModule], controllers: [RequestLimitController] })
class RequestLimitTestModule {}

let app: NestFastifyApplication;
let base: string;
before(async () => {
  const adapter = new FastifyAdapter({ bodyLimit: ROOT_LIMIT });
  app = await NestFactory.create<NestFastifyApplication>(
    RequestLimitTestModule, adapter, { logger: false });
  app.useGlobalFilters(new ProblemJsonFilter());
  await app.init(); await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(async () => { if (app) await app.close(); });

const json = (path: string, method: 'PATCH' | 'POST', body: string,
  fixedLength = true): Promise<number> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'content-type': 'application/json', connection: 'close',
    };
    if (fixedLength) headers['content-length'] = Buffer.byteLength(body);
    const request = httpRequest(new URL(path, base), { method, headers }, (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    request.on('error', reject);
    if (fixedLength) request.end(body);
    else {
      request.write(body.slice(0, -1));
      request.end(body.slice(-1));
    }
  });

test('PATCH Wallet Core accepts a valid exact 16 MiB configuration and rejects one byte more',
async () => {
  const boundary = patchBody(PATCH_LIMIT);
  assert.equal(await json('/v1/admin/wallet/core', 'PATCH', boundary), 200);
  assert.equal(await json('/v1/admin/wallet/core', 'PATCH', boundary + ' ', false), 413);
});

test('only PATCH Wallet Core gets the exception; neighboring JSON routes retain 64 KiB', async () => {
  assert.equal(await json('/v1/admin/wallet/core', 'PATCH', patchBody(100 * 1024)), 200);
  const oversized = JSON.stringify({ padding: 'x'.repeat(70 * 1024) });
  assert.equal(await json('/v1/admin/wallet/core/provider-catalogue/refresh',
    'POST', oversized), 413);
  assert.equal(await json('/v1/admin/wallet/core/preferences', 'PATCH', oversized), 413);
});
