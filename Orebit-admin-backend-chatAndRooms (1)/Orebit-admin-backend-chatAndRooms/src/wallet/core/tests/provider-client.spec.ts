import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLOCKCHAIN_ADMIN_ORIGIN,
  CATALOGUE_CONCURRENCY,
  CATALOGUE_PAGE_SIZE,
  CATALOGUE_TIMEOUT_MS,
  BlockchainAdminCatalogueClient,
  CatalogueDecodedByteBudget,
  WalletCatalogueClientError,
  parseWalletCatalogueLimits,
  type BlockchainAdminTransport,
  type CatalogueDeadlineTimer,
} from '../blockchain-admin.client.js';

type TransportHandler = (url: URL, init: RequestInit) => Promise<Response> | Response;

class FakeTransport implements BlockchainAdminTransport {
  readonly calls: Array<Readonly<{ url: string; init: RequestInit }>> = [];
  active = 0;
  maxActive = 0;
  constructor(private readonly handler: TransportHandler) {}
  async request(url: URL, init: RequestInit): Promise<Response> {
    this.calls.push({ url: url.toString(), init });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try { return await this.handler(url, init); }
    finally { this.active -= 1; }
  }
}

class FakeTimer implements CatalogueDeadlineTimer {
  callback: (() => void) | null = null;
  readonly delays: number[] = [];
  cleared = 0;
  set(callback: () => void, delayMs: number): object {
    this.callback = callback;
    this.delays.push(delayMs);
    return {};
  }
  clear(): void { this.cleared += 1; }
  fire(): void {
    const callback = this.callback;
    assert.ok(callback);
    callback();
  }
}

function streamedJson(value: unknown, options: { chunk?: number; cancelled?: () => void } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + (options.chunk ?? bytes.length));
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() { options.cancelled?.(); },
  }));
}

const chain = (id = 1, overrides: Record<string, unknown> = {}) => ({
  id, name: ' Ethereum ', short_name: 'ETH', status: 'activated', is_evm: 1, ...overrides,
});
const coin = (id = 10, overrides: Record<string, unknown> = {}) => ({
  id, chain_id: 1, currency_name: `TOKEN${id}`, token_address: `0x${id.toString(16)}`,
  decimal: '18.00000000', is_base_currency: 0, is_stake: 0, status: 'activated',
  chain_name: 'Ethereum', chain_short_name: 'ETH', ...overrides,
});
const page = (key: 'chains' | 'coins', rows: unknown[], total = rows.length, pageNumber = 1,
  totalPages = Math.max(1, Math.ceil(total / 50))) => ({
  status: true, data: { total, page: pageNumber, limit: 50, totalPages, [key]: rows },
});

const route = (routes: Readonly<Record<string, unknown>>) => new FakeTransport((url) => {
  const value = routes[url.pathname + url.search];
  if (value === undefined) throw new Error(`unexpected request: ${url}`);
  return streamedJson(value);
});

async function rejectsCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) =>
    error instanceof WalletCatalogueClientError && error.code === code);
}

describe('blockchain Admin catalogue transport boundary', () => {
  it('pins fixed constants and parses only positive safe deployment caps', () => {
    assert.equal(BLOCKCHAIN_ADMIN_ORIGIN, 'https://wallet-user.orebit.dev/user/v1');
    assert.equal(CATALOGUE_PAGE_SIZE, 50);
    assert.equal(CATALOGUE_CONCURRENCY, 8);
    assert.equal(CATALOGUE_TIMEOUT_MS, 10_000);
    assert.deepEqual(parseWalletCatalogueLimits({}), {
      maxChains: 100, maxCoinsPerChain: 2_000, maxTotalCoins: 10_000,
      maxPageBytes: 2_097_152, maxTotalBytes: 67_108_864,
    });
    assert.deepEqual(parseWalletCatalogueLimits({
      WALLET_CATALOGUE_MAX_CHAINS: '7',
      WALLET_CATALOGUE_MAX_COINS_PER_CHAIN: '8',
      WALLET_CATALOGUE_MAX_COINS_PER_REFRESH: '9',
      WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES: '1000',
      WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES: '2000',
    }), { maxChains: 7, maxCoinsPerChain: 8, maxTotalCoins: 9,
      maxPageBytes: 1000, maxTotalBytes: 2000 });
    for (const value of ['0', '-1', '1.5', '1e3', '9007199254740992', '']) {
      assert.throws(() => parseWalletCatalogueLimits({ WALLET_CATALOGUE_MAX_CHAINS: value }));
    }
    assert.throws(() => parseWalletCatalogueLimits({
      WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES: '101',
      WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES: '100',
    }));
  });

  it('enforces exact decoded page and refresh limits through the production counter', () => {
    let cancelled = 0;
    const pageBudget = new CatalogueDecodedByteBudget(2_097_152, 67_108_864);
    const pageCounter = pageBudget.beginPage(() => { cancelled += 1; });
    pageCounter.consume(2_097_152);
    assert.equal(pageBudget.decodedBytes, 2_097_152);
    assert.throws(() => pageCounter.consume(1), (error: unknown) =>
      error instanceof WalletCatalogueClientError && error.code === 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, 1);

    cancelled = 0;
    const refreshBudget = new CatalogueDecodedByteBudget(2_097_152, 67_108_864);
    for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
      refreshBudget.beginPage(() => { cancelled += 1; }).consume(2_097_152);
    }
    assert.equal(refreshBudget.decodedBytes, 67_108_864);
    assert.throws(() => refreshBudget.beginPage(() => { cancelled += 1; }).consume(1),
      (error: unknown) => error instanceof WalletCatalogueClientError
        && error.code === 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, 1);
  });

  it('uses only fixed GET paths and leaves security credentials to the injected transport', async () => {
    const transport = route({
      '/user/v1/get-chain?page=1&limit=50': page('chains', [chain()]),
      '/user/v1/get-coin?chain_id=1&page=1&limit=50': page('coins', []),
    });
    const result = await BlockchainAdminCatalogueClient.production(transport).fetchCompleteCatalogue();
    assert.equal(result.chains.length, 1);
    assert.deepEqual(transport.calls.map((call) => call.url), [
      `${BLOCKCHAIN_ADMIN_ORIGIN}/get-chain?page=1&limit=50`,
      `${BLOCKCHAIN_ADMIN_ORIGIN}/get-coin?chain_id=1&page=1&limit=50`,
    ]);
    for (const { init } of transport.calls) {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      assert.equal(init.headers, undefined);
      assert.ok(init.signal instanceof AbortSignal);
    }
    assert.equal(transport.calls.some(({ url }) => url.includes('encrypt')), false);
  });

  it('allows origin replacement only through the explicit test constructor', async () => {
    const transport = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', []),
    });
    await BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue();
    assert.equal(transport.calls[0]?.url,
      'https://catalogue.test.invalid/fixture/get-chain?page=1&limit=50');
    for (const invalid of [
      'file:///catalogue', 'https://user:pass@test.invalid/x',
      'https://test.invalid/x?q=1', 'https://test.invalid/x#fragment',
    ]) assert.throws(() => BlockchainAdminCatalogueClient.forTest(invalid, transport));
  });

  it('settles at the fixed deadline when the transport ignores abort', async () => {
    const timer = new FakeTimer();
    let aborted = 0;
    const transport = new FakeTransport((_url, init) => new Promise<Response>(() => {
      init.signal?.addEventListener('abort', () => { aborted += 1; }, { once: true });
    }));
    const pending = BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport, {}, timer,
    ).fetchCompleteCatalogue();
    await Promise.resolve();
    timer.fire();
    await rejectsCode(() => pending, 'TIMEOUT');
    assert.deepEqual(timer.delays, [10_000]);
    assert.equal(timer.cleared, 1);
    assert.equal(aborted, 1);
  });

  it('cancels a hanging acquired body and reports its deadline as TIMEOUT', async () => {
    const timer = new FakeTimer();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {}, cancel() { cancelled += 1; },
    });
    const transport = new FakeTransport(() => new Response(body));
    const pending = BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport, {}, timer,
    ).fetchCompleteCatalogue();
    await Promise.resolve(); await Promise.resolve();
    timer.fire();
    await rejectsCode(() => pending, 'TIMEOUT');
    await Promise.resolve();
    assert.equal(cancelled, 1);
    assert.equal(timer.cleared, 1);
    assert.equal(body.locked, false);
  });
});

describe('complete catalogue traversal and normalization', () => {
  it('fetches every page and normalizes exact chain and coin fields', async () => {
    const firstCoins = [
      coin(1, { currency_name: 'ETH', token_address: null, is_base_currency: 1, is_stake: 1 }),
      ...Array.from({ length: 49 }, (_, index) => coin(index + 2)),
    ];
    const transport = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain()]),
      '/fixture/get-coin?chain_id=1&page=1&limit=50': page('coins', firstCoins, 51, 1, 2),
      '/fixture/get-coin?chain_id=1&page=2&limit=50': page('coins', [coin(51)], 51, 2, 2),
    });
    const snapshot = await BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue();
    assert.deepEqual(snapshot.chains, [{
      providerChainId: 1, name: 'Ethereum', shortName: 'ETH',
      state: 'ACTIVATED', isEvm: true,
    }]);
    assert.deepEqual(snapshot.coins[0], {
      providerChainId: 1, providerCoinId: 1, currencyName: 'ETH', tokenAddress: null,
      blockchainPrecision: 18, isBaseCurrency: true, isStake: true, state: 'ACTIVATED',
    });
    assert.equal(snapshot.coins.length, 51);
    assert.ok(snapshot.decodedBytes > 0);
    assert.equal(transport.calls.at(-1)?.url.endsWith('/get-coin?chain_id=1&page=2&limit=50'), true);
  });

  it('uppercases provider short identities while preserving trimmed display names', async () => {
    const transport = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain(29, {
        name: ' Binance Smart Chain ', short_name: 'bsc',
      })]),
      '/fixture/get-coin?chain_id=29&page=1&limit=50': page('coins', [coin(42, {
        chain_id: 29, currency_name: 'bnb', token_address: null,
        is_base_currency: 1, is_stake: 1, chain_name: 'Binance Smart Chain',
        chain_short_name: 'bsc',
      })]),
    });
    const snapshot = await BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue();
    assert.equal(snapshot.chains[0]?.shortName, 'BSC');
    assert.equal(snapshot.chains[0]?.name, 'Binance Smart Chain');
    assert.equal(snapshot.coins[0]?.currencyName, 'BNB');
  });

  it('shares one eight-slot semaphore while keeping each chain page sequence ordered', async () => {
    const chains = Array.from({ length: 12 }, (_, index) => chain(index + 1, {
      name: `Chain${index + 1}`, short_name: `CHAIN${index + 1}`,
    }));
    const transport = new FakeTransport(async (url) => {
      if (url.pathname.endsWith('/get-chain')) return streamedJson(page('chains', chains));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return streamedJson(page('coins', []));
    });
    await BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue();
    assert.equal(transport.maxActive, 8);
    assert.equal(transport.active, 0);
  });

  it('finishes every advertised chain page before starting per-chain coin traversal', async () => {
    const chains = Array.from({ length: 51 }, (_, index) => chain(index + 1, {
      name: `Chain${index + 1}`, short_name: `chain${index + 1}`,
    }));
    const transport = new FakeTransport((url) => {
      if (url.pathname.endsWith('/get-chain')) {
        const pageNumber = Number(url.searchParams.get('page'));
        return streamedJson(page('chains', pageNumber === 1 ? chains.slice(0, 50) : chains.slice(50),
          51, pageNumber, 2));
      }
      return streamedJson(page('coins', []));
    });
    await BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue();
    const urls = transport.calls.map(({ url }) => url);
    assert.equal(urls[1]?.includes('/get-chain?page=2&limit=50'), true);
    assert.equal(urls.findIndex((url) => url.includes('/get-coin?')), 2);
    assert.equal(urls.filter((url) => url.includes('/get-coin?')).length, 51);
  });

  it('aborts all work and releases slots after the first fatal transport failure', async () => {
    const chains = Array.from({ length: 10 }, (_, index) => chain(index + 1, {
      name: `Chain${index + 1}`, short_name: `CHAIN${index + 1}`,
    }));
    const transport = new FakeTransport(async (url, init) => {
      if (url.pathname.endsWith('/get-chain')) return streamedJson(page('chains', chains));
      if (url.searchParams.get('chain_id') === '1') throw new Error('socket credentials redacted');
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')),
          { once: true });
      });
    });
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
    ).fetchCompleteCatalogue(), 'TRANSPORT_ERROR');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(transport.maxActive <= 8);
    assert.equal(transport.active, 0);
  });
});

describe('catalogue fail-closed validation', () => {
  it('rejects unstable metadata and incomplete page lengths', async () => {
    const badPages = [
      page('chains', [chain()], 1, 2, 1),
      page('chains', [chain()], 51, 1, 2),
      { status: true, data: { total: 1, page: 1, limit: 49, totalPages: 1, chains: [chain()] } },
    ];
    for (const bad of badPages) {
      const transport = route({ '/fixture/get-chain?page=1&limit=50': bad });
      await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
        'https://catalogue.test.invalid/fixture', transport,
      ).fetchCompleteCatalogue(), 'PAGINATION_INCONSISTENT');
    }
  });

  it('rejects malformed rows, duplicate identities, and wrong chain associations', async () => {
    const cases: Array<readonly [unknown[], string]> = [
      [[chain(0)], 'INVALID_RESPONSE'],
      [[chain(1, { is_evm: true })], 'INVALID_RESPONSE'],
      [[chain(1), chain(1)], 'DUPLICATE_PROVIDER_ID'],
      [[chain(1), chain(2, { name: 'Other', short_name: 'ETH' })], 'DUPLICATE_PROVIDER_ID'],
    ];
    for (const [rows, code] of cases) {
      const transport = route({ '/fixture/get-chain?page=1&limit=50': page('chains', rows) });
      await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
        'https://catalogue.test.invalid/fixture', transport,
      ).fetchCompleteCatalogue(), code);
    }

    const badCoins: Array<readonly [Record<string, unknown>[], string]> = [
      [[coin(0)], 'INVALID_RESPONSE'],
      [[coin(1, { decimal: 18 })], 'INVALID_RESPONSE'],
      [[coin(1, { decimal: '18.1' })], 'INVALID_RESPONSE'],
      [[coin(1, { status: 'disabled ' })], 'INVALID_RESPONSE'],
      [[coin(1, { is_stake: 1 })], 'INVALID_RESPONSE'],
      [[coin(1, { chain_id: 2 })], 'WRONG_CHAIN_ASSOCIATION'],
      [[coin(1, { chain_name: 'Wrong' })], 'WRONG_CHAIN_ASSOCIATION'],
      [[coin(1), coin(1, { token_address: '0x2' })], 'DUPLICATE_PROVIDER_ID'],
      [[coin(1, { token_address: '0xAbC' }), coin(2, { token_address: '0xaBc' })], 'DUPLICATE_PROVIDER_ID'],
      [[coin(1, { currency_name: 'ETH', token_address: null, is_base_currency: 1 }),
        coin(2, { currency_name: 'ETH2', token_address: null, is_base_currency: 1 })],
      'DUPLICATE_PROVIDER_ID'],
    ];
    for (const [rows, code] of badCoins) {
      const transport = route({
        '/fixture/get-chain?page=1&limit=50': page('chains', [chain()]),
        '/fixture/get-coin?chain_id=1&page=1&limit=50': page('coins', rows),
      });
      await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
        'https://catalogue.test.invalid/fixture', transport,
      ).fetchCompleteCatalogue(), code);
    }
  });

  it('enforces configured count limits before accepting any partial snapshot', async () => {
    const limits = {
      WALLET_CATALOGUE_MAX_CHAINS: '1', WALLET_CATALOGUE_MAX_COINS_PER_CHAIN: '1',
      WALLET_CATALOGUE_MAX_COINS_PER_REFRESH: '1',
    };
    const tooManyChains = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain(), chain(2, {
        name: 'Other', short_name: 'OTHER',
      })]),
    });
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', tooManyChains, limits,
    ).fetchCompleteCatalogue(), 'CATALOGUE_LIMIT_EXCEEDED');
    const tooManyCoins = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain()]),
      '/fixture/get-coin?chain_id=1&page=1&limit=50': page('coins', [coin(), coin(11)]),
    });
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', tooManyCoins, limits,
    ).fetchCompleteCatalogue(), 'CATALOGUE_LIMIT_EXCEEDED');
    const tooManyAcrossChains = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain(), chain(2, {
        name: 'Other', short_name: 'OTHER',
      })]),
      '/fixture/get-coin?chain_id=1&page=1&limit=50': page('coins', [coin()]),
      '/fixture/get-coin?chain_id=2&page=1&limit=50': page('coins', [coin(20, {
        chain_id: 2, chain_name: 'Other', chain_short_name: 'OTHER',
      })]),
    });
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', tooManyAcrossChains, limits,
    ).fetchCompleteCatalogue(), 'CATALOGUE_LIMIT_EXCEEDED');
  });

  it('cancels streamed bodies on per-page and shared decoded-byte overflow', async () => {
    let cancelled = 0;
    const transport = new FakeTransport(() => streamedJson(page('chains', [chain()]), {
      chunk: 20, cancelled: () => { cancelled += 1; },
    }));
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', transport,
      { WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES: '30' },
    ).fetchCompleteCatalogue(), 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, 1);

    const shared = route({
      '/fixture/get-chain?page=1&limit=50': page('chains', [chain()]),
      '/fixture/get-coin?chain_id=1&page=1&limit=50': page('coins', []),
    });
    await rejectsCode(() => BlockchainAdminCatalogueClient.forTest(
      'https://catalogue.test.invalid/fixture', shared,
      { WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES: '200',
        WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES: '200' },
    ).fetchCompleteCatalogue(), 'RESPONSE_TOO_LARGE');
  });

  it('normalizes response, timeout, and transport failures to safe codes only', async () => {
    const cases: Array<readonly [TransportHandler, string]> = [
      [() => new Response(null, { status: 503 }), 'PROVIDER_REJECTED'],
      [() => streamedJson({ status: false, secret: 'provider-body' }), 'PROVIDER_REJECTED'],
      [() => streamedJson('not-an-envelope'), 'INVALID_RESPONSE'],
      [() => { throw new DOMException('timed out', 'AbortError'); }, 'TIMEOUT'],
      [() => { throw new Error('https://secret.internal/token'); }, 'TRANSPORT_ERROR'],
      [() => new Response(new ReadableStream({
        start(controller) { controller.error(new Error('stream socket failed')); },
      })), 'TRANSPORT_ERROR'],
    ];
    for (const [handler, code] of cases) {
      const client = BlockchainAdminCatalogueClient.forTest(
        'https://catalogue.test.invalid/fixture', new FakeTransport(handler),
      );
      await assert.rejects(() => client.fetchCompleteCatalogue(), (error: unknown) =>
        error instanceof WalletCatalogueClientError && error.code === code
        && error.message === code && !error.message.includes('secret'));
    }
  });
});
