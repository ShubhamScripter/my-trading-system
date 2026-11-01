import { Inject, Injectable } from '@nestjs/common';
import type { AdminAuditPort } from '../../admin-audits/admin-audit.types.js';
import { ADMIN_AUDIT_PORT } from '../../admin-audits/admin-audit.writer.service.js';
import { PriceConversionBootstrapRepository } from './price-conversion.bootstrap-repository.js';
import { PriceConversionConfigurationWriter } from './price-conversion.configuration-writer.js';
import {
  PRICE_CONVERSION_DATABASE,
  type PriceConversionPool,
} from './price-conversion.database.js';
import { PriceConversionHistoryRepository } from './price-conversion.history-repository.js';
import { PriceConversionPriceRepository } from './price-conversion.price-repository.js';
import type {
  PriceConversionAuditContext,
  PriceConversionBootstrap,
  PriceConversionBootstrapQuery,
  PriceConversionHistoryPage,
  PriceConversionHistoryQuery,
  PriceConversionPatch,
  PriceConversionPricePage,
  PriceConversionPriceQuery,
  PriceConversionStore,
  PriceConversionUpdateResult,
} from './price-conversion.types.js';

export {
  PRICE_CONVERSION_DATABASE,
  PriceConversionDatabase,
  priceConversionSchemaFromUrl,
} from './price-conversion.database.js';
export type { PriceConversionPool, PriceConversionSchema } from './price-conversion.database.js';
export {
  priceRoleConfigurationStatus,
  serializePriceConfiguration,
} from './price-conversion.policy.js';

/** Preserves the store contract while delegating reads, writes, and history to focused units. */
@Injectable()
export class PriceConversionDbOperation implements PriceConversionStore {
  private readonly bootstrapRepository: PriceConversionBootstrapRepository;
  private readonly configurationWriter: PriceConversionConfigurationWriter;
  private readonly historyRepository: PriceConversionHistoryRepository;
  private readonly priceRepository: PriceConversionPriceRepository;

  constructor(
    @Inject(PRICE_CONVERSION_DATABASE) database: PriceConversionPool,
    @Inject(ADMIN_AUDIT_PORT) audit: AdminAuditPort,
  ) {
    this.bootstrapRepository = new PriceConversionBootstrapRepository(database);
    this.configurationWriter = new PriceConversionConfigurationWriter(database, audit);
    this.historyRepository = new PriceConversionHistoryRepository(database);
    this.priceRepository = new PriceConversionPriceRepository(database);
  }

  /** Returns the coherent administrative bootstrap view. */
  bootstrap(input: PriceConversionBootstrapQuery): Promise<PriceConversionBootstrap> {
    return this.bootstrapRepository.bootstrap(input);
  }

  /** Applies a complete configuration revision and its audit record atomically. */
  updateAtomically(
    input: PriceConversionPatch,
    audit: PriceConversionAuditContext,
  ): Promise<PriceConversionUpdateResult> {
    return this.configurationWriter.updateAtomically(input, audit);
  }

  /** Returns one filtered append-only operational and audit history page. */
  history(input: PriceConversionHistoryQuery): Promise<PriceConversionHistoryPage> {
    return this.historyRepository.history(input);
  }

  /** Returns one independently bounded latest effective-price page. */
  prices(input: PriceConversionPriceQuery): Promise<PriceConversionPricePage> {
    return this.priceRepository.prices(input);
  }
}
