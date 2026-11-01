import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  compare,
  cryptoShown,
  cryptoStored,
  cut,
  cutText,
  maxOf,
  minOf,
  money,
  parseAmount,
  percentOf,
  shareOf,
  sum,
  usdShown,
  usdStored,
} from '../../src/social/chat/platform/money';

/**
 * Chat money maths (rulebook B-1, B-2; FR-004, FR-181, FR-105): cut never round, exact, refuse extra decimals.
 */
describe('cutting', () => {
  it('cuts toward zero and never rounds up', () => {
    expect(cutText('9.999', 2)).toBe('9.99');
    expect(cutText('0.999999999', 8)).toBe('0.99999999');
    expect(usdShown('1.999')).toBe('1.99');
    expect(cryptoShown('0.123456789')).toBe('0.12345678');
  });

  it('pads to the places', () => {
    expect(usdStored('5')).toBe('5.00000000');
    expect(cryptoStored('1.5')).toBe('1.500000000000000000');
    expect(cutText('12', 0)).toBe('12');
  });

  it('keeps 18 crypto places and 8 USD places as stored', () => {
    expect(cryptoStored('0.123456789012345678')).toBe('0.123456789012345678');
    expect(usdStored('0.123456789')).toBe('0.12345678');
  });

  it('a negative that cuts to zero is zero, never "-0.00"', () => {
    expect(usdShown('-0.001')).toBe('0.00');
    expect(usdShown('-1.999')).toBe('-1.99');
  });
});

describe('exact maths', () => {
  it('a share is cut, not rounded: 7.00000001 x 1/3', () => {
    expect(usdStored(shareOf('7.00000001', 1, 3))).toBe('2.33333333');
    expect(usdStored(shareOf('10', 2, 3))).toBe('6.66666666');
    expect(usdStored(shareOf('10', 3, 4))).toBe('7.50000000');
  });

  it('a percent is a decimal product, not a float one', () => {
    // 0.1 x 3 is 0.30000000000000004 as a float.
    expect(percentOf('100', money(0.1).mul(3)).toFixed()).toBe('0.3');
    expect(percentOf('100', 10).toFixed()).toBe('10');
    expect(percentOf('3', '33.333333').toFixed()).toBe('0.99999999');
  });

  it('keeps more than 20 significant digits (the library default would round)', () => {
    const value = money('1234567890.123456789012345678').add('0.000000000000000001');
    expect(value.toFixed()).toBe('1234567890.123456789012345679');
  });

  it('compound percentages stay exact: +10% then +20% on 100 is 132', () => {
    const afterTen = money(100).mul(money(110)).div(100);
    expect(afterTen.mul(120).div(100).toFixed()).toBe('132');
  });

  it('sums, minimum, maximum and compare', () => {
    expect(sum(['0.1', '0.2', '0.3']).toFixed()).toBe('0.6');
    expect(minOf('2', '10').toFixed()).toBe('2');
    expect(maxOf('2', '10').toFixed()).toBe('10');
    expect(compare('1.10', '1.1')).toBe(0);
    expect(compare('1', '2')).toBe(-1);
  });

  it('a share needs whole numbers and 0 <= part <= whole', () => {
    expect(() => shareOf('10', 1, 0)).toThrow(MoneyError);
    expect(() => shareOf('10', 5, 4)).toThrow(MoneyError);
    expect(() => shareOf('10', 0.5, 2)).toThrow(MoneyError);
  });

  it('cut() returns an exact amount for further maths', () => {
    expect(cut('1.239', 2).toFixed()).toBe('1.23');
  });
});

describe('amounts typed or sent by someone', () => {
  it('accepts a plain decimal within the places', () => {
    expect(parseAmount('12.5', 8).toFixed()).toBe('12.5');
    expect(parseAmount(' 3 ', 2).toFixed()).toBe('3');
    expect(parseAmount('0.12345678', 8).toFixed()).toBe('0.12345678');
  });

  it('refuses more decimals than allowed instead of rounding them', () => {
    expect(() => parseAmount('10.505', 2)).toThrow(/At most 2 decimal places/);
    expect(() => parseAmount('0.123456789', 8)).toThrow(MoneyError);
  });

  it('refuses anything that is not a plain decimal', () => {
    for (const bad of ['', '-5', '1e5', '1,5', '1.', '.5', 'abc', '0x10', '1 2']) {
      expect(() => parseAmount(bad, 8), bad).toThrow(MoneyError);
    }
  });

  it('names the field in the error', () => {
    try {
      parseAmount('x', 2, 'basePrice');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as MoneyError).field).toBe('basePrice');
    }
  });
});
