import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';

export const PRICE_CONVERSION_DATABASE = Symbol('PRICE_CONVERSION_DATABASE');
export type PriceConversionSchema = 'price_conversion' | 'price_conversion_test';

/** Restricts database access to the production schema or the explicit disposable test schema. */
export function priceConversionSchemaFromUrl(
  connectionString: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'PRICE_TEST_ALLOW_RESET'>> = process.env,
): PriceConversionSchema {
  const url = new URL(connectionString);
  const schema = url.searchParams.get('schema');
  if (schema === 'price_conversion') return schema;
  if (schema === 'price_conversion_test' && env.NODE_ENV === 'test'
    && env.PRICE_TEST_ALLOW_RESET === 'true'
    && decodeURIComponent(url.pathname.slice(1)) === 'orebit_price_test') return schema;
  throw new Error('PRICE_DATABASE_URL must use schema=price_conversion');
}

/** PostgreSQL pool contract carrying the schema validated at construction time. */
export interface PriceConversionPool extends pg.Pool {
  readonly priceConversionSchema?: PriceConversionSchema;
}

/** Owns the validated PostgreSQL pool lifecycle for the isolated price-conversion module. */
@Injectable()
export class PriceConversionDatabase extends pg.Pool implements OnModuleInit, OnModuleDestroy {
  readonly priceConversionSchema: PriceConversionSchema;

  constructor() {
    const connectionString = process.env.PRICE_DATABASE_URL;
    if (connectionString === undefined || connectionString === '') throw new Error('PRICE_DATABASE_URL is required');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PRICE_DATABASE_URL must use PostgreSQL');
    const schema = priceConversionSchemaFromUrl(connectionString);
    super({ connectionString, application_name: 'orebit-admin-price-conversion', max: 10 });
    this.priceConversionSchema = schema;
  }

  async onModuleInit(): Promise<void> {
    const result = await this.query<{ settings: string | null }>(
      `SELECT to_regclass('${this.priceConversionSchema}.price_settings')::text AS settings`,
    );
    if (result.rows[0]?.settings !== `${this.priceConversionSchema}.price_settings`) {
      throw new Error(`${this.priceConversionSchema} schema is not migrated`);
    }
  }

  /** Closes the private pool when Nest stops so no administrative connection leaks. */
  async onModuleDestroy(): Promise<void> {
    await this.end();
  }
}
