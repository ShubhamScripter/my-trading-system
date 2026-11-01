// Money arithmetic for chat (rulebook B-1, B-2; handoff , , ): the one place that adds, scales,
// cuts and formats an amount. Nothing else in chat may use `Number`, `Math.round` or `toFixed` on money.
// - **Cut, never round.** Every result is cut toward zero at the places it is stored or shown.
// - **Exact.** The decimal class below keeps 60 significant digits, so a share like 7.00000001 x 1/3 is exact before it
// is cut (the default 20-digit precision rounds silently).
// - **Places.** Crypto is stored at 18 decimals and USD at 8; the API shows crypto cut to 8 and USD cut to 2.
// - **Inputs with too many decimals are refused**, not rounded (admin money inputs and user amounts, B-2).
// Pure: no database, no clock.
import { Prisma } from '@prisma/client';

// The decimal class: 60 significant digits and ROUND_DOWN as its own rounding, so no operation rounds up.
const Decimal = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_DOWN });
export type Money = InstanceType<typeof Decimal>;
export type MoneyInput = string | number | bigint | { toString(): string };

// The places money is stored and shown at.
export const PLACES = {
  usdStored: 8,
  usdShown: 2,
  cryptoStored: 18,
  cryptoShown: 8,
} as const;

// A refused amount: the field it came from and why.
export class MoneyError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

// Any decimal-looking value as an exact amount. A number is read by its shortest text (0.1 is 0.1, not 0.1000000000000000055).
export function money(value: MoneyInput): Money {
  return new Decimal(typeof value === 'string' || typeof value === 'number' ? value : value.toString());
}

const PLAIN = /^\d{1,28}(\.\d+)?$/;

// An amount typed by a person or sent by an admin: a plain decimal, at most `maxDecimals` places. More places are
// refused, never rounded (B-2).
export function parseAmount(text: string, maxDecimals: number, field = 'amount'): Money {
  const trimmed = text.trim();
  if (!PLAIN.test(trimmed)) throw new MoneyError(field, 'An amount such as 12.5');
  const places = trimmed.split('.')[1]?.length ?? 0;
  if (places > maxDecimals) throw new MoneyError(field, `At most ${maxDecimals} decimal places`);
  return money(trimmed);
}

// The value cut toward zero at `places`.
export function cut(value: MoneyInput, places: number): Money {
  return money(value).toDecimalPlaces(places, Prisma.Decimal.ROUND_DOWN);
}

// The value cut at `places` as fixed text, padded with zeros: `cutText('9.999', 2)` is `'9.99'`.
export function cutText(value: MoneyInput, places: number): string {
  const out = cut(value, places).toFixed(places);
  // A negative that cuts to zero reads as zero, never "-0.00".
  return /^-0(\.0+)?$/.test(out) ? out.slice(1) : out;
}

// USD as stored (8 places), as shown (2 places); crypto as stored (18) and as shown (8).
export const usdStored = (value: MoneyInput): string => cutText(value, PLACES.usdStored);
export const usdShown = (value: MoneyInput): string => cutText(value, PLACES.usdShown);
export const cryptoStored = (value: MoneyInput): string => cutText(value, PLACES.cryptoStored);
export const cryptoShown = (value: MoneyInput): string => cutText(value, PLACES.cryptoShown);

// `percent` percent of `base` (percent as text or a number; never a float product). Not yet cut.
export function percentOf(base: MoneyInput, percent: MoneyInput): Money {
  return money(base).mul(money(percent)).div(100);
}

// `part / whole` of `total` for whole numbers: what 3 unused posts of 4 are of a price. Not yet cut.
export function shareOf(total: MoneyInput, part: number, whole: number): Money {
  if (!Number.isInteger(part) || !Number.isInteger(whole) || whole <= 0 || part < 0 || part > whole) {
    throw new MoneyError('share', 'A share is whole numbers with 0 <= part <= whole and whole > 0');
  }
  return money(total).mul(part).div(whole);
}

export const sum = (values: readonly MoneyInput[]): Money =>
  values.reduce<Money>((acc, value) => acc.add(money(value)), money(0));

export const minOf = (a: MoneyInput, b: MoneyInput): Money => (money(a).lte(money(b)) ? money(a) : money(b));
export const maxOf = (a: MoneyInput, b: MoneyInput): Money => (money(a).gte(money(b)) ? money(a) : money(b));

// -1, 0 or 1.
export const compare = (a: MoneyInput, b: MoneyInput): number => money(a).comparedTo(money(b));
export const isPositive = (value: MoneyInput): boolean => money(value).gt(0);
