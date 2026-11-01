import { walletQueryFingerprint } from './wallet-core.cursor.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';

export type ProviderState = 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE' | 'UNAVAILABLE';
type SortDirection = 'asc' | 'desc';
export type ChainPageQuery = Readonly<{ search?: string; providerState?: ProviderState;
  sortBy?: 'providerChainId' | 'name' | 'shortName'; sortDirection?: SortDirection;
  cursor?: string; limit?: number }>;
export type CoinPageQuery = Readonly<{ providerChainId?: string; search?: string;
  providerState?: ProviderState; isBaseCurrency?: boolean; isStake?: boolean;
  sortBy?: 'providerCoinId' | 'currencyName'; sortDirection?: SortDirection;
  cursor?: string; limit?: number }>;

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const SEARCH = /^.{1,100}$/u;

export function providerPageLimit(input: unknown, keys: readonly string[]): number {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new WalletConfigurationInvalid('Invalid provider catalogue page query.');
  }
  const value = input as Readonly<{ limit?: unknown }>;
  const limit = value.limit === undefined ? 50 : value.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new WalletConfigurationInvalid('Invalid provider catalogue page query.');
  }
  return limit;
}

export const validProviderId = (value: unknown): value is string => typeof value === 'string'
  && POSITIVE_ID.test(value) && BigInt(value) <= MAX_BIGINT;
export const validRevision = (value: unknown): value is string => typeof value === 'string'
  && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_BIGINT;
export const validCursorText = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 128 && !value.includes('\0');
export const validSearch = (value: unknown): value is string => typeof value === 'string'
  && value === value.trim() && SEARCH.test(value) && !value.includes('\0');
export const providerQueryFingerprint = (input: Record<string, unknown>, keys: readonly string[]) =>
  walletQueryFingerprint(Object.fromEntries(keys.map((key) => [key, input[key]])));
