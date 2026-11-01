/** Public Wallet Core surface; internal persistence and worker details stay module-private. */
export { WalletCoreModule } from './wallet-core.module.js';
export { WalletCoreService, WALLET_CORE_AUTHORIZATION, WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT,
  WALLET_CORE_BOOTSTRAP_REPOSITORY, WALLET_CORE_CONFIGURATION_WRITER, WALLET_CORE_DATABASE,
  WALLET_CORE_HISTORY_REPOSITORY, WALLET_CORE_IDENTITY, WALLET_CORE_LOGO_PROCESSOR,
  WALLET_CORE_LOGO_STORAGE, WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY } from './wallet-core.service.js';
export type { WalletAdminPreferencePatch, WalletCoreIdentityPort, WalletLogoProcessor,
  WalletProviderCatalogueCoinsQuery, WalletProviderCatalogueQuery } from './wallet-core.service.js';
export type { ProviderCatalogueChain, ProviderCatalogueCoin, ProviderCatalogueFlatCoin,
  ProviderCataloguePage, ProviderCatalogueRefreshResult } from './provider-catalogue.repository.js';
export type { AdminWalletBootstrap, WalletAdminPermission, WalletAuditContext,
  WalletCorePatch, WalletHistoryPage } from './wallet-core.types.js';
export type {
  PublicAdminWalletBinding,
  PublicAdminWalletBootstrap,
  PublicAdminWalletChain,
  PublicAdminWalletCurrency,
  PublicChainUpsert,
  PublicCurrencyChainUpsert,
  PublicCurrencyUpsert,
  PublicProviderCatalogueChain,
  PublicProviderCatalogueCoin,
  PublicProviderCatalogueFlatCoin,
  PublicProviderCataloguePage,
  PublicWalletCorePatch,
  PublicWalletProviderCatalogueCoinsQuery,
  PublicWalletProviderCatalogueQuery,
} from './wallet-core.http-references.js';
export { WalletAdminBearerGuard, requireBoundAdminBearer } from './wallet-admin-bearer.guard.js';
