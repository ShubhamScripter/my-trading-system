import type { ProviderCatalogueChain, ProviderCatalogueCoin, ProviderCatalogueFlatCoin,
  ProviderCataloguePage } from './provider-catalogue.repository.js';
import type { AdminWalletBinding, AdminWalletBootstrap, AdminWalletChain,
  AdminWalletCurrency, ChainUpsert, CurrencyChainUpsert, CurrencyUpsert,
  WalletCorePatch as InternalWalletCorePatch } from './wallet-core.types.js';

export type PublicAdminWalletChain = Omit<AdminWalletChain,
  'providerChainId' | 'blockchainReference'> & Readonly<{
    blockchainCatalogueChainId: string; blockchainRequestReference: string;
  }>;
export type PublicAdminWalletBinding = Omit<AdminWalletBinding,
  'providerCoinId' | 'blockchainReference'> & Readonly<{
    blockchainCatalogueCoinId: string; blockchainRequestReference: string;
  }>;
export type PublicAdminWalletCurrency = Omit<AdminWalletCurrency,
  'providerReferences' | 'bindings'> & Readonly<{
    priceProviderReferences: AdminWalletCurrency['providerReferences'];
    bindings: readonly PublicAdminWalletBinding[];
  }>;
export type PublicAdminWalletBootstrap = Omit<AdminWalletBootstrap, 'chains' | 'currencies'>
  & Readonly<{ chains: readonly PublicAdminWalletChain[]; currencies: Readonly<{
    items: readonly PublicAdminWalletCurrency[]; nextCursor: string | null;
  }> }>;
export type PublicProviderCatalogueChain = Omit<ProviderCatalogueChain, 'providerChainId'>
  & Readonly<{ blockchainCatalogueChainId: string }>;
export type PublicProviderCatalogueCoin = Omit<ProviderCatalogueCoin,
  'providerChainId' | 'providerCoinId'> & Readonly<{
    blockchainCatalogueChainId: string; blockchainCatalogueCoinId: string;
  }>;
export type PublicProviderCatalogueFlatCoin = Omit<ProviderCatalogueFlatCoin,
  'providerCoinId' | 'chain'> & Readonly<{ blockchainCatalogueCoinId: string; chain:
    Omit<ProviderCatalogueFlatCoin['chain'], 'providerChainId'>
      & Readonly<{ blockchainCatalogueChainId: string }> }>;
export type PublicProviderCataloguePage<T> = Omit<ProviderCataloguePage<never>, 'items'>
  & Readonly<{ items: readonly T[] }>;

export type PublicChainUpsert = Omit<ChainUpsert, 'providerChainId' | 'blockchainReference'>
  & Readonly<{ blockchainCatalogueChainId: number; blockchainRequestReference: string }>;
export type PublicCurrencyChainUpsert = Omit<CurrencyChainUpsert,
  'providerCoinId' | 'blockchainReference'> & Readonly<{
    blockchainCatalogueCoinId: number; blockchainRequestReference: string;
  }>;
export type PublicCurrencyUpsert = Omit<CurrencyUpsert, 'providerRefs' | 'bindings'>
  & Readonly<{ priceProviderReferences: CurrencyUpsert['providerRefs'];
    bindings: readonly PublicCurrencyChainUpsert[] }>;
export type PublicWalletCorePatch = Omit<InternalWalletCorePatch, 'config'> & Readonly<{
  config: Omit<InternalWalletCorePatch['config'], 'chains' | 'currencies'> & Readonly<{
    chains?: readonly PublicChainUpsert[]; currencies?: readonly PublicCurrencyUpsert[];
  }>;
}>;
type PublicProviderCatalogueCommonQuery = Readonly<{
  search?: string; providerState?: 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE' | 'UNAVAILABLE';
  isBaseCurrency?: boolean; isStake?: boolean; sortDirection?: 'asc' | 'desc'; cursor?: string;
  limit?: number;
}>;
export type PublicWalletProviderCatalogueQuery = PublicProviderCatalogueCommonQuery & Readonly<{
  blockchainCatalogueChainId?: string; sortBy?: 'blockchainCatalogueChainId'
    | 'blockchainCatalogueCoinId' | 'name' | 'shortName' | 'currencyName';
}>;
export type PublicWalletProviderCatalogueCoinsQuery = PublicProviderCatalogueCommonQuery
  & Readonly<{ blockchainCatalogueChainId?: string;
    sortBy?: 'blockchainCatalogueCoinId' | 'currencyName' }>;

// HTTP names intentionally differ from persisted/provider contracts; each mapper preserves all other values.

const publicChain = ({ providerChainId, blockchainReference, ...chain }: AdminWalletChain) => ({
  ...chain, blockchainCatalogueChainId: providerChainId,
  blockchainRequestReference: blockchainReference,
});
const publicBinding = ({ providerCoinId, blockchainReference, ...binding }: AdminWalletBinding) => ({
  ...binding, blockchainCatalogueCoinId: providerCoinId,
  blockchainRequestReference: blockchainReference,
});
const publicCurrency = ({ providerReferences, bindings, ...currency }: AdminWalletCurrency) => ({
  ...currency, priceProviderReferences: providerReferences,
  bindings: bindings.map(publicBinding),
});

export const toPublicWalletBootstrap = (value: AdminWalletBootstrap): PublicAdminWalletBootstrap => ({
  ...value, chains: value.chains.map(publicChain), currencies: {
    ...value.currencies, items: value.currencies.items.map(publicCurrency),
  },
});
export const toPublicWalletChainPage = (value: Readonly<{
  items: readonly AdminWalletChain[]; nextCursor: string | null;
}>): Readonly<{ items: readonly PublicAdminWalletChain[]; nextCursor: string | null }> =>
  ({ ...value, items: value.items.map(publicChain) });

type CatalogueItem = ProviderCatalogueChain | ProviderCatalogueCoin | ProviderCatalogueFlatCoin;
const publicCatalogueItem = (item: CatalogueItem) => {
  if ('chain' in item) {
    const { providerCoinId, chain, ...coin } = item;
    const { providerChainId, ...chainValues } = chain;
    return { ...coin, blockchainCatalogueCoinId: providerCoinId, chain: {
      ...chainValues, blockchainCatalogueChainId: providerChainId,
    } };
  }
  if ('providerCoinId' in item) {
    const { providerChainId, providerCoinId, ...coin } = item;
    return { ...coin, blockchainCatalogueChainId: providerChainId,
      blockchainCatalogueCoinId: providerCoinId };
  }
  const { providerChainId, ...chain } = item;
  return { ...chain, blockchainCatalogueChainId: providerChainId };
};

export const toPublicProviderCataloguePage = (value: ProviderCataloguePage<CatalogueItem>):
  PublicProviderCataloguePage<PublicProviderCatalogueChain | PublicProviderCatalogueCoin
    | PublicProviderCatalogueFlatCoin> => ({
  ...value, items: value.items.map(publicCatalogueItem),
});
