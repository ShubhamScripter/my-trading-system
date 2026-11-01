import {
  decodeBoundCursor,
  encodeBoundCursor,
  isPriceCursorSortValue,
  priceCursorContext,
} from './price-conversion.cursor.js';
import { type PriceConversionPool, type PriceConversionSchema } from './price-conversion.database.js';
import { isoOrNull, requiredCursorTimestamp, requiredIso,
  stringOrNull } from './price-conversion.row-values.js';
import type {
  LatestPrice,
  PriceConversionPricePage,
  PriceConversionPriceQuery,
  ProviderCode,
} from './price-conversion.types.js';

interface PriceRow extends Record<string, unknown> {
  readonly id: string;
  readonly currencyId: string;
  readonly updatedAt: unknown;
  readonly cursorUpdatedAt: unknown;
}

/** Pages the latest effective record independently from the bounded bootstrap. */
export class PriceConversionPriceRepository {
  private readonly schema: PriceConversionSchema;

  constructor(private readonly database: PriceConversionPool) {
    this.schema = database.priceConversionSchema ?? 'price_conversion';
  }

  async prices(input: PriceConversionPriceQuery): Promise<PriceConversionPricePage> {
    const context = priceCursorContext(input);
    const cursor = input.cursor === undefined ? null : decodeBoundCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null) throw new Error('Invalid price cursor');
    if (cursor !== null && cursor[2] !== context) throw new Error('Price cursor does not match query');
    const sortBy = input.sortBy ?? 'currencyId';
    if (cursor !== null && !isPriceCursorSortValue(cursor[0], sortBy)) {
      throw new Error('Invalid price cursor sort value');
    }
    const values: unknown[] = [];
    const predicates: string[] = [];
    const add = (value: unknown, predicate: (parameter: string) => string): void => {
      values.push(value);
      predicates.push(predicate(`$${values.length}`));
    };
    if (input.currencyId !== undefined) add(input.currencyId,
      parameter => `currency_id = ${parameter}::uuid`);
    if (input.providerCode !== undefined) add(input.providerCode,
      parameter => `provider = ${parameter}`);
    if (input.status !== undefined) add(input.status,
      parameter => `pricing_status = ${parameter}`);
    const sortColumn = sortBy === 'updatedAt' ? 'updated_at' : 'currency_id';
    const direction = input.sortDirection === 'desc' ? 'DESC' : 'ASC';
    const comparator = direction === 'ASC' ? '>' : '<';
    if (cursor !== null) {
      values.push(cursor[0], cursor[1]);
      const cast = sortBy === 'updatedAt' ? 'timestamptz' : 'uuid';
      predicates.push(`(${sortColumn}, id) ${comparator}
        ($${values.length - 1}::${cast}, $${values.length}::uuid)`);
    }
    const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
    values.push(input.limit + 1);
    const result = await this.database.query<PriceRow>(`WITH latest AS (
      SELECT DISTINCT ON (r.currency_id) r.id, r.currency_id,
        r.effective_price_usd::text AS price_usd, r.observed_at,
        r.created_at AS updated_at, p.code::text AS provider,
        r.effective_snapshot_id AS snapshot_id, r.stale,
        c.pricing_status::text AS pricing_status,
        (c.pricing_status = 'DISABLED') AS disabled, r.reason::text AS reason
      FROM ${this.schema}.price_resolutions r
      JOIN ${this.schema}.currencies c ON c.id = r.currency_id
      LEFT JOIN ${this.schema}.price_providers p ON p.id = r.effective_provider_id
      ORDER BY r.currency_id, r.created_at DESC, r.id DESC
    ) SELECT id, currency_id AS "currencyId", price_usd AS "priceUsd",
      observed_at AS "observedAt", updated_at AS "updatedAt", provider,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorUpdatedAt",
      snapshot_id AS "snapshotId", stale, disabled, reason
    FROM latest ${where}
    ORDER BY ${sortColumn} ${direction}, id ${direction} LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, input.limit);
    return {
      items: rows.map(mapPrice),
      nextCursor: result.rows.length > input.limit
        ? encodeBoundCursor([
          sortBy === 'updatedAt'
            ? requiredCursorTimestamp(rows.at(-1)?.cursorUpdatedAt)
            : String(rows.at(-1)?.currencyId),
          String(rows.at(-1)?.id),
          context,
        ])
        : null,
    };
  }
}

function mapPrice(row: PriceRow): LatestPrice {
  return {
    currencyId: String(row.currencyId),
    priceUsd: stringOrNull(row.priceUsd),
    observedAt: isoOrNull(row.observedAt),
    updatedAt: requiredIso(row.updatedAt),
    provider: row.provider as ProviderCode | null,
    snapshotId: stringOrNull(row.snapshotId),
    stale: Boolean(row.stale),
    disabled: Boolean(row.disabled),
    reason: row.reason as LatestPrice['reason'],
  };
}
