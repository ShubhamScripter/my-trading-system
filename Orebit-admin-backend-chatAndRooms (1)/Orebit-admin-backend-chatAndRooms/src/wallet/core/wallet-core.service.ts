import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../../auth/auth.types.js';
import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../admin-audits/index.js';
import { ADMIN_AUDIT_PORT } from '../../admin-audits/admin-audit.writer.service.js';
import type { BlockchainAdminClient } from './blockchain-admin.client.js';
import { WalletCatalogueClientError } from './blockchain-admin.client.js';
import { normalizeWalletLogo, type NormalizedWalletLogo } from './logo-processing.js';
import { createWalletLogoObjectKey, type WalletLogoStorage } from './logo-storage.js';
import type { WalletLogoAssetRepository } from './logo-asset.repository.js';
import type { ProviderCatalogueRepository } from './provider-catalogue.repository.js';
import type { WalletCoreBootstrapRepository } from './wallet-core.bootstrap-repository.js';
import type { WalletCoreConfigurationWriter } from './wallet-core.configuration-writer.js';
import type { WalletCoreDatabase } from './wallet-core.database.js';
import { WalletPreferenceInvalid, WalletProviderUnavailable } from './wallet-core.errors.js';
import type { WalletCoreHistoryRepository } from './wallet-core.history-repository.js';
import type { AdminBootstrapQuery, AdminChainQuery, WalletAuditContext, WalletCorePatch,
  WalletHistoryQuery } from './wallet-core.types.js';

export const WALLET_CORE_AUTHORIZATION = Symbol('WALLET_CORE_AUTHORIZATION');
export const WALLET_CORE_BOOTSTRAP_REPOSITORY = Symbol('WALLET_CORE_BOOTSTRAP_REPOSITORY');
export const WALLET_CORE_CONFIGURATION_WRITER = Symbol('WALLET_CORE_CONFIGURATION_WRITER');
export const WALLET_CORE_HISTORY_REPOSITORY = Symbol('WALLET_CORE_HISTORY_REPOSITORY');
export const WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY =
  Symbol('WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY');
export const WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT = Symbol('WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT');
export const WALLET_CORE_IDENTITY = Symbol('WALLET_CORE_IDENTITY');
export const WALLET_CORE_LOGO_PROCESSOR = Symbol('WALLET_CORE_LOGO_PROCESSOR');
export const WALLET_CORE_LOGO_STORAGE = Symbol('WALLET_CORE_LOGO_STORAGE');
export const WALLET_CORE_LOGO_ASSETS = Symbol('WALLET_CORE_LOGO_ASSETS');
export const WALLET_CORE_DATABASE = Symbol('WALLET_CORE_DATABASE');

export interface WalletCoreIdentityPort { nextUuidV7(): string }
export interface WalletLogoProcessor { process(input: Buffer): Promise<NormalizedWalletLogo> }
type ProviderCatalogueCommonQuery = Readonly<{
  search?: string; providerState?: 'ACTIVATED' | 'DISABLED'
    | 'MAINTENANCE' | 'UNAVAILABLE'; isBaseCurrency?: boolean; isStake?: boolean;
  sortDirection?: 'asc' | 'desc'; cursor?: string; limit?: number;
}>;
export type WalletProviderCatalogueQuery = ProviderCatalogueCommonQuery & Readonly<{
  providerChainId?: string;
  sortBy?: 'providerChainId' | 'providerCoinId' | 'name' | 'shortName' | 'currencyName';
}>;
export type WalletProviderCatalogueCoinsQuery = Readonly<{
  providerChainId?: string; search?: string; providerState?: 'ACTIVATED' | 'DISABLED'
    | 'MAINTENANCE' | 'UNAVAILABLE'; isBaseCurrency?: boolean; isStake?: boolean;
  sortBy?: 'providerCoinId' | 'currencyName'; sortDirection?: 'asc' | 'desc';
  cursor?: string; limit?: number;
}>;
export type WalletAdminPreferencePatch = Readonly<{ timezone: string }>;

const normalizedLogoProcessor: WalletLogoProcessor = { process: normalizeWalletLogo };
export { normalizedLogoProcessor as WALLET_CORE_DEFAULT_LOGO_PROCESSOR };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validTimezone(value: string): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value !== value.trim()) {
    return false;
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

@Injectable()
/** Coordinates Wallet admin use cases while repositories retain transaction ownership. */
export class WalletCoreService {
  constructor(
    @Inject(WALLET_CORE_BOOTSTRAP_REPOSITORY)
    private readonly bootstrapRepository: WalletCoreBootstrapRepository,
    @Inject(WALLET_CORE_CONFIGURATION_WRITER)
    private readonly configurationWriter: WalletCoreConfigurationWriter,
    @Inject(WALLET_CORE_HISTORY_REPOSITORY)
    private readonly historyRepository: WalletCoreHistoryRepository,
    @Inject(WALLET_CORE_PROVIDER_CATALOGUE_REPOSITORY)
    private readonly providerCatalogue: ProviderCatalogueRepository,
    @Inject(WALLET_CORE_BLOCKCHAIN_ADMIN_CLIENT)
    private readonly blockchainClient: BlockchainAdminClient,
    @Inject(WALLET_CORE_IDENTITY) private readonly identity: WalletCoreIdentityPort,
    @Inject(WALLET_CORE_LOGO_PROCESSOR) private readonly logoProcessor: WalletLogoProcessor,
    @Inject(WALLET_CORE_LOGO_STORAGE) private readonly logoStorage: WalletLogoStorage,
    @Inject(WALLET_CORE_LOGO_ASSETS) private readonly logoAssets: WalletLogoAssetRepository,
    @Inject(WALLET_CORE_DATABASE) private readonly database: WalletCoreDatabase,
    @Inject(ADMIN_AUDIT_PORT) private readonly audit: AdminAuditPort,
  ) {}

  bootstrap(principal: Principal, query: AdminBootstrapQuery) {
    return this.bootstrapRepository.bootstrap(query, { adminId: principal.adminId });
  }

  chains(_principal: Principal, query: AdminChainQuery) {
    return this.bootstrapRepository.chainPage(query);
  }

  update(_principal: Principal, patch: WalletCorePatch, audit: WalletAuditContext) {
    return this.configurationWriter.updateAtomically(patch, audit);
  }

  history(_principal: Principal, query: WalletHistoryQuery) {
    return this.historyRepository.history(query);
  }

  catalogue(_principal: Principal, query: WalletProviderCatalogueQuery) {
    if (query.providerChainId === undefined) return this.providerCatalogue.chains(
      query as Parameters<ProviderCatalogueRepository['chains']>[0]);
    const { providerChainId, ...page } = query;
    return this.providerCatalogue.coins(providerChainId,
      page as Parameters<ProviderCatalogueRepository['coins']>[1]);
  }

  catalogueCoins(_principal: Principal, query: WalletProviderCatalogueCoinsQuery) {
    return this.providerCatalogue.allCoins(query);
  }

  async refreshCatalogue(_principal: Principal, audit: WalletAuditContext) {
    // Allocate the audit identity before I/O so failed provider fetches cannot masquerade as refreshes.
    const prefetchEventKey = this.identity.nextUuidV7();
    if (!UUID_V7.test(prefetchEventKey)) throw new Error('WALLET_CATALOGUE_EVENT_KEY_INVALID');
    let snapshot;
    try { snapshot = await this.blockchainClient.fetchCompleteCatalogue(); }
    catch (error) {
      if (!(error instanceof WalletCatalogueClientError)) throw error;
      await this.providerCatalogue.recordFailure(error.code);
      throw new WalletProviderUnavailable();
    }
    return this.providerCatalogue.refresh(snapshot, audit, prefetchEventKey);
  }

  async uploadLogo(_principal: Principal, input: Buffer, audit: WalletAuditContext) {
    const normalized = await this.logoProcessor.process(input);
    const objectKey = createWalletLogoObjectKey();
    const url = this.logoStorage.publicUrl(objectKey);
    // Reserve first so every stored object is either attached or discoverable by cleanup.
    await this.logoAssets.reserve(objectKey);
    try { await this.logoStorage.putWebp(objectKey, normalized.content); }
    catch (error) { await this.logoAssets.requestDeletion(objectKey); throw error; }
    try {
      const result = await this.database.transaction(async client => {
        const appended = await this.audit.appendWithTransaction(
          client, this.logoAudit(objectKey, normalized, audit));
        await this.logoAssets.markUploadedWithTransaction(client, objectKey);
        return appended;
      });
      if (result.replayed) throw new Error('WALLET_LOGO_AUDIT_REPLAYED');
      return { objectKey, url };
    } catch (error) {
      await this.logoAssets.requestDeletion(objectKey);
      await this.logoStorage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async updatePreferences(principal: Principal, patch: WalletAdminPreferencePatch,
    audit: WalletAuditContext): Promise<WalletAdminPreferencePatch> {
    if (Object.keys(patch).length !== 1 || !validTimezone(patch.timezone)) {
      throw new WalletPreferenceInvalid('Invalid Admin display timezone.');
    }
    // Preference and audit must commit together so operator-visible changes are attributable.
    return this.database.transaction(async (client) => {
      const current = (await client.query<{ timezone: unknown; revision: unknown }>(
        `SELECT preference.timezone,settings.revision FROM
         ${this.database.schemas.wallet}.wallet_settings settings
         LEFT JOIN ${this.database.schemas.wallet}.admin_preferences preference ON preference.admin_id=$1
         WHERE settings.id FOR UPDATE OF settings`, [principal.adminId])).rows[0];
      if (!current) throw new Error('WALLET_SETTINGS_ROW_MISSING');
      const before = typeof current.timezone === 'string' ? current.timezone : 'Asia/Kolkata';
      const revision = Number(current.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('WALLET_REVISION_INVALID');
      await client.query(`INSERT INTO ${this.database.schemas.wallet}.admin_preferences
        (admin_id,timezone,updated_at) VALUES ($1,$2,clock_timestamp())
        ON CONFLICT (admin_id) DO UPDATE SET timezone=EXCLUDED.timezone,
          updated_at=EXCLUDED.updated_at`, [principal.adminId, patch.timezone]);
      const result = await this.audit.appendWithTransaction(client, { domain: 'WALLET_CORE',
        action: 'ADMIN_TIMEZONE.UPDATED', eventKey: `wallet-timezone:${audit.actor.requestId}`,
        actor: audit.actor, subject: { type: 'ADMIN', id: principal.adminId },
        reason: 'admin-timezone-update', before: { timezone: before },
        after: { timezone: patch.timezone }, metadata: { configurationRevision: revision } });
      if (result.replayed) throw new Error('WALLET_TIMEZONE_AUDIT_REPLAYED');
      return patch;
    });
  }

  private logoAudit(objectKey: string, logo: NormalizedWalletLogo,
    audit: WalletAuditContext): WalletCoreAdminAuditInput {
    return { domain: 'WALLET_CORE', action: 'LOGO.UPLOADED',
      eventKey: `wallet-logo:${objectKey}`, actor: audit.actor,
      subject: { type: 'LOGO_ASSET', id: objectKey }, reason: 'wallet-logo-upload',
      before: { stored: false }, after: { stored: true, mediaType: 'image/webp',
        width: logo.width, height: logo.height, bytes: logo.bytes },
      metadata: { sourceFormat: logo.sourceFormat } };
  }
}
