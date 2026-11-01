import { describe, expect, it } from 'vitest';
import { composePublicUrl, validBase } from '../../src/country/country.storage';
import { newCountryImageKey, parseCountryImageKey } from '../../src/country/country.types';

/**
 * Key derivation and URL composition — the two pure halves of the storage adapter.
 *
 * Tested as free functions because the class reads the frozen `config` singleton at
 * construction and a spec cannot vary it. What remains in the class is the S3 client and
 * a null check.
 */
describe('newCountryImageKey', () => {
  /**
   * ═══ EVERY UPLOAD IS A NEW OBJECT ══════════════════════════════════════════
   *
   * The single most important property of the new key strategy, and the one the old
   * deterministic `countries/{ISO}/round.webp` could not provide. Two uploads for the
   * same country and slot must produce two keys, or the second silently destroys the
   * first — including one a live country is already pointing at.
   */
  it('never produces the same key twice', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newCountryImageKey('IN', 'round')));
    expect(keys.size).toBe(50);
  });

  it('files the asset under its ISO code and slot', () => {
    expect(newCountryImageKey('IN', 'round')).toMatch(/^country-assets\/IN\/round\/[0-9a-f-]{36}\.webp$/);
    expect(newCountryImageKey('US', 'square')).toMatch(/^country-assets\/US\/square\/[0-9a-f-]{36}\.webp$/);
  });

  it('always ends in .webp, because normalisation always produces WebP', () => {
    expect(newCountryImageKey('GB', 'square')).toMatch(/\.webp$/);
  });

  /** Whatever it mints must be readable again by the trust boundary. */
  it('produces keys that parse back to the same slot and code', () => {
    for (const slot of ['round', 'square'] as const) {
      const parsed = parseCountryImageKey(newCountryImageKey('JP', slot));
      expect(parsed).toEqual({ slot, isoCode: 'JP' });
    }
  });
});

describe('parseCountryImageKey', () => {
  it('reads a current-layout key', () => {
    expect(
      parseCountryImageKey('country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp'),
    ).toEqual({ slot: 'round', isoCode: 'IN' });
  });

  /**
   * Objects written before the library existed are still perfectly good flags, so the
   * original layout stays selectable. Nothing writes here any more.
   */
  it('reads a legacy-layout key', () => {
    expect(parseCountryImageKey('countries/IN/square.webp')).toEqual({
      slot: 'square',
      isoCode: 'IN',
    });
  });

  /**
   * ═══ THE TRUST BOUNDARY FOR CLIENT-SUPPLIED REFERENCES ═════════════════════
   *
   * `POST /countries` takes keys from the client. Everything below is something a caller
   * might send to point a country at an object that is not ours — and every one of them
   * must fail to PARSE rather than be sanitised into something that does.
   */
  it.each([
    ['an absolute https URL', 'https://random-site.com/image.png'],
    ['a URL that mentions our bucket', 'https://cdn.example/country-assets/IN/round/x.webp'],
    ['a protocol-relative URL', '//evil.example/x.webp'],
    ['parent traversal', 'country-assets/../../etc/passwd'],
    ['traversal inside a segment', 'country-assets/IN/round/../../../secrets.webp'],
    ['an absolute path', '/country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['a backslash', 'country-assets\\IN\\round\\x.webp'],
    ['an empty segment', 'country-assets//round/x.webp'],
    ['another prefix entirely', 'uploads/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['a bucket-root object', 'round.webp'],
    ['an unknown slot', 'country-assets/IN/banner/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['an unassigned ISO code', 'country-assets/XX/round/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['a lowercase ISO code', 'country-assets/in/round/0195f0a0-aaaa-7000-8000-000000000001.webp'],
    ['a non-uuid filename', 'country-assets/IN/round/anything.webp'],
    ['a non-webp extension', 'country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.svg'],
    ['a legacy key with an unknown slot', 'countries/IN/banner.webp'],
    ['an empty string', ''],
  ])('refuses %s', (_label, key) => {
    expect(parseCountryImageKey(key)).toBeNull();
  });

  it('refuses an absurdly long key', () => {
    expect(parseCountryImageKey('country-assets/IN/round/' + 'a'.repeat(300) + '.webp')).toBeNull();
  });

  /**
   * The slot is read from the key rather than taken on trust, which is what lets the
   * DTO check a caller's claim that a given key is the round image.
   */
  it('distinguishes round from square', () => {
    const round = parseCountryImageKey('country-assets/IN/round/0195f0a0-aaaa-7000-8000-000000000001.webp');
    const square = parseCountryImageKey('country-assets/IN/square/0195f0a0-aaaa-7000-8000-000000000001.webp');
    expect(round?.slot).toBe('round');
    expect(square?.slot).toBe('square');
  });
});

describe('validBase', () => {
  it('accepts an https origin and forces a trailing slash', () => {
    expect(validBase('https://cdn.example').toString()).toBe('https://cdn.example/');
  });

  /**
   * Without the forced slash, `new URL('countries/IN/round.webp', 'https://cdn/assets')`
   * resolves against `/` and silently drops `assets`, pointing every image at the wrong
   * prefix without erroring anywhere.
   */
  it('preserves a path prefix by appending the slash it needs', () => {
    expect(validBase('https://cdn.example/assets').toString()).toBe(
      'https://cdn.example/assets/',
    );
  });

  it('rejects http — these URLs are embedded in pages and would be blocked', () => {
    expect(() => validBase('http://cdn.example')).toThrow(/R2_PUBLIC_BASE_URL/);
  });

  it('rejects credentials in the URL, which would be a leak in every response', () => {
    expect(() => validBase('https://user:pass@cdn.example')).toThrow(/R2_PUBLIC_BASE_URL/);
  });

  /** A base with its own query would collide with the `?v=` cache-buster. */
  it.each(['https://cdn.example/?token=1', 'https://cdn.example/#frag'])(
    'rejects %s',
    (value) => {
      expect(() => validBase(value)).toThrow(/R2_PUBLIC_BASE_URL/);
    },
  );

  it('rejects a value that is not a URL at all', () => {
    expect(() => validBase('cdn.example')).toThrow(/R2_PUBLIC_BASE_URL/);
  });
});

describe('composePublicUrl', () => {
  const base = validBase('https://cdn.example');
  const version = new Date('2026-09-19T12:00:00.000Z');

  it('joins the base onto the stored key', () => {
    expect(composePublicUrl(base, 'countries/IN/round.webp', null)).toBe(
      'https://cdn.example/countries/IN/round.webp',
    );
  });

  /**
   * ═══ WHY THE CACHE-BUSTER IS NOT COSMETIC ══════════════════════════════════
   *
   * Objects are stored at deterministic keys and served with a year-long
   * `CacheControl`, so replacing a flag does not change its URL. Without `?v=` a CDN
   * would keep serving the previous image until the object expired.
   */
  it('appends the version as a cache-buster', () => {
    expect(composePublicUrl(base, 'countries/IN/round.webp', version)).toBe(
      `https://cdn.example/countries/IN/round.webp?v=${version.getTime()}`,
    );
  });

  it('produces a different URL after a replacement, for the same object key', () => {
    const later = new Date(version.getTime() + 1000);
    expect(composePublicUrl(base, 'countries/IN/round.webp', version)).not.toBe(
      composePublicUrl(base, 'countries/IN/round.webp', later),
    );
  });

  it('keeps the path prefix of a base that has one', () => {
    expect(
      composePublicUrl(validBase('https://cdn.example/assets'), 'countries/IN/round.webp', null),
    ).toBe('https://cdn.example/assets/countries/IN/round.webp');
  });

  /**
   * Segment-wise encoding, not whole-key encoding: `encodeURIComponent` over the whole
   * key would escape the slashes and collapse the path into a single filename.
   */
  it('keeps the key a path rather than flattening it into one segment', () => {
    expect(composePublicUrl(base, 'countries/IN/round.webp', null)).not.toContain('%2F');
  });
});
