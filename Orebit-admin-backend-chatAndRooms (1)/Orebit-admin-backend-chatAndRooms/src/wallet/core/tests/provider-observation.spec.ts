import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BlockchainAdminCatalogueClient,
  type BlockchainAdminTransport,
  type ProviderObservationResult,
  type WalletProviderObservationErrorCode,
} from '../blockchain-admin.client.js';
import { persistProviderWaves } from '../provider-request-wave.js';
import type { WalletCoreClient } from '../wallet-core.database.js';

class FakeTransport implements BlockchainAdminTransport {
  readonly calls: string[] = [];
  constructor(private readonly handler: (url: URL) => Response | Promise<Response>) {}
  async request(url: URL): Promise<Response> {
    this.calls.push(url.pathname + url.search);
    return this.handler(url);
  }
}

const chain = (id: number, status = 'activated') => ({
  id, name: `Chain ${id}`, short_name: `C${id}`, status, is_evm: 1,
});
const coin = (chainId: number, id: number, status = 'activated') => ({
  id, chain_id: chainId, currency_name: `COIN${id}`, token_address: `0x${id}`,
  decimal: '18', is_base_currency: 0, is_stake: 0, status,
  chain_name: `Chain ${chainId}`, chain_short_name: `C${chainId}`,
});
const page = (key: 'chains' | 'coins', rows: unknown[], total = rows.length, pageNumber = 1,
  totalPages = Math.max(1, Math.ceil(total / 50))) => new Response(JSON.stringify({
  status: true,
  data: { total, page: pageNumber, limit: 50, totalPages, [key]: rows },
}));
const client = (transport: BlockchainAdminTransport) => BlockchainAdminCatalogueClient.forTest(
  'https://provider.test.invalid/user/v1', transport,
);

describe('scoped blockchain provider observations', () => {
  it('returns a frozen empty result without calling the provider for an empty scope', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('empty scope must not perform transport');
    });
    const result = await client(transport).fetchScopedProviderObservations({ chains: [] });
    assert.deepEqual(result, { chains: [], bindings: [], failures: [] });
    assert.equal(transport.calls.length, 0);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.chains));
    assert.ok(Object.isFrozen(result.bindings));
    assert.ok(Object.isFrozen(result.failures));
  });

  it('deduplicates and sorts configured targets while preserving observed states and omissions', async () => {
    const transport = new FakeTransport((url) => {
      if (url.pathname.endsWith('/get-chain')) {
        return page('chains', [chain(2, 'maintenance'), chain(1)]);
      }
      const chainId = Number(url.searchParams.get('chain_id'));
      return page('coins', chainId === 1
        ? [coin(1, 10, 'disabled')]
        : [coin(2, 20, 'activated')]);
    });
    const result = await client(transport).fetchScopedProviderObservations({ chains: [
      { providerChainId: 2, bindings: [{ providerCoinId: 20 }, { providerCoinId: 20 }] },
      { providerChainId: 1, bindings: [{ providerCoinId: 11 }, { providerCoinId: 10 }] },
      { providerChainId: 1, bindings: [{ providerCoinId: 10 }] },
    ] });
    assert.deepEqual(result, {
      chains: [
        { outcome: 'OBSERVED', providerChainId: 1, providerState: 'ACTIVATED' },
        { outcome: 'OBSERVED', providerChainId: 2, providerState: 'MAINTENANCE' },
      ],
      bindings: [
        { outcome: 'OBSERVED', providerChainId: 1, providerCoinId: 10, providerState: 'DISABLED' },
        { outcome: 'OMITTED', providerChainId: 1, providerCoinId: 11 },
        { outcome: 'OBSERVED', providerChainId: 2, providerCoinId: 20, providerState: 'ACTIVATED' },
      ],
      failures: [],
    } satisfies ProviderObservationResult);
    assert.deepEqual(transport.calls.slice(1), [
      '/user/v1/get-coin?chain_id=1&page=1&limit=50',
      '/user/v1/get-coin?chain_id=2&page=1&limit=50',
    ]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.bindings));
  });

  it('traverses every chain and coin page before resolving configured observations', async () => {
    const chains = Array.from({ length: 51 }, (_, index) => chain(index + 1));
    const coins = Array.from({ length: 51 }, (_, index) => coin(51, index + 1));
    const transport = new FakeTransport((url) => {
      const pageNumber = Number(url.searchParams.get('page'));
      if (url.pathname.endsWith('/get-chain')) {
        return page('chains', pageNumber === 1 ? chains.slice(0, 50) : chains.slice(50),
          51, pageNumber, 2);
      }
      return page('coins', pageNumber === 1 ? coins.slice(0, 50) : coins.slice(50),
        51, pageNumber, 2);
    });
    const result = await client(transport).fetchScopedProviderObservations({
      chains: [{ providerChainId: 51, bindings: [{ providerCoinId: 51 }] }],
    });
    assert.deepEqual(result, {
      chains: [{ outcome: 'OBSERVED', providerChainId: 51, providerState: 'ACTIVATED' }],
      bindings: [{ outcome: 'OBSERVED', providerChainId: 51, providerCoinId: 51,
        providerState: 'ACTIVATED' }],
      failures: [],
    });
    assert.deepEqual(transport.calls, [
      '/user/v1/get-chain?page=1&limit=50',
      '/user/v1/get-chain?page=2&limit=50',
      '/user/v1/get-coin?chain_id=51&page=1&limit=50',
      '/user/v1/get-coin?chain_id=51&page=2&limit=50',
    ]);
  });

  it('admits at most fifty multipage requests before awaiting the next checkpoint', async () => {
    const chains = Array.from({ length: 51 }, (_, index) => chain(index + 1));
    let starts = 0;
    const checkpoints: number[] = [];
    const transport = new FakeTransport((url) => {
      starts += 1;
      const pageNumber = Number(url.searchParams.get('page'));
      if (url.pathname.endsWith('/get-chain')) {
        return page('chains', pageNumber === 1 ? chains.slice(0, 50) : chains.slice(50),
          51, pageNumber, 2);
      }
      const chainId = Number(url.searchParams.get('chain_id'));
      return page('coins', [coin(chainId, chainId * 10)]);
    });
    const result = await client(transport).fetchScopedProviderObservations({
      chains: chains.map((entry) => ({ providerChainId: entry.id,
        bindings: [{ providerCoinId: entry.id * 10 }] })),
    }, async () => { checkpoints.push(starts); });
    assert.equal(result.failures.length, 0);
    assert.equal(starts, 53);
    assert.deepEqual(checkpoints, [50]);
  });

  it('propagates a checkpoint failure unchanged and admits no later request wave', async () => {
    const chains = Array.from({ length: 51 }, (_, index) => chain(index + 1));
    let starts = 0;
    let checkpointCalls = 0;
    const sentinel = new Error('LEASE_CHECKPOINT_LOST');
    const transport = new FakeTransport((url) => {
      starts += 1;
      const pageNumber = Number(url.searchParams.get('page'));
      if (url.pathname.endsWith('/get-chain')) {
        return page('chains', pageNumber === 1 ? chains.slice(0, 50) : chains.slice(50),
          51, pageNumber, 2);
      }
      const chainId = Number(url.searchParams.get('chain_id'));
      return page('coins', [coin(chainId, chainId * 10)]);
    });
    await assert.rejects(() => client(transport).fetchScopedProviderObservations({
      chains: chains.map((entry) => ({ providerChainId: entry.id,
        bindings: [{ providerCoinId: entry.id * 10 }] })),
    }, async () => { checkpointCalls += 1; throw sentinel; }), (error) => error === sentinel);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 50);
    assert.equal(checkpointCalls, 1);
  });

  it('keeps chain and binding omissions independent', async () => {
    const transport = new FakeTransport((url) => url.pathname.endsWith('/get-chain')
      ? page('chains', []) : page('coins', [coin(7, 70)]));
    const result = await client(transport).fetchScopedProviderObservations({
      chains: [{ providerChainId: 7, bindings: [{ providerCoinId: 70 }] }],
    });
    assert.deepEqual(result.chains, [{ outcome: 'OMITTED', providerChainId: 7 }]);
    assert.deepEqual(result.bindings, [{
      outcome: 'OBSERVED', providerChainId: 7, providerCoinId: 70,
      providerState: 'ACTIVATED',
    }]);
    assert.equal(transport.calls.some((call) => call.includes('chain_id=7')), true);
  });

  it('returns one ALL failure and makes no coin calls when get-chain fails', async () => {
    const transport = new FakeTransport(() => { throw new Error('socket secret'); });
    const result = await client(transport).fetchScopedProviderObservations({
      chains: [{ providerChainId: 1, bindings: [{ providerCoinId: 10 }] }],
    });
    assert.deepEqual(result, {
      chains: [], bindings: [],
      failures: [{ scope: 'ALL', safeErrorCode: 'TRANSPORT_ERROR' }],
    });
    assert.equal(transport.calls.length, 1);
  });

  it('maps representative chain-list failures to closed ALL-scope safe codes', async () => {
    const cases: readonly Readonly<{
      code: WalletProviderObservationErrorCode;
      response: () => Response | Promise<Response>;
      deployment?: Readonly<Record<string, string>>;
    }>[] = [
      { code: 'TIMEOUT',
        response: () => { throw new DOMException('provider detail', 'AbortError'); } },
      { code: 'RESPONSE_TOO_LARGE', response: () => page('chains', [chain(1)]),
        deployment: { WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES: '20',
          WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES: '20' } },
      { code: 'INVALID_RESPONSE',
        response: () => new Response(JSON.stringify({ status: true, data: null })) },
      { code: 'PAGINATION_INCONSISTENT',
        response: () => page('chains', [chain(1)], 1, 2, 1) },
      { code: 'DUPLICATE_PROVIDER_ID',
        response: () => page('chains', [chain(1), chain(1)]) },
    ];
    for (const value of cases) {
      const transport = new FakeTransport(value.response);
      const result = await BlockchainAdminCatalogueClient.forTest(
        'https://provider.test.invalid/user/v1', transport, value.deployment,
      ).fetchScopedProviderObservations({
        chains: [{ providerChainId: 1, bindings: [{ providerCoinId: 10 }] }],
      });
      assert.deepEqual(result, {
        chains: [], bindings: [], failures: [{ scope: 'ALL', safeErrorCode: value.code }],
      }, value.code);
      assert.equal(transport.calls.length, 1, value.code);
    }
  });

  it('scopes each get-coin failure only to that chain bindings', async () => {
    const transport = new FakeTransport((url) => {
      if (url.pathname.endsWith('/get-chain')) return page('chains', [chain(1), chain(2)]);
      if (url.searchParams.get('chain_id') === '1') return new Response(null, { status: 503 });
      return page('coins', []);
    });
    const result = await client(transport).fetchScopedProviderObservations({ chains: [
      { providerChainId: 1, bindings: [{ providerCoinId: 10 }] },
      { providerChainId: 2, bindings: [{ providerCoinId: 20 }] },
    ] });
    assert.deepEqual(result.chains.map((entry) => entry.providerChainId), [1, 2]);
    assert.deepEqual(result.bindings, [
      { outcome: 'OMITTED', providerChainId: 2, providerCoinId: 20 },
    ]);
    assert.deepEqual(result.failures, [{
      scope: 'CHAIN', providerChainId: 1, safeErrorCode: 'PROVIDER_REJECTED',
    }]);
  });

  it('maps wrong-chain coin rows only to the affected chain binding scope', async () => {
    const transport = new FakeTransport((url) => url.pathname.endsWith('/get-chain')
      ? page('chains', [chain(1), chain(2)])
      : url.searchParams.get('chain_id') === '1'
        ? page('coins', [coin(2, 10)])
        : page('coins', [coin(2, 20)]));
    const result = await client(transport).fetchScopedProviderObservations({ chains: [
      { providerChainId: 1, bindings: [{ providerCoinId: 10 }] },
      { providerChainId: 2, bindings: [{ providerCoinId: 20 }] },
    ] });
    assert.deepEqual(result.failures, [{
      scope: 'CHAIN', providerChainId: 1, safeErrorCode: 'WRONG_CHAIN_ASSOCIATION',
    }]);
    assert.deepEqual(result.bindings, [{
      outcome: 'OBSERVED', providerChainId: 2, providerCoinId: 20,
      providerState: 'ACTIVATED',
    }]);
  });

  it('excludes persistence-only errors from scoped provider failure contracts', () => {
    const safe: WalletProviderObservationErrorCode = 'CATALOGUE_LIMIT_EXCEEDED';
    // @ts-expect-error database persistence is not part of the observation client
    const database: WalletProviderObservationErrorCode = 'DATABASE_ERROR';
    // @ts-expect-error audit persistence is not part of the observation client
    const audit: WalletProviderObservationErrorCode = 'AUDIT_ERROR';
    assert.equal([safe, database, audit].length, 3);
  });

  it('stops before the tail after the first completely failed later persistence wave', async () => {
    const calls: number[] = [];
    let checkpoints = 0;
    const client = {
      async query() { return { rows: [], rowCount: null }; },
      release() {},
    } satisfies WalletCoreClient;
    const result = await persistProviderWaves(client,
      Array.from({ length: 101 }, (_, index) => index), async (item) => {
        calls.push(item);
        if (item >= 50 && item < 100) throw new Error('PERSISTENCE_SENTINEL');
        return false;
      }, async () => { checkpoints += 1; });
    assert.deepEqual(result, { processedCount: 100, failedCount: 50,
      persistenceFailedCount: 50, stopped: true });
    assert.equal(checkpoints, 1);
    assert.equal(calls.includes(100), false);
  });
});
