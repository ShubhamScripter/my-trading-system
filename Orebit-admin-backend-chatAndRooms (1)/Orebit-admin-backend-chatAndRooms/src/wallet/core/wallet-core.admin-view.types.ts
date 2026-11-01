import type {
  AdminReconciliationDistribution,
  CurrencyProviderReference,
  WalletAlertSafePayload,
  WalletOperation,
  WalletProviderState,
  WalletReconciliationAlertBasis,
} from './wallet-core.types.js';

/** Read-model contracts intentionally expose formatted values and no persistence rows. */
export interface AdminBootstrapQuery {
  readonly search?: string;
  /** Filters and sorts the operator-facing effectiveState field. */
  readonly state?: 'OFF' | 'ON' | 'MAINTAIN' | 'UPCOMING' | 'DELISTED';
  readonly chainId?: string;
  readonly sortBy?: 'symbol' | 'name' | 'state';
  readonly sortDirection?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
  readonly scheduledCursor?: string;
  readonly scheduledLimit?: number;
  readonly activeAlertCursor?: string;
  readonly activeAlertLimit?: number;
}

export interface AdminChainQuery {
  readonly search?: string;
  /** Filters and sorts the operator-facing effectiveState field. */
  readonly state?: 'OFF' | 'ON' | 'MAINTAIN';
  readonly isEvm?: boolean;
  readonly sortBy?: 'shortName' | 'name' | 'state';
  readonly sortDirection?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminBootstrapViewerInput {
  readonly adminId: string;
}

export interface WalletLogoUrlResolver {
  publicUrl(objectKey: string): string;
}

export interface WalletSettingsView {
  readonly globalDesiredState: 'OFF' | 'ON' | 'MAINTAIN';
  readonly catalogueMode: 'ALL' | 'RELEVANT';
  readonly reconciliationIncludeTreasury: boolean;
  readonly reconciliationIncludeCollection: boolean;
  readonly reconciliationAlertPercent: string;
  readonly reconciliationAlertBasis: WalletReconciliationAlertBasis;
  readonly defaultCurrencyIds: readonly string[];
  readonly updatedAt: string;
}

export interface ConfigurationSummary {
  readonly id: string;
  readonly revision: string;
  readonly status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED';
  readonly reason: string;
  readonly changelogId: string | null;
  readonly actorId: string;
  readonly effectiveAt: string | null;
  readonly appliedAt: string | null;
  readonly createdAt: string;
}

export interface WalletProviderHealthView {
  readonly state: WalletProviderState;
  readonly consecutiveFailedChecks: number;
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly updatedAt: string | null;
}

export interface AdminWalletChain {
  readonly id: string;
  readonly providerChainId: string;
  readonly blockchainReference: string;
  readonly shortName: string;
  readonly name: string;
  readonly isEvm: boolean;
  readonly logo: Readonly<{ objectKey: string; url: string }> | null;
  readonly availableFor: 'USER' | 'MERCHANT' | 'BOTH';
  readonly desiredState: 'OFF' | 'ON' | 'MAINTAIN';
  readonly effectiveState: 'OFF' | 'ON' | 'MAINTAIN';
  readonly maintenancePinned: boolean;
  readonly provider: WalletProviderHealthView;
}

export interface AdminWalletBinding {
  readonly id: string;
  readonly chainId: string;
  readonly chainShortName: string;
  readonly providerCoinId: string;
  readonly blockchainReference: string;
  readonly isToken: boolean;
  readonly tokenContractAddress: string | null;
  readonly blockchainPrecision: number;
  readonly desiredState: 'OFF' | 'ON' | 'MAINTAIN';
  readonly effectiveState: 'OFF' | 'ON' | 'MAINTAIN' | 'UPCOMING' | 'DELISTED';
  readonly maintenancePinned: boolean;
  readonly provider: WalletProviderHealthView;
  readonly hotWalletAddresses: readonly string[];
  readonly coldWalletAddresses: readonly string[];
  readonly stakingWalletAddresses: readonly string[];
}

export interface AdminWalletCurrency {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: 18;
  readonly pricingStatus: 'ACTIVE' | 'DISABLED';
  readonly pricingAutoDisabled: boolean;
  readonly providerReferences: readonly CurrencyProviderReference[];
  readonly binanceReference: string | null;
  readonly logo: Readonly<{ objectKey: string; url: string }> | null;
  readonly viewEnabled: boolean;
  readonly geoCountryDeny: readonly string[];
  readonly geoContinentDeny: readonly string[];
  readonly accessLevel: 'ALL' | 'KYC_L1' | 'KYC_L2';
  readonly availableFor: 'USER' | 'MERCHANT' | 'BOTH';
  readonly listingKind: 'PERMANENT' | 'TIME_LIMITED';
  readonly listingStartsAt: string | null;
  readonly showBeforeListing: boolean;
  readonly premiumEarlyAccessAt: string | null;
  readonly premiumOperations: readonly WalletOperation[];
  readonly soEarlyAccessAt: string | null;
  readonly soOperations: readonly WalletOperation[];
  readonly delistAt: string | null;
  readonly afterDelistMode: 'AUTO_EXCHANGE' | 'LEAVE' | null;
  readonly autoExchangeToCurrencyId: string | null;
  readonly autoExchangeFeeBps: number | null;
  readonly leaveDays: number | null;
  readonly afterLeaveMode: 'LOSS' | 'AUTO_EXCHANGE' | null;
  readonly afterLeaveAutoExchangeToCurrencyId: string | null;
  readonly afterLeaveAutoExchangeFeeBps: number | null;
  readonly postDelistOperations: readonly ('WITHDRAW' | 'EXCHANGE')[];
  readonly desiredState: 'OFF' | 'ON' | 'MAINTAIN';
  readonly effectiveState: 'OFF' | 'ON' | 'MAINTAIN' | 'UPCOMING' | 'DELISTED';
  readonly maintenanceAudiences: readonly ('USER' | 'SO')[];
  readonly showBalanceInMaintenance: Readonly<Record<'USER' | 'SO', boolean>>;
  readonly price: Readonly<{
    readiness: 'HEALTHY' | 'UNAVAILABLE';
    changedAt: string | null;
  }>;
  readonly bindings: readonly AdminWalletBinding[];
}

type AlertPayload<Category extends WalletAlertSafePayload['category']> = Omit<
  Extract<WalletAlertSafePayload, { readonly category: Category }>,
  'category'
>;
export type ShortfallAlertPayload = AlertPayload<'SHORTFALL'>;
export type PartialDataAlertPayload = AlertPayload<'PARTIAL_DATA'>;
export type StakingMismatchAlertPayload = AlertPayload<'STAKING_TOTAL_MISMATCH'>;
export type CatalogueRefreshFailedPayload = AlertPayload<'CATALOGUE_REFRESH_FAILED'>;
type ProviderMaintenanceSafePayload = Extract<
  WalletAlertSafePayload,
  { readonly category: 'PROVIDER_MAINTENANCE' }
>;
export type ProviderMaintenanceAlertViewPayload =
  | Omit<Extract<ProviderMaintenanceSafePayload, { readonly subjectType: 'CHAIN' }>, 'category'>
  | Omit<Extract<ProviderMaintenanceSafePayload,
      { readonly subjectType: 'CURRENCY_CHAIN' }>, 'category'>;

export interface AdminAlertBase<Category, Payload, CurrencyId> {
  readonly id: string;
  readonly category: Category;
  readonly status: 'ACTIVE';
  readonly currencyId: CurrencyId;
  readonly payload: Payload;
  readonly openedAt: string;
  readonly updatedAt: string;
}

export type AdminWalletAlert =
  | AdminAlertBase<'PRICE_MAINTENANCE', AlertPayload<'PRICE_MAINTENANCE'>, string>
  | AdminAlertBase<'DELISTING_PENDING', AlertPayload<'DELISTING_PENDING'>, string>
  | AdminAlertBase<'DELISTING_ACCOUNT_REVIEW', AlertPayload<'DELISTING_ACCOUNT_REVIEW'>, string>
  | AdminAlertBase<'SHORTFALL', ShortfallAlertPayload, string>
  | AdminAlertBase<'PARTIAL_DATA', PartialDataAlertPayload, string>
  | AdminAlertBase<'STAKING_TOTAL_MISMATCH', StakingMismatchAlertPayload, string>
  | AdminAlertBase<'CATALOGUE_REFRESH_FAILED', CatalogueRefreshFailedPayload, null>
  | AdminAlertBase<'PROVIDER_MAINTENANCE',
      Omit<Extract<ProviderMaintenanceSafePayload, { readonly subjectType: 'CHAIN' }>, 'category'>,
      null>
  | AdminAlertBase<'PROVIDER_MAINTENANCE',
      Omit<Extract<ProviderMaintenanceSafePayload,
        { readonly subjectType: 'CURRENCY_CHAIN' }>, 'category'>,
      string>;

export interface AdminReconciliationRunSummary {
  readonly id: string;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  readonly scheduledFor: string;
  readonly valuationAt: string;
  readonly completedAt: string | null;
  readonly appliedConfigurationRevision: string;
  readonly appliedAlertPercent: string;
  readonly appliedAlertBasis: WalletReconciliationAlertBasis | null;
  readonly comparisonRule: 'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD';
  readonly currencyCount: number;
  readonly warningCount: number;
  readonly safeErrorCode: string | null;
}

export interface ReconciliationComponentCount {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface ReconciliationEvidenceSummary {
  readonly componentCounts: Readonly<Record<
    'HOT' | 'COLD' | 'STAKING' | 'BINANCE',
    ReconciliationComponentCount
  >>;
  readonly anomalousComponentCount: number;
}

export interface ReconciliationComponentEvidence {
  readonly id: string;
  readonly kind: 'HOT' | 'COLD' | 'STAKING' | 'BINANCE';
  readonly currencyChainId: string | null;
  readonly custodyAddressId: string | null;
  readonly walletAddress: string | null;
  readonly binanceReference: string | null;
  readonly attemptsUsed: number;
  readonly acceptedRawDecimal: string | null;
  readonly selectedBalance: string | null;
  readonly safeErrorCode: string | null;
  readonly totalAdminStakeBalance: string | null;
  readonly totalAdminManualStakeBalance: string | null;
  readonly totalBalance: string | null;
  readonly stakeSelectedSource: 'REPORTED_TOTAL' | 'COMPONENT_SUM' | null;
  readonly stakeTotalMismatch: boolean;
}

export interface AdminReconciliationItemSummary {
  readonly id: string;
  readonly currencyId: string;
  readonly status: 'COMPLETE' | 'PARTIAL';
  readonly hotColdBalance: string;
  readonly stakingBalance: string;
  readonly binanceBalance: string;
  readonly totalCustodyBalance: string;
  readonly requiredBacking: string;
  readonly userMerchantBalance: string;
  readonly treasuryBalance: string;
  readonly collectionBalance: string;
  readonly ledgerSignedTotal: string | null;
  readonly ledgerSignedTotalUsd: string | null;
  readonly ledgerPositiveTotal: string | null;
  readonly ledgerPositiveTotalUsd: string | null;
  readonly alertBasis: WalletReconciliationAlertBasis | null;
  readonly partialReasons: readonly string[];
  readonly shortfallSuppressed: boolean;
  readonly shortfallPercent: string | null;
  readonly evidenceSummary: ReconciliationEvidenceSummary;
  readonly anomalousComponents: readonly ReconciliationComponentEvidence[];
}

export interface AdminReconciliationSnapshot {
  readonly run: AdminReconciliationRunSummary;
  readonly distribution: AdminReconciliationDistribution;
  readonly items: readonly AdminReconciliationItemSummary[];
}

export interface AdminWalletBootstrap {
  readonly currentRevision: string;
  readonly settings: WalletSettingsView;
  readonly configuration: Readonly<{
    live: ConfigurationSummary | null;
    scheduled: Readonly<{ items: readonly ConfigurationSummary[]; total: number;
      nextCursor: string | null }>;
  }>;
  readonly chains: readonly AdminWalletChain[];
  readonly currencies: Readonly<{
    items: readonly AdminWalletCurrency[];
    nextCursor: string | null;
  }>;
  readonly activeAlerts: Readonly<{ items: readonly AdminWalletAlert[]; total: number;
    nextCursor: string | null }>;
  readonly lastReconciliation: AdminReconciliationSnapshot | null;
  readonly viewer: Readonly<{
    displayTimezone: string;
  }>;
}

export type WalletHistoryActor =
  | Readonly<{ kind: 'ADMIN'; adminId: string }>
  | Readonly<{ kind: 'SYSTEM'; runId: string }>
  | null;
export interface HistoryBase {
  readonly id: string;
  readonly createdAt: string;
  readonly actor: WalletHistoryActor;
}
export type WalletHistoryCategory =
  | 'CONFIGURATION' | 'STATE' | 'PROVIDER' | 'ALERT'
  | 'RECONCILIATION' | 'FORFEITURE' | 'JOB';
export type WalletAlertCategory = WalletAlertSafePayload['category'];

export type WalletHistoryItem =
  | (HistoryBase & Readonly<{ category: 'CONFIGURATION'; configuration: ConfigurationSummary }>)
  | (HistoryBase & Readonly<{ category: 'STATE'; eventType: 'CHAIN.STATUS_CHANGED';
      subject: Readonly<{ type: 'CHAIN'; id: string }>;
      fromState: string | null; toState: string; reasonCode: string | null }>)
  | (HistoryBase & Readonly<{ category: 'STATE'; eventType: 'CURRENCY.STATUS_CHANGED';
      subject: Readonly<{ type: 'CURRENCY' | 'CURRENCY_CHAIN'; id: string }>;
      fromState: string | null; toState: string; reasonCode: string | null }>)
  | (HistoryBase & Readonly<{ category: 'PROVIDER';
      eventType: 'PROVIDER_MAINTENANCE.ENTERED' | 'PROVIDER_MAINTENANCE.RECOVERED';
      subject: Readonly<{ type: 'CHAIN' | 'CURRENCY_CHAIN'; id: string }>;
      fromState: WalletProviderState; toState: WalletProviderState;
      beforeMaintenancePinned: null; afterMaintenancePinned: null }>)
  | (HistoryBase & Readonly<{ category: 'PROVIDER';
      eventType: 'PROVIDER_MAINTENANCE.PINNED' | 'PROVIDER_MAINTENANCE.UNPINNED';
      subject: Readonly<{ type: 'CHAIN' | 'CURRENCY_CHAIN'; id: string }>;
      fromState: null; toState: null;
      beforeMaintenancePinned: boolean; afterMaintenancePinned: boolean }>)
  | (HistoryBase & Readonly<{ category: 'ALERT'; alertId: string;
      alertCategory: WalletAlertCategory; status: 'ACTIVE' | 'CLEARED';
      currencyId: string | null }>)
  | (HistoryBase & Readonly<{ category: 'RECONCILIATION'; runId: string;
      status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; scheduledFor: string;
      completedAt: string | null; currencyCount: number;
      warningCount: number; safeErrorCode: string | null }>)
  | (HistoryBase & Readonly<{ category: 'FORFEITURE'; executionId: string;
      currencyId: string; policyRevision: string;
      status: 'RUNNING' | 'PARTIAL' | 'FAILED' | 'COMPLETED'; deadline: string;
      processedCount: number; skippedCount: number; failedCount: number;
      safeErrorCode: string | null }>)
  | (HistoryBase & Readonly<{ category: 'JOB'; jobName: string; scheduledFor: string;
      status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
      attemptCount: number; processedCount: number; failedCount: number;
      safeErrorCode: string | null; leaseExpiresAt: string | null;
      finishedAt: string | null }>);

export interface WalletHistoryQuery {
  readonly eventType?: 'CHAIN.STATUS_CHANGED' | 'CURRENCY.STATUS_CHANGED'
    | 'PROVIDER_MAINTENANCE.ENTERED' | 'PROVIDER_MAINTENANCE.RECOVERED'
    | 'PROVIDER_MAINTENANCE.PINNED' | 'PROVIDER_MAINTENANCE.UNPINNED';
  readonly currencyId?: string;
  readonly actorId?: string;
  readonly status?: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED'
    | 'ACTIVE' | 'CLEARED' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'RUNNING'
    | 'COMPLETED' | 'SKIPPED';
  readonly from?: string;
  readonly to?: string;
  readonly sortDirection?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
}
export interface WalletHistoryPage {
  readonly items: readonly WalletHistoryItem[];
  readonly nextCursor: string | null;
}
