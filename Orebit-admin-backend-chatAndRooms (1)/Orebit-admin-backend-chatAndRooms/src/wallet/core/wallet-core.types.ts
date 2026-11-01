import type { Principal } from '../../../auth/auth.types.js';
import type { AdminAuditActor } from '../../admin-audits/index.js';
import type { ProviderCode as PriceProviderCode } from '../price-conversion/price-conversion.types.js';

/** Closed vocabularies keep policy, persistence, and Admin responses on the same wire values. */
export const WALLET_CONFIG_ACTIONS = ['PUSH', 'SCHEDULE'] as const;
export const WALLET_DESIRED_STATES = ['OFF', 'ON', 'MAINTAIN'] as const;
export const WALLET_OPERATIONS = [
  'DEPOSIT', 'WITHDRAW', 'EXCHANGE', 'USER_TRANSFER', 'SEND_API', 'STAKE', 'BANKROLL',
] as const;
export const WALLET_AVAILABILITIES = ['USER', 'MERCHANT', 'BOTH'] as const;
export const WALLET_ACCESS_LEVELS = ['ALL', 'KYC_L1', 'KYC_L2'] as const;
export const WALLET_PRICE_PROVIDERS = ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'] as const;
export const WALLET_RECONCILIATION_ALERT_BASES = ['SIGNED', 'POSITIVE_ONLY'] as const;
export const WALLET_ADMIN_PERMISSIONS = [
  'WALLET_CORE_READ',
  'WALLET_CORE_CONFIGURE',
  'WALLET_CORE_IMPORT',
  'WALLET_CORE_RECONCILIATION_READ',
  'DEPOSIT_ADMIN_READ',
  'DEPOSIT_ADMIN_CONFIGURE',
  'DEPOSIT_ADMIN_MODERATE',
] as const;
export const WALLET_SCHEDULE_REJECTION_REASONS = [
  'STALE_SETTINGS_REVISION',
  'CONFIGURATION_INVALID',
  'CATALOGUE_REVISION_CHANGED',
  'CATALOGUE_REFERENCE_UNAVAILABLE',
] as const;
export const WALLET_DISTRIBUTION_STATUSES = ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'] as const;
export const WALLET_RECONCILIATION_SAFE_ERROR_CODES = [
  'ENCRYPTION_FAILED',
  'AUTHENTICATION_FAILED',
  'UNAUTHORIZED_IP',
  'PROVIDER_MAINTENANCE',
  'PROVIDER_DISABLED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_REJECTED',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
  'INVALID_DECIMAL',
] as const;
export const WALLET_PARTIAL_DATA_REASONS = [
  ...WALLET_RECONCILIATION_SAFE_ERROR_CODES,
  'CUSTODY_NOT_CONFIGURED',
  'PRICE_UNAVAILABLE',
  'STAKING_TOTAL_MISMATCH',
] as const;
export const WALLET_CATALOGUE_REFRESH_ERROR_CODES = [
  'PROVIDER_REJECTED',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
  'CATALOGUE_LIMIT_EXCEEDED',
  'PAGINATION_INCONSISTENT',
  'DUPLICATE_PROVIDER_ID',
  'WRONG_CHAIN_ASSOCIATION',
  'DATABASE_ERROR',
  'AUDIT_ERROR',
] as const;
export const WALLET_CRON_SAFE_REASON_CODES = [
  'LOGO_CLEANUP_PARTIAL',
  'CONFIGURATION_REJECTED',
  'PROVIDER_OBSERVATION_PARTIAL',
  'PROVIDER_OBSERVATION_FAILED',
  'DEPENDENCY_UNAVAILABLE',
  'MISSED_SCHEDULE',
  'CATCHUP_TRUNCATED',
  'UNEXPECTED_ERROR',
] as const;
export const WALLET_PROVIDER_MAINTENANCE_OUTBOX_EVENTS = [
  'WALLET_PROVIDER_MAINTENANCE_ENTERED',
  'WALLET_PROVIDER_MAINTENANCE_RECOVERED',
] as const;

export type WalletConfigAction = (typeof WALLET_CONFIG_ACTIONS)[number];
export type WalletDesiredState = (typeof WALLET_DESIRED_STATES)[number];
export type WalletOperation = (typeof WALLET_OPERATIONS)[number];
export type WalletAvailability = (typeof WALLET_AVAILABILITIES)[number];
export type WalletAccessLevel = (typeof WALLET_ACCESS_LEVELS)[number];
export type WalletPriceProvider = (typeof WALLET_PRICE_PROVIDERS)[number];
export type WalletReconciliationAlertBasis =
  (typeof WALLET_RECONCILIATION_ALERT_BASES)[number];
export type WalletAdminPermission = (typeof WALLET_ADMIN_PERMISSIONS)[number];
export type WalletScheduleRejectionReason = (typeof WALLET_SCHEDULE_REJECTION_REASONS)[number];
export type WalletDistributionStatus = (typeof WALLET_DISTRIBUTION_STATUSES)[number];
export type WalletReconciliationSafeErrorCode =
  (typeof WALLET_RECONCILIATION_SAFE_ERROR_CODES)[number];
export type WalletPartialDataReason = (typeof WALLET_PARTIAL_DATA_REASONS)[number];
export type WalletCatalogueRefreshErrorCode =
  (typeof WALLET_CATALOGUE_REFRESH_ERROR_CODES)[number];
export type WalletProviderObservationErrorCode = Exclude<
  WalletCatalogueRefreshErrorCode,
  'DATABASE_ERROR' | 'AUDIT_ERROR'
>;
export type WalletCronSafeReasonCode = (typeof WALLET_CRON_SAFE_REASON_CODES)[number];
export type WalletProviderMaintenanceOutboxEvent =
  (typeof WALLET_PROVIDER_MAINTENANCE_OUTBOX_EVENTS)[number];
declare const positiveSkippedBucketCount: unique symbol;
export type WalletPositiveSkippedBucketCount = number & {
  readonly [positiveSkippedBucketCount]: true;
};
export function walletPositiveSkippedBucketCount(
  value: number,
): WalletPositiveSkippedBucketCount {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid skipped bucket count.');
  }
  return value as WalletPositiveSkippedBucketCount;
}
export type WalletAudience = 'USER' | 'SO';
export type WalletProviderState = 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE' | 'UNAVAILABLE';
export type WalletPriceReadiness = 'HEALTHY' | 'UNAVAILABLE';
export type WalletEffectiveState = 'OFF' | 'ON' | 'MAINTAIN' | 'UPCOMING' | 'DELISTED';

export type WalletCronRunOutcome =
  | Readonly<{ status: 'SUCCESS'; safeErrorCode: null; skippedBucketCount: 0 }>
  | Readonly<{ status: 'PARTIAL'; safeErrorCode:
      'CONFIGURATION_REJECTED' | 'PROVIDER_OBSERVATION_PARTIAL' | 'LOGO_CLEANUP_PARTIAL'; skippedBucketCount: 0 }>
  | Readonly<{ status: 'FAILED'; safeErrorCode:
      'PROVIDER_OBSERVATION_FAILED' | 'DEPENDENCY_UNAVAILABLE' | 'UNEXPECTED_ERROR';
      skippedBucketCount: 0 }>
  | Readonly<{ status: 'SKIPPED'; safeErrorCode: 'MISSED_SCHEDULE'; skippedBucketCount: 0 }>
  | Readonly<{ status: 'SKIPPED'; safeErrorCode: 'CATCHUP_TRUNCATED';
      skippedBucketCount: WalletPositiveSkippedBucketCount }>;

export type WalletProviderCheckOutcome =
  | 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE' | 'FAILED';
export interface ProviderMaintenanceObservationInput {
  readonly previousProviderState: WalletProviderState;
  readonly failureStreak: number;
  readonly desiredState: WalletDesiredState;
  readonly maintenancePinned: boolean;
  readonly outcome: WalletProviderCheckOutcome;
}
export interface ProviderMaintenanceObservationResolution {
  readonly providerState: WalletProviderState;
  readonly failureStreak: number;
  readonly effectiveState: WalletDesiredState;
  readonly transition: 'ENTERED' | 'RECOVERED' | null;
  readonly outboxEvent: WalletProviderMaintenanceOutboxEvent | null;
}

export interface ProviderObservationScope {
  readonly chains: readonly Readonly<{
    providerChainId: number;
    bindings: readonly Readonly<{ providerCoinId: number }>[];
  }>[];
}
type ProviderReportedState = Exclude<WalletProviderState, 'UNAVAILABLE'>;
export type ProviderChainObservation =
  | Readonly<{ outcome: 'OBSERVED'; providerChainId: number;
      providerState: ProviderReportedState }>
  | Readonly<{ outcome: 'OMITTED'; providerChainId: number }>;
export type ProviderBindingObservation =
  | Readonly<{ outcome: 'OBSERVED'; providerChainId: number; providerCoinId: number;
      providerState: ProviderReportedState }>
  | Readonly<{ outcome: 'OMITTED'; providerChainId: number; providerCoinId: number }>;
export type ProviderObservationFailure =
  | Readonly<{ scope: 'ALL'; safeErrorCode: WalletProviderObservationErrorCode }>
  | Readonly<{ scope: 'CHAIN'; providerChainId: number;
      safeErrorCode: WalletProviderObservationErrorCode }>;
export interface ProviderObservationResult {
  readonly chains: readonly ProviderChainObservation[];
  readonly bindings: readonly ProviderBindingObservation[];
  readonly failures: readonly ProviderObservationFailure[];
}

export interface WalletAdminAuthorizationPort {
  require(principal: Principal, permission: WalletAdminPermission): Promise<void>;
}

export type WalletAdminAuditActor = Extract<AdminAuditActor, { readonly kind: 'ADMIN' }>;
export type WalletSystemAuditActor = Extract<AdminAuditActor, { readonly kind: 'SYSTEM' }>;
export type WalletAuditContext = Readonly<{ readonly actor: WalletAdminAuditActor }>;
export interface WalletCoreSystemAuditContext {
  readonly actor: WalletSystemAuditActor;
}

type NonZeroDigit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type WalletPositiveRevision = `${bigint}` & `${NonZeroDigit}${string}`;
type WalletPositiveProviderId = `${bigint}` & `${NonZeroDigit}${string}`;

/** Repository results validate UUIDv7 IDs and canonical UTC timestamps before constructing this union. */
export type WalletUpdateResult =
  | Readonly<{
      outcome: 'PUSHED';
      configurationId: string;
      revision: WalletPositiveRevision;
      status: 'LIVE';
      appliedAt: string;
    }>
  | Readonly<{
      outcome: 'SCHEDULED';
      configurationId: string;
      revision: WalletPositiveRevision;
      status: 'SCHEDULED';
      effectiveAt: string;
    }>
  | Readonly<{
      outcome: 'SCHEDULE_APPLIED';
      configurationId: string;
      revision: WalletPositiveRevision;
      status: 'LIVE';
      appliedAt: string;
    }>
  | Readonly<{
      outcome: 'SCHEDULE_REJECTED';
      configurationId: string;
      revision: WalletPositiveRevision;
      status: 'REJECTED';
      reasonCode: WalletScheduleRejectionReason;
    }>
  | Readonly<{
      outcome: 'ALREADY_PROCESSED';
      configurationId: string;
      revision: WalletPositiveRevision;
      status: 'LIVE' | 'ARCHIVED' | 'REJECTED';
    }>;

/** JSON projection values are formatted at the API boundary; persisted amounts remain exact. */
export interface WalletDistributionBucket {
  readonly cryptoAmount: string;
  readonly usdValue: string | null;
  readonly percentage: string | null;
  readonly complete: boolean;
}

export interface WalletPriceProvenanceView {
  readonly resolutionId: string;
  readonly snapshotId: string;
  readonly provider: PriceProviderCode;
  readonly priceUsd: string;
  readonly observedAt: string;
  readonly resolutionReason: string;
  readonly usedFallback: boolean;
}

export interface WalletCurrencyDistribution {
  readonly currencyId: string;
  readonly symbol: string;
  readonly status: WalletDistributionStatus;
  readonly price: WalletPriceProvenanceView | null;
  readonly blockchainWallets: WalletDistributionBucket;
  readonly stakingWallets: WalletDistributionBucket;
  readonly binance: WalletDistributionBucket;
  readonly totalCrypto: string;
  readonly totalUsd: string | null;
  readonly percentageOfOverallUsd: string | null;
}

export interface WalletOverallUsdDistributionBucket {
  readonly usdValue: string | null;
  readonly percentage: string | null;
}

export interface WalletOverallUsdDistribution {
  readonly status: WalletDistributionStatus;
  readonly valuationAt: string;
  readonly blockchainWallets: WalletOverallUsdDistributionBucket;
  readonly stakingWallets: WalletOverallUsdDistributionBucket;
  readonly binance: WalletOverallUsdDistributionBucket;
  readonly totalUsd: string | null;
}

export interface AdminReconciliationDistribution {
  readonly currencies: readonly WalletCurrencyDistribution[];
  readonly overall: WalletOverallUsdDistribution;
}

export type WalletAlertSafePayload =
  | import('./wallet-core.runtime-alert.js').RuntimeAlertPayload
  | Readonly<{
      category: 'SHORTFALL';
      runId: string;
      itemId: string;
      currencyId: string;
      custodyBalance: string;
      requiredBacking: string;
      shortfallPercent: string;
      thresholdPercent: string;
    }>
  | Readonly<{
      category: 'PARTIAL_DATA';
      runId: string;
      itemId: string;
      currencyId: string;
      partialReasons: readonly WalletPartialDataReason[];
      shortfallSuppressed: boolean;
    }>
  | Readonly<{
      category: 'STAKING_TOTAL_MISMATCH';
      runId: string;
      itemId: string;
      componentId: string;
      currencyId: string;
      reportedTotal: string;
      componentSum: string;
      selectedSource: 'REPORTED_TOTAL' | 'COMPONENT_SUM';
    }>
  | Readonly<{
      category: 'CATALOGUE_REFRESH_FAILED';
      safeErrorCode: WalletCatalogueRefreshErrorCode;
      failedAt: string;
    }>
  | ProviderMaintenanceAlertPayload;

type WalletProviderFailureStreak = 0 | 1 | 2 | 3;
type ProviderMaintenanceAlertBase = Readonly<{
  subjectId: string;
  providerState: WalletProviderState;
  failureStreak: WalletProviderFailureStreak;
  maintenancePinned: boolean;
  effectiveState: WalletDesiredState;
  observedAt: string;
}>;
export type ProviderMaintenanceAlertPayload =
  | (ProviderMaintenanceAlertBase & Readonly<{
      category: 'PROVIDER_MAINTENANCE';
      subjectType: 'CHAIN';
      providerReference: `CHAIN:${WalletPositiveProviderId}`;
    }>)
  | (ProviderMaintenanceAlertBase & Readonly<{
      category: 'PROVIDER_MAINTENANCE';
      subjectType: 'CURRENCY_CHAIN';
      providerReference: `CURRENCY_CHAIN:${WalletPositiveProviderId}:${WalletPositiveProviderId}`;
    }>);

export interface WalletSettingsPatch {
  readonly globalDesiredState: WalletDesiredState;
  readonly catalogueMode: 'ALL' | 'RELEVANT';
  readonly reconciliationIncludeTreasury: boolean;
  readonly reconciliationIncludeCollection: boolean;
  readonly reconciliationAlertPercent: string;
  readonly reconciliationAlertBasis?: WalletReconciliationAlertBasis;
  readonly defaultCurrencyIds: readonly string[];
}

export const DEFAULT_WALLET_SETTINGS = {
  globalDesiredState: 'ON',
  catalogueMode: 'ALL',
  reconciliationIncludeTreasury: true,
  reconciliationIncludeCollection: false,
  reconciliationAlertPercent: '5',
  reconciliationAlertBasis: 'SIGNED',
  defaultCurrencyIds: [],
} as const satisfies WalletSettingsPatch;

export interface ChainUpsert {
  readonly id?: string;
  readonly providerChainId: number;
  readonly blockchainReference: string;
  readonly name: string;
  readonly shortName: string;
  readonly isEvm: boolean;
  readonly logoObjectKey?: string;
  readonly availableFor: WalletAvailability;
  readonly desiredState: WalletDesiredState;
}

export interface CurrencyChainUpsert {
  readonly id?: string;
  readonly chainId: string;
  readonly providerCoinId: number;
  readonly blockchainReference: string;
  readonly isToken: boolean;
  readonly tokenContractAddress?: string;
  readonly blockchainPrecision: number;
  readonly desiredState: WalletDesiredState;
  readonly hotWalletAddresses: readonly string[];
  readonly coldWalletAddresses: readonly string[];
  readonly stakingWalletAddresses: readonly string[];
}

export interface CurrencyProviderReference {
  readonly provider: WalletPriceProvider;
  readonly providerAssetId: string;
  readonly providerSymbol: string;
  readonly network?: string;
  readonly address?: string;
}

export interface CurrencyUpsert {
  readonly id?: string;
  readonly symbol: string;
  readonly name: string;
  readonly providerRefs: readonly CurrencyProviderReference[];
  readonly binanceReference?: string;
  readonly logoObjectKey?: string;
  readonly viewEnabled: boolean;
  readonly geoCountryDeny: readonly string[];
  readonly geoContinentDeny: readonly string[];
  readonly accessLevel: WalletAccessLevel;
  readonly availableFor: WalletAvailability;
  readonly listingKind: 'PERMANENT' | 'TIME_LIMITED';
  readonly listingStartsAt?: string;
  readonly showBeforeListing: boolean;
  readonly premiumEarlyAccessAt?: string;
  readonly premiumOperations: readonly WalletOperation[];
  readonly soEarlyAccessAt?: string;
  readonly soOperations: readonly WalletOperation[];
  readonly delistAt?: string;
  readonly afterDelistMode?: 'AUTO_EXCHANGE' | 'LEAVE';
  readonly autoExchangeToCurrencyId?: string;
  readonly autoExchangeFeeBps?: number;
  readonly leaveDays?: number;
  readonly afterLeaveMode?: 'LOSS' | 'AUTO_EXCHANGE';
  readonly afterLeaveAutoExchangeToCurrencyId?: string;
  readonly afterLeaveAutoExchangeFeeBps?: number;
  readonly postDelistOperations: readonly ('WITHDRAW' | 'EXCHANGE')[];
  readonly desiredState: WalletDesiredState;
  readonly maintenanceAudiences: readonly WalletAudience[];
  readonly showBalanceInMaintenance: Readonly<Record<WalletAudience, boolean>>;
  readonly bindings: readonly CurrencyChainUpsert[];
}

export interface ProviderMaintenancePin {
  readonly subject: 'CHAIN' | 'CURRENCY_CHAIN';
  readonly subjectId: string;
  readonly pinned: boolean;
}

export interface WalletCoreConfigurationPatch {
  readonly settings?: WalletSettingsPatch;
  readonly chains?: readonly ChainUpsert[];
  readonly currencies?: readonly CurrencyUpsert[];
  readonly providerPins?: readonly ProviderMaintenancePin[];
}

/** Command accepted by the atomic writer after transport validation and normalization. */
export interface WalletCorePatch {
  readonly action: WalletConfigAction;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly changelogId?: string;
  readonly effectiveAt?: string;
  readonly config: WalletCoreConfigurationPatch;
}

export interface WalletPageQuery {
  readonly cursor?: string;
  readonly limit: number;
}

export interface NormalizedCustodyAddressLists {
  readonly hotWalletAddresses: readonly string[];
  readonly coldWalletAddresses: readonly string[];
  readonly stakingWalletAddresses: readonly string[];
}

export type {
  AdminAlertBase,
  AdminChainQuery,
  AdminBootstrapQuery,
  AdminBootstrapViewerInput,
  AdminReconciliationItemSummary,
  AdminReconciliationRunSummary,
  AdminReconciliationSnapshot,
  AdminWalletAlert,
  AdminWalletBinding,
  AdminWalletBootstrap,
  AdminWalletChain,
  AdminWalletCurrency,
  CatalogueRefreshFailedPayload,
  ConfigurationSummary,
  HistoryBase,
  PartialDataAlertPayload,
  ReconciliationComponentCount,
  ReconciliationComponentEvidence,
  ReconciliationEvidenceSummary,
  ShortfallAlertPayload,
  StakingMismatchAlertPayload,
  WalletAlertCategory,
  WalletHistoryActor,
  WalletHistoryCategory,
  WalletHistoryItem,
  WalletHistoryPage,
  WalletHistoryQuery,
  WalletLogoUrlResolver,
  WalletProviderHealthView,
  WalletSettingsView,
} from './wallet-core.admin-view.types.js';
