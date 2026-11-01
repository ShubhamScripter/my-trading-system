import { walletCorePatchSchema } from './wallet-core.dto.js';
import type { CatalogueEvidence, StoredConfigurationChange } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import type { WalletCoreConfigurationPatch } from './wallet-core.types.js';

export type StoredWalletSnapshot = Readonly<{
  config: WalletCoreConfigurationPatch;
  catalogue: CatalogueEvidence;
}>;

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord : null;

function validCatalogue(value: unknown): value is CatalogueEvidence {
  const catalogue = record(value);
  if (!catalogue || !Array.isArray(catalogue.chains) || !Array.isArray(catalogue.currencies)) {
    return false;
  }
  return catalogue.chains.every((raw) => {
    const entry = record(raw);
    return entry && Number.isSafeInteger(entry.providerChainId)
      && Number.isSafeInteger(entry.revision) && typeof entry.name === 'string'
      && typeof entry.shortName === 'string' && typeof entry.isEvm === 'boolean'
      && typeof entry.providerState === 'string';
  }) && catalogue.currencies.every((raw) => {
    const entry = record(raw);
    return entry && Number.isSafeInteger(entry.providerChainId)
      && Number.isSafeInteger(entry.providerCoinId) && Number.isSafeInteger(entry.revision)
      && Number.isSafeInteger(entry.blockchainPrecision) && typeof entry.currencyName === 'string'
      && (entry.tokenAddress === null || typeof entry.tokenAddress === 'string')
      && typeof entry.isBaseCurrency === 'boolean' && typeof entry.isStake === 'boolean'
      && typeof entry.providerState === 'string';
  });
}

/** Maps only known pre-WP11 snapshot keys; the immutable stored payload is never rewritten. */
function compatibleConfig(value: unknown, catalogue: CatalogueEvidence): unknown {
  const config = record(value);
  if (!config) return value;
  let evidenceOffset = 0;
  const settings = record(config.settings);
  const chains = Array.isArray(config.chains) ? config.chains.map((raw) => {
    const chain = record(raw);
    if (!chain || chain.blockchainReference !== undefined) return raw;
    const evidence = catalogue.chains.find((entry) =>
      entry.providerChainId === chain.providerChainId);
    return evidence ? { ...chain, blockchainReference: evidence.shortName } : raw;
  }) : config.chains;
  const currencies = Array.isArray(config.currencies) ? config.currencies.map((raw) => {
    const currency = record(raw);
    if (!currency) return raw;
    if (currency.kind !== undefined && currency.kind !== 'CRYPTO') {
      throw new WalletConfigurationInvalid(
        'Stored FIAT holding configuration cannot be reclassified as CRYPTO.',
      );
    }
    const { kind: _legacyKind, ...current } = currency;
    const providerRefs = Array.isArray(currency.providerRefs)
      ? currency.providerRefs.map((rawReference) => {
        const reference = record(rawReference);
        if (!reference || reference.providerAssetId !== undefined
          || reference.providerSymbol !== undefined) return rawReference;
        const { externalId, symbol, ...rest } = reference;
        return { ...rest, providerAssetId: externalId, providerSymbol: symbol };
      }) : currency.providerRefs;
    const bindings = Array.isArray(currency.bindings) ? currency.bindings.map((rawBinding) => {
      const binding = record(rawBinding);
      const evidence = catalogue.currencies[evidenceOffset++];
      if (!binding || binding.blockchainReference !== undefined) return rawBinding;
      return evidence ? { ...binding, blockchainReference: evidence.currencyName } : rawBinding;
    }) : currency.bindings;
    return { ...current, providerRefs, bindings };
  }) : config.currencies;
  return {
    ...config,
    ...(settings ? { settings: { ...settings,
      defaultCurrencyIds: settings.defaultCurrencyIds ?? [] } } : {}),
    ...(chains === undefined ? {} : { chains }),
    ...(currencies === undefined ? {} : { currencies }),
  };
}

export function readStoredWalletSnapshot(
  change: StoredConfigurationChange,
): StoredWalletSnapshot {
  const snapshot = record(change.snapshot);
  const catalogue = snapshot?.catalogue;
  if (!validCatalogue(catalogue)) {
    throw new WalletConfigurationInvalid('Stored configuration does not pass validation.');
  }
  const parsed = walletCorePatchSchema.safeParse({ action: 'PUSH',
    expectedRevision: change.revision, reason: change.reason,
    changelogId: change.changelogId ?? undefined,
    config: compatibleConfig(snapshot?.config, catalogue) });
  if (!parsed.success || parsed.data.config === undefined) {
    throw new WalletConfigurationInvalid('Stored configuration does not pass validation.');
  }
  return { config: parsed.data.config, catalogue };
}
