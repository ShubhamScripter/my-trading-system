import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
/* eslint-disable @typescript-eslint/no-explicit-any -- invalid request fixtures intentionally cross the type boundary */
import type { AdminAuditActor } from '../../../admin-audits/index.js';
import type { AdminWalletBootstrap as BarrelAdminWalletBootstrap,
  WalletCorePatch as BarrelWalletCorePatch,
  WalletCoreService as BarrelWalletCoreService } from '../index.js';
import {
  walletAdminCurrencyPageQuerySchema,
  walletAdminHistoryPageQuerySchema,
  walletCoreHttpPatchSchema,
  walletCorePatchSchema,
  walletProviderCataloguePageQuerySchema,
} from '../wallet-core.dto.js';
import {
  DEFAULT_WALLET_SETTINGS,
  WALLET_DISTRIBUTION_STATUSES,
  WALLET_SCHEDULE_REJECTION_REASONS,
  type AdminReconciliationDistribution,
  type WalletAuditContext,
  type WalletCoreSystemAuditContext,
  type WalletDistributionBucket,
  type WalletUpdateResult,
} from '../wallet-core.types.js';

const ID = {
  chain: '01920000-0000-7000-8000-000000000001',
  currency: '01920000-0000-7000-8000-000000000002',
  binding: '01920000-0000-7000-8000-000000000003',
  target: '01920000-0000-7000-8000-000000000004',
  draft: '01920000-0000-7000-8000-000000000005',
} as const;

function settings(): Record<string, unknown> {
  return {
    globalDesiredState: 'ON', catalogueMode: 'ALL',
    reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
    reconciliationAlertPercent: '5.000', defaultCurrencyIds: [ID.currency],
  };
}

function lifecycle(action: 'PUSH' | 'SCHEDULE'): any {
  return {
    action, expectedRevision: 0, reason: 'Approved change', changelogId: ID.target,
    ...(action === 'SCHEDULE' ? { effectiveAt: '2099-09-05T10:00:00.000Z' } : {}),
    config: { settings: settings() },
  };
}

function completePatch(isEvm = true, includeIds = true): any {
  return {
    action: 'PUSH', expectedRevision: 4, reason: 'Add currency', changelogId: ID.target,
    config: {
      settings: settings(),
      chains: [{
        ...(includeIds ? { id: ID.chain } : {}),
        providerChainId: 1, blockchainReference: 'ethereum',
        name: 'Ethereum', shortName: 'ETH', isEvm,
        availableFor: 'BOTH', desiredState: 'ON',
      }],
      currencies: [{
        ...(includeIds ? { id: ID.currency } : {}),
        symbol: 'USDT', name: 'Tether',
        providerRefs: [
          { provider: 'COINGECKO', providerAssetId: 'tether', providerSymbol: 'USDT' },
          { provider: 'ALCHEMY', providerAssetId: 'ethereum:usdt', providerSymbol: 'USDT' },
          { provider: 'COINMARKETCAP', providerAssetId: '825', providerSymbol: 'USDT' },
        ],
        viewEnabled: false, geoCountryDeny: ['US'], geoContinentDeny: ['NA'], accessLevel: 'ALL',
        availableFor: 'BOTH', listingKind: 'PERMANENT', showBeforeListing: false,
        premiumOperations: [], soOperations: [], postDelistOperations: [], desiredState: 'ON',
        maintenanceAudiences: [], showBalanceInMaintenance: { USER: true, SO: true },
        bindings: [{
          ...(includeIds ? { id: ID.binding } : {}),
          chainId: ID.chain, providerCoinId: 10, blockchainReference: 'tether', isToken: true,
          tokenContractAddress: '0xAbCd', blockchainPrecision: 18, desiredState: 'ON',
          hotWalletAddresses: [' 0xHot '], coldWalletAddresses: ['0xCold'],
          stakingWalletAddresses: [],
        }],
      }],
    },
  };
}

function completeHttpPatch(): any {
  return {
    action: 'PUSH', expectedRevision: 4, reason: 'Add currency', changelogId: ID.target,
    config: {
      settings: settings(),
      chains: [{
        id: ID.chain, blockchainCatalogueChainId: 1,
        blockchainRequestReference: 'ethereum', name: 'Ethereum', shortName: 'ETH',
        isEvm: true, availableFor: 'BOTH', desiredState: 'ON',
      }],
      currencies: [{
        id: ID.currency, symbol: 'USDT', name: 'Tether',
        priceProviderReferences: [
          { provider: 'COINGECKO', providerAssetId: 'tether', providerSymbol: 'USDT' },
          { provider: 'ALCHEMY', providerAssetId: 'ethereum:usdt', providerSymbol: 'USDT' },
          { provider: 'COINMARKETCAP', providerAssetId: '825', providerSymbol: 'USDT' },
        ],
        viewEnabled: false, geoCountryDeny: ['US'], geoContinentDeny: ['NA'], accessLevel: 'ALL',
        availableFor: 'BOTH', listingKind: 'PERMANENT', showBeforeListing: false,
        premiumOperations: [], soOperations: [], postDelistOperations: [], desiredState: 'ON',
        maintenanceAudiences: [], showBalanceInMaintenance: { USER: true, SO: true },
        bindings: [{
          id: ID.binding, chainId: ID.chain, blockchainCatalogueCoinId: 10,
          blockchainRequestReference: 'tether', isToken: true,
          tokenContractAddress: '0xAbCd', blockchainPrecision: 18, desiredState: 'ON',
          hotWalletAddresses: [' 0xHot '], coldWalletAddresses: ['0xCold'],
          stakingWalletAddresses: [],
        }],
      }],
    },
  };
}

describe('Wallet Core strict Admin patch contract', () => {
  it('keeps barrel internal types assignable to the exported service contract', () => {
    const patchFits: BarrelWalletCorePatch extends
      Parameters<BarrelWalletCoreService['update']>[1] ? true : false = true;
    const bootstrapFits: Awaited<ReturnType<BarrelWalletCoreService['bootstrap']>> extends
      BarrelAdminWalletBootstrap ? true : false = true;
    assert.deepEqual([patchFits, bootstrapFits], [true, true]);
  });

  it('translates only the renamed HTTP reference fields into the unchanged internal patch', () => {
    const parsed = walletCoreHttpPatchSchema.parse(completeHttpPatch());
    assert.deepEqual(parsed, walletCorePatchSchema.parse(completePatch()));
    assert.equal(walletCoreHttpPatchSchema.safeParse(completePatch()).success, false);
  });

  it('reports invalid renamed reference values with only their current public paths', () => {
    const invalid = completeHttpPatch();
    invalid.config.chains[0].blockchainCatalogueChainId = 0;
    invalid.config.currencies[0].bindings[0].blockchainRequestReference = '';
    const result = walletCoreHttpPatchSchema.safeParse(invalid);
    assert.equal(result.success, false);
    if (result.success) return;
    const paths = result.error.issues.map(({ path }) => path.join('.'));
    assert.ok(paths.includes('config.chains.0.blockchainCatalogueChainId'));
    assert.ok(paths.includes('config.currencies.0.bindings.0.blockchainRequestReference'));
    assert.equal(paths.some((path) => /providerChainId|blockchainReference/.test(path)), false);
  });

  it('selects Admin and SYSTEM audit contexts from the canonical global actor union', () => {
    const adminActor = {
      kind: 'ADMIN', actorId: ID.currency, sessionId: ID.binding, requestId: ID.target,
      ipAddress: '127.0.0.1', deviceId: 'device-1',
    } satisfies Extract<AdminAuditActor, { readonly kind: 'ADMIN' }>;
    const systemActor = {
      kind: 'SYSTEM', runId: ID.draft,
    } satisfies Extract<AdminAuditActor, { readonly kind: 'SYSTEM' }>;
    const adminContext: WalletAuditContext = { actor: adminActor };
    const systemContext: WalletCoreSystemAuditContext = { actor: systemActor };

    assert.deepEqual(adminContext, { actor: adminActor });
    assert.deepEqual(systemContext, { actor: systemActor });
  });

  it('defines the exact closed JSON-safe Wallet update outcomes', () => {
    assert.deepEqual(WALLET_SCHEDULE_REJECTION_REASONS, [
      'STALE_SETTINGS_REVISION',
      'CONFIGURATION_INVALID',
      'CATALOGUE_REVISION_CHANGED',
      'CATALOGUE_REFERENCE_UNAVAILABLE',
    ]);
    const results = [
      {
        outcome: 'PUSHED', configurationId: ID.draft, revision: '2', status: 'LIVE',
        appliedAt: '2026-09-05T09:00:00.000000Z',
      },
      {
        outcome: 'SCHEDULED', configurationId: ID.draft, revision: '3', status: 'SCHEDULED',
        effectiveAt: '2026-09-06T09:00:00.000000Z',
      },
      {
        outcome: 'SCHEDULE_APPLIED', configurationId: ID.draft, revision: '4', status: 'LIVE',
        appliedAt: '2026-09-06T09:00:00.000000Z',
      },
      {
        outcome: 'SCHEDULE_REJECTED', configurationId: ID.draft, revision: '4', status: 'REJECTED',
        reasonCode: 'STALE_SETTINGS_REVISION',
      },
      {
        outcome: 'ALREADY_PROCESSED', configurationId: ID.draft, revision: '4', status: 'ARCHIVED',
      },
    ] as const satisfies readonly WalletUpdateResult[];
    assert.deepEqual(results.map(({ outcome, status }) => [outcome, status]), [
      ['PUSHED', 'LIVE'], ['SCHEDULED', 'SCHEDULED'],
      ['SCHEDULE_APPLIED', 'LIVE'], ['SCHEDULE_REJECTED', 'REJECTED'],
      ['ALREADY_PROCESSED', 'ARCHIVED'],
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(results)), results);
  });

  it('defines the exact Admin reconciliation distribution projection', () => {
    assert.deepEqual(WALLET_DISTRIBUTION_STATUSES, ['COMPLETE', 'PARTIAL', 'UNAVAILABLE']);
    const distribution = {
      currencies: [{
        currencyId: ID.currency,
        symbol: 'USDT',
        status: 'COMPLETE',
        price: {
          resolutionId: ID.chain,
          snapshotId: ID.binding,
          provider: 'COINGECKO',
          priceUsd: '1',
          observedAt: '2026-09-05T09:00:00.000000Z',
          resolutionReason: 'PRIMARY_HEALTHY',
          usedFallback: false,
        },
        blockchainWallets: {
          cryptoAmount: '10.12345678', usdValue: '10.12', percentage: '50.123', complete: true,
        },
        stakingWallets: {
          cryptoAmount: '5', usdValue: '5', percentage: '25', complete: true,
        },
        binance: {
          cryptoAmount: '4.87654321', usdValue: '4.87', percentage: '24.876', complete: true,
        },
        totalCrypto: '20',
        totalUsd: '20',
        percentageOfOverallUsd: '40',
      }],
      overall: {
        status: 'PARTIAL',
        valuationAt: '2026-09-05T09:00:00.000000Z',
        blockchainWallets: { usdValue: '25.12', percentage: '50.24' },
        stakingWallets: { usdValue: '12.5', percentage: '25' },
        binance: { usdValue: '12.37', percentage: '24.74' },
        totalUsd: '49.99',
      },
    } as const satisfies AdminReconciliationDistribution;
    assert.deepEqual(JSON.parse(JSON.stringify(distribution)), distribution);

    // @ts-expect-error distribution buckets expose one percentage, never duplicate native/USD keys
    const redundantPercentage = { cryptoAmount: '1', usdValue: '1', percentage: '100', complete: true, cryptoPercentage: '100' } satisfies WalletDistributionBucket;
    assert.equal(redundantPercentage.cryptoPercentage, '100');
  });

  it('rejects impossible Wallet update result literals at compile time', () => {
    // @ts-expect-error revisions are canonical positive decimals, never zero
    const zeroRevision = { outcome: 'PUSHED', configurationId: ID.draft, revision: '0', status: 'LIVE', appliedAt: '2026-09-05T09:00:00.000000Z' } satisfies WalletUpdateResult;
    // @ts-expect-error already-processed rows cannot still be scheduled
    const scheduledReplay = { outcome: 'ALREADY_PROCESSED', configurationId: ID.draft, revision: '1', status: 'SCHEDULED' } satisfies WalletUpdateResult;
    // @ts-expect-error schedule rejection reasons are a closed vocabulary
    const unknownReason = { outcome: 'SCHEDULE_REJECTED', configurationId: ID.draft, revision: '1', status: 'REJECTED', reasonCode: 'UNKNOWN' } satisfies WalletUpdateResult;
    // @ts-expect-error the result object has no extensible metadata bag
    const extraField = { outcome: 'PUSHED', configurationId: ID.draft, revision: '1', status: 'LIVE', appliedAt: '2026-09-05T09:00:00.000000Z', metadata: {} } satisfies WalletUpdateResult;
    assert.equal([zeroRevision, scheduledReplay, unknownReason, extraField].length, 4);
  });

  it('accepts only PUSH/SCHEDULE with required config and rejects the removed draft contract', () => {
    for (const action of ['PUSH', 'SCHEDULE'] as const) {
      assert.equal(walletCorePatchSchema.safeParse(lifecycle(action)).success, true, action);
    }
    assert.equal(walletCorePatchSchema.safeParse({
      action: 'SAVE_DRAFT', expectedRevision: 2, reason: 'Removed server draft',
      config: { settings: settings() },
    }).success, false);
    assert.equal(walletCorePatchSchema.safeParse({
      action: 'PUSH', expectedRevision: 2, reason: 'Removed stored draft',
      draftId: ID.draft, config: { settings: settings() },
    }).success, false);
    assert.equal(walletCorePatchSchema.safeParse({
      action: 'PUSH', expectedRevision: 2, reason: 'Config required',
    }).success, false);
    assert.equal(walletCorePatchSchema.safeParse({
      ...lifecycle('PUSH'), changelogId: null,
    }).success, false);
    assert.equal(walletCorePatchSchema.safeParse({
      ...lifecycle('PUSH'), effectiveAt: '2099-09-05T10:00:00.000Z',
    }).success, false);
    assert.equal(walletCorePatchSchema.safeParse({ ...lifecycle('SCHEDULE'), effectiveAt: undefined }).success, false);
  });

  it('defaults new installations to global ON and strictly normalizes approved thresholds', () => {
    assert.equal(DEFAULT_WALLET_SETTINGS.globalDesiredState, 'ON');
    const cases = [
      ['0', '0'], ['0.000', '0'], ['5', '5'], ['5.0', '5'], ['5.000', '5'],
      ['49.990', '49.99'], ['49.999', '49.999'], ['50', '50'], ['50.000', '50'],
    ] as const;
    for (const [input, expected] of cases) {
      const patch = lifecycle('PUSH');
      patch.config.settings.reconciliationAlertPercent = input;
      const result = walletCorePatchSchema.safeParse(patch);
      assert.equal(result.success, true, input);
      if (result.success) assert.equal(result.data.config?.settings?.reconciliationAlertPercent, expected);
    }
    for (const input of ['-0.001', '50.001', '5e0', 'five', '1.0000', '.5', '+5', ' 5 ']) {
      const patch = lifecycle('PUSH');
      patch.config.settings.reconciliationAlertPercent = input;
      assert.equal(walletCorePatchSchema.safeParse(patch).success, false, input);
    }
  });

  it('normalizes existing UUIDv7 ids and generates lowercase UUIDv7 ids once at parse time', () => {
    const existing = completePatch();
    existing.config.chains[0].id = ID.chain.toUpperCase();
    const parsedExisting = walletCorePatchSchema.parse(existing);
    assert.equal(parsedExisting.config?.chains?.[0]?.id, ID.chain);

    const generated = completePatch(true, false);
    const parsedGenerated = walletCorePatchSchema.parse(generated);
    for (const id of [
      parsedGenerated.config?.chains?.[0]?.id,
      parsedGenerated.config?.currencies?.[0]?.id,
      parsedGenerated.config?.currencies?.[0]?.bindings[0]?.id,
    ]) assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps identities uppercase and rejects duplicate chain/provider identities', () => {
    const lowercase = completePatch();
    lowercase.config.chains[0].shortName = 'eth';
    assert.equal(walletCorePatchSchema.safeParse(lowercase).success, false);
    const lowerSymbol = completePatch();
    lowerSymbol.config.currencies[0].symbol = 'usdt';
    assert.equal(walletCorePatchSchema.safeParse(lowerSymbol).success, false);

    const duplicateChain = completePatch();
    duplicateChain.config.chains.push({ ...duplicateChain.config.chains[0], id: undefined });
    assert.equal(walletCorePatchSchema.safeParse(duplicateChain).success, false);
    const duplicateCoin = completePatch();
    duplicateCoin.config.currencies[0].bindings.push({
      ...duplicateCoin.config.currencies[0].bindings[0], id: undefined,
    });
    assert.equal(walletCorePatchSchema.safeParse(duplicateCoin).success, false);
  });

  it('rejects zero as a blockchain provider chain identifier', () => {
    const zeroChain = completePatch();
    zeroChain.config.chains[0].providerChainId = 0;
    assert.equal(walletCorePatchSchema.safeParse(zeroChain).success, false);
  });

  it('rejects zero as a blockchain provider coin identifier', () => {
    const zeroCoin = completePatch();
    zeroCoin.config.currencies[0].bindings[0].providerCoinId = 0;
    assert.equal(walletCorePatchSchema.safeParse(zeroCoin).success, false);
  });

  it('requires exactly the three price references for an ON cryptocurrency', () => {
    const patch = completePatch();
    patch.config.currencies[0].providerRefs.pop();
    assert.equal(walletCorePatchSchema.safeParse(patch).success, false);
    const duplicate = completePatch();
    duplicate.config.currencies[0].providerRefs[2].provider = 'ALCHEMY';
    assert.equal(walletCorePatchSchema.safeParse(duplicate).success, false);
    assert.equal(walletCorePatchSchema.safeParse(completePatch()).success, true);
  });

  it('keeps display and provider identities separate and rejects removed legacy keys', () => {
    const patch = completePatch();
    const parsed = walletCorePatchSchema.parse(patch);
    assert.equal(parsed.config.chains?.[0]?.blockchainReference, 'ethereum');
    assert.equal(parsed.config.currencies?.[0]?.bindings[0]?.blockchainReference, 'tether');
    assert.deepEqual(parsed.config.currencies?.[0]?.providerRefs[0], {
      provider: 'COINGECKO', providerAssetId: 'tether', providerSymbol: 'USDT',
    });

    for (const mutate of [
      (value: any) => { value.config.currencies[0].kind = 'CRYPTO'; },
      (value: any) => { value.config.currencies[0].providerRefs[0].externalId = 'tether'; },
      (value: any) => { value.config.currencies[0].providerRefs[0].symbol = 'USDT'; },
    ]) {
      const legacy = completePatch();
      mutate(legacy);
      assert.equal(walletCorePatchSchema.safeParse(legacy).success, false);
    }
  });

  it('enforces native/token, precision, fee, operation, GEO, and listing/delist rules', () => {
    const native = completePatch();
    Object.assign(native.config.currencies[0].bindings[0], {
      isToken: false, tokenContractAddress: undefined, stakingWalletAddresses: ['native-stake'],
      blockchainPrecision: 0,
    });
    assert.equal(walletCorePatchSchema.safeParse(native).success, true);
    for (const precision of [-1, 19]) {
      const patch = completePatch();
      patch.config.currencies[0].bindings[0].blockchainPrecision = precision;
      assert.equal(walletCorePatchSchema.safeParse(patch).success, false);
    }
    const tokenStake = completePatch();
    tokenStake.config.currencies[0].bindings[0].stakingWalletAddresses = ['not-allowed'];
    assert.equal(walletCorePatchSchema.safeParse(tokenStake).success, false);

    const scheduled = completePatch();
    Object.assign(scheduled.config.currencies[0], {
      listingKind: 'TIME_LIMITED', listingStartsAt: '2026-09-05T00:00:00.000Z',
      delistAt: '2026-09-06T00:00:00.000Z', afterDelistMode: 'AUTO_EXCHANGE',
      autoExchangeToCurrencyId: ID.target, autoExchangeFeeBps: 10_000,
      premiumEarlyAccessAt: '2026-09-04T00:00:00.000Z', premiumOperations: ['DEPOSIT'],
      soEarlyAccessAt: '2026-09-04T12:00:00.000Z', soOperations: ['WITHDRAW'],
      postDelistOperations: ['WITHDRAW', 'EXCHANGE'], geoCountryDeny: ['IN'], geoContinentDeny: ['AS'],
    });
    assert.equal(walletCorePatchSchema.safeParse(scheduled).success, true);
    for (const changes of [
      { delistAt: undefined }, { autoExchangeFeeBps: 10_001 }, { geoCountryDeny: ['India'] },
      { geoContinentDeny: ['Asia'] }, { premiumOperations: ['DELETE'] },
      { listingStartsAt: '2026-09-07T00:00:00.000Z' },
    ]) {
      const invalid = completePatch();
      Object.assign(invalid.config.currencies[0], scheduled.config.currencies[0], changes);
      assert.equal(walletCorePatchSchema.safeParse(invalid).success, false);
    }
  });

  it('trims address projections, uses chain identity rules, and accepts the exact 10,000 boundary', () => {
    const parsed = walletCorePatchSchema.parse(completePatch());
    const binding = parsed.config?.currencies?.[0]?.bindings[0];
    assert.deepEqual(binding?.hotWalletAddresses, ['0xHot']);
    assert.deepEqual(binding?.coldWalletAddresses, ['0xCold']);
    assert.deepEqual(binding?.stakingWalletAddresses, []);

    const mixedDuplicate = completePatch();
    mixedDuplicate.config.currencies[0].bindings[0].hotWalletAddresses = ['0xAbC', '0xaBc'];
    assert.equal(walletCorePatchSchema.safeParse(mixedDuplicate).success, false);
    const overlap = completePatch();
    overlap.config.currencies[0].bindings[0].hotWalletAddresses = ['0xAbC'];
    overlap.config.currencies[0].bindings[0].coldWalletAddresses = ['0xaBc'];
    assert.equal(walletCorePatchSchema.safeParse(overlap).success, false);

    const nonEvm = completePatch(false);
    nonEvm.config.currencies[0].bindings[0].hotWalletAddresses = ['Case', 'case'];
    assert.equal(walletCorePatchSchema.safeParse(nonEvm).success, true);
    const permitted = completePatch();
    Object.assign(permitted.config.currencies[0].bindings[0], {
      isToken: false, tokenContractAddress: undefined,
      hotWalletAddresses: ['0xSame'], coldWalletAddresses: ['0xCold'],
      stakingWalletAddresses: ['0xsame', '0xcold'],
    });
    assert.equal(walletCorePatchSchema.safeParse(permitted).success, true);

    const boundary = completePatch();
    boundary.config.currencies[0].bindings[0].hotWalletAddresses = Array.from(
      { length: 10_000 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`,
    );
    assert.equal(walletCorePatchSchema.safeParse(boundary).success, true);
    boundary.config.currencies[0].bindings[0].hotWalletAddresses.push('0xoverflow');
    assert.equal(walletCorePatchSchema.safeParse(boundary).success, false);
  });

  it('rejects unknown keys at every request boundary', () => {
    assert.equal(walletCorePatchSchema.safeParse({ ...lifecycle('PUSH'), unexpected: true }).success, false);
    const nested = completePatch();
    Object.assign(nested.config.currencies[0].bindings[0], { unexpected: true });
    assert.equal(walletCorePatchSchema.safeParse(nested).success, false);
    for (const schema of [
      walletAdminCurrencyPageQuerySchema, walletProviderCataloguePageQuerySchema,
      walletAdminHistoryPageQuerySchema,
    ]) assert.equal(schema.safeParse({ limit: 10, unexpected: true }).success, false);
  });
});

describe('Wallet Core page bounds', () => {
  it('accepts limits from 1 through 100 and rejects values outside the range', () => {
    for (const schema of [
      walletAdminCurrencyPageQuerySchema, walletProviderCataloguePageQuerySchema,
      walletAdminHistoryPageQuerySchema,
    ]) {
      assert.equal(schema.parse({}).limit, 50);
      assert.equal(schema.safeParse({ limit: 1 }).success, true);
      assert.equal(schema.safeParse({ limit: '100' }).success, true);
      assert.equal(schema.safeParse({ limit: 0 }).success, false);
      assert.equal(schema.safeParse({ limit: 101 }).success, false);
    }
  });
});
