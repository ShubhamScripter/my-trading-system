import type {
  ProviderBindingObservation, ProviderChainObservation, ProviderObservationFailure,
  ProviderObservationResult, ProviderObservationScope, WalletCatalogueRefreshErrorCode,
  WalletProviderObservationErrorCode,
} from './wallet-core.types.js';
import {
  ProviderRequestCheckpointError,
  ProviderRequestWave,
  type ProviderRequestCheckpoint,
} from './provider-request-wave.js';
export type { ProviderObservationResult, WalletProviderObservationErrorCode } from './wallet-core.types.js';
export const BLOCKCHAIN_ADMIN_ORIGIN = 'https://wallet-user.orebit.dev/user/v1';
export const CATALOGUE_PAGE_SIZE = 50;
export const CATALOGUE_CONCURRENCY = 8;
export const CATALOGUE_TIMEOUT_MS = 10_000;
const CAP_ENV = {
  maxChains: ['WALLET_CATALOGUE_MAX_CHAINS', 100],
  maxCoinsPerChain: ['WALLET_CATALOGUE_MAX_COINS_PER_CHAIN', 2_000],
  maxTotalCoins: ['WALLET_CATALOGUE_MAX_COINS_PER_REFRESH', 10_000],
  maxPageBytes: ['WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES', 2_097_152],
  maxTotalBytes: ['WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES', 67_108_864],
} as const;
export interface WalletCatalogueLimits {
  readonly maxChains: number; readonly maxCoinsPerChain: number;
  readonly maxTotalCoins: number; readonly maxPageBytes: number; readonly maxTotalBytes: number;
}
export interface BlockchainAdminTransport { request(url: URL, init: RequestInit): Promise<Response> }
export interface CatalogueDeadlineTimer {
  set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void;
}
export interface NormalizedProviderChain {
  readonly providerChainId: number; readonly name: string; readonly shortName: string;
  readonly state: 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE';
  readonly isEvm: boolean;
}
export interface NormalizedProviderCoin {
  readonly providerChainId: number; readonly providerCoinId: number;
  readonly currencyName: string; readonly tokenAddress: string | null;
  readonly blockchainPrecision: number; readonly isBaseCurrency: boolean; readonly isStake: boolean;
  readonly state: 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE';
}
export interface NormalizedCatalogueSnapshot {
  readonly chains: readonly NormalizedProviderChain[]; readonly coins: readonly NormalizedProviderCoin[];
  readonly decodedBytes: number;
}
export interface BlockchainAdminClient {
  fetchCompleteCatalogue(): Promise<NormalizedCatalogueSnapshot>;
  fetchScopedProviderObservations(scope: ProviderObservationScope,
    checkpoint?: ProviderRequestCheckpoint): Promise<ProviderObservationResult>;
}
export class WalletCatalogueClientError extends Error {
  constructor(readonly code: WalletCatalogueRefreshErrorCode) {
    super(code); this.name = 'WalletCatalogueClientError';
  }
}
/** Enforces both per-page and whole-refresh decoded byte ceilings while streaming responses. */
export class CatalogueDecodedByteBudget {
  decodedBytes = 0;
  constructor(private readonly pageLimit: number, private readonly totalLimit: number) {}
  beginPage(cancel: () => void): { consume(bytes: number): void } {
    let pageBytes = 0;
    return { consume: (bytes) => {
      pageBytes += bytes;
      this.decodedBytes += bytes;
      if (pageBytes > this.pageLimit || this.decodedBytes > this.totalLimit) {
        cancel();
        throw new WalletCatalogueClientError('RESPONSE_TOO_LARGE');
      }
    } };
  }
}
export function parseWalletCatalogueLimits(
  source: Readonly<Record<string, string | undefined>>,
): WalletCatalogueLimits {
  const read = (name: string, fallback: number): number => {
    const raw = source[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error('WALLET_CATALOGUE_CONFIGURATION_INVALID');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error('WALLET_CATALOGUE_CONFIGURATION_INVALID');
    return value;
  };
  const limits = {
    maxChains: read(...CAP_ENV.maxChains),
    maxCoinsPerChain: read(...CAP_ENV.maxCoinsPerChain),
    maxTotalCoins: read(...CAP_ENV.maxTotalCoins),
    maxPageBytes: read(...CAP_ENV.maxPageBytes),
    maxTotalBytes: read(...CAP_ENV.maxTotalBytes),
  };
  if (limits.maxTotalBytes < limits.maxPageBytes) {
    throw new Error('WALLET_CATALOGUE_CONFIGURATION_INVALID');
  }
  return limits;
}
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= CATALOGUE_CONCURRENCY) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try { return await work(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
interface PageData {
  readonly total: number; readonly page: number; readonly limit: number;
  readonly totalPages: number; readonly rows: readonly unknown[];
}
interface RefreshBudget { readonly bytes: CatalogueDecodedByteBudget; declaredCoins: number }

const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const requirePositiveId = (value: unknown): number => positiveId(value) ? value : invalid();
const flag = (value: unknown): boolean => value === 0 ? false : value === 1 ? true : invalid();
const text = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string') throw invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) throw invalid();
  return normalized;
};
const upper = (value: unknown, maximum: number): string => text(value, maximum).toUpperCase();
const state = (value: unknown): NormalizedProviderChain['state'] => {
  if (value === 'activated') return 'ACTIVATED';
  if (value === 'disabled') return 'DISABLED';
  if (value === 'maintenance') return 'MAINTENANCE';
  throw invalid();
};
const precision = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(?:\.0+)?$/.test(value)) throw invalid();
  const parsed = Number(value.split('.')[0]);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) throw invalid();
  return parsed;
};
const invalid = (): never => { throw new WalletCatalogueClientError('INVALID_RESPONSE'); };
const pagination = (): never => { throw new WalletCatalogueClientError('PAGINATION_INCONSISTENT'); };
const duplicate = (): never => { throw new WalletCatalogueClientError('DUPLICATE_PROVIDER_ID'); };
const observationError = (error: unknown): WalletProviderObservationErrorCode =>
  error instanceof WalletCatalogueClientError
    && error.code !== 'DATABASE_ERROR' && error.code !== 'AUDIT_ERROR'
    ? error.code : 'INVALID_RESPONSE';
const observationResult = (
  chains: ProviderChainObservation[], bindings: ProviderBindingObservation[],
  failures: ProviderObservationFailure[],
): ProviderObservationResult => Object.freeze({ chains: Object.freeze(chains),
  bindings: Object.freeze(bindings), failures: Object.freeze(failures) });

function origin(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value.endsWith('/') ? value : value + '/'); }
  catch { throw new Error('WALLET_CATALOGUE_ORIGIN_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash) throw new Error('WALLET_CATALOGUE_ORIGIN_INVALID');
  return parsed;
}

const fetchTransport: BlockchainAdminTransport = {
  request: (url, init) => fetch(url, init),
};
const systemTimer: CatalogueDeadlineTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** Fetches bounded catalogue/status data and rejects inconsistent provider pagination or identity. */
export class BlockchainAdminCatalogueClient implements BlockchainAdminClient {
  private readonly semaphore = new Semaphore();
  private constructor(
    private readonly baseUrl: URL,
    private readonly transport: BlockchainAdminTransport,
    private readonly limits: WalletCatalogueLimits,
    private readonly timer: CatalogueDeadlineTimer,
  ) {}

  static production(
    transport: BlockchainAdminTransport = fetchTransport,
    deployment: Readonly<Record<string, string | undefined>> = process.env,
  ): BlockchainAdminCatalogueClient {
    return new BlockchainAdminCatalogueClient(origin(BLOCKCHAIN_ADMIN_ORIGIN), transport,
      parseWalletCatalogueLimits(deployment), systemTimer);
  }

  static forTest(
    testOrigin: string,
    transport: BlockchainAdminTransport,
    deployment: Readonly<Record<string, string | undefined>> = {},
    timer: CatalogueDeadlineTimer = systemTimer,
  ): BlockchainAdminCatalogueClient {
    return new BlockchainAdminCatalogueClient(origin(testOrigin), transport,
      parseWalletCatalogueLimits(deployment), timer);
  }

  async fetchCompleteCatalogue(): Promise<NormalizedCatalogueSnapshot> {
    const abort = new AbortController();
    const budget: RefreshBudget = {
      bytes: new CatalogueDecodedByteBudget(this.limits.maxPageBytes, this.limits.maxTotalBytes),
      declaredCoins: 0,
    };
    try {
      const chainRows = await this.pages('chains', (pageNumber) =>
        this.url('get-chain', { page: pageNumber, limit: CATALOGUE_PAGE_SIZE }),
      this.limits.maxChains, abort, budget);
      const chains = this.normalizeChains(chainRows);
      const coins = (await Promise.all(chains.map(async (chain) => {
        const rows = await this.pages('coins', (pageNumber) => this.url('get-coin', {
          chain_id: chain.providerChainId, page: pageNumber, limit: CATALOGUE_PAGE_SIZE,
        }), this.limits.maxCoinsPerChain, abort, budget, true);
        return this.normalizeCoins(rows, chain);
      }))).flat();
      if (coins.length > this.limits.maxTotalCoins) throw new WalletCatalogueClientError('CATALOGUE_LIMIT_EXCEEDED');
      return Object.freeze({
        chains: Object.freeze(chains), coins: Object.freeze(coins),
        decodedBytes: budget.bytes.decodedBytes,
      });
    } catch (error) {
      abort.abort();
      if (error instanceof WalletCatalogueClientError) throw error;
      throw new WalletCatalogueClientError('INVALID_RESPONSE');
    }
  }

  async fetchScopedProviderObservations(
    input: ProviderObservationScope,
    checkpoint?: ProviderRequestCheckpoint,
  ): Promise<ProviderObservationResult> {
    const targets = new Map<number, Set<number>>();
    for (const chain of input.chains) {
      const chainId = requirePositiveId(chain.providerChainId);
      const bindings = targets.get(chainId) ?? new Set<number>();
      for (const binding of chain.bindings) bindings.add(requirePositiveId(binding.providerCoinId));
      targets.set(chainId, bindings);
    }
    const scope = [...targets].sort(([left], [right]) => left - right)
      .map(([providerChainId, bindings]) => ({
        providerChainId, bindings: [...bindings].sort((left, right) => left - right),
      }));
    if (scope.length === 0) return observationResult([], [], []);
    const abort = new AbortController();
    const budget: RefreshBudget = {
      bytes: new CatalogueDecodedByteBudget(this.limits.maxPageBytes, this.limits.maxTotalBytes),
      declaredCoins: 0,
    };
    const wave = new ProviderRequestWave(checkpoint);
    let chainStates: Map<number, NormalizedProviderChain['state']>;
    try {
      const rows = await this.pages('chains', (page) => this.url('get-chain', {
        page, limit: CATALOGUE_PAGE_SIZE,
      }), this.limits.maxChains, abort, budget, false, wave);
      chainStates = this.statuses(rows);
    } catch (error) {
      if (error instanceof ProviderRequestCheckpointError) throw error.reason;
      return observationResult([], [], [{ scope: 'ALL', safeErrorCode: observationError(error) }]);
    }
    const chains: ProviderChainObservation[] = scope.map(({ providerChainId }) => {
      const providerState = chainStates.get(providerChainId);
      return providerState === undefined ? { outcome: 'OMITTED', providerChainId }
        : { outcome: 'OBSERVED', providerChainId, providerState };
    });
    const batches = await Promise.all(scope.map(async ({ providerChainId, bindings }) => {
      if (bindings.length === 0) return { bindings: [] as ProviderBindingObservation[] };
      try {
        const rows = await this.pages('coins', (page) => this.url('get-coin', {
          chain_id: providerChainId, page, limit: CATALOGUE_PAGE_SIZE,
        }), this.limits.maxCoinsPerChain, abort, budget, true, wave);
        const states = this.statuses(rows, providerChainId);
        return { bindings: bindings.map((providerCoinId): ProviderBindingObservation => {
          const providerState = states.get(providerCoinId);
          return providerState === undefined
            ? { outcome: 'OMITTED', providerChainId, providerCoinId }
            : { outcome: 'OBSERVED', providerChainId, providerCoinId, providerState };
        }) };
      } catch (error) {
        if (error instanceof ProviderRequestCheckpointError) throw error.reason;
        return { bindings: [] as ProviderBindingObservation[], failure: {
          scope: 'CHAIN' as const, providerChainId, safeErrorCode: observationError(error),
        } };
      }
    }));
    return observationResult(chains, batches.flatMap((batch) => batch.bindings),
      batches.flatMap((batch) => batch.failure === undefined ? [] : [batch.failure]));
  }

  private url(path: 'get-chain' | 'get-coin', values: Record<string, number>): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
    return url;
  }

  private async pages(
    key: 'chains' | 'coins',
    url: (page: number) => URL,
    maximum: number,
    abort: AbortController,
    budget: RefreshBudget,
    countCoins = false,
    wave?: ProviderRequestWave,
  ): Promise<readonly unknown[]> {
    const first = await this.requestPage(url(1), key, abort, budget, wave);
    this.validatePage(first, 1);
    if (first.total > maximum) throw new WalletCatalogueClientError('CATALOGUE_LIMIT_EXCEEDED');
    if (countCoins) {
      budget.declaredCoins += first.total;
      if (budget.declaredCoins > this.limits.maxTotalCoins) {
        throw new WalletCatalogueClientError('CATALOGUE_LIMIT_EXCEEDED');
      }
    }
    const rows = [...first.rows];
    for (let pageNumber = 2; pageNumber <= first.totalPages; pageNumber += 1) {
      const next = await this.requestPage(url(pageNumber), key, abort, budget, wave);
      this.validatePage(next, pageNumber, first);
      rows.push(...next.rows);
    }
    if (rows.length !== first.total) pagination();
    return rows;
  }

  private validatePage(page: PageData, requested: number, first = page): void {
    if (!Number.isSafeInteger(page.total) || page.total < 0
      || !positiveId(page.page) || page.page !== requested
      || page.limit !== CATALOGUE_PAGE_SIZE || !positiveId(page.totalPages)
      || page.totalPages !== Math.max(1, Math.ceil(page.total / CATALOGUE_PAGE_SIZE))
      || page.total !== first.total || page.limit !== first.limit
      || page.totalPages !== first.totalPages) pagination();
    const expected = requested < page.totalPages
      ? CATALOGUE_PAGE_SIZE : page.total - CATALOGUE_PAGE_SIZE * (page.totalPages - 1);
    if (page.rows.length !== expected) pagination();
  }

  private async requestPage(
    url: URL,
    key: 'chains' | 'coins',
    abort: AbortController,
    budget: RefreshBudget,
    wave?: ProviderRequestWave,
  ): Promise<PageData> {
    return this.semaphore.run(async () => {
      if (wave) await wave.beforeRequest();
      if (abort.signal.aborted) throw new WalletCatalogueClientError('TRANSPORT_ERROR');
      const timeout = new AbortController();
      let timedOut = false;
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let timerHandle: unknown;
      const deadline = new Promise<never>((_resolve, reject) => {
        timerHandle = this.timer.set(() => {
          timedOut = true;
          timeout.abort();
          if (activeReader !== null) void activeReader.cancel().catch(() => undefined);
          reject(new WalletCatalogueClientError('TIMEOUT'));
        }, CATALOGUE_TIMEOUT_MS);
      });
      try {
        const operation = async (): Promise<PageData> => {
          let response: Response;
          try {
            response = await this.transport.request(url, {
              method: 'GET', redirect: 'error', signal: AbortSignal.any([abort.signal, timeout.signal]),
            });
          } catch (error) {
            if (timedOut || timeout.signal.aborted
              || (error instanceof DOMException && error.name === 'AbortError')) {
              throw new WalletCatalogueClientError('TIMEOUT');
            }
            throw new WalletCatalogueClientError('TRANSPORT_ERROR');
          }
          if (timedOut) throw new WalletCatalogueClientError('TIMEOUT');
          if (!response.ok) throw new WalletCatalogueClientError('PROVIDER_REJECTED');
          const parsed = await this.readJson(response, budget,
            (reader) => { activeReader = reader; }, () => timedOut);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid();
          const envelope = parsed as Record<string, unknown>;
          if (envelope.status !== true) throw new WalletCatalogueClientError('PROVIDER_REJECTED');
          if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) invalid();
          const data = envelope.data as Record<string, unknown>;
          if (!Array.isArray(data[key])) invalid();
          return {
            total: data.total as number, page: data.page as number, limit: data.limit as number,
            totalPages: data.totalPages as number, rows: data[key] as unknown[],
          };
        };
        return await Promise.race([operation(), deadline]);
      } finally { this.timer.clear(timerHandle); }
    });
  }

  private async readJson(
    response: Response,
    budget: RefreshBudget,
    acquired: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
    timedOut: () => boolean,
  ): Promise<unknown> {
    const body = response.body;
    if (body === null) throw new WalletCatalogueClientError('INVALID_RESPONSE');
    const reader = body.getReader();
    acquired(reader);
    const pageBudget = budget.bytes.beginPage(() => {
      void reader.cancel().catch(() => undefined);
    });
    const chunks: Uint8Array[] = [];
    let pageBytes = 0;
    let complete = false;
    try {
      while (!complete) {
        const part = await reader.read();
        if (part.done) { complete = true; continue; }
        pageBytes += part.value.byteLength;
        pageBudget.consume(part.value.byteLength);
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof WalletCatalogueClientError) throw error;
      if (timedOut()) throw new WalletCatalogueClientError('TIMEOUT');
      throw new WalletCatalogueClientError('TRANSPORT_ERROR');
    } finally { reader.releaseLock(); }
    try {
      const bytes = new Uint8Array(pageBytes);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      if (error instanceof WalletCatalogueClientError) throw error;
      return invalid();
    }
  }

  private normalizeChains(rows: readonly unknown[]): NormalizedProviderChain[] {
    const ids = new Set<number>();
    const names = new Set<string>();
    return rows.map((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
      const row = value as Record<string, unknown>;
      const id = requirePositiveId(row.id);
      const shortName = upper(row.short_name, 32);
      if (ids.has(id) || names.has(shortName)) duplicate();
      ids.add(id); names.add(shortName);
      return {
        providerChainId: id, name: text(row.name, 128), shortName,
        state: state(row.status), isEvm: flag(row.is_evm),
      };
    });
  }

  private statuses(
    rows: readonly unknown[], providerChainId?: number,
  ): Map<number, NormalizedProviderChain['state']> {
    const result = new Map<number, NormalizedProviderChain['state']>();
    for (const value of rows) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
      const row = value as Record<string, unknown>;
      const id = requirePositiveId(row.id);
      if (providerChainId !== undefined && requirePositiveId(row.chain_id) !== providerChainId) {
        throw new WalletCatalogueClientError('WRONG_CHAIN_ASSOCIATION');
      }
      if (result.has(id)) duplicate();
      result.set(id, state(row.status));
    }
    return result;
  }

  private normalizeCoins(
    rows: readonly unknown[],
    chain: NormalizedProviderChain,
  ): NormalizedProviderCoin[] {
    const ids = new Set<number>();
    const identities = new Set<string>();
    let baseCoins = 0;
    return rows.map((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
      const row = value as Record<string, unknown>;
      const id = requirePositiveId(row.id);
      const chainId = requirePositiveId(row.chain_id);
      if (chainId !== chain.providerChainId) {
        throw new WalletCatalogueClientError('WRONG_CHAIN_ASSOCIATION');
      }
      const chainName = text(row.chain_name, 128);
      const chainShortName = upper(row.chain_short_name, 32);
      if (chainName !== chain.name || chainShortName !== chain.shortName) {
        throw new WalletCatalogueClientError('WRONG_CHAIN_ASSOCIATION');
      }
      const currencyName = upper(row.currency_name, 128);
      const base = flag(row.is_base_currency);
      const stake = flag(row.is_stake);
      const tokenAddress = row.token_address === null ? null : text(row.token_address, 256);
      if ((base && tokenAddress !== null) || (!base && tokenAddress === null) || (!base && stake)) invalid();
      if (base) { baseCoins += 1; if (baseCoins > 1) duplicate(); }
      const identity = base ? `BASE:${currencyName}`
        : `TOKEN:${chain.isEvm ? tokenAddress!.toLowerCase() : tokenAddress}`;
      if (ids.has(id) || identities.has(identity)) duplicate();
      ids.add(id); identities.add(identity);
      return {
        providerChainId: chain.providerChainId, providerCoinId: id,
        currencyName, tokenAddress, blockchainPrecision: precision(row.decimal),
        isBaseCurrency: base, isStake: stake, state: state(row.status),
      };
    });
  }
}
