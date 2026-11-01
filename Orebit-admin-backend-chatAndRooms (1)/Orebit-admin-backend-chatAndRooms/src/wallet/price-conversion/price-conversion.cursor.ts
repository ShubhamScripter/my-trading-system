const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BoundCursor = readonly [sortValue: string, id: string, context: string];

function decode(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) return null;
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function encode(value: BoundCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Decodes the shared opaque `(sortValue,id,queryContext)` cursor envelope. */
export function decodeBoundCursor(value: string): BoundCursor | null {
  const decoded = decode(value);
  if (!Array.isArray(decoded) || decoded.length !== 3) return null;
  const [sortValue, id, context] = decoded;
  if (typeof sortValue !== 'string' || typeof id !== 'string' || typeof context !== 'string'
    || !UUID.test(id)) return null;
  return [sortValue, id, context];
}

/** Decodes and strictly validates the opaque history timestamp cursor. */
export function decodeHistoryCursor(value: string): BoundCursor | null {
  const decoded = decodeBoundCursor(value);
  if (decoded === null) return null;
  const [createdAt, id, context] = decoded;
  return isCursorTimestamp(createdAt) ? [createdAt, id, context] : null;
}

/** Encodes a query-bound ordering tuple as a canonical base64url cursor. */
export function encodeHistoryCursor(value: BoundCursor): string {
  return encode(value);
}

export function encodeBoundCursor(value: BoundCursor): string {
  return encode(value);
}

/** Canonical filter/sort context bound into every history cursor. */
export function historyCursorContext(input: Readonly<{
  eventType?: unknown;
  currencyId?: unknown;
  providerCode?: unknown;
  status?: unknown;
  from?: unknown;
  to?: unknown;
  sortBy?: unknown;
  sortDirection?: unknown;
}>): string {
  return JSON.stringify([
    'history', input.eventType ?? null, input.currencyId ?? null, input.providerCode ?? null,
    input.status ?? null, input.from ?? null, input.to ?? null,
    input.sortBy ?? 'timestamp', input.sortDirection ?? 'desc',
  ]);
}

/** Canonical filter/sort context bound into every latest-price cursor. */
export function priceCursorContext(input: Readonly<{
  currencyId?: unknown;
  providerCode?: unknown;
  status?: unknown;
  sortBy?: unknown;
  sortDirection?: unknown;
}>): string {
  return JSON.stringify([
    'prices', input.currencyId ?? null, input.providerCode ?? null, input.status ?? null,
    input.sortBy ?? 'currencyId', input.sortDirection ?? 'asc',
  ]);
}

/** Ensures a price cursor's sort value matches the selected allowlisted column type. */
export function isPriceCursorSortValue(value: string, sortBy: 'currencyId' | 'updatedAt'): boolean {
  if (sortBy === 'currencyId') return UUID.test(value);
  return isCursorTimestamp(value);
}

export const scheduledCursorContext = 'scheduled-configurations:effectiveAt:asc';
import { isCursorTimestamp } from './price-conversion.row-values.js';
