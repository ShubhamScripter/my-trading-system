import { createHash } from 'node:crypto';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Covers a 128-character JSON-escaped sort value plus scope, fingerprint, and IDs. */
export const MAX_WALLET_QUERY_CURSOR_LENGTH = 1536;

export type WalletQueryCursorScope = 'CURRENCY' | 'CHAIN' | 'PROVIDER_CHAIN'
  | 'PROVIDER_COIN' | 'HISTORY' | 'CONFIGURATION' | 'ALERT';

/** Accepts only the canonical microsecond UTC form used by history keyset ordering. */
export function isCanonicalWalletHistoryTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.startsWith('0000-') || !UTC_MICROSECOND.test(value)) {
    return false;
  }
  const milliseconds = value.slice(0, 23) + 'Z';
  const parsed = new Date(milliseconds);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === milliseconds;
}

/** Rejects non-canonical base64url so equivalent cursor spellings cannot bypass validation. */
function decode(value: string, maximum = 512): unknown {
  if (value.length === 0 || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function encode(value: readonly string[]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Hashes normalized filter/order values so a cursor cannot be reused with another query. */
export function walletQueryFingerprint(input: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(entries))).digest('base64url');
}

export function encodeWalletQueryCursor(
  scope: WalletQueryCursorScope,
  fingerprint: string,
  values: readonly string[],
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint)
    || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw new TypeError('Invalid Wallet query cursor.');
  }
  const encoded = encode(['1', scope, fingerprint, ...values]);
  if (encoded.length > MAX_WALLET_QUERY_CURSOR_LENGTH) {
    throw new TypeError('Invalid Wallet query cursor.');
  }
  return encoded;
}

export function decodeWalletQueryCursor(
  value: string,
  scope: WalletQueryCursorScope,
  fingerprint: string,
  valueCount: number,
): readonly string[] | null {
  const decoded = decode(value, MAX_WALLET_QUERY_CURSOR_LENGTH);
  const positions = Array.isArray(decoded) ? decoded.slice(3) : [];
  if (!Array.isArray(decoded) || decoded.length !== valueCount + 3
    || decoded[0] !== '1' || decoded[1] !== scope || decoded[2] !== fingerprint
    || positions.some((entry) => typeof entry !== 'string' || entry.includes('\0'))) return null;
  return positions as string[];
}
