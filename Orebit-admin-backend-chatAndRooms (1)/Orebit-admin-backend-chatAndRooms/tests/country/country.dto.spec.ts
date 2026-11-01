import { describe, expect, it } from 'vitest';
import {
  countryCreateSchema,
  countryImageQuerySchema,
  countryImageUploadSchema,
  countryQuerySchema,
} from '../../src/country/country.dto';

/**
 * Every rule the country DTOs enforce, pinned.
 *
 * Two things here are load-bearing rather than routine:
 *
 *   · the ISO normalisation, because the object key is derived from the PARSED value —
 *     a schema that let `in` through unchanged would file an asset under
 *     `country-assets/in/...` while every reader looked for `IN`;
 *   · the image-key validation, because those values come FROM THE CLIENT and are the
 *     only thing binding a country to its flags.
 */

const ROUND = 'country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp';
const SQUARE = 'country-assets/IN/square/0195f0a0-aaaa-7000-8000-000000000002.webp';
const LEGACY_ROUND = 'countries/IN/round.webp';
const LEGACY_SQUARE = 'countries/IN/square.webp';

const valid = { name: 'India', isoCode: 'IN', roundImageKey: ROUND, squareImageKey: SQUARE };

describe('countryCreateSchema', () => {
  it('accepts a name, a code and two image keys', () => {
    expect(countryCreateSchema.parse(valid)).toEqual(valid);
  });

  it('accepts legacy-layout keys, which are still selectable', () => {
    expect(() =>
      countryCreateSchema.parse({
        ...valid,
        roundImageKey: LEGACY_ROUND,
        squareImageKey: LEGACY_SQUARE,
      }),
    ).not.toThrow();
  });

  /**
   * An asset filed under one country may legitimately be chosen for another — the ISO
   * segment of a key is where it was uploaded, not who owns it. What binds an image to a
   * country is the key stored in the row.
   */
  it("accepts an asset filed under a different country's code", () => {
    expect(() =>
      countryCreateSchema.parse({
        name: 'Nepal',
        isoCode: 'NP',
        roundImageKey: ROUND,
        squareImageKey: SQUARE,
      }),
    ).not.toThrow();
  });

  it('uppercases the ISO code, so the derived key is deterministic', () => {
    expect(countryCreateSchema.parse({ ...valid, isoCode: 'in' }).isoCode).toBe('IN');
  });

  it('trims surrounding whitespace', () => {
    expect(countryCreateSchema.parse({ ...valid, name: '  India  ' }).name).toBe('India');
  });

  it.each(['XX', 'ZZ'])('rejects %s, which is not an assigned ISO code', (code) => {
    expect(() => countryCreateSchema.parse({ ...valid, isoCode: code })).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => countryCreateSchema.parse({ ...valid, name: '   ' })).toThrow();
  });

  it('rejects a name longer than the column', () => {
    expect(() => countryCreateSchema.parse({ ...valid, name: 'x'.repeat(81) })).toThrow();
  });

  it('requires both image keys', () => {
    expect(() => countryCreateSchema.parse({ name: 'India', isoCode: 'IN' })).toThrow();
    expect(() =>
      countryCreateSchema.parse({ name: 'India', isoCode: 'IN', roundImageKey: ROUND }),
    ).toThrow();
  });

  /**
   * ═══ THE ANTI-AMBIGUITY ASSERTIONS ═════════════════════════════════════════
   *
   * A caller must not be able to point a country at anything that is not one of our
   * assets. `.strict()` kills the URL-shaped field names outright; `parseCountryImageKey`
   * kills everything that survives that.
   */
  it.each(['roundImageUrl', 'squareImageUrl', 'imageUrl'])(
    'refuses a client-supplied %s outright',
    (field) => {
      expect(() =>
        countryCreateSchema.parse({ ...valid, [field]: 'https://random-site.com/x.png' }),
      ).toThrow();
    },
  );

  it.each([
    ['an external URL', 'https://random-site.com/image.png'],
    ['a URL naming our CDN', 'https://cdn.example/country-assets/IN/round/x.webp'],
    ['path traversal', 'country-assets/../../etc/passwd'],
    ['an unknown prefix', 'uploads/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['a bucket-root object', 'round.webp'],
  ])('refuses %s as a roundImageKey', (_label, key) => {
    expect(() => countryCreateSchema.parse({ ...valid, roundImageKey: key })).toThrow();
  });

  /**
   * The caller CLAIMS which slot a key is for; the key itself says what it actually is.
   * A mismatch is refused rather than stored, or a UI mix-up would show a square flag in
   * a round frame for the life of the row.
   */
  it('refuses a square asset offered as the round image', () => {
    expect(() => countryCreateSchema.parse({ ...valid, roundImageKey: SQUARE })).toThrow(
      /square image/i,
    );
  });

  it('refuses a round asset offered as the square image', () => {
    expect(() => countryCreateSchema.parse({ ...valid, squareImageKey: ROUND })).toThrow(
      /round image/i,
    );
  });

  it('refuses the same asset for both slots', () => {
    // Unreachable via the slot check alone, since one key cannot satisfy both — this
    // states the rule rather than leaving it implied by the key layout.
    expect(() =>
      countryCreateSchema.parse({ ...valid, squareImageKey: valid.roundImageKey }),
    ).toThrow();
  });

  it('rejects any other unknown key', () => {
    expect(() => countryCreateSchema.parse({ ...valid, id: 'chosen-by-caller' })).toThrow();
  });
});

describe('countryQuerySchema', () => {
  it('accepts an absent isoCode, which means "every country"', () => {
    expect(countryQuerySchema.parse({})).toEqual({});
  });

  it('normalises the filter the same way the create body does', () => {
    expect(countryQuerySchema.parse({ isoCode: 'us' }).isoCode).toBe('US');
  });

  it('rejects an unknown code rather than returning an empty list', () => {
    expect(() => countryQuerySchema.parse({ isoCode: 'XX' })).toThrow();
  });

  it('rejects unknown query parameters', () => {
    expect(() => countryQuerySchema.parse({ limit: '10' })).toThrow();
  });
});

describe('countryImageQuerySchema', () => {
  it('accepts no filter at all', () => {
    expect(countryImageQuerySchema.parse({})).toEqual({});
  });

  it('accepts either filter, or both', () => {
    expect(countryImageQuerySchema.parse({ isoCode: 'in' })).toEqual({ isoCode: 'IN' });
    expect(countryImageQuerySchema.parse({ type: 'round' })).toEqual({ type: 'round' });
    expect(countryImageQuerySchema.parse({ isoCode: 'IN', type: 'square' })).toEqual({
      isoCode: 'IN',
      type: 'square',
    });
  });

  it('rejects a type that is not a slot', () => {
    expect(() => countryImageQuerySchema.parse({ type: 'banner' })).toThrow();
  });

  it('rejects unknown query parameters', () => {
    expect(() => countryImageQuerySchema.parse({ prefix: 'country-assets/' })).toThrow();
  });
});

describe('countryImageUploadSchema', () => {
  it('normalises the code through the same rule as every other entry point', () => {
    expect(countryImageUploadSchema.parse({ isoCode: 'in', type: 'round' })).toEqual({
      isoCode: 'IN',
      type: 'round',
    });
  });

  it('requires both fields', () => {
    expect(() => countryImageUploadSchema.parse({ isoCode: 'IN' })).toThrow();
    expect(() => countryImageUploadSchema.parse({ type: 'round' })).toThrow();
  });

  /**
   * The type cannot be inferred from the bytes — a round flag and a square one are both
   * square rasters — so the caller declares it and it must be one of exactly two values.
   */
  it('rejects a type outside the two slots', () => {
    expect(() => countryImageUploadSchema.parse({ isoCode: 'IN', type: 'banner' })).toThrow();
  });

  /**
   * A multipart field arrives as a string, but the reader hands the raw value through
   * untouched — so a repeated field, which some parsers surface as an array, must be
   * refused rather than coerced into `'IN,US'`.
   */
  it.each([
    ['array', ['IN']],
    ['number', 42],
    ['null', null],
  ])('rejects an isoCode sent as a %s', (_label, value) => {
    expect(() => countryImageUploadSchema.parse({ isoCode: value, type: 'round' })).toThrow();
  });
});
