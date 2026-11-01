export const PROVIDER_CODES = ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'] as const;
export type ProviderCode = (typeof PROVIDER_CODES)[number];

export const PROVIDER_ROLES = ['PRIMARY', 'COMPARISON', 'FALLBACK'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export const FIAT_CODES = [
  'AED', 'ARS', 'AUD', 'BDT', 'BHD', 'BMD', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'CZK',
  'DKK', 'EUR', 'GBP', 'GEL', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KRW', 'KWD',
  'LKR', 'MMK', 'MXN', 'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PKR', 'PLN', 'RUB', 'SAR',
  'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'UAH', 'USD', 'VND', 'ZAR',
] as const;
export type FiatCode = (typeof FIAT_CODES)[number];

export const CURRENCY_KINDS = ['CRYPTO', 'FIAT'] as const;
export type CurrencyKind = (typeof CURRENCY_KINDS)[number];

export const PRICE_CONFIG_ACTIONS = ['SAVE_DRAFT', 'PUSH', 'SCHEDULE'] as const;
export type PriceConfigAction = (typeof PRICE_CONFIG_ACTIONS)[number];
export type PriceConfigStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED';
export const PRICE_HISTORY_EVENT_TYPES = [
  'RESOLUTION', 'VIEW_RESOLUTION', 'FETCH_RUN', 'CONFIG_CHANGE', 'AUDIT',
] as const;
export type PriceHistoryEventType = (typeof PRICE_HISTORY_EVENT_TYPES)[number];
export const PRICE_HISTORY_STATUSES = [
  'AVAILABLE', 'UNAVAILABLE', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED',
  'DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED',
] as const;
export type PriceHistoryStatus = (typeof PRICE_HISTORY_STATUSES)[number];
export const PRICE_RECORD_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type PriceRecordStatus = (typeof PRICE_RECORD_STATUSES)[number];
export type PriceResolutionReason =
  | 'PRIMARY_CONFIRMED'
  | 'FALLBACK_PRIMARY_FAILED'
  | 'FALLBACK_DIVERGENCE'
  | 'RECOVERED'
  | 'STALE_DISPLAY'
  | 'PRICE_UNAVAILABLE';

export const PRICE_VIEW_RESOLUTION_STATUSES = ['AVAILABLE', 'UNAVAILABLE'] as const;
export type PriceViewResolutionStatus = (typeof PRICE_VIEW_RESOLUTION_STATUSES)[number];

export const PRICE_VIEW_RESOLUTION_REASONS = [
  'CONFIGURED_PROVIDER',
  'SENSITIVE_FALLBACK_PROVIDER',
  'ALCHEMY_FALLBACK_SECONDARY',
  'VIEW_FAILURE_SECONDARY',
  'SECONDARY_UNAVAILABLE',
] as const;
export type PriceViewResolutionReason = (typeof PRICE_VIEW_RESOLUTION_REASONS)[number];

export interface ProviderPatch {
  readonly code: ProviderCode;
  readonly enabled: boolean;
  readonly role: ProviderRole | null;
  readonly viewEnabled: boolean;
  readonly refreshIntervalSeconds: number;
}

/** New fields are optional only when reading immutable legacy configuration JSON. */
export interface PersistedPriceConfiguration {
  readonly settings: {
    readonly divergenceThresholdBps: number;
    readonly visibleFiatCodes?: readonly FiatCode[];
  };
  readonly providers: Readonly<Record<ProviderCode, {
    readonly enabled: boolean;
    readonly sensitiveRole: ProviderRole | null;
    readonly viewEnabled: boolean;
    readonly refreshIntervalSeconds?: number;
  }>>;
}

export interface PriceConversionPatch {
  readonly action: PriceConfigAction;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly changelog: string;
  readonly effectiveAt?: string;
  readonly draftId?: string;
  readonly divergenceThresholdBps?: number;
  readonly visibleFiatCodes?: readonly FiatCode[];
  readonly providers?: readonly ProviderPatch[];
}

export interface PriceConversionBootstrapQuery {
  readonly scheduledCursor?: string;
  readonly scheduledLimit?: number;
}

export interface PriceConversionHistoryQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly eventType?: PriceHistoryEventType;
  readonly currencyId?: string;
  readonly providerCode?: ProviderCode;
  readonly status?: PriceHistoryStatus;
  readonly from?: string;
  readonly to?: string;
  readonly sortBy?: 'timestamp';
  readonly sortDirection?: 'asc' | 'desc';
}

export interface PriceConversionPriceQuery {
  readonly cursor?: string;
  readonly limit: number;
  readonly currencyId?: string;
  readonly providerCode?: ProviderCode;
  readonly status?: PriceRecordStatus;
  readonly sortBy?: 'currencyId' | 'updatedAt';
  readonly sortDirection?: 'asc' | 'desc';
}

/** Authenticated request identity persisted with every atomic administrative write. */
export interface PriceConversionAuditContext {
  readonly actorId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly ipAddress: string;
  readonly deviceId: string;
}

export interface BootstrapPrice {
  readonly currencyId: string;
  readonly priceUsd: string | null;
  readonly observedAt: string | null;
  readonly provider: ProviderCode | null;
  readonly snapshotId: string | null;
  readonly stale: boolean;
  readonly disabled: boolean;
  readonly reason: PriceResolutionReason;
}

export interface LatestPrice extends BootstrapPrice {
  readonly updatedAt: string;
}

export interface PriceConversionPricePage {
  readonly items: readonly LatestPrice[];
  readonly nextCursor: string | null;
}

export interface PriceProviderBootstrap {
  readonly code: ProviderCode;
  readonly enabled: boolean;
  readonly role: ProviderRole | null;
  readonly viewEnabled: boolean;
  readonly revision: number;
  readonly referenceCount: number;
  readonly refreshIntervalSeconds: number;
  readonly health: {
    readonly trackedCurrencies: number;
    readonly healthyCurrencies: number;
    readonly lastSuccessAt: string | null;
    readonly lastErrorAt: string | null;
    readonly updatedAt: string | null;
  };
  readonly usage: {
    readonly dailyRequests: number;
    readonly monthlyRequests: number;
  };
}

export interface FiatVisibilityOption {
  readonly code: FiatCode;
  readonly visible: boolean;
}

export interface PriceConfigChange {
  readonly id: string;
  readonly revision: number;
  readonly status: PriceConfigStatus;
  readonly effectiveAt: string | null;
  readonly changelog: string;
  readonly actorId: string | null;
  readonly config: unknown;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

export interface PriceConversionBootstrap {
  readonly settings: {
    readonly revision: number;
    readonly divergenceThresholdBps: number;
    readonly updatedAt: string;
  };
  readonly providers: readonly PriceProviderBootstrap[];
  readonly configuration: {
    readonly draft: PriceConfigChange | null;
    readonly live: PriceConfigChange | null;
    readonly scheduled: readonly PriceConfigChange[];
    readonly scheduledNextCursor: string | null;
  };
  readonly fiatOptions: readonly FiatVisibilityOption[];
  readonly roleConfigurationStatus: 'HEALTHY' | 'DEGRADED';
  readonly securityState: 'HEALTHY' | 'DEGRADED';
}

interface HistoryBase {
  readonly id: string;
  readonly createdAt: string;
}

export interface ResolutionHistoryItem extends HistoryBase {
  readonly kind: 'RESOLUTION';
  readonly currencyId: string;
  readonly reason: PriceResolutionReason;
  readonly priceUsd: string | null;
  readonly observedAt: string | null;
  readonly provider: ProviderCode | null;
  readonly snapshotId: string | null;
  readonly stale: boolean;
}

export interface ViewResolutionHistoryItem extends HistoryBase {
  readonly kind: 'VIEW_RESOLUTION';
  readonly currencyId: string;
  readonly selectedProvider: ProviderCode | null;
  readonly configuredProvider: ProviderCode;
  readonly secondaryProvider: ProviderCode | null;
  readonly sensitiveResolutionId: string | null;
  readonly reason: PriceViewResolutionReason;
  readonly status: PriceViewResolutionStatus;
  readonly safeErrorCode: string | null;
}

export interface FetchRunHistoryItem extends HistoryBase {
  readonly kind: 'FETCH_RUN';
  readonly provider: ProviderCode;
  readonly scheduledFor: string;
  readonly status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  readonly requestedCount: number;
  readonly observedCount: number;
  readonly latencyMs: number | null;
  readonly safeErrorCode: string | null;
  readonly workerInstanceId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface ConfigChangeHistoryItem extends HistoryBase {
  readonly kind: 'CONFIG_CHANGE';
  readonly revision: number;
  readonly status: PriceConfigStatus;
  readonly effectiveAt: string | null;
  readonly changelog: string;
  readonly actorId: string | null;
  readonly config: unknown;
  readonly appliedAt: string | null;
}

/** Append-only administrative audit event exposed only through SUPER_ADMIN history. */
export interface AuditHistoryItem extends HistoryBase {
  readonly kind: 'AUDIT';
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly deviceId: string | null;
  readonly action: string;
  readonly reason: string;
  readonly before: unknown;
  readonly after: unknown;
}

export type PriceConversionHistoryItem =
  | ResolutionHistoryItem
  | ViewResolutionHistoryItem
  | FetchRunHistoryItem
  | ConfigChangeHistoryItem
  | AuditHistoryItem;

export interface PriceConversionHistoryPage {
  readonly items: readonly PriceConversionHistoryItem[];
  readonly nextCursor: string | null;
}

export type PriceConversionUpdateResult =
  | { readonly kind: 'updated'; readonly revision: number }
  | { readonly kind: 'revision_conflict'; readonly actualRevision: number };

/** Stable facade contract consumed by the service regardless of repository decomposition. */
export interface PriceConversionStore {
  bootstrap(input: PriceConversionBootstrapQuery): Promise<PriceConversionBootstrap>;
  updateAtomically(input: PriceConversionPatch, audit: PriceConversionAuditContext): Promise<PriceConversionUpdateResult>;
  history(input: PriceConversionHistoryQuery): Promise<PriceConversionHistoryPage>;
  prices(input: PriceConversionPriceQuery): Promise<PriceConversionPricePage>;
}
