import type { ChainUpsert, CurrencyUpsert, WalletCoreConfigurationPatch } from '../wallet/core/wallet-core.types.js';
import type { FiatCode, ProviderCode, ProviderRole } from '../wallet/price-conversion/price-conversion.types.js';

export type AdminAuditActor =
  | {
      readonly kind: 'ADMIN';
      readonly actorId: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly ipAddress: string;
      readonly deviceId: string;
    }
  | { readonly kind: 'SYSTEM'; readonly runId: string };

export const WALLET_CORE_ADMIN_AUDIT_ACTIONS = [
  'SETTINGS.SAVED',
  'SETTINGS.PUSHED',
  'SETTINGS.SCHEDULED',
  'SETTINGS.SCHEDULE_APPLIED',
  'SETTINGS.SCHEDULE_REJECTED',
  'LOGO.UPLOADED',
  'ADMIN_TIMEZONE.UPDATED',
  'CATALOGUE.REFRESHED',
  'CHAIN.CREATED',
  'CHAIN.UPDATED',
  'CHAIN.IMPORTED',
  'CHAIN.STATUS_CHANGED',
  'CURRENCY.CREATED',
  'CURRENCY.UPDATED',
  'CURRENCY.IMPORTED',
  'CURRENCY.STATUS_CHANGED',
  'PROVIDER_MAINTENANCE.PINNED',
  'PROVIDER_MAINTENANCE.UNPINNED',
  'PROVIDER_MAINTENANCE.ENTERED',
  'PROVIDER_MAINTENANCE.RECOVERED',
  'PRICE_MAINTENANCE.ENTERED',
  'PRICE_MAINTENANCE.RECOVERED',
  'RECONCILIATION.COMPLETED',
  'RECONCILIATION.WARNING_RAISED',
  'RECONCILIATION.WARNING_CLEARED',
  'DELISTING.FORFEITURE_POSTED',
] as const;
export const DEPOSIT_ADMIN_AUDIT_ACTIONS = [
  'SETTINGS.SAVED',
  'SETTINGS.PUSHED',
  'SETTINGS.SCHEDULED',
  'SETTINGS.SCHEDULE_APPLIED',
  'SETTINGS.SCHEDULE_REJECTED',
  'DEPOSIT.RELEASED',
  'DEPOSIT.REJECTED',
  'DEPOSIT.CANCELLED',
  'DEPOSIT.MAINTENANCE_CANCELLED',
  'DEPOSIT.REVERIFICATION_HELD',
  'DEPOSIT.CLAWBACK_TO_ZERO_POSTED',
  'DEPOSIT.CLAWBACK_NEGATIVE_POSTED',
  'DEPOSIT.ACCOUNTING_REVERSAL_POSTED',
  'DEPOSIT.STATUS_CHANGED',
  'BLOCKER.WAIVED',
  'QUARANTINE.RETRIED',
  'QUARANTINE.ASSIGNED',
  'QUARANTINE.CREDIT_REQUESTED',
  'QUARANTINE.RETAINED',
  'KILL_SWITCH.ACTIVATED',
  'KILL_SWITCH.CLEARED',
  'BULK_JOB.CREATED',
  'BULK_JOB.STARTED',
  'BULK_JOB.ITEM_SUCCEEDED',
  'BULK_JOB.ITEM_FAILED',
  'BULK_JOB.PAUSED',
  'BULK_JOB.RESUMED',
  'BULK_JOB.COMPLETED',
  'BULK_JOB.COMPLETED_WITH_FAILURES',
  'BULK_JOB.FAILED',
] as const;

type AdminActor = Extract<AdminAuditActor, { readonly kind: 'ADMIN' }>;
type SystemActor = Extract<AdminAuditActor, { readonly kind: 'SYSTEM' }>;
export type AdminAuditJson = string | number | boolean | null | readonly AdminAuditJson[] | { readonly [key: string]: AdminAuditJson };
type State = Readonly<Record<string, AdminAuditJson>>;
export const PRICE_CONVERSION_ADMIN_AUDIT_ACTIONS = ['SETTINGS.SAVED', 'SETTINGS.PUSHED', 'SETTINGS.SCHEDULED', 'SETTINGS.SCHEDULE_APPLIED', 'SETTINGS.SCHEDULE_REJECTED'] as const;
type Input<
  A extends string,
  S extends string,
  B extends object,
  M extends object,
  Actor extends AdminAuditActor = AdminAuditActor,
> = Readonly<{
  domain: 'WALLET_CORE' | 'DEPOSIT';
  action: A;
  eventKey: string;
  actor: Actor;
  subject: Readonly<{ type: S; id: string }>;
  reason: string;
  before: B | null;
  after: B | null;
  metadata: M;
}>;
type SettingsStatus = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED';
type SettingsState<S extends SettingsStatus = SettingsStatus, C = never> = Readonly<{
  revision?: number;
  status: S;
  effectiveAt?: string | null;
  config?: C;
}>;
type SettingsMetadata = Readonly<{
  configurationRevision: number;
  changelogId?: string;
  safeErrorCode?: string;
}>;
type ChainState = Readonly<{
  config?: ChainUpsert;
  name?: string;
  shortName?: string;
  blockchainReference?: string;
  availableFor?: 'USER' | 'MERCHANT' | 'BOTH';
  logoObjectKey?: string;
}>;
type CurrencyState = Readonly<{
  config?: CurrencyUpsert;
  symbol?: string;
  name?: string;
  kind?: 'CRYPTO' | 'FIAT';
  pricingStatus?: 'ACTIVE' | 'DISABLED';
  desiredState?: WalletState;
  logoObjectKey?: string;
}>;
type WalletState = 'ON' | 'OFF' | 'MAINTAIN' | 'UPCOMING';
type DepositState = Readonly<{
  status?: 'PENDING' | 'HELD' | 'SUCCESS' | 'FAILED' | 'REJECTED' | 'CANCELLED' | 'QUARANTINED' | 'RETRY_PENDING';
  bucket?: 'AVAILABLE' | 'HOLD' | 'OREBIT_TREASURY' | 'OREBIT_COLLECTION';
  visible?: boolean;
}>;

type SettingsAuditInput<D extends 'WALLET_CORE' | 'DEPOSIT', A extends string, B extends SettingsState | null, S extends SettingsStatus, Actor extends AdminAuditActor> =
  Omit<Input<A, 'SETTINGS_REVISION', SettingsState, SettingsMetadata, Actor>, 'domain' | 'before' | 'after'> &
  Readonly<{ domain: D; before: B extends null ? null : B & { readonly config?: D extends 'WALLET_CORE' ? WalletCoreConfigurationPatch : never }; after: SettingsState<S, D extends 'WALLET_CORE' ? WalletCoreConfigurationPatch : never> }>;
type WalletCoreSettingsAuditInput =
  | SettingsAuditInput<'WALLET_CORE', 'SETTINGS.SAVED', null, 'DRAFT', AdminActor>
  | SettingsAuditInput<'WALLET_CORE', 'SETTINGS.PUSHED', SettingsState<'DRAFT'>, 'LIVE', AdminActor>
  | SettingsAuditInput<'WALLET_CORE', 'SETTINGS.SCHEDULED', SettingsState<'DRAFT'>, 'SCHEDULED', AdminActor>
  | SettingsAuditInput<'WALLET_CORE', 'SETTINGS.SCHEDULE_APPLIED', SettingsState<'SCHEDULED'>, 'LIVE', SystemActor>
  | SettingsAuditInput<'WALLET_CORE', 'SETTINGS.SCHEDULE_REJECTED', SettingsState<'SCHEDULED'>, 'REJECTED', SystemActor>;
type WalletCoreLogoAuditInput = Omit<
  Input<'LOGO.UPLOADED', 'LOGO_ASSET', State, Readonly<{ sourceFormat: 'PNG' | 'JPEG' | 'WEBP' | 'AVIF' }>, AdminActor>,
  'domain' | 'before' | 'after'
> & Readonly<{
  domain: 'WALLET_CORE';
  before: Readonly<{ stored: false }>;
  after: Readonly<{ stored: true; mediaType: 'image/webp'; width: number; height: number; bytes: number }>;
}>;
interface WalletCoreAdminTimezoneAuditInput extends Input<
  'ADMIN_TIMEZONE.UPDATED',
  'ADMIN',
  Readonly<{ timezone?: string }>,
  Readonly<{ configurationRevision: number }>,
  AdminActor
> {
  readonly domain: 'WALLET_CORE';
}
interface WalletCoreCatalogueAuditInput extends Input<
  'CATALOGUE.REFRESHED',
  'PROVIDER_CATALOGUE',
  Readonly<{ revision?: number; itemCount?: number }>,
  Readonly<{ configurationRevision: number; source: 'BLOCKCHAIN' }>,
  AdminActor
> {
  readonly domain: 'WALLET_CORE';
}
interface WalletCoreChainAuditInput extends Input<
  'CHAIN.CREATED' | 'CHAIN.UPDATED' | 'CHAIN.IMPORTED',
  'CHAIN',
  ChainState,
  Readonly<{ configurationRevision: number; importCatalogueRevision?: number }>,
  AdminActor
> {
  readonly domain: 'WALLET_CORE';
}
interface WalletCoreCurrencyAuditInput extends Input<
  'CURRENCY.CREATED' | 'CURRENCY.UPDATED' | 'CURRENCY.IMPORTED',
  'CURRENCY',
  CurrencyState,
  Readonly<{
    configurationRevision: number;
    providerReferenceCount?: number;
    chainBindingCount?: number;
    importCatalogueRevision?: number;
  }>,
  AdminActor
> {
  readonly domain: 'WALLET_CORE';
}
type WalletCoreStatusAuditInput =
  | (Input<
      'CHAIN.STATUS_CHANGED',
      'CHAIN',
      Readonly<{
        desiredState?: WalletState;
        effectiveState?: WalletState;
        maintenancePinned?: boolean;
      }>,
      Readonly<{ configurationRevision: number; scheduledChangeId?: string }>
    > &
      Readonly<{ domain: 'WALLET_CORE' }>)
  | (Input<
      'CURRENCY.STATUS_CHANGED',
      'CURRENCY' | 'CURRENCY_CHAIN',
      Readonly<{ desiredState?: WalletState; effectiveState?: WalletState; showBalance?: boolean }>,
      Readonly<{ configurationRevision: number; scheduledChangeId?: string }>
    > &
      Readonly<{ domain: 'WALLET_CORE' }>);
interface WalletCoreProviderMaintenanceAuditInput extends Input<
  'PROVIDER_MAINTENANCE.PINNED' | 'PROVIDER_MAINTENANCE.UNPINNED',
  'CHAIN' | 'CURRENCY_CHAIN',
  Readonly<{ maintenancePinned?: boolean; effectiveState?: WalletState }>,
  Readonly<{ configurationRevision: number }>,
  AdminActor
> {
  readonly domain: 'WALLET_CORE';
}
type ScheduledBusinessInput<T extends { readonly metadata: object }> = Omit<T, 'actor' | 'metadata'> & Readonly<{
  actor: SystemActor;
  metadata: T['metadata'] & Readonly<{ scheduledChangeId: string }>;
}>;
type WalletCoreScheduledBusinessAuditInput =
  | ScheduledBusinessInput<Omit<WalletCoreChainAuditInput, 'action'> & Readonly<{ action: 'CHAIN.UPDATED' | 'CHAIN.IMPORTED' }>>
  | ScheduledBusinessInput<Omit<WalletCoreCurrencyAuditInput, 'action'> & Readonly<{ action: 'CURRENCY.UPDATED' | 'CURRENCY.IMPORTED' }>>
  | ScheduledBusinessInput<WalletCoreProviderMaintenanceAuditInput>;
type MaintenanceRunState = Readonly<{
  effectiveState?: WalletState; failureStreak?: number; maintenancePinned?: boolean;
}>;
type MaintenanceRunMetadata = Readonly<{ configurationRevision: number; providerReference: string }>;
type WalletCoreMaintenanceRunAuditInput =
  | (Input<'PROVIDER_MAINTENANCE.ENTERED' | 'PROVIDER_MAINTENANCE.RECOVERED',
      'CHAIN' | 'CURRENCY' | 'CURRENCY_CHAIN', MaintenanceRunState, MaintenanceRunMetadata, SystemActor>
    & Readonly<{ domain: 'WALLET_CORE' }>)
  | (Input<'PRICE_MAINTENANCE.ENTERED' | 'PRICE_MAINTENANCE.RECOVERED',
      'CHAIN' | 'CURRENCY', MaintenanceRunState, MaintenanceRunMetadata, SystemActor>
    & Readonly<{ domain: 'WALLET_CORE' }>);
interface WalletCoreReconciliationAuditInput extends Input<
  'RECONCILIATION.COMPLETED',
  'RECONCILIATION_RUN',
  Readonly<{ status?: 'SUCCESS' | 'PARTIAL' | 'FAILED'; partial?: boolean }>,
  Readonly<{ currencyCount: number; warningCount: number }>,
  SystemActor
> {
  readonly domain: 'WALLET_CORE';
}
type WalletCoreReconciliationWarningState =
  | Readonly<{ active?: boolean; partial: true; shortfallPercent?: string | null }>
  | Readonly<{ active: false; partial?: false; shortfallPercent?: string | null }>
  | Readonly<{ active?: boolean; partial?: false; shortfallPercent?: string }>;
interface WalletCoreReconciliationWarningAuditInput extends Input<
  'RECONCILIATION.WARNING_RAISED' | 'RECONCILIATION.WARNING_CLEARED',
  'CURRENCY',
  WalletCoreReconciliationWarningState,
  Readonly<{ reconciliationRunId: string }>,
  SystemActor
> {
  readonly domain: 'WALLET_CORE';
}
interface WalletCoreForfeitureAuditInput extends Input<
  'DELISTING.FORFEITURE_POSTED',
  'LEDGER_JOURNAL',
  Readonly<{ balance?: string }>,
  Readonly<{ currencyId: string; ownerType: 'USER' | 'MERCHANT'; ownerId: string; amount: string }>,
  SystemActor
> {
  readonly domain: 'WALLET_CORE';
}

type DepositSettingsAuditInput =
  | SettingsAuditInput<'DEPOSIT', 'SETTINGS.SAVED', null, 'DRAFT', AdminActor>
  | SettingsAuditInput<'DEPOSIT', 'SETTINGS.PUSHED', SettingsState<'DRAFT'>, 'LIVE', AdminActor>
  | SettingsAuditInput<'DEPOSIT', 'SETTINGS.SCHEDULED', SettingsState<'DRAFT'>, 'SCHEDULED', AdminActor>
  | SettingsAuditInput<'DEPOSIT', 'SETTINGS.SCHEDULE_APPLIED', SettingsState<'SCHEDULED'>, 'LIVE', SystemActor>
  | SettingsAuditInput<'DEPOSIT', 'SETTINGS.SCHEDULE_REJECTED', SettingsState<'SCHEDULED'>, 'REJECTED', SystemActor>;
interface DepositDecisionAuditInput extends Input<
  'DEPOSIT.RELEASED' | 'DEPOSIT.REJECTED' | 'DEPOSIT.CANCELLED' | 'DEPOSIT.MAINTENANCE_CANCELLED',
  'DEPOSIT',
  DepositState,
  Readonly<{
    currencyId: string;
    grossAmount: string;
    feeAmount?: string;
    ledgerJournalId?: string;
    priceResolutionId?: string;
    priceSnapshotId?: string;
    priceBasis?: 'WEBHOOK_TIME' | 'ADMIN_CREDIT_TIME';
  }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositReverificationAuditInput extends Input<
  'DEPOSIT.REVERIFICATION_HELD',
  'DEPOSIT',
  DepositState,
  Readonly<{ currencyId: string; grossAmount: string; ledgerJournalId: string; blockerId: string }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositClawbackAuditInput extends Input<
  'DEPOSIT.CLAWBACK_TO_ZERO_POSTED' | 'DEPOSIT.CLAWBACK_NEGATIVE_POSTED',
  'DEPOSIT',
  DepositState,
  Readonly<{
    currencyId: string;
    ledgerJournalId: string;
    clawbackAmount: string;
    shortfallAmount?: string;
  }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositAccountingReversalAuditInput extends Input<
  'DEPOSIT.ACCOUNTING_REVERSAL_POSTED',
  'DEPOSIT',
  DepositState,
  Readonly<{ currencyId: string; originalJournalId: string; reversalJournalId: string }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositStatusAuditInput extends Input<
  'DEPOSIT.STATUS_CHANGED',
  'DEPOSIT',
  DepositState,
  Readonly<{ currencyId: string; ledgerJournalId?: string }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositBlockerAuditInput extends Input<
  'BLOCKER.WAIVED',
  'DEPOSIT_BLOCKER',
  Readonly<{ status?: 'PENDING' | 'RESOLVED' | 'WAIVED' }>,
  Readonly<{ depositId: string; blockerKind: string }>,
  AdminActor
> {
  readonly domain: 'DEPOSIT';
}
interface DepositQuarantineAuditInput extends Input<
  'QUARANTINE.RETRIED' | 'QUARANTINE.ASSIGNED' | 'QUARANTINE.CREDIT_REQUESTED' | 'QUARANTINE.RETAINED',
  'QUARANTINE',
  Readonly<{
    status?: 'OPEN' | 'RETRY_PENDING' | 'ASSIGNED' | 'RETAINED' | 'SETTLED';
    assignedUserId?: string | null;
  }>,
  Readonly<{
    currencyId: string;
    grossAmount: string;
    depositId?: string;
    ledgerJournalId?: string;
    priceResolutionId?: string;
    priceSnapshotId?: string;
    priceBasis?: 'WEBHOOK_TIME' | 'ADMIN_CREDIT_TIME';
  }>
> {
  readonly domain: 'DEPOSIT';
}
interface DepositKillSwitchAuditInput extends Input<
  'KILL_SWITCH.ACTIVATED' | 'KILL_SWITCH.CLEARED',
  'FEATURE_STATE',
  Readonly<{ killed?: boolean }>,
  Readonly<{ configurationRevision: number }>,
  AdminActor
> {
  readonly domain: 'DEPOSIT';
}
type BulkJobState = Readonly<{
  status?: 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_WITH_FAILURES' | 'FAILED';
}>;
type BulkJobMetadata = Readonly<{
  actionKind:
    | 'RELEASE'
    | 'REJECT'
    | 'MAINTENANCE_RELEASE'
    | 'MAINTENANCE_CANCEL'
    | 'REVERIFICATION_HOLD'
    | 'CLAWBACK_TO_ZERO'
    | 'CLAWBACK_NEGATIVE'
    | 'WAIT_FOR_SETTLEMENT'
    | 'SCHEDULED_STATE_TRANSITION';
  totalItems: number;
  attemptedCount: number;
  succeededCount: number;
  failedCount: number;
  batchNumber?: number;
  safeErrorCode?: string;
}>;
type DepositBulkJobAuditInput =
  | (Input<'BULK_JOB.CREATED' | 'BULK_JOB.RESUMED', 'BULK_JOB', BulkJobState, BulkJobMetadata, AdminActor> &
      Readonly<{ domain: 'DEPOSIT' }>)
  | (Input<
      'BULK_JOB.STARTED' | 'BULK_JOB.PAUSED' | 'BULK_JOB.COMPLETED' | 'BULK_JOB.COMPLETED_WITH_FAILURES' | 'BULK_JOB.FAILED',
      'BULK_JOB',
      BulkJobState,
      BulkJobMetadata,
      SystemActor
    > &
      Readonly<{ domain: 'DEPOSIT' }>);
interface DepositBulkItemAuditInput extends Input<
  'BULK_JOB.ITEM_SUCCEEDED' | 'BULK_JOB.ITEM_FAILED',
  'BULK_JOB_ITEM',
  Readonly<{ status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' }>,
  Readonly<{
    bulkJobId: string;
    depositId: string;
    attempt: number;
    ledgerJournalId?: string;
    safeErrorCode?: string;
  }>,
  SystemActor
> {
  readonly domain: 'DEPOSIT';
}

export type WalletCoreAdminAuditInput =
  | WalletCoreScheduledBusinessAuditInput
  | WalletCoreSettingsAuditInput
  | WalletCoreLogoAuditInput
  | WalletCoreAdminTimezoneAuditInput
  | WalletCoreCatalogueAuditInput
  | WalletCoreChainAuditInput
  | WalletCoreCurrencyAuditInput
  | WalletCoreStatusAuditInput
  | WalletCoreProviderMaintenanceAuditInput
  | WalletCoreMaintenanceRunAuditInput
  | WalletCoreReconciliationAuditInput
  | WalletCoreReconciliationWarningAuditInput
  | WalletCoreForfeitureAuditInput;
export type DepositAdminAuditInput =
  | DepositSettingsAuditInput
  | DepositDecisionAuditInput
  | DepositReverificationAuditInput
  | DepositClawbackAuditInput
  | DepositAccountingReversalAuditInput
  | DepositStatusAuditInput
  | DepositBlockerAuditInput
  | DepositQuarantineAuditInput
  | DepositKillSwitchAuditInput
  | DepositBulkJobAuditInput
  | DepositBulkItemAuditInput;

export type PriceConversionAuditConfiguration = Readonly<{
  divergenceThresholdBps: number;
  visibleFiatCodes: readonly FiatCode[];
  providers: Readonly<Record<ProviderCode, Readonly<{ enabled: boolean; role: ProviderRole | null; viewEnabled: boolean; refreshIntervalSeconds: number }>>>;
}>;
type PriceAuditState<S extends SettingsStatus, C = PriceConversionAuditConfiguration> = SettingsState<S, C> & Readonly<{ config: C }>;
export type PriceConversionAdminAuditInput = Readonly<{
  domain: 'PRICE_CONVERSION';
  eventKey: string;
  subject: Readonly<{ type: 'SETTINGS_REVISION'; id: string }>;
  reason: string;
  metadata: Readonly<{ configurationRevision: number; configChangeId?: string; changelog?: string; safeErrorCode?: string }>;
}> & (
  | Readonly<{ action: 'SETTINGS.SAVED'; actor: AdminActor; before: PriceAuditState<'DRAFT' | 'LIVE'> | null; after: PriceAuditState<'DRAFT'> }>
  | Readonly<{ action: 'SETTINGS.PUSHED'; actor: AdminActor; before: PriceAuditState<'DRAFT' | 'LIVE'>; after: PriceAuditState<'LIVE'> }>
  | Readonly<{ action: 'SETTINGS.SCHEDULED'; actor: AdminActor; before: PriceAuditState<'DRAFT' | 'LIVE' | 'SCHEDULED'>; after: PriceAuditState<'SCHEDULED'> }>
  | Readonly<{ action: 'SETTINGS.SCHEDULE_APPLIED'; actor: SystemActor; before: PriceAuditState<'SCHEDULED'>; after: PriceAuditState<'LIVE'> }>
  | Readonly<{ action: 'SETTINGS.SCHEDULE_REJECTED'; actor: SystemActor; before: PriceAuditState<'SCHEDULED', PriceConversionAuditConfiguration | null>; after: PriceAuditState<'REJECTED', PriceConversionAuditConfiguration | null> }>
);

export interface AdminAuditTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

export interface AdminAuditAppendResult {
  readonly id: string;
  /** Signals a semantically identical retry; it never authorizes a second fresh business mutation. */
  readonly replayed: boolean;
}

export interface AdminAuditPort {
  /** Append on the mutation's open transaction; fresh-mutation callers must abort on replay. */
  appendWithTransaction(
    tx: AdminAuditTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput | PriceConversionAdminAuditInput,
  ): Promise<AdminAuditAppendResult>;
}

export interface AdminAuditHistoryQuery {
  readonly domain?: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION';
  readonly action?: string;
  readonly actorId?: string;
  readonly runId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AdminAuditHistoryItem {
  readonly id: string;
  readonly eventKey: string;
  readonly domain: 'WALLET_CORE' | 'DEPOSIT' | 'PRICE_CONVERSION';
  readonly action: string;
  readonly actor: AdminAuditActor;
  readonly subject: Readonly<{ type: string; id: string }>;
  readonly reason: string;
  readonly before: State | null;
  readonly after: State | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: string;
}

export interface AdminAuditHistoryPage {
  readonly items: readonly AdminAuditHistoryItem[];
  readonly nextCursor: string | null;
}
