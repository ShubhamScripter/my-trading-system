import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

it('projects actionable runtime alert identities and rejects unknown payload fields', async () => {
  const { mapRuntimeAlert } = await import('../wallet-core.runtime-alert.js');
  const currencyId = randomUUID(); const observedAt = '2026-09-06T00:00:00.000Z';
  for (const [category,payload] of [
    ['PRICE_MAINTENANCE',{currencyId,observedAt,priceReadiness:'UNAVAILABLE'}],
    ['DELISTING_PENDING',{executionId:randomUUID(),observedAt,safeErrorCode:'PRICE_UNAVAILABLE'}],
    ['DELISTING_ACCOUNT_REVIEW',{executionId:randomUUID(),observedAt,accountId:randomUUID(),ownerId:randomUUID(),
      ownerType:'USER',bucket:'AVAILABLE',accountStatus:'CLOSED'}],
  ] as const) {
    const row = {id:randomUUID(),category,currency_id:currencyId,payload,
      opened_at:'2026-09-06T00:00:00.000000Z',updated_at:'2026-09-06T00:00:00.000000Z'};
    assert.deepEqual(mapRuntimeAlert(row)?.payload,payload);
    assert.throws(() => mapRuntimeAlert({...row,payload:{...payload,rawBody:'secret'}}));
    assert.throws(() => mapRuntimeAlert({...row,currency_id:null}));
  }
});
it('projects both provider maintenance subject kinds with closed safe evidence', async () => {
  const { mapRuntimeAlert } = await import('../wallet-core.runtime-alert.js');
  for (const subjectType of ['CHAIN','CURRENCY_CHAIN'] as const) {
    const payload = {subjectType,subjectId:randomUUID(),providerState:'MAINTENANCE',failureStreak:3,
      maintenancePinned:false,effectiveState:'MAINTAIN',observedAt:'2026-09-06T00:00:00.000Z',
      providerReference:subjectType==='CHAIN' ? 'CHAIN:9' : 'CURRENCY_CHAIN:9:10'};
    const row = {id:randomUUID(),category:'PROVIDER_MAINTENANCE',payload,
      currency_id:subjectType==='CHAIN' ? null : randomUUID(),
      opened_at:'2026-09-06T00:00:00.000000Z',updated_at:'2026-09-06T00:00:00.000000Z'};
    assert.deepEqual(mapRuntimeAlert(row)?.payload,payload);
    for (const invalid of [{...payload,rawBody:'secret'}, {...payload,failureStreak:4},
      {...payload,providerReference:'CHAIN:0'}, {...payload,maintenancePinned:'false'}]) {
      assert.throws(() => mapRuntimeAlert({...row,payload:invalid}));
    }
  }
});
import {
  WALLET_CATALOGUE_REFRESH_ERROR_CODES,
  WALLET_RECONCILIATION_SAFE_ERROR_CODES,
  type AdminBootstrapQuery,
  type AdminBootstrapViewerInput,
  type AdminReconciliationItemSummary,
  type AdminReconciliationRunSummary,
  type AdminReconciliationSnapshot,
  type AdminWalletAlert,
  type AdminWalletBinding,
  type AdminWalletBootstrap,
  type AdminWalletChain,
  type AdminWalletCurrency,
  type ConfigurationSummary,
  type ReconciliationComponentEvidence,
  type ReconciliationEvidenceSummary,
  type WalletAlertSafePayload,
  type WalletHistoryItem,
  type WalletHistoryPage,
  type WalletHistoryQuery,
  type WalletLogoUrlResolver,
  type WalletPriceProvenanceView,
  type WalletProviderHealthView,
  type WalletSettingsView,
} from '../wallet-core.types.js';

const ID = {
  run: '01970000-0000-7000-8000-000000000001',
  item: '01970000-0000-7000-8000-000000000002',
  component: '01970000-0000-7000-8000-000000000003',
  currency: '01970000-0000-7000-8000-000000000004',
} as const;

describe('Wallet Admin safe alert contracts', () => {
  it('freezes the exact provider and catalogue failure vocabularies', () => {
    assert.deepEqual(WALLET_RECONCILIATION_SAFE_ERROR_CODES, [
      'ENCRYPTION_FAILED', 'AUTHENTICATION_FAILED', 'UNAUTHORIZED_IP',
      'PROVIDER_MAINTENANCE', 'PROVIDER_DISABLED', 'PROVIDER_NOT_FOUND',
      'PROVIDER_REJECTED', 'TIMEOUT', 'TRANSPORT_ERROR', 'RESPONSE_TOO_LARGE',
      'INVALID_RESPONSE', 'INVALID_DECIMAL',
    ]);
    assert.deepEqual(WALLET_CATALOGUE_REFRESH_ERROR_CODES, [
      'PROVIDER_REJECTED', 'TIMEOUT', 'TRANSPORT_ERROR', 'RESPONSE_TOO_LARGE',
      'INVALID_RESPONSE', 'CATALOGUE_LIMIT_EXCEEDED', 'PAGINATION_INCONSISTENT',
      'DUPLICATE_PROVIDER_ID', 'WRONG_CHAIN_ASSOCIATION', 'DATABASE_ERROR', 'AUDIT_ERROR',
    ]);
  });

  it('defines four closed, readonly, JSON-safe alert payload variants', () => {
    const alerts = [
      {
        category: 'SHORTFALL', runId: ID.run, itemId: ID.item, currencyId: ID.currency,
        custodyBalance: '95.000000000000000000', requiredBacking: '100.000000000000000000',
        shortfallPercent: '5', thresholdPercent: '4.999',
      },
      {
        category: 'PARTIAL_DATA', runId: ID.run, itemId: ID.item, currencyId: ID.currency,
        partialReasons: ['TIMEOUT', 'PRICE_UNAVAILABLE'], shortfallSuppressed: true,
      },
      {
        category: 'STAKING_TOTAL_MISMATCH', runId: ID.run, itemId: ID.item,
        componentId: ID.component, currencyId: ID.currency,
        reportedTotal: '8.000000000000000000', componentSum: '7.000000000000000000',
        selectedSource: 'COMPONENT_SUM',
      },
      {
        category: 'CATALOGUE_REFRESH_FAILED', safeErrorCode: 'PAGINATION_INCONSISTENT',
        failedAt: '2026-09-05T09:00:00.000000Z',
      },
    ] as const satisfies readonly WalletAlertSafePayload[];
    assert.deepEqual(JSON.parse(JSON.stringify(alerts)), alerts);
  });

  it('rejects unknown reasons and raw provider material at compile time', () => {
    // @ts-expect-error PARTIAL_DATA accepts only closed safe reasons
    const unknownReason = { category: 'PARTIAL_DATA', runId: ID.run, itemId: ID.item, currencyId: ID.currency, partialReasons: ['RAW_PROVIDER_ERROR'], shortfallSuppressed: true } satisfies WalletAlertSafePayload;
    // @ts-expect-error alert payloads have no raw provider body field
    const rawPayload = { category: 'CATALOGUE_REFRESH_FAILED', safeErrorCode: 'TIMEOUT', failedAt: '2026-09-05T09:00:00.000000Z', providerBody: 'secret' } satisfies WalletAlertSafePayload;
    assert.equal([unknownReason, rawPayload].length, 2);
  });
});

describe('Wallet Admin bootstrap and history contracts', () => {
  const settings = {
    globalDesiredState: 'ON', catalogueMode: 'ALL',
    reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
    reconciliationAlertPercent: '5', reconciliationAlertBasis: 'SIGNED',
    defaultCurrencyIds: [ID.currency],
    updatedAt: '2026-09-05T09:00:00.000000Z',
  } as const satisfies WalletSettingsView;
  const configuration = {
    id: ID.run, revision: '1', status: 'LIVE', reason: 'approved', changelogId: ID.component,
    actorId: ID.item, effectiveAt: null, appliedAt: '2026-09-05T09:00:00.000000Z',
    createdAt: '2026-09-05T08:00:00.000000Z',
  } as const satisfies ConfigurationSummary;
  const provider = {
    state: 'ACTIVATED', consecutiveFailedChecks: 0, lastSuccessAt: '2026-09-05T09:00:00.000000Z',
    lastErrorAt: null, updatedAt: '2026-09-05T09:00:00.000000Z',
  } as const satisfies WalletProviderHealthView;
  const chain = {
    id: ID.run, providerChainId: '1', blockchainReference: 'ethereum',
    shortName: 'ETH', name: 'Ethereum', isEvm: true,
    logo: { objectKey: 'wallet/eth.webp', url: 'https://orebit.com/assets/wallet/eth.webp' },
    availableFor: 'BOTH', desiredState: 'ON', effectiveState: 'ON',
    maintenancePinned: false, provider,
  } as const satisfies AdminWalletChain;
  const binding = {
    id: ID.component, chainId: ID.run, chainShortName: 'ETH', providerCoinId: '2',
    blockchainReference: 'tether',
    isToken: true, tokenContractAddress: '0xabc', blockchainPrecision: 18,
    desiredState: 'ON', effectiveState: 'ON', maintenancePinned: false, provider,
    hotWalletAddresses: ['0xhot'], coldWalletAddresses: ['0xcold'], stakingWalletAddresses: [],
  } as const satisfies AdminWalletBinding;
  const currency = {
    id: ID.currency, symbol: 'USDT', name: 'Tether', decimals: 18,
    pricingStatus: 'ACTIVE', pricingAutoDisabled: false,
    providerReferences: [{ provider: 'COINGECKO', providerAssetId: 'tether',
      providerSymbol: 'USDT' }],
    binanceReference: 'USDT', logo: null, viewEnabled: false,
    geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH',
    listingKind: 'PERMANENT', listingStartsAt: null, showBeforeListing: false,
    premiumEarlyAccessAt: null, premiumOperations: [], soEarlyAccessAt: null, soOperations: [],
    delistAt: null, afterDelistMode: null, autoExchangeToCurrencyId: null,
    autoExchangeFeeBps: null, leaveDays: null, afterLeaveMode: null,
    afterLeaveAutoExchangeToCurrencyId: null, afterLeaveAutoExchangeFeeBps: null,
    postDelistOperations: [], desiredState: 'ON', effectiveState: 'ON', maintenanceAudiences: [],
    showBalanceInMaintenance: { USER: true, SO: true },
    price: { readiness: 'HEALTHY', changedAt: '2026-09-05T09:00:00.000000Z' }, bindings: [binding],
  } as const satisfies AdminWalletCurrency;
  const alert = {
    id: ID.item, category: 'SHORTFALL', status: 'ACTIVE', currencyId: ID.currency,
    payload: {
      runId: ID.run, itemId: ID.item, currencyId: ID.currency, custodyBalance: '95',
      requiredBacking: '100', shortfallPercent: '5', thresholdPercent: '4.999',
    },
    openedAt: '2026-09-05T09:00:00.000000Z', updatedAt: '2026-09-05T09:00:00.000000Z',
  } as const satisfies AdminWalletAlert;
  const run = {
    id: ID.run, status: 'PARTIAL', scheduledFor: '2026-09-05T03:30:00.000000Z',
    valuationAt: '2026-09-05T03:31:00.000000Z', completedAt: '2026-09-05T03:32:00.000000Z',
    appliedConfigurationRevision: '1', appliedAlertPercent: '5', appliedAlertBasis: null,
    comparisonRule: 'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD',
    currencyCount: 1, warningCount: 1, safeErrorCode: null,
  } as const satisfies AdminReconciliationRunSummary;
  const evidenceSummary = {
    componentCounts: {
      HOT: { total: 1, succeeded: 1, failed: 0 }, COLD: { total: 1, succeeded: 1, failed: 0 },
      STAKING: { total: 1, succeeded: 0, failed: 1 }, BINANCE: { total: 0, succeeded: 0, failed: 0 },
    }, anomalousComponentCount: 1,
  } as const satisfies ReconciliationEvidenceSummary;
  const component = {
    id: ID.component, kind: 'STAKING', currencyChainId: ID.component,
    custodyAddressId: ID.item, walletAddress: 'stake-address', binanceReference: null,
    attemptsUsed: 3, acceptedRawDecimal: null, selectedBalance: null, safeErrorCode: 'TIMEOUT',
    totalAdminStakeBalance: null, totalAdminManualStakeBalance: null, totalBalance: null,
    stakeSelectedSource: null, stakeTotalMismatch: false,
  } as const satisfies ReconciliationComponentEvidence;
  const price = {
    resolutionId: ID.run, snapshotId: ID.item, provider: 'COINGECKO', priceUsd: '100',
    observedAt: '2026-09-05T09:00:00.000000Z', resolutionReason: 'PRIMARY_CONFIRMED',
    usedFallback: false,
  } as const satisfies WalletPriceProvenanceView;
  const logoResolver = {
    publicUrl: (objectKey: string) => `https://assets.test.invalid/${objectKey}`,
  } satisfies WalletLogoUrlResolver;
  const viewerInput = {
    adminId: ID.item,
  } as const satisfies AdminBootstrapViewerInput;
  const item = {
    id: ID.item, currencyId: ID.currency, status: 'PARTIAL', hotColdBalance: '10',
    stakingBalance: '0', binanceBalance: '0', totalCustodyBalance: '10', requiredBacking: '10',
    userMerchantBalance: '10', treasuryBalance: '0', collectionBalance: '0',
    ledgerSignedTotal: null, ledgerSignedTotalUsd: null, ledgerPositiveTotal: null,
    ledgerPositiveTotalUsd: null, alertBasis: null,
    partialReasons: ['TIMEOUT'], shortfallSuppressed: true, shortfallPercent: null,
    evidenceSummary, anomalousComponents: [component],
  } as const satisfies AdminReconciliationItemSummary;

  it('defines the exact normal bootstrap without raw evidence or visibility flags', () => {
    const reconciliation = {
      run,
      distribution: {
        currencies: [], overall: {
          status: 'UNAVAILABLE', valuationAt: '2026-09-05T03:31:00.000000Z',
          blockchainWallets: { usdValue: null, percentage: null },
          stakingWallets: { usdValue: null, percentage: null },
          binance: { usdValue: null, percentage: null }, totalUsd: null,
        },
      },
      items: [item],
    } as const satisfies AdminReconciliationSnapshot;
    const bootstrap = {
      currentRevision: '1', settings,
      configuration: { live: configuration,
        scheduled: { items: [], total: 0, nextCursor: null } },
      chains: [chain], currencies: { items: [currency], nextCursor: null },
      activeAlerts: { items: [alert], total: 1, nextCursor: null },
      lastReconciliation: reconciliation,
      viewer: { displayTimezone: 'Asia/Kolkata' },
    } as const satisfies AdminWalletBootstrap;
    const query = { cursor: undefined, limit: 50 } satisfies AdminBootstrapQuery;
    assert.deepEqual(JSON.parse(JSON.stringify(bootstrap)), bootstrap);
    assert.equal(query.limit, 50);
    assert.equal(logoResolver.publicUrl('wallet/btc.webp'),
      'https://assets.test.invalid/wallet/btc.webp');
    assert.deepEqual(viewerInput, { adminId: ID.item });
    assert.equal(price.provider, 'COINGECKO');

    // @ts-expect-error provenance exposes canonical provider code, not an internal provider UUID
    const providerIdLeak = { ...price, providerId: ID.item } satisfies WalletPriceProvenanceView;
    assert.equal(providerIdLeak.providerId, ID.item);

    // @ts-expect-error no global or per-user catalogue/portfolio visibility field exists
    const visibilityLeak = { ...currency, catalogueVisible: true } satisfies AdminWalletCurrency;
    assert.equal(visibilityLeak.catalogueVisible, true);
  });

  it('defines the exact seven-category bounded history union', () => {
    const base = { id: ID.run, createdAt: '2026-09-05T09:00:00.000000Z', actor: null } as const;
    const providerPin = { ...base, category: 'PROVIDER', eventType: 'PROVIDER_MAINTENANCE.PINNED',
      subject: { type: 'CHAIN', id: ID.run }, fromState: null, toState: null,
      beforeMaintenancePinned: false, afterMaintenancePinned: true,
    } as const satisfies WalletHistoryItem;
    const items = [
      { ...base, category: 'CONFIGURATION', configuration },
      { ...base, category: 'STATE', eventType: 'CURRENCY.STATUS_CHANGED', subject: { type: 'CURRENCY', id: ID.currency }, fromState: 'OFF', toState: 'ON', reasonCode: null },
      { ...base, category: 'PROVIDER', eventType: 'PROVIDER_MAINTENANCE.RECOVERED', subject: { type: 'CHAIN', id: ID.run }, fromState: 'UNAVAILABLE', toState: 'ACTIVATED', beforeMaintenancePinned: null, afterMaintenancePinned: null },
      { ...base, category: 'ALERT', alertId: ID.item, alertCategory: 'SHORTFALL', status: 'ACTIVE', currencyId: ID.currency },
      { ...base, category: 'RECONCILIATION', runId: ID.run, status: 'PARTIAL', scheduledFor: run.scheduledFor, completedAt: run.completedAt, currencyCount: 1, warningCount: 1, safeErrorCode: null },
      { ...base, category: 'FORFEITURE', executionId: ID.item, currencyId: ID.currency, policyRevision: '1', status: 'COMPLETED', deadline: '2026-09-05T09:00:00.000000Z', processedCount: 1, skippedCount: 0, failedCount: 0, safeErrorCode: null },
      { ...base, category: 'JOB', jobName: 'wallet-reconciliation', scheduledFor: run.scheduledFor, status: 'SUCCESS', attemptCount: 1, processedCount: 1, failedCount: 0, safeErrorCode: null, leaseExpiresAt: null, finishedAt: run.completedAt },
    ] as const satisfies readonly WalletHistoryItem[];
    const query = { limit: 100 } satisfies WalletHistoryQuery;
    const page = { items, nextCursor: null } satisfies WalletHistoryPage;
    assert.deepEqual(page.items.map((entry) => entry.category), [
      'CONFIGURATION', 'STATE', 'PROVIDER', 'ALERT', 'RECONCILIATION', 'FORFEITURE', 'JOB',
    ]);
    assert.equal(query.limit, 100);
    assert.equal(providerPin.afterMaintenancePinned, true);

    // @ts-expect-error pin events cannot carry provider-state transitions
    const invalidPin = { ...providerPin, toState: 'ACTIVATED' } satisfies WalletHistoryItem;
    // @ts-expect-error provider-state transitions cannot carry pin transitions
    const invalidProviderState = { ...items[2], beforeMaintenancePinned: false } satisfies WalletHistoryItem;
    // @ts-expect-error create/import/update are represented by CONFIGURATION summaries
    const invalidStateAction = { ...items[1], eventType: 'CHAIN.IMPORTED' } satisfies WalletHistoryItem;
    assert.equal([invalidPin, invalidProviderState, invalidStateAction].length, 3);
  });
});
