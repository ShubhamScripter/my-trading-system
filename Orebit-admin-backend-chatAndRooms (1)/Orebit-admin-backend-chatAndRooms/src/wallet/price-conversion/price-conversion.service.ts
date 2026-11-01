import { Inject, Injectable } from '@nestjs/common';
import { PriceConfigurationConflict } from './price-conversion.errors.js';
export { PriceConfigurationConflict, PriceConfigurationValidationError } from './price-conversion.errors.js';
import type {
  PriceConversionBootstrap,
  PriceConversionBootstrapQuery,
  PriceConversionAuditContext,
  PriceConversionHistoryPage,
  PriceConversionHistoryQuery,
  PriceConversionPatch,
  PriceConversionPricePage,
  PriceConversionPriceQuery,
  PriceConversionStore,
} from './price-conversion.types.js';

export const PRICE_CONVERSION_STORE = Symbol('PRICE_CONVERSION_STORE');

/** Preserves the store contract and translates revision conflicts into stable domain errors. */
@Injectable()
export class PriceConversionService {
  constructor(@Inject(PRICE_CONVERSION_STORE) private readonly store: PriceConversionStore) {}

  bootstrap(input: PriceConversionBootstrapQuery): Promise<PriceConversionBootstrap> {
    return this.store.bootstrap(input);
  }

  async update(input: PriceConversionPatch, audit: PriceConversionAuditContext): Promise<{ readonly revision: number }> {
    const result = await this.store.updateAtomically(input, audit);
    if (result.kind === 'updated') return { revision: result.revision };

    throw new PriceConfigurationConflict(result.actualRevision);
  }

  history(input: PriceConversionHistoryQuery): Promise<PriceConversionHistoryPage> {
    return this.store.history(input);
  }

  prices(input: PriceConversionPriceQuery): Promise<PriceConversionPricePage> {
    return this.store.prices(input);
  }
}
