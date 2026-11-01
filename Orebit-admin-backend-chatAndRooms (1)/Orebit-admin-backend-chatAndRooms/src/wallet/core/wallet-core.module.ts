import multipart from '@fastify/multipart';
import type {} from '../../../node_modules/@fastify/cookie/types/index.js';
import { Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AdminDbOperation } from '../../../auth/auth.dboperation.js';
import { AuthModule } from '../../../auth/auth.module.js';
import { AdminAuditWriterModule } from '../../admin-audits/admin-audit.writer.module.js';
import { ADMIN_AUDIT_PORT } from '../../admin-audits/admin-audit.writer.service.js';
import type { AdminAuditPort } from '../../admin-audits/admin-audit.types.js';
import { uuidv7 } from '../../utils/public.utils.js';
import { BlockchainAdminCatalogueClient } from './blockchain-admin.client.js';
import { LocalWalletLogoStorage } from './logo-storage.js';
import { WalletLogoAssetRepository } from './logo-asset.repository.js';
import { ProviderCatalogueRepository } from './provider-catalogue.repository.js';
import { DatabaseBackedWalletAuthorization } from './wallet-core.authorization.js';
import { WalletCoreBootstrapRepository } from './wallet-core.bootstrap-repository.js';
import { WalletCoreConfigurationWriter } from './wallet-core.configuration-writer.js';
import { createWalletCoreProductionDatabase, type WalletCoreDatabase } from './wallet-core.database.js';
import { WalletCoreExceptionFilter } from './wallet-core.filter.js';
import { WalletCoreHistoryRepository } from './wallet-core.history-repository.js';
import { WalletCoreRepository } from './wallet-core.repository.js';
import { WalletCoreRequestLimitModule } from './wallet-core.request-limit.js';
import { WalletCorePermissionGuard, WalletCoreRoutes } from './wallet-core.routes.js';
import { WalletAdminBearerGuard } from './wallet-admin-bearer.guard.js';
import { WALLET_CORE_AUTHORIZATION, WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT,
  WALLET_CORE_BOOTSTRAP_REPOSITORY, WALLET_CORE_CONFIGURATION_WRITER, WALLET_CORE_DATABASE,
  WALLET_CORE_DEFAULT_LOGO_PROCESSOR, WALLET_CORE_HISTORY_REPOSITORY, WALLET_CORE_IDENTITY,
  WALLET_CORE_LOGO_PROCESSOR, WALLET_CORE_LOGO_STORAGE,
  WALLET_CORE_LOGO_ASSETS,
  WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY, WalletCoreService,
  type WalletCoreIdentityPort } from './wallet-core.service.js';

const identity: WalletCoreIdentityPort = { nextUuidV7: uuidv7 };

@Injectable()
/** Closes only the production-owned pool when Nest tears the module down. */
class WalletCoreDatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(WALLET_CORE_DATABASE) private readonly database: WalletCoreDatabase) {}
  onModuleDestroy(): Promise<void> { return this.database.close(); }
}

@Injectable()
/** Registers the bounded multipart parser before Wallet logo routes receive requests. */
class WalletCoreMultipartRegistration implements OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}
  async onModuleInit(): Promise<void> {
    const adapter = this.host.httpAdapter;
    if (!adapter || adapter.getType() !== 'fastify') throw new Error('WALLET_FASTIFY_REQUIRED');
    await adapter.getInstance().register(multipart, {
      limits: { fileSize: 1_048_576, files: 1, fields: 0, parts: 1 },
    });
  }
}

/** Deliberately unmounted until the root application explicitly imports this module. */
@Module({
  imports: [AuthModule, AdminAuditWriterModule, WalletCoreRequestLimitModule],
  controllers: [WalletCoreRoutes],
  providers: [
    { provide: WALLET_CORE_DATABASE, useFactory: () => createWalletCoreProductionDatabase() },
    { provide: WALLET_CORE_AUTHORIZATION,
      useFactory: (admins: AdminDbOperation) => new DatabaseBackedWalletAuthorization(admins),
      inject: [AdminDbOperation] },
    { provide: WALLET_CORE_IDENTITY, useValue: identity },
    { provide: WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT,
      useFactory: () => BlockchainAdminCatalogueClient.production() },
    { provide: WALLET_CORE_LOGO_PROCESSOR, useValue: WALLET_CORE_DEFAULT_LOGO_PROCESSOR },
    { provide: WALLET_CORE_LOGO_STORAGE, useFactory: () => LocalWalletLogoStorage.create({
      root: process.env.WALLET_LOGO_STORAGE_ROOT ?? '',
      publicBaseUrl: process.env.WALLET_LOGO_PUBLIC_BASE_URL ?? '',
    }) },
    { provide: WALLET_CORE_LOGO_ASSETS,
      useFactory: (database: WalletCoreDatabase) => new WalletLogoAssetRepository(database),
      inject: [WALLET_CORE_DATABASE] },
    { provide: WALLET_CORE_BOOTSTRAP_REPOSITORY,
      useFactory: (database: WalletCoreDatabase, logo: LocalWalletLogoStorage) =>
        new WalletCoreBootstrapRepository(database, logo),
      inject: [WALLET_CORE_DATABASE, WALLET_CORE_LOGO_STORAGE] },
    { provide: WALLET_CORE_CONFIGURATION_WRITER,
      useFactory: (database: WalletCoreDatabase, audit: AdminAuditPort,
        assets: WalletLogoAssetRepository) =>
        new WalletCoreConfigurationWriter(new WalletCoreRepository(database), audit, assets),
      inject: [WALLET_CORE_DATABASE, ADMIN_AUDIT_PORT, WALLET_CORE_LOGO_ASSETS] },
    { provide: WALLET_CORE_HISTORY_REPOSITORY,
      useFactory: (database: WalletCoreDatabase) => new WalletCoreHistoryRepository(database),
      inject: [WALLET_CORE_DATABASE] },
    { provide: WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY,
      useFactory: (database: WalletCoreDatabase, audit: AdminAuditPort,
        ids: WalletCoreIdentityPort) => new ProviderCatalogueRepository(database, audit, ids),
      inject: [WALLET_CORE_DATABASE, ADMIN_AUDIT_PORT, WALLET_CORE_IDENTITY] },
    WalletCoreService, WalletAdminBearerGuard, WalletCorePermissionGuard, WalletCoreExceptionFilter,
    WalletCoreDatabaseLifecycle, WalletCoreMultipartRegistration,
  ],
})
export class WalletCoreModule {}
