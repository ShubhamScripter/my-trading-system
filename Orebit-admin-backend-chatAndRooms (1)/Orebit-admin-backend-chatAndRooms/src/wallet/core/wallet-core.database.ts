import pg from 'pg';

export interface WalletCoreQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface WalletCoreClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<WalletCoreQueryResult<Row>>;
  release(discard?: boolean): void;
}

export interface WalletCorePool {
  connect(): Promise<WalletCoreClient>;
  end(): Promise<void>;
}

export interface WalletCoreSchemaMap {
  readonly wallet: 'wallet_core' | 'wallet_core_test';
  readonly price: 'price_conversion' | 'price_conversion_test';
  readonly ledger: 'ledger' | 'ledger_test';
  readonly admin: 'admin' | 'admin_test';
}

export interface CatalogueEvidence {
  readonly chains: readonly Readonly<{
    providerChainId: number;
    name: string;
    shortName: string;
    isEvm: boolean;
    providerState: string;
    revision: number;
  }>[];
  readonly currencies: readonly Readonly<{
    providerChainId: number;
    providerCoinId: number;
    currencyName: string;
    tokenAddress: string | null;
    isBaseCurrency: boolean;
    isStake: boolean;
    blockchainPrecision: number;
    providerState: string;
    revision: number;
  }>[];
}

export interface WalletEntityChange {
  readonly action:
    | 'CHAIN.IMPORTED' | 'CHAIN.UPDATED' | 'CHAIN.STATUS_CHANGED'
    | 'CURRENCY.IMPORTED' | 'CURRENCY.UPDATED' | 'CURRENCY.STATUS_CHANGED'
    | 'PROVIDER_MAINTENANCE.PINNED' | 'PROVIDER_MAINTENANCE.UNPINNED';
  readonly subject: Readonly<{ type: 'CHAIN' | 'CURRENCY' | 'CURRENCY_CHAIN'; id: string }>;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
  readonly importCatalogueRevision?: number;
}

export interface LockedWalletSettings { readonly revision: number }
export interface StoredConfigurationChange {
  readonly id: string;
  readonly revision: number;
  readonly status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED';
  readonly effectiveAt: string | null;
  readonly appliedAt: Date | null;
  readonly reason: string;
  readonly changelogId: string | null;
  readonly actorId: string;
  readonly snapshot: unknown;
}
export interface ConfigurationChangeInsert {
  readonly id: string; readonly revision: number; readonly reason: string;
  readonly changelogId: string | null; readonly actorId: string; readonly snapshot: unknown;
}
export type ChainCatalogueEvidence = CatalogueEvidence['chains'][number];
export type CurrencyCatalogueEvidence = CatalogueEvidence['currencies'][number];
export const walletDbInteger = (value: unknown, allowZero = false): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
  }
  return number;
};
export const walletDbDate = (value: unknown): Date | null => {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
  return parsed;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
  return value;
};
export const chainCatalogueEvidence = (
  providerChainId: number, row: Record<string, unknown>,
): ChainCatalogueEvidence => ({ providerChainId, name: text(row.name),
  shortName: text(row.short_name), isEvm: bool(row.is_evm),
  providerState: text(row.provider_state), revision: walletDbInteger(row.revision, true) });
export const currencyCatalogueEvidence = (providerChainId: number, providerCoinId: number,
  row: Record<string, unknown>): CurrencyCatalogueEvidence => ({
  providerChainId, providerCoinId, currencyName: text(row.currency_name),
  tokenAddress: row.token_address === null ? null : text(row.token_address),
  isBaseCurrency: bool(row.is_base_currency), isStake: bool(row.is_stake),
  blockchainPrecision: walletDbInteger(row.blockchain_precision, true),
  providerState: text(row.provider_state), revision: walletDbInteger(row.revision, true),
});
export const sameCatalogueEvidence = (left: ChainCatalogueEvidence | CurrencyCatalogueEvidence,
  right: ChainCatalogueEvidence | CurrencyCatalogueEvidence): boolean => {
  const keys = Object.keys(left) as (keyof typeof left)[];
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

const PRODUCTION_SCHEMAS = Object.freeze({
  wallet: 'wallet_core',
  price: 'price_conversion',
  ledger: 'ledger',
  admin: 'admin',
} as const satisfies WalletCoreSchemaMap);

export const WALLET_CORE_TEST_SCHEMAS = Object.freeze({
  wallet: 'wallet_core_test',
  price: 'price_conversion_test',
  ledger: 'ledger_test',
  admin: 'admin_test',
} as const satisfies WalletCoreSchemaMap);

const exactSchemas = (value: WalletCoreSchemaMap, expected: WalletCoreSchemaMap): boolean =>
  Object.keys(value).length === 4
  && (Object.keys(expected) as (keyof WalletCoreSchemaMap)[])
    .every((key) => value[key] === expected[key]);

export function validateWalletCoreProductionUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WALLET_CORE_DATABASE_URL_INVALID');
  }
  const schemas = url.searchParams.getAll('schema');
  const port = Number(url.port || 5432);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || url.username === ''
    || database === ''
    || schemas.length !== 1
    || schemas[0] !== 'wallet_core'
    || database.endsWith('_test')
    || schemas.some((schema) => schema.endsWith('_test'))
    || port === 55435
    || database === 'orebit_wallet_core_test'
  ) throw new Error('WALLET_CORE_DATABASE_URL_INVALID');
  return url;
}

class PgClient implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<WalletCoreQueryResult<Row>> {
    const result = await this.client.query(sql, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }

  release(discard?: boolean): void {
    this.client.release(discard);
  }
}

class PgPool implements WalletCorePool {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }
  async connect(): Promise<WalletCoreClient> {
    return new PgClient(await this.pool.connect());
  }
  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Owns schema-safe transaction boundaries and prevents production/test database crossover. */
export class WalletCoreDatabase {
  private constructor(
    private readonly pool: WalletCorePool,
    readonly schemas: WalletCoreSchemaMap,
    private readonly ownsPool: boolean,
  ) {}

  static production(connectionString: string): WalletCoreDatabase {
    const url = validateWalletCoreProductionUrl(connectionString);
    return new WalletCoreDatabase(new PgPool(url.toString()), PRODUCTION_SCHEMAS, true);
  }

  static validatedTest(pool: WalletCorePool, schemas: WalletCoreSchemaMap): WalletCoreDatabase {
    if (!exactSchemas(schemas, WALLET_CORE_TEST_SCHEMAS)) {
      throw new Error('WALLET_CORE_TEST_SCHEMA_MAP_INVALID');
    }
    return new WalletCoreDatabase(pool, WALLET_CORE_TEST_SCHEMAS, false);
  }

  async transaction<T>(work: (client: WalletCoreClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    let discard: true | undefined;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      await client.query('ROLLBACK').catch(() => { discard = true; });
      throw error;
    } finally {
      // Uncertain transactions must be destroyed; cleanup cannot replace the original failure.
      try { client.release(discard); } catch (error) { if (!failed) throw error; }
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

export const createWalletCoreProductionDatabase = (
  connectionString = process.env.WALLET_CORE_DATABASE_URL ?? '',
): WalletCoreDatabase => WalletCoreDatabase.production(connectionString);

export const createValidatedWalletCoreTestDatabase = (
  pool: WalletCorePool,
  schemas: WalletCoreSchemaMap,
): WalletCoreDatabase => WalletCoreDatabase.validatedTest(pool, schemas);
