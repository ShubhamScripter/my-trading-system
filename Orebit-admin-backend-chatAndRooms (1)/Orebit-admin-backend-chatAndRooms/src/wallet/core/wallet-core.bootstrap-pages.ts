import { decodeWalletQueryCursor, encodeWalletQueryCursor,
  isCanonicalWalletHistoryTimestamp, walletQueryFingerprint } from './wallet-core.cursor.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { resolveWalletEffectiveState } from './wallet-core.policy.js';
import { mapRuntimeAlert } from './wallet-core.runtime-alert.js';
import { WALLET_CATALOGUE_REFRESH_ERROR_CODES,
  WALLET_PARTIAL_DATA_REASONS } from './wallet-core.types.js';
import type { AdminChainQuery, AdminWalletAlert, AdminWalletChain,
  ConfigurationSummary, WalletLogoUrlResolver } from './wallet-core.types.js';

export type BootstrapRow = Record<string, unknown>;
export const BOOTSTRAP_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const BOOTSTRAP_SEARCH = /^.{1,100}$/u;

export const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('WALLET_BOOTSTRAP_ROW_INVALID'); return value;
};
export const optionalText = (value: unknown): string | null => value === null ? null : text(value);
export const optionalUuid = (value: unknown): string | null => {
  const result = optionalText(value);
  if (result !== null && !BOOTSTRAP_UUID.test(result)) throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
  return result;
};
export const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('WALLET_BOOTSTRAP_ROW_INVALID'); return value;
};
export const count = (value: unknown): number => {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
  return result;
};
export const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
  }
  return [...value];
};
export const instant = (value: unknown): string => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(result)) {
    throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
  }
  return result;
};
export const optionalInstant = (value: unknown): string | null =>
  value === null ? null : instant(value);
const payloadInstant = (value: unknown): string => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6})?Z$/.test(result)) {
    throw new Error('WALLET_ALERT_ROW_INVALID');
  }
  return result;
};
export const allowed = <T extends string>(value: unknown, values: readonly T[]): T => {
  const result = text(value);
  if (!values.includes(result as T)) throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
  return result as T;
};
export const exactKeys = (value: unknown, keys: readonly string[]): value is BootstrapRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
export const timestamp = (expression: string) => `to_char(${expression} AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const fingerprint = (input: Record<string, unknown>, keys: readonly string[]) =>
  walletQueryFingerprint(Object.fromEntries(keys.map((key) => [key, input[key]])));
export const validLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;

export const health = (row: BootstrapRow) => ({
  state: allowed(row.provider_state, ['ACTIVATED', 'DISABLED', 'MAINTENANCE', 'UNAVAILABLE']),
  consecutiveFailedChecks: count(row.consecutive_failed_checks),
  lastSuccessAt: optionalInstant(row.last_success_at), lastErrorAt: optionalInstant(row.last_error_at),
  updatedAt: optionalInstant(row.provider_updated_at),
});
export const logo = (key: unknown, resolver: WalletLogoUrlResolver) => {
  const objectKey = optionalText(key); if (objectKey === null) return null;
  const url = resolver.publicUrl(objectKey);
  if (typeof url !== 'string' || url.length === 0) throw new Error('WALLET_LOGO_URL_INVALID');
  return { objectKey, url };
};

function mapConfiguration(row: BootstrapRow): ConfigurationSummary {
  return { id: text(row.id), revision: text(row.revision),
    status: allowed(row.status, ['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED']),
    reason: text(row.reason), changelogId: optionalUuid(row.changelog_id), actorId: text(row.actor_id),
    effectiveAt: optionalInstant(row.effective_at), appliedAt: optionalInstant(row.applied_at),
    createdAt: instant(row.created_at) };
}

function mapAlert(row: BootstrapRow): AdminWalletAlert {
  const runtime = mapRuntimeAlert(row); if (runtime) return runtime;
  const category = allowed(row.category, ['SHORTFALL', 'PARTIAL_DATA',
    'STAKING_TOTAL_MISMATCH', 'CATALOGUE_REFRESH_FAILED']);
  const payload = row.payload; const id = text(row.id); const currencyId = optionalText(row.currency_id);
  const base = { id, category, status: 'ACTIVE' as const,
    openedAt: instant(row.opened_at), updatedAt: instant(row.updated_at) };
  const idValue = (record: BootstrapRow, key: string) => {
    const value = text(record[key]);
    if (!BOOTSTRAP_UUID.test(value)) throw new Error('WALLET_ALERT_ROW_INVALID'); return value;
  };
  if (category === 'CATALOGUE_REFRESH_FAILED') {
    if (currencyId !== null || !exactKeys(payload, ['safeErrorCode', 'failedAt'])) {
      throw new Error('WALLET_ALERT_ROW_INVALID');
    }
    return { ...base, category, currencyId: null, payload: {
      safeErrorCode: allowed(payload.safeErrorCode, WALLET_CATALOGUE_REFRESH_ERROR_CODES),
      failedAt: payloadInstant(payload.failedAt) } };
  }
  if (currencyId === null) throw new Error('WALLET_ALERT_ROW_INVALID');
  if (category === 'SHORTFALL') {
    if (!exactKeys(payload, ['runId', 'itemId', 'currencyId', 'custodyBalance',
      'requiredBacking', 'shortfallPercent', 'thresholdPercent'])) {
      throw new Error('WALLET_ALERT_ROW_INVALID');
    }
    const payloadCurrencyId = idValue(payload, 'currencyId');
    if (payloadCurrencyId !== currencyId) throw new Error('WALLET_ALERT_ROW_INVALID');
    return { ...base, category, currencyId, payload: { runId: idValue(payload, 'runId'),
      itemId: idValue(payload, 'itemId'), currencyId: payloadCurrencyId,
      custodyBalance: text(payload.custodyBalance), requiredBacking: text(payload.requiredBacking),
      shortfallPercent: text(payload.shortfallPercent), thresholdPercent: text(payload.thresholdPercent) } };
  }
  if (category === 'PARTIAL_DATA') {
    if (!exactKeys(payload, ['runId', 'itemId', 'currencyId', 'partialReasons',
      'shortfallSuppressed'])) throw new Error('WALLET_ALERT_ROW_INVALID');
    const partialReasons = strings(payload.partialReasons);
    if (partialReasons.some((reason) => !WALLET_PARTIAL_DATA_REASONS.includes(reason as never))) {
      throw new Error('WALLET_ALERT_ROW_INVALID');
    }
    const payloadCurrencyId = idValue(payload, 'currencyId');
    if (payloadCurrencyId !== currencyId) throw new Error('WALLET_ALERT_ROW_INVALID');
    return { ...base, category, currencyId, payload: { runId: idValue(payload, 'runId'),
      itemId: idValue(payload, 'itemId'), currencyId: payloadCurrencyId,
      partialReasons, shortfallSuppressed: boolean(payload.shortfallSuppressed) } } as AdminWalletAlert;
  }
  if (!exactKeys(payload, ['runId', 'itemId', 'componentId', 'currencyId', 'reportedTotal',
    'componentSum', 'selectedSource'])) throw new Error('WALLET_ALERT_ROW_INVALID');
  const payloadCurrencyId = idValue(payload, 'currencyId');
  if (payloadCurrencyId !== currencyId) throw new Error('WALLET_ALERT_ROW_INVALID');
  return { ...base, category, currencyId, payload: { runId: idValue(payload, 'runId'),
    itemId: idValue(payload, 'itemId'), componentId: idValue(payload, 'componentId'),
    currencyId: payloadCurrencyId, reportedTotal: text(payload.reportedTotal),
    componentSum: text(payload.componentSum),
    selectedSource: allowed(payload.selectedSource, ['REPORTED_TOTAL', 'COMPONENT_SUM']) } };
}

/** Reads and maps the independently paged collections included in the Admin bootstrap. */
export class WalletCoreBootstrapPages {
  constructor(private readonly database: WalletCoreDatabase,
    private readonly logoResolver: WalletLogoUrlResolver) {}

  async configurations(client: WalletCoreClient, cursorValue: string | undefined, limit: number) {
    const fields = `id::text,revision::text,status::text,reason,changelog_id::text,actor_id::text,
      ${timestamp('effective_at')} effective_at,${timestamp('applied_at')} applied_at,
      ${timestamp('created_at')} created_at`;
    const current = (await client.query<BootstrapRow>(`SELECT ${fields} FROM ${this.database.schemas.wallet}.
      configuration_changes WHERE status='LIVE' ORDER BY revision DESC,id DESC LIMIT 1`)).rows;
    const context = walletQueryFingerprint({ sortBy: 'effectiveAt', sortDirection: 'asc' });
    const cursor = cursorValue === undefined ? null : decodeWalletQueryCursor(
      cursorValue, 'CONFIGURATION', context, 2);
    if (cursorValue !== undefined && (cursor === null || !isCanonicalWalletHistoryTimestamp(cursor[0])
      || !BOOTSTRAP_UUID.test(cursor[1]!))) {
      throw new WalletConfigurationInvalid('Invalid scheduled configuration cursor.');
    }
    const scheduled = (await client.query<BootstrapRow>(`SELECT ${fields},
      (SELECT count(*) FROM ${this.database.schemas.wallet}.configuration_changes
        WHERE status='SCHEDULED') total FROM ${this.database.schemas.wallet}.configuration_changes
      WHERE status='SCHEDULED'
        AND ($1::timestamptz IS NULL OR (effective_at,id)>($1::timestamptz,$2::uuid))
      ORDER BY effective_at,id LIMIT $3`, [cursor?.[0] ?? null, cursor?.[1] ?? null,
      limit + 1])).rows;
    const live = current.find((row) => row.status === 'LIVE');
    const page = scheduled.slice(0, limit); const last = page.at(-1);
    return { live: live ? mapConfiguration(live) : null,
      scheduled: { items: page.map(mapConfiguration),
        total: scheduled[0] ? count(scheduled[0].total) : 0,
        nextCursor: scheduled.length > limit && last
          ? encodeWalletQueryCursor('CONFIGURATION', context,
            [instant(last.effective_at), text(last.id)]) : null } };
  }

  async activeAlerts(client: WalletCoreClient, cursorValue: string | undefined, limit: number) {
    const context = walletQueryFingerprint({
      sortBy: 'category,currencyId', sortDirection: 'asc',
    });
    const cursor = cursorValue === undefined ? null
      : decodeWalletQueryCursor(cursorValue, 'ALERT', context, 3);
    if (cursorValue !== undefined && (cursor === null || !BOOTSTRAP_UUID.test(cursor[2]!))) {
      throw new WalletConfigurationInvalid('Invalid active alert cursor.');
    }
    const rows = (await client.query<BootstrapRow>(`SELECT id::text,category::text,currency_id::text,
      payload,${timestamp('opened_at')} opened_at,${timestamp('updated_at')} updated_at,
      (SELECT count(*) FROM ${this.database.schemas.wallet}.wallet_alerts
        WHERE status='ACTIVE') total FROM ${this.database.schemas.wallet}.wallet_alerts
      WHERE status='ACTIVE' AND ($1::text IS NULL OR
        (category::text,COALESCE(currency_id::text,''),id)>($1::text,$2::text,$3::uuid))
      ORDER BY category,currency_id NULLS FIRST,id LIMIT $4`, [cursor?.[0] ?? null,
      cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit); const last = page.at(-1);
    return { items: page.map(mapAlert), total: rows[0] ? count(rows[0].total) : 0,
      nextCursor: rows.length > limit && last ? encodeWalletQueryCursor('ALERT', context,
        [text(last.category), optionalText(last.currency_id) ?? '', text(last.id)]) : null };
  }

  async chains(client: WalletCoreClient, global: 'OFF' | 'ON' | 'MAINTAIN') {
    const rows = (await client.query<BootstrapRow>(`SELECT id::text,provider_chain_id::text,
      blockchain_reference,short_name,name,is_evm,logo_object_key,available_for::text,
      desired_state::text,maintenance_pinned,provider_state::text,consecutive_failed_checks,
      ${timestamp('last_success_at')} last_success_at,${timestamp('last_error_at')} last_error_at,
      ${timestamp('provider_updated_at')} provider_updated_at
      FROM ${this.database.schemas.wallet}.chains ORDER BY short_name,id`)).rows;
    return rows.map((row) => this.mapChain(row, global));
  }

  async chainPage(input: AdminChainQuery): Promise<Readonly<{
    items: readonly AdminWalletChain[]; nextCursor: string | null;
  }>> {
    const limit = input.limit ?? 50; const sortBy = input.sortBy ?? 'shortName';
    const sortDirection = input.sortDirection ?? 'asc'; const queryShape = { ...input, sortBy, sortDirection };
    const context = fingerprint(queryShape, ['search', 'state', 'isEvm', 'sortBy', 'sortDirection']);
    const cursor = input.cursor === undefined ? null
      : decodeWalletQueryCursor(input.cursor, 'CHAIN', context, 2);
    if (Object.keys(input).some((key) => !['search', 'state', 'isEvm', 'sortBy',
      'sortDirection', 'cursor', 'limit'].includes(key)) || !validLimit(limit)
      || (input.search !== undefined && (!BOOTSTRAP_SEARCH.test(input.search)
        || input.search !== input.search.trim()))
      || (input.state !== undefined && !['OFF', 'ON', 'MAINTAIN'].includes(input.state))
      || (input.isEvm !== undefined && typeof input.isEvm !== 'boolean')
      || !['shortName', 'name', 'state'].includes(sortBy) || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && (cursor === null || !BOOTSTRAP_UUID.test(cursor[1]!)))) {
      throw new WalletConfigurationInvalid('Invalid Wallet chain query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const settings = (await client.query<BootstrapRow>(`SELECT global_desired_state::text FROM
        ${this.database.schemas.wallet}.wallet_settings WHERE id`)).rows[0];
      if (!settings) throw new Error('WALLET_SETTINGS_ROW_MISSING');
      const global = allowed(settings.global_desired_state, ['OFF', 'ON', 'MAINTAIN']);
      const rows = (await client.query<BootstrapRow>(this.chainPageSql(sortBy, sortDirection), [
        input.search ?? null, input.state ?? null, input.isEvm ?? null,
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1])).rows;
      const items = rows.slice(0, limit).map((row) => this.mapChain(row, global));
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last
        ? encodeWalletQueryCursor('CHAIN', context,
          [sortBy === 'state' ? last.effectiveState : last[sortBy], last.id]) : null };
    });
  }

  private mapChain(row: BootstrapRow, global: 'OFF' | 'ON' | 'MAINTAIN'): AdminWalletChain {
    const desiredState = allowed(row.desired_state, ['OFF', 'ON', 'MAINTAIN']);
    const provider = health(row); const maintenancePinned = boolean(row.maintenance_pinned);
    return { id: text(row.id), providerChainId: text(row.provider_chain_id),
      blockchainReference: text(row.blockchain_reference), shortName: text(row.short_name),
      name: text(row.name), isEvm: boolean(row.is_evm),
      logo: logo(row.logo_object_key, this.logoResolver),
      availableFor: allowed(row.available_for, ['USER', 'MERCHANT', 'BOTH']), desiredState,
      effectiveState: allowed(resolveWalletEffectiveState({ completedDelist: false,
        globalDesiredState: global, chainDesiredState: desiredState, currencyDesiredState: 'ON',
        bindingDesiredState: 'ON', listingState: 'LISTED', providerState: provider.state,
        providerPinned: maintenancePinned, priceReadiness: 'HEALTHY' }),
      ['OFF', 'ON', 'MAINTAIN'] as const), maintenancePinned, provider };
  }

  private chainPageSql(sortBy: 'shortName' | 'name' | 'state', direction: 'asc' | 'desc') {
    const wallet = this.database.schemas.wallet;
    const sort = { shortName: 'short_name', name: 'name', state: 'effective_state' }[sortBy];
    const sqlDirection = direction === 'asc' ? 'ASC' : 'DESC';
    const comparison = direction === 'asc' ? '>' : '<';
    return `WITH chain_view AS (SELECT chain.*,
      CASE WHEN settings.global_desired_state='OFF' OR chain.desired_state='OFF' THEN 'OFF'
        WHEN settings.global_desired_state='MAINTAIN' OR chain.desired_state='MAINTAIN'
          OR chain.maintenance_pinned OR chain.provider_state<>'ACTIVATED' THEN 'MAINTAIN'
        ELSE 'ON' END effective_state
      FROM ${wallet}.chains chain CROSS JOIN ${wallet}.wallet_settings settings WHERE settings.id)
      SELECT id::text,provider_chain_id::text,blockchain_reference,short_name,name,is_evm,
        logo_object_key,available_for::text,desired_state::text,maintenance_pinned,
        provider_state::text,consecutive_failed_checks,${timestamp('last_success_at')} last_success_at,
        ${timestamp('last_error_at')} last_error_at,${timestamp('provider_updated_at')} provider_updated_at
      FROM chain_view WHERE ($1::text IS NULL OR strpos(lower(name),lower($1::text))>0
        OR strpos(lower(short_name),lower($1::text))>0)
        AND ($2::text IS NULL OR effective_state=$2) AND ($3::boolean IS NULL OR is_evm=$3)
        AND ($4::text IS NULL OR (${sort},id)${comparison}($4::text,$5::uuid))
      ORDER BY ${sort} ${sqlDirection},id ${sqlDirection} LIMIT $6`;
  }

  currencySql(sortBy: 'symbol' | 'name' | 'state', direction: 'asc' | 'desc') {
    const price = this.database.schemas.price; const wallet = this.database.schemas.wallet;
    const sort = { symbol: 'symbol', name: 'name', state: 'effective_state' }[sortBy];
    const sqlDirection = direction === 'asc' ? 'ASC' : 'DESC';
    const comparison = direction === 'asc' ? '>' : '<';
    return `WITH currency_view AS (SELECT master.id,master.symbol,master.name,master.decimals,
      master.kind::text,master.pricing_status::text,master.auto_disabled,setting.*,
      ${timestamp('setting.listing_start_at')} listing_start_at,
      ${timestamp('setting.premium_early_access_at')} premium_early_access_at,
      ${timestamp('setting.so_early_access_at')} so_early_access_at,
      ${timestamp('setting.delist_at')} delist_at,
      ${timestamp('setting.price_readiness_changed_at')} price_readiness_changed_at,
      CASE WHEN setting.listing_start_at IS NOT NULL AND setting.listing_start_at>transaction_timestamp()
        THEN CASE WHEN setting.show_before_listing THEN 'UPCOMING_VISIBLE' ELSE 'UPCOMING_HIDDEN' END
        ELSE 'LISTED' END listing_state,
      setting.delist_at IS NOT NULL AND setting.delist_at<=transaction_timestamp() completed_delist,
      CASE WHEN setting.delist_at IS NOT NULL AND setting.delist_at<=transaction_timestamp() THEN 'DELISTED'
        WHEN settings.global_desired_state='OFF' OR setting.desired_state='OFF' THEN 'OFF'
        WHEN setting.listing_start_at IS NOT NULL AND setting.listing_start_at>transaction_timestamp()
          AND setting.show_before_listing THEN 'UPCOMING'
        WHEN setting.listing_start_at IS NOT NULL AND setting.listing_start_at>transaction_timestamp() THEN 'OFF'
        WHEN settings.global_desired_state='MAINTAIN' OR setting.desired_state='MAINTAIN'
          OR setting.price_readiness<>'HEALTHY' THEN 'MAINTAIN' ELSE 'ON' END effective_state
      FROM ${price}.currencies master JOIN ${wallet}.currency_settings setting
        ON setting.currency_id=master.id CROSS JOIN ${wallet}.wallet_settings settings
      WHERE settings.id AND master.kind='CRYPTO')
      SELECT * FROM currency_view WHERE
        ($1::text IS NULL OR strpos(lower(name),lower($1::text))>0
          OR strpos(lower(symbol),lower($1::text))>0)
        AND ($2::text IS NULL OR effective_state=$2)
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM ${wallet}.currencies binding
          WHERE binding.currency_id=currency_view.id AND binding.chain_id=$3::uuid))
        AND ($4::text IS NULL OR (${sort},id)${comparison}($4::text,$5::uuid))
      ORDER BY ${sort} ${sqlDirection},id ${sqlDirection} LIMIT $6`;
  }
}
