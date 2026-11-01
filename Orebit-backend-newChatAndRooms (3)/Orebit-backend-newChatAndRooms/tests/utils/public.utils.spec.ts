import { describe, expect, it } from 'vitest';
import { safeEqual } from '../../src/utils/public.utils';

/**
 * ═══ safeEqual, AND THE TWO WAYS TO MEASURE A STRING ════════════════════════
 *
 * `timingSafeEqual` compares BYTES and throws unless both buffers are the same byte
 * length. The guard in front of it used to be `a.length !== b.length` — UTF-16 code
 * units, which is a different quantity for anything that is not one byte per
 * character. So the guard agreed on inputs whose encodings did not, and
 * `timingSafeEqual` threw `RangeError` out of a function every caller treats as
 * returning a boolean.
 *
 * The fix is not "handle the error": it is to make the guard measure the thing the
 * comparison measures. These tests are written in those terms — every case names its
 * UTF-16 length and its byte length, because the bug lives entirely in the gap
 * between them.
 *
 * ─── Why this is worth a file of its own ────────────────────────────────────
 *
 * Ten call sites compare an attacker-supplied guess through this function: the CSRF
 * cookie/header pair, the Telegram login HMAC, the OTP and registration code hashes,
 * the anti-phishing code, the device-cookie signature, the JWKS check and the
 * email-change grant. The reachable one was CSRF, where both halves come from the
 * request — but the primitive is shared, so it is the primitive that gets the test.
 */

/** Every fixture states both measurements, because the bug is the difference. */
const measure = (s: string): { units: number; bytes: number } => ({
  units: s.length,
  bytes: Buffer.from(s, 'utf8').length,
});

describe('safeEqual — ordinary ASCII', () => {
  it('is true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('is false for same-length strings that differ', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('is false for different lengths, without throwing', () => {
    expect(() => safeEqual('a', 'ab')).not.toThrow();
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('is false either way round', () => {
    expect(safeEqual('ab', 'a')).toBe(false);
  });

  it('is true for two empty strings', () => {
    // `timingSafeEqual` is happy with two zero-length buffers, and "no value" equalling
    // "no value" is the answer every caller already relies on via its own null checks.
    expect(safeEqual('', '')).toBe(true);
  });

  it('is false when only one side is empty', () => {
    expect(safeEqual('', 'a')).toBe(false);
    expect(safeEqual('a', '')).toBe(false);
  });
});

describe('safeEqual — multibyte against ASCII', () => {
  /**
   * ═══ FINDING #3, IN ONE LINE ══════════════════════════════════════════════
   *
   * The reported reproduction. `'é'` and `'a'` are both ONE UTF-16 code unit, so the
   * old guard let them through; they are TWO bytes and ONE byte, so `timingSafeEqual`
   * threw `RangeError: Input buffers must have the same byte length`.
   *
   * On the CSRF path both sides are attacker-supplied, so this was a 500 with a stack
   * trace in the log, available on demand, instead of the intended 403.
   */
  it('returns false for é vs a instead of throwing RangeError', () => {
    expect(measure('é')).toEqual({ units: 1, bytes: 2 });
    expect(measure('a')).toEqual({ units: 1, bytes: 1 });

    // The assertion the old implementation cannot satisfy: it threw here.
    expect(() => safeEqual('é', 'a')).not.toThrow();
    expect(safeEqual('é', 'a')).toBe(false);
  });

  it('returns false in the other direction too', () => {
    expect(() => safeEqual('a', 'é')).not.toThrow();
    expect(safeEqual('a', 'é')).toBe(false);
  });

  it('handles a three-byte character against one and two byte ones', () => {
    // A BMP character outside Latin-1: one code unit, three bytes.
    expect(measure('€')).toEqual({ units: 1, bytes: 3 });

    for (const other of ['a', 'é']) {
      expect(() => safeEqual('€', other)).not.toThrow();
      expect(safeEqual('€', other)).toBe(false);
    }
  });

  it('handles the raw high byte the reviewer used', () => {
    // `Cookie: orebit_csrf=<0xC3>` arrives as U+00C3 once Node decodes the header as
    // latin1 — one code unit, two bytes.
    expect(measure('Ã')).toEqual({ units: 1, bytes: 2 });
    expect(safeEqual('Ã', 'a')).toBe(false);
  });
});

describe('safeEqual — multibyte with EQUAL byte length', () => {
  /**
   * The case that proves the fix did not simply become "reject anything non-ASCII".
   * Same encoded length, so the comparison genuinely runs and has to be correct.
   */
  it('is true for identical two-byte characters', () => {
    expect(measure('é')).toEqual({ units: 1, bytes: 2 });
    expect(safeEqual('é', 'é')).toBe(true);
  });

  it('is false for different two-byte characters of the same byte length', () => {
    // é vs è — C3 A9 against C3 A8. Equal length, differing final byte.
    expect(measure('è')).toEqual({ units: 1, bytes: 2 });
    expect(safeEqual('é', 'è')).toBe(false);
  });

  it('is true for a longer identical multibyte string', () => {
    const value = 'héllo wörld';
    expect(measure(value).units).not.toBe(measure(value).bytes);
    expect(safeEqual(value, value)).toBe(true);
  });

  it('is false for a one-byte difference inside a multibyte string', () => {
    expect(safeEqual('héllo wörld', 'héllo wörlt')).toBe(false);
  });
});

describe('safeEqual — supplementary characters (surrogate pairs)', () => {
  /**
   * The strongest statement that this is byte-based rather than code-unit-based.
   *
   * An emoji outside the BMP is TWO UTF-16 code units and FOUR UTF-8 bytes, so
   * `'😀'.length === 'ab'.length` while their encodings differ by two bytes. The old
   * guard could not tell them apart and `timingSafeEqual` threw.
   */
  const GRIN = '\u{1F600}';
  const BEAM = '\u{1F601}';

  it('is true for the same emoji', () => {
    expect(measure(GRIN)).toEqual({ units: 2, bytes: 4 });
    expect(safeEqual(GRIN, GRIN)).toBe(true);
  });

  it('is false for a different emoji of the same byte length', () => {
    expect(measure(BEAM)).toEqual({ units: 2, bytes: 4 });
    expect(safeEqual(GRIN, BEAM)).toBe(false);
  });

  it('returns false for an emoji against a two-character ASCII string', () => {
    // Equal UTF-16 length, unequal byte length — the old guard's blind spot exactly.
    expect(measure('ab')).toEqual({ units: 2, bytes: 2 });

    expect(() => safeEqual(GRIN, 'ab')).not.toThrow();
    expect(safeEqual(GRIN, 'ab')).toBe(false);
  });

  it('returns false for an emoji against a single character', () => {
    expect(() => safeEqual(GRIN, 'a')).not.toThrow();
    expect(safeEqual(GRIN, 'a')).toBe(false);
  });
});

describe('safeEqual — the invariant', () => {
  /**
   * Stated as a property rather than a case list: `timingSafeEqual` must never be
   * reached with mismatched buffers, so this function must never throw for ANY pair of
   * strings. The grid below crosses every byte length from 1 to 4 against every other.
   */
  const SAMPLES = ['', 'a', 'ab', 'abc', 'abcd', 'é', 'éé', '€', '\u{1F600}', 'héllo wörld', '\u{1F600}\u{1F601}'];

  it('never throws for any pair, and is symmetric', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        let result: boolean | undefined;
        expect(() => {
          result = safeEqual(a, b);
        }).not.toThrow();

        // Equality of the encoded bytes is the whole contract.
        const expected = Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'));
        expect(result).toBe(expected);
        expect(safeEqual(b, a)).toBe(expected);
      }
    }
  });
});
