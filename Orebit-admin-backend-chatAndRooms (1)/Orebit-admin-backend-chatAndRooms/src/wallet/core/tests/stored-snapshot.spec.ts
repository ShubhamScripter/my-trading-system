import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStoredWalletSnapshot } from '../wallet-core.stored-snapshot.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import type { StoredConfigurationChange } from '../wallet-core.database.js';

const change = (kind: 'CRYPTO' | 'FIAT'): StoredConfigurationChange => ({
  id: '01980000-0000-7000-8000-000000000010', revision: 4, status: 'SCHEDULED',
  effectiveAt: '2099-09-10T00:00:00.000000Z', appliedAt: null,
  reason: 'legacy scheduled snapshot', changelogId: null,
  actorId: '01980000-0000-7000-8000-000000000011',
  snapshot: { config: {
    settings: { globalDesiredState: 'ON', catalogueMode: 'RELEVANT',
      reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
      reconciliationAlertPercent: '5' },
    chains: [{ id: '01980000-0000-7000-8000-000000000001', providerChainId: 42,
      name: 'Website Chain', shortName: 'WEB', isEvm: true,
      availableFor: 'BOTH', desiredState: 'OFF' }],
    currencies: [{ id: '01980000-0000-7000-8000-000000000002', symbol: 'OLD',
      name: 'Website Coin', kind, providerRefs: [{ provider: 'COINGECKO',
        externalId: 'old-coin', symbol: 'OLD' }], viewEnabled: false,
      geoCountryDeny: [], geoContinentDeny: [], accessLevel: 'ALL', availableFor: 'BOTH',
      listingKind: 'PERMANENT', showBeforeListing: false, premiumOperations: [],
      soOperations: [], postDelistOperations: [], desiredState: 'OFF',
      maintenanceAudiences: [], showBalanceInMaintenance: { USER: true, SO: true },
      bindings: [{ id: '01980000-0000-7000-8000-000000000003',
        chainId: '01980000-0000-7000-8000-000000000001', providerCoinId: 99,
        isToken: false, blockchainPrecision: 18, desiredState: 'OFF',
        hotWalletAddresses: [], coldWalletAddresses: [], stakingWalletAddresses: [] }] }],
  }, catalogue: { chains: [{ providerChainId: 42, name: 'Provider Chain',
    shortName: 'PROVIDER', isEvm: true, providerState: 'ACTIVATED', revision: 2 }],
  currencies: [{ providerChainId: 42, providerCoinId: 99, currencyName: 'Provider Coin',
    tokenAddress: null, isBaseCurrency: true, isStake: true, blockchainPrecision: 18,
    providerState: 'ACTIVATED', revision: 3 }] } },
});

describe('stored Wallet configuration compatibility', () => {
  it('maps only known legacy keys to frozen identities without changing historical input', () => {
    const legacy = change('CRYPTO');
    const original = JSON.parse(JSON.stringify(legacy.snapshot));
    const stored = readStoredWalletSnapshot(legacy);

    assert.deepEqual(stored.config.settings?.defaultCurrencyIds, []);
    assert.equal(stored.config.chains?.[0]?.blockchainReference, 'PROVIDER');
    assert.equal(stored.config.currencies?.[0]?.bindings[0]?.blockchainReference,
      'Provider Coin');
    assert.deepEqual(stored.config.currencies?.[0]?.providerRefs[0], {
      provider: 'COINGECKO', providerAssetId: 'old-coin', providerSymbol: 'OLD',
    });
    assert.equal('kind' in stored.config.currencies![0]!, false);
    assert.deepEqual(legacy.snapshot, original);
  });

  it('rejects a legacy FIAT holding instead of reclassifying it as CRYPTO', () => {
    assert.throws(() => readStoredWalletSnapshot(change('FIAT')),
      WalletConfigurationInvalid);
  });
});
