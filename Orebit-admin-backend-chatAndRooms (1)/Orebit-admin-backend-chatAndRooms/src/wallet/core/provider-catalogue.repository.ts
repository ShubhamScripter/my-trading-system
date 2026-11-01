import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../admin-audits/index.js';

import type { NormalizedCatalogueSnapshot } from './blockchain-admin.client.js';
import { decodeWalletQueryCursor, encodeWalletQueryCursor } from './wallet-core.cursor.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { providerPageLimit as pageLimit, providerQueryFingerprint as fingerprint,
  validCursorText, validProviderId, validRevision, validSearch,
  type ChainPageQuery, type CoinPageQuery,
  type ProviderState } from './provider-catalogue.query.js';
import { WALLET_CATALOGUE_REFRESH_ERROR_CODES } from './wallet-core.types.js';
import type { WalletAuditContext, WalletCatalogueRefreshErrorCode } from './wallet-core.types.js';

type Row = Record<string, unknown>;
export type ProviderCatalogueRefreshResult = Readonly<{ revision: string; itemCount: number }>;
export type ProviderCatalogueChain = Readonly<{ providerChainId: string; name: string;
  shortName: string; isEvm: boolean; providerState: ProviderState; revision: string;
  refreshedAt: string }>;
export type ProviderCatalogueCoin = Readonly<{ providerChainId: string; providerCoinId: string;
  currencyName: string; tokenAddress: string | null; isBaseCurrency: boolean; isStake: boolean;
  blockchainPrecision: number; providerState: ProviderState; revision: string; refreshedAt: string }>;
export type ProviderCatalogueFlatCoin = Readonly<{ providerCoinId: string; currencyName: string;
  tokenAddress: string | null; blockchainPrecision: number; isBaseCurrency: boolean;
  isStake: boolean; providerState: ProviderState; chain: Readonly<{ providerChainId: string; name: string;
    shortName: string; isEvm: boolean; providerState: ProviderState }> }>;
export type ProviderCataloguePage<T> = Readonly<{ revision: string; items: readonly T[];
  nextCursor: string | null }>;
export interface ProviderCatalogueIdentityPort { nextUuidV7(): string }

const ALERT_KEY = 'provider-catalogue:BLOCKCHAIN';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestamp = (expression: string) => `to_char(${expression} AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('PROVIDER_CATALOGUE_ROW_INVALID'); return value;
};
const optionalText = (value: unknown): string | null => value === null ? null : text(value);
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('PROVIDER_CATALOGUE_ROW_INVALID'); return value;
};
const integer = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('PROVIDER_CATALOGUE_ROW_INVALID');
  return parsed;
};
const providerId = (value: unknown): string => {
  const parsed = text(value);
  if (!validProviderId(parsed)) {
    throw new Error('PROVIDER_CATALOGUE_ROW_INVALID');
  }
  return parsed;
};
const state = (value: unknown): ProviderState => {
  const parsed = text(value);
  if (!['ACTIVATED', 'DISABLED', 'MAINTENANCE', 'UNAVAILABLE'].includes(parsed)) {
    throw new Error('PROVIDER_CATALOGUE_ROW_INVALID');
  }
  return parsed as ProviderState;
};
const safeCode = (value: unknown): WalletCatalogueRefreshErrorCode => {
  if (!WALLET_CATALOGUE_REFRESH_ERROR_CODES.includes(value as never)) {
    throw new WalletConfigurationInvalid('Invalid catalogue failure code.');
  }
  return value as WalletCatalogueRefreshErrorCode;
};

class CatalogueAuditFailure extends Error {}
export class ProviderCataloguePersistenceError extends Error {
  constructor(readonly code: 'DATABASE_ERROR' | 'AUDIT_ERROR') {
    super(code); this.name = 'ProviderCataloguePersistenceError';
  }
}

/** Stores versioned provider catalogues and exposes revision-bound keyset pages to Admin. */
export class ProviderCatalogueRepository {
  constructor(private readonly database: WalletCoreDatabase, private readonly audit: AdminAuditPort,
    private readonly identity: ProviderCatalogueIdentityPort) {}

  async refresh(snapshot: NormalizedCatalogueSnapshot,
    context: WalletAuditContext, prefetchEventKey: string): Promise<ProviderCatalogueRefreshResult> {
    if (context?.actor?.kind !== 'ADMIN') {
      throw new WalletConfigurationInvalid('Authenticated ADMIN audit context is required.');
    }
    if (typeof prefetchEventKey !== 'string' || !UUID_V7.test(prefetchEventKey)) {
      throw new WalletConfigurationInvalid('Invalid provider catalogue refresh event key.');
    }
    const settled = await this.database.transaction(async (client) => {
      await client.query('SAVEPOINT provider_catalogue_refresh');
      try {
        const before = await this.lockSnapshot(client);
        const refreshedAt = await this.databaseInstant(client);
        const revision = before.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('PROVIDER_CATALOGUE_REVISION_INVALID');
        await this.persistSnapshot(client, snapshot, revision, refreshedAt);
        await this.clearFailure(client);
        const input: WalletCoreAdminAuditInput = { domain: 'WALLET_CORE',
          action: 'CATALOGUE.REFRESHED', eventKey: prefetchEventKey, actor: context.actor,
          subject: { type: 'PROVIDER_CATALOGUE', id: 'BLOCKCHAIN' },
          reason: 'Blockchain provider catalogue refreshed.',
          before: { revision: before.revision, itemCount: before.itemCount },
          after: { revision, itemCount: snapshot.chains.length + snapshot.coins.length },
          metadata: { configurationRevision: before.configurationRevision, source: 'BLOCKCHAIN' } };
        const audit = await this.audit.appendWithTransaction(client, input)
          .catch((error: unknown) => { throw new CatalogueAuditFailure('AUDIT_ERROR', { cause: error }); });
        if (audit.replayed) throw new CatalogueAuditFailure('AUDIT_ERROR');
        const marker = await client.query(`UPDATE ${this.database.schemas.wallet}.wallet_settings
          SET provider_catalogue_revision=$1 WHERE id AND provider_catalogue_revision=$2`,
        [revision, before.revision]);
        if (marker.rowCount !== 1) throw new Error('PROVIDER_CATALOGUE_REVISION_CONFLICT');
        await client.query('RELEASE SAVEPOINT provider_catalogue_refresh');
        return { ok: true as const, result: { revision: String(revision),
          itemCount: snapshot.chains.length + snapshot.coins.length } };
      } catch (error) {
        // Preserve the failure alert even when catalogue persistence or audit must roll back.
        await client.query('ROLLBACK TO SAVEPOINT provider_catalogue_refresh');
        const code: 'AUDIT_ERROR' | 'DATABASE_ERROR' = error instanceof CatalogueAuditFailure
          ? 'AUDIT_ERROR' : 'DATABASE_ERROR';
        await this.writeFailure(client, code);
        return { ok: false as const, code };
      }
    });
    if (!settled.ok) throw new ProviderCataloguePersistenceError(settled.code);
    return settled.result;
  }

  async recordFailure(code: WalletCatalogueRefreshErrorCode): Promise<void> {
    const checkedCode = safeCode(code);
    await this.database.transaction((client) => this.writeFailure(client, checkedCode));
  }

  async chains(input: ChainPageQuery): Promise<ProviderCataloguePage<ProviderCatalogueChain>> {
    const limit = pageLimit(input, ['search', 'providerState', 'sortBy', 'sortDirection',
      'cursor', 'limit']);
    const sortBy = input.sortBy ?? 'providerChainId';
    const sortDirection = input.sortDirection ?? 'asc';
    const queryShape = { ...input, sortBy, sortDirection };
    const cursor = input.cursor === undefined ? null : decodeWalletQueryCursor(input.cursor,
      'PROVIDER_CHAIN', fingerprint(queryShape, ['search', 'providerState', 'sortBy',
        'sortDirection']), 3);
    if ((input.search !== undefined && !validSearch(input.search))
      || (input.providerState !== undefined && !['ACTIVATED', 'DISABLED', 'MAINTENANCE',
        'UNAVAILABLE'].includes(input.providerState))
      || !['providerChainId', 'name', 'shortName'].includes(sortBy)
      || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && (cursor === null || !validRevision(cursor[0])
        || !validProviderId(cursor[2])
        || (sortBy === 'providerChainId' ? !validProviderId(cursor[1])
          : !validCursorText(cursor[1]))))) {
      throw new WalletConfigurationInvalid('Invalid provider chain catalogue query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = await this.currentRevision(client);
      if (cursor && cursor[0] !== revision) {
        throw new WalletConfigurationInvalid('Stale provider chain catalogue cursor.');
      }
      const sort = { providerChainId: 'chain.provider_chain_id', name: 'chain.name',
        shortName: 'chain.short_name' }[sortBy];
      const cursorCast = sortBy === 'providerChainId' ? 'bigint' : 'text';
      const direction = sortDirection === 'asc' ? 'ASC' : 'DESC';
      const comparison = sortDirection === 'asc' ? '>' : '<';
      const rows = (await client.query<Row>(`SELECT chain.provider_chain_id::text,chain.name,
        chain.short_name,chain.is_evm,chain.provider_state::text,chain.revision::text,
        ${timestamp('chain.refreshed_at')} refreshed_at FROM
        ${this.database.schemas.wallet}.provider_catalogue_chains chain WHERE
        ($1::text IS NULL OR strpos(lower(chain.name),lower($1::text))>0
          OR strpos(lower(chain.short_name),lower($1::text))>0)
        AND (($2::text IS NULL AND chain.provider_state<>'UNAVAILABLE')
          OR chain.provider_state::text=$2)
        AND ($3::${cursorCast} IS NULL OR (${sort},chain.provider_chain_id)${comparison}
          ($3::${cursorCast},$4::bigint))
        ORDER BY ${sort} ${direction},chain.provider_chain_id ${direction} LIMIT $5`,
      [input.search ?? null, input.providerState ?? null, cursor?.[1] ?? null,
        cursor?.[2] ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map((row): ProviderCatalogueChain => ({
        providerChainId: providerId(row.provider_chain_id), name: text(row.name),
        shortName: text(row.short_name), isEvm: bool(row.is_evm),
        providerState: state(row.provider_state), revision: text(row.revision),
        refreshedAt: text(row.refreshed_at) }));
      const last = items.at(-1);
      return { revision, items, nextCursor: rows.length > limit && last
        ? encodeWalletQueryCursor('PROVIDER_CHAIN', fingerprint(queryShape,
          ['search', 'providerState', 'sortBy', 'sortDirection']), [revision,
        sortBy === 'providerChainId' ? last.providerChainId : last[sortBy],
        last.providerChainId]) : null };
    });
  }

  async coins(providerChainId: string,
    input: CoinPageQuery): Promise<ProviderCataloguePage<ProviderCatalogueCoin>> {
    if (!validProviderId(providerChainId)) {
      throw new WalletConfigurationInvalid('Invalid provider chain identifier.');
    }
    const limit = pageLimit(input, ['search', 'providerState', 'isBaseCurrency', 'isStake',
      'sortBy', 'sortDirection', 'cursor', 'limit']);
    const sortBy = input.sortBy ?? 'providerCoinId'; const sortDirection = input.sortDirection ?? 'asc';
    const queryShape = { ...input, providerChainId, sortBy, sortDirection };
    const cursor = input.cursor === undefined ? null : decodeWalletQueryCursor(input.cursor,
      'PROVIDER_COIN', fingerprint(queryShape, ['providerChainId', 'search', 'providerState',
        'isBaseCurrency', 'isStake', 'sortBy', 'sortDirection']), 4);
    if ((input.search !== undefined && !validSearch(input.search))
      || (input.providerState !== undefined && !['ACTIVATED', 'DISABLED', 'MAINTENANCE',
        'UNAVAILABLE'].includes(input.providerState))
      || (input.isBaseCurrency !== undefined && typeof input.isBaseCurrency !== 'boolean')
      || (input.isStake !== undefined && typeof input.isStake !== 'boolean')
      || !['providerCoinId', 'currencyName'].includes(sortBy)
      || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && (cursor === null || !validRevision(cursor[0])
        || cursor[2] !== providerChainId || !validProviderId(cursor[3])
        || (sortBy === 'providerCoinId' ? !validProviderId(cursor[1])
          : !validCursorText(cursor[1]))))) {
      throw new WalletConfigurationInvalid('Invalid provider coin catalogue query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = await this.currentRevision(client);
      if (cursor && (cursor[0] !== revision || cursor[2] !== providerChainId)) {
        throw new WalletConfigurationInvalid('Stale or wrong-chain provider coin catalogue cursor.');
      }
      const sort = sortBy === 'providerCoinId' ? 'coin.provider_coin_id' : 'coin.currency_name';
      const cursorCast = sortBy === 'providerCoinId' ? 'bigint' : 'text';
      const direction = sortDirection === 'asc' ? 'ASC' : 'DESC';
      const comparison = sortDirection === 'asc' ? '>' : '<';
      const rows = (await client.query<Row>(`SELECT coin.provider_chain_id::text,
        coin.provider_coin_id::text,coin.currency_name,coin.token_address,
        coin.is_base_currency,coin.is_stake,coin.blockchain_precision,
        coin.provider_state::text,coin.revision::text,
        ${timestamp('coin.refreshed_at')} refreshed_at FROM
        ${this.database.schemas.wallet}.provider_catalogue_currencies coin
        WHERE coin.provider_chain_id=$1
        AND ($2::text IS NULL OR strpos(lower(coin.currency_name),lower($2::text))>0)
        AND (($3::text IS NULL AND coin.provider_state<>'UNAVAILABLE')
          OR coin.provider_state::text=$3)
        AND ($4::boolean IS NULL OR coin.is_base_currency=$4)
        AND ($5::boolean IS NULL OR coin.is_stake=$5)
        AND ($6::${cursorCast} IS NULL OR (${sort},coin.provider_coin_id)${comparison}
          ($6::${cursorCast},$7::bigint))
        ORDER BY ${sort} ${direction},coin.provider_coin_id ${direction} LIMIT $8`,
      [providerChainId, input.search ?? null, input.providerState ?? null,
        input.isBaseCurrency ?? null, input.isStake ?? null, cursor?.[1] ?? null,
        cursor?.[3] ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map((row): ProviderCatalogueCoin => ({
        providerChainId: providerId(row.provider_chain_id), providerCoinId: providerId(row.provider_coin_id),
        currencyName: text(row.currency_name), tokenAddress: optionalText(row.token_address),
        isBaseCurrency: bool(row.is_base_currency), isStake: bool(row.is_stake),
        blockchainPrecision: integer(row.blockchain_precision), providerState: state(row.provider_state),
        revision: text(row.revision), refreshedAt: text(row.refreshed_at) }));
      const last = items.at(-1);
      return { revision, items, nextCursor: rows.length > limit && last
        ? encodeWalletQueryCursor('PROVIDER_COIN', fingerprint(queryShape,
          ['providerChainId', 'search', 'providerState', 'isBaseCurrency', 'isStake',
            'sortBy', 'sortDirection']), [revision,
        sortBy === 'providerCoinId' ? last.providerCoinId : last.currencyName,
        providerChainId, last.providerCoinId]) : null };
    });
  }

  async allCoins(input: CoinPageQuery): Promise<ProviderCataloguePage<ProviderCatalogueFlatCoin>> {
    const limit = pageLimit(input, ['providerChainId', 'search', 'providerState',
      'isBaseCurrency', 'isStake', 'sortBy', 'sortDirection', 'cursor', 'limit']);
    const sortBy = input.sortBy ?? 'providerChainId'; const sortDirection = input.sortDirection ?? 'asc';
    const queryShape = { ...input, sortBy, sortDirection };
    const cursor = input.cursor === undefined ? null : decodeWalletQueryCursor(input.cursor,
      'PROVIDER_COIN', fingerprint(queryShape, ['providerChainId', 'search', 'providerState',
        'isBaseCurrency', 'isStake', 'sortBy', 'sortDirection']), 4);
    if ((input.providerChainId !== undefined && !validProviderId(input.providerChainId))
      || (input.search !== undefined && !validSearch(input.search))
      || (input.providerState !== undefined && !['ACTIVATED', 'DISABLED', 'MAINTENANCE',
        'UNAVAILABLE'].includes(input.providerState))
      || (input.isBaseCurrency !== undefined && typeof input.isBaseCurrency !== 'boolean')
      || (input.isStake !== undefined && typeof input.isStake !== 'boolean')
      || (input.sortBy !== undefined && !['providerCoinId', 'currencyName'].includes(input.sortBy))
      || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && (cursor === null || !validRevision(cursor[0])
        || !validProviderId(cursor[2]) || !validProviderId(cursor[3])
        || (sortBy === 'currencyName' ? !validCursorText(cursor[1])
          : !validProviderId(cursor[1]))))) {
      throw new WalletConfigurationInvalid('Invalid provider coin catalogue query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = await this.currentRevision(client);
      if (cursor && cursor[0] !== revision) {
        throw new WalletConfigurationInvalid('Stale provider coin catalogue cursor.');
      }
      const sort = sortBy === 'providerChainId' ? 'coin.provider_chain_id'
        : sortBy === 'providerCoinId' ? 'coin.provider_coin_id' : 'coin.currency_name';
      const cursorCast = sortBy === 'currencyName' ? 'text' : 'bigint';
      const direction = sortDirection === 'asc' ? 'ASC' : 'DESC';
      const comparison = sortDirection === 'asc' ? '>' : '<';
      const seek = sortBy === 'providerChainId'
        ? `($6::bigint IS NULL OR (coin.provider_chain_id,coin.provider_coin_id)${comparison}
            ($7::bigint,$8::bigint))`
        : `($6::${cursorCast} IS NULL OR
            (${sort},coin.provider_chain_id,coin.provider_coin_id)${comparison}
              ($6::${cursorCast},$7::bigint,$8::bigint))`;
      const order = sortBy === 'providerChainId'
        ? `coin.provider_chain_id ${direction},coin.provider_coin_id ${direction}`
        : `${sort} ${direction},coin.provider_chain_id ${direction},
          coin.provider_coin_id ${direction}`;
      const rows = (await client.query<Row>(`SELECT coin.provider_chain_id::text,
        coin.provider_coin_id::text,coin.currency_name,coin.token_address,
        coin.blockchain_precision,coin.is_base_currency,coin.is_stake,
        coin.provider_state::text coin_state,chain.name chain_name,
        chain.short_name chain_short_name,chain.is_evm,chain.provider_state::text chain_state
        FROM ${this.database.schemas.wallet}.provider_catalogue_currencies coin
        JOIN ${this.database.schemas.wallet}.provider_catalogue_chains chain
          ON chain.provider_chain_id=coin.provider_chain_id
        WHERE ($1::text IS NULL OR strpos(lower(coin.currency_name),lower($1::text))>0)
          AND ($2::bigint IS NULL OR coin.provider_chain_id=$2)
          AND (($3::text IS NULL AND coin.provider_state<>'UNAVAILABLE') OR coin.provider_state::text=$3)
          AND chain.provider_state<>'UNAVAILABLE'
          AND ($4::boolean IS NULL OR coin.is_base_currency=$4)
          AND ($5::boolean IS NULL OR coin.is_stake=$5)
          AND ${seek}
        ORDER BY ${order} LIMIT $9`,
      [input.search ?? null, input.providerChainId ?? null, input.providerState ?? null,
        input.isBaseCurrency ?? null, input.isStake ?? null, cursor?.[1] ?? null,
        cursor?.[2] ?? null, cursor?.[3] ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map((row): ProviderCatalogueFlatCoin => ({
        providerCoinId: providerId(row.provider_coin_id), currencyName: text(row.currency_name),
        tokenAddress: optionalText(row.token_address), blockchainPrecision: integer(
          row.blockchain_precision), isBaseCurrency: bool(row.is_base_currency),
        isStake: bool(row.is_stake), providerState: state(row.coin_state), chain: {
          providerChainId: providerId(row.provider_chain_id), name: text(row.chain_name),
          shortName: text(row.chain_short_name), isEvm: bool(row.is_evm),
          providerState: state(row.chain_state) } }));
      const last = items.at(-1);
      return { revision, items, nextCursor: rows.length > limit && last
        ? encodeWalletQueryCursor('PROVIDER_COIN', fingerprint(queryShape,
          ['providerChainId', 'search', 'providerState', 'isBaseCurrency', 'isStake',
            'sortBy', 'sortDirection']), [revision,
        sortBy === 'currencyName' ? last.currencyName
          : sortBy === 'providerCoinId' ? last.providerCoinId : last.chain.providerChainId,
        last.chain.providerChainId, last.providerCoinId]) : null };
    });
  }

  private async currentRevision(client: WalletCoreClient): Promise<string> {
    const row = (await client.query<Row>(`SELECT provider_catalogue_revision::text revision
      FROM ${this.database.schemas.wallet}.wallet_settings WHERE id`)).rows[0];
    if (!row) throw new Error('PROVIDER_CATALOGUE_REVISION_MISSING');
    return text(row.revision);
  }

  private async lockSnapshot(client: WalletCoreClient) {
    const wallet = this.database.schemas.wallet;
    const settings = (await client.query<Row>(`SELECT revision::text configuration_revision,
      provider_catalogue_revision::text revision
      FROM ${wallet}.wallet_settings WHERE id FOR UPDATE`)).rows[0];
    if (!settings) throw new Error('WALLET_SETTINGS_ROW_MISSING');
    const row = (await client.query<Row>(`SELECT ((SELECT count(*) FROM
        ${wallet}.provider_catalogue_chains
          WHERE provider_state<>'UNAVAILABLE')+
       (SELECT count(*) FROM ${wallet}.provider_catalogue_currencies
          WHERE provider_state<>'UNAVAILABLE'))::text item_count`)).rows[0];
    if (!row) throw new Error('PROVIDER_CATALOGUE_SNAPSHOT_MISSING');
    return { configurationRevision: integer(settings.configuration_revision),
      revision: integer(settings.revision), itemCount: integer(row.item_count) };
  }

  /** Persists a complete authoritative snapshot; omitted provider rows become UNAVAILABLE. */
  private async persistSnapshot(client: WalletCoreClient, snapshot: NormalizedCatalogueSnapshot,
    revision: number, refreshedAt: string): Promise<void> {
    const wallet = this.database.schemas.wallet;
    const chains = JSON.stringify(snapshot.chains);
    const coins = JSON.stringify(snapshot.coins);
    await client.query(`INSERT INTO ${wallet}.provider_catalogue_chains
      (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
      SELECT incoming."providerChainId",incoming.name,incoming."shortName",incoming."isEvm",
        incoming.state::${wallet}."WalletProviderState",$2,$3
      FROM jsonb_to_recordset($1::jsonb) AS incoming(
        "providerChainId" bigint,name text,"shortName" text,state text,"isEvm" boolean)
      ON CONFLICT (provider_chain_id) DO UPDATE SET name=EXCLUDED.name,
        short_name=EXCLUDED.short_name,is_evm=EXCLUDED.is_evm,
        provider_state=EXCLUDED.provider_state,revision=EXCLUDED.revision,
        refreshed_at=EXCLUDED.refreshed_at`, [chains, revision, refreshedAt]);
    await client.query(`INSERT INTO ${wallet}.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
       blockchain_precision,provider_state,revision,refreshed_at)
      SELECT incoming."providerChainId",incoming."providerCoinId",incoming."currencyName",
        incoming."tokenAddress",incoming."isBaseCurrency",incoming."isStake",
        incoming."blockchainPrecision",incoming.state::${wallet}."WalletProviderState",$2,$3
      FROM jsonb_to_recordset($1::jsonb) AS incoming(
        "providerChainId" bigint,"providerCoinId" bigint,"currencyName" text,"tokenAddress" text,
        "blockchainPrecision" integer,"isBaseCurrency" boolean,"isStake" boolean,state text)
      ON CONFLICT (provider_chain_id,provider_coin_id) DO UPDATE SET
        currency_name=EXCLUDED.currency_name,token_address=EXCLUDED.token_address,
        is_base_currency=EXCLUDED.is_base_currency,is_stake=EXCLUDED.is_stake,
        blockchain_precision=EXCLUDED.blockchain_precision,provider_state=EXCLUDED.provider_state,
        revision=EXCLUDED.revision,refreshed_at=EXCLUDED.refreshed_at`,
    [coins, revision, refreshedAt]);
    await client.query(`UPDATE ${wallet}.provider_catalogue_currencies existing SET
      provider_state='UNAVAILABLE',revision=$2,refreshed_at=$3 WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS incoming(
          "providerChainId" bigint,"providerCoinId" bigint)
        WHERE incoming."providerChainId"=existing.provider_chain_id
          AND incoming."providerCoinId"=existing.provider_coin_id)`, [coins, revision, refreshedAt]);
    await client.query(`UPDATE ${wallet}.provider_catalogue_chains SET
      provider_state='UNAVAILABLE',revision=$2,refreshed_at=$3
      WHERE NOT (provider_chain_id=ANY($1::bigint[]))`,
    [snapshot.chains.map((chain) => String(chain.providerChainId)), revision, refreshedAt]);
  }

  private async databaseInstant(client: WalletCoreClient): Promise<string> {
    const row = (await client.query<Row>(`SELECT ${timestamp('clock_timestamp()')} instant`)).rows[0];
    const value = text(row?.instant);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
      throw new Error('PROVIDER_CATALOGUE_DATABASE_TIME_INVALID');
    }
    return value;
  }

  private nextId(): string {
    const value = this.identity.nextUuidV7();
    if (typeof value !== 'string' || !UUID_V7.test(value)) {
      throw new Error('PROVIDER_CATALOGUE_IDENTITY_INVALID');
    }
    return value;
  }

  private async writeFailure(client: WalletCoreClient,
    code: WalletCatalogueRefreshErrorCode): Promise<void> {
    const wallet = this.database.schemas.wallet;
    const failedAt = await this.databaseInstant(client);
    const current = (await client.query<Row>(`SELECT id::text,status::text FROM
      ${wallet}.wallet_alerts WHERE dedupe_key=$1 FOR UPDATE`, [ALERT_KEY])).rows[0];
    if (!current) {
      const alertId = this.nextId(); const payload = { safeErrorCode: code, failedAt };
      await client.query(`INSERT INTO ${wallet}.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',NULL,$3,$4,$4)`,
      [alertId, ALERT_KEY, payload, failedAt]);
      await client.query(`INSERT INTO ${wallet}.wallet_alert_events
        (id,alert_id,category,status,payload,created_at)
        VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',$3,$4)`,
      [this.nextId(), alertId, payload, failedAt]);
      return;
    }
    const changed = (await client.query<Row>(`WITH stamp AS (
        SELECT GREATEST($2::timestamptz,updated_at+interval '1 microsecond') value
        FROM ${wallet}.wallet_alerts WHERE id=$3::uuid)
      UPDATE ${wallet}.wallet_alerts alert SET status='ACTIVE',cleared_at=NULL,
        updated_at=stamp.value,payload=jsonb_build_object('safeErrorCode',$1::text,'failedAt',
          to_char(stamp.value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM stamp WHERE alert.id=$3::uuid RETURNING alert.payload,
        ${timestamp('alert.updated_at')} updated_at`, [code, failedAt, text(current.id)])).rows[0];
    if (!changed) throw new Error('CATALOGUE_ALERT_UPDATE_FAILED');
    if (current.status === 'CLEARED') {
      await client.query(`INSERT INTO ${wallet}.wallet_alert_events
        (id,alert_id,category,status,payload,created_at)
        VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','ACTIVE',$3,$4)`,
      [this.nextId(), current.id, changed.payload, changed.updated_at]);
    } else if (current.status !== 'ACTIVE') throw new Error('CATALOGUE_ALERT_STATUS_INVALID');
  }

  private async clearFailure(client: WalletCoreClient): Promise<void> {
    const wallet = this.database.schemas.wallet;
    const current = (await client.query<Row>(`SELECT id::text,status::text FROM
      ${wallet}.wallet_alerts WHERE dedupe_key=$1 FOR UPDATE`, [ALERT_KEY])).rows[0];
    if (!current || current.status === 'CLEARED') return;
    if (current.status !== 'ACTIVE') throw new Error('CATALOGUE_ALERT_STATUS_INVALID');
    const changed = (await client.query<Row>(`WITH stamp AS (SELECT GREATEST(
        clock_timestamp(),updated_at+interval '1 microsecond') value
        FROM ${wallet}.wallet_alerts WHERE id=$1::uuid)
      UPDATE ${wallet}.wallet_alerts alert SET status='CLEARED',cleared_at=stamp.value,
        updated_at=stamp.value FROM stamp WHERE alert.id=$1::uuid
      RETURNING alert.payload,${timestamp('alert.updated_at')} updated_at`, [current.id])).rows[0];
    if (!changed) throw new Error('CATALOGUE_ALERT_CLEAR_FAILED');
    await client.query(`INSERT INTO ${wallet}.wallet_alert_events
      (id,alert_id,category,status,payload,created_at)
      VALUES ($1,$2,'CATALOGUE_REFRESH_FAILED','CLEARED',$3,$4)`,
    [this.nextId(), current.id, changed.payload, changed.updated_at]);
  }
}
