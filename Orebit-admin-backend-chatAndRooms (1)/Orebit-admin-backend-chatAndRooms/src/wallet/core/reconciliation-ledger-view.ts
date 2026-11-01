import { truncateApiCrypto, truncateApiFiat } from './wallet-core.policy.js';

export interface ReconciliationLedgerViewInput {
  readonly ledgerSignedTotal: string | null;
  readonly ledgerPositiveTotal: string | null;
  readonly priceUsd: string | null;
  readonly alertBasis: 'SIGNED' | 'POSITIVE_ONLY' | null;
}

type ParsedDecimal = Readonly<{ units: bigint; scale: number }>;

/** Parses bounded decimal text into exact integer units to avoid floating-point balance drift. */
function parseDecimal(value: string, maximumIntegerDigits: number, options: Readonly<{
  allowNegative: boolean; allowZero: boolean;
}>): ParsedDecimal {
  const match = typeof value === 'string'
    ? /^(-?)(0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(value) : null;
  if (match === null || (match[2] as string).length > maximumIntegerDigits
    || !options.allowNegative && match[1] === '-') {
    throw new TypeError('Invalid reconciliation decimal.');
  }
  const fraction = match[3] ?? '';
  const units = BigInt(`${match[1]}${match[2]}${fraction}`);
  if (units === 0n && (!options.allowZero || match[1] === '-')) {
    throw new TypeError('Invalid reconciliation decimal.');
  }
  return { units, scale: fraction.length };
}

/** Converts exact scaled units back to the canonical decimal form used by Admin responses. */
function decimal(units: bigint, scale: number): string {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

function usd(total: ParsedDecimal | null, price: ParsedDecimal | null): string | null {
  if (total === null || price === null) return null;
  // Multiply the exact scaled integers before applying the API display truncation.
  return truncateApiFiat(decimal(total.units * price.units, total.scale + price.scale));
}

/** Builds the signed/positive ledger totals and their USD projections for reconciliation review. */
export function formatReconciliationLedgerView(input: ReconciliationLedgerViewInput) {
  if (input.alertBasis !== null && input.alertBasis !== 'SIGNED'
    && input.alertBasis !== 'POSITIVE_ONLY') throw new TypeError('Invalid reconciliation alert basis.');
  const signed = input.ledgerSignedTotal === null ? null
    : parseDecimal(input.ledgerSignedTotal, 60, { allowNegative: true, allowZero: true });
  const positive = input.ledgerPositiveTotal === null ? null
    : parseDecimal(input.ledgerPositiveTotal, 60, { allowNegative: false, allowZero: true });
  const price = input.priceUsd === null ? null
    : parseDecimal(input.priceUsd, 20, { allowNegative: false, allowZero: false });
  return {
    ledgerSignedTotal: signed === null ? null : truncateApiCrypto(input.ledgerSignedTotal!),
    ledgerSignedTotalUsd: usd(signed, price),
    ledgerPositiveTotal: positive === null ? null : truncateApiCrypto(input.ledgerPositiveTotal!),
    ledgerPositiveTotalUsd: usd(positive, price),
    alertBasis: input.alertBasis,
  };
}
