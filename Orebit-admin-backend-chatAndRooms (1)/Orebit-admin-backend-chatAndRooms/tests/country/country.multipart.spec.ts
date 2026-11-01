import { describe, expect, it } from 'vitest';
import { CountryImageInvalid, CountryImageTooLarge } from '../../src/country/country.errors';
import { readCountryImageMultipart } from '../../src/country/country.multipart';

/**
 * Reading one image and its two fields out of a multipart body.
 *
 * The parts are supplied directly rather than through a live Fastify instance: what is
 * under test is this function's handling of what the parser yields — ordering, absence,
 * repetition, truncation — and driving those through a real HTTP request would mean
 * constructing bodies whose only purpose is to produce a part sequence that can simply be
 * written down. The end-to-end path is covered in country.authorization.spec.ts.
 */

type Part =
  | { type: 'file'; fieldname: string; truncated?: boolean; bytes?: Buffer }
  | { type: 'field'; fieldname: string; value: unknown };

function request(parts: readonly Part[], onIterate?: () => never) {
  return {
    parts: () => {
      if (onIterate) onIterate();
      return (async function* () {
        for (const part of parts) {
          yield part.type === 'file'
            ? {
                type: 'file' as const,
                fieldname: part.fieldname,
                file: { truncated: part.truncated ?? false },
                toBuffer: async () => part.bytes ?? Buffer.from([1, 2, 3]),
              }
            : { type: 'field' as const, fieldname: part.fieldname, value: part.value };
        }
      })();
    },
  } as unknown as Parameters<typeof readCountryImageMultipart>[0];
}

const IMAGE: Part = { type: 'file', fieldname: 'image', bytes: Buffer.from([1]) };
const ISO: Part = { type: 'field', fieldname: 'isoCode', value: 'IN' };
const TYPE: Part = { type: 'field', fieldname: 'type', value: 'round' };

describe('a well-formed upload', () => {
  it('returns the file and both fields', async () => {
    const result = await readCountryImageMultipart(request([ISO, TYPE, IMAGE]));

    expect(result.fields).toEqual({ isoCode: 'IN', type: 'round' });
    expect(result.image.equals(Buffer.from([1]))).toBe(true);
  });

  /**
   * ═══ PART ORDER IS NOT GUARANTEED ══════════════════════════════════════════
   *
   * A client may legitimately serialise the file before the fields. A reader that
   * demanded them first would reject valid requests depending on which HTTP library the
   * caller happened to use — so every part is drained before anything is validated.
   */
  it('accepts the fields arriving AFTER the file', async () => {
    const result = await readCountryImageMultipart(request([IMAGE, ISO, TYPE]));
    expect(result.fields).toEqual({ isoCode: 'IN', type: 'round' });
  });

  /**
   * ═══ ONE IMAGE PER REQUEST, AND NO COUNTRY NEEDED ══════════════════════════
   *
   * The library flow uploads assets one at a time — an admin may replace only the round
   * flag and keep the square one they already had. Demanding both would make the common
   * case impossible.
   */
  it('needs only a single file', async () => {
    const result = await readCountryImageMultipart(request([ISO, TYPE, IMAGE]));
    expect(result.image).toBeInstanceOf(Buffer);
  });

  /**
   * The raw values are handed through untouched — `countryImageUploadSchema` is the one
   * place they are normalised, so this function cannot introduce a second rule.
   */
  it('does not normalise the fields itself', async () => {
    const result = await readCountryImageMultipart(
      request([{ type: 'field', fieldname: 'isoCode', value: ' in ' }, TYPE, IMAGE]),
    );
    expect(result.fields.isoCode).toBe(' in ');
  });

  /** Absent fields are the schema's problem to report, not this reader's to guess at. */
  it('leaves missing fields to the schema', async () => {
    const result = await readCountryImageMultipart(request([IMAGE]));
    expect(result.fields).toEqual({ isoCode: undefined, type: undefined });
  });
});

describe('a malformed upload', () => {
  it('refuses a request with no file', async () => {
    await expect(readCountryImageMultipart(request([ISO, TYPE]))).rejects.toThrow(
      /image file is required/i,
    );
  });

  /** The `.strict()` reflex, applied to a multipart body. */
  it('refuses an unexpected file field instead of ignoring it', async () => {
    await expect(
      readCountryImageMultipart(request([ISO, TYPE, { type: 'file', fieldname: 'flag' }])),
    ).rejects.toThrow(/Unexpected file field "flag"/);
  });

  it('refuses an unexpected non-file field', async () => {
    await expect(
      readCountryImageMultipart(
        request([ISO, TYPE, { type: 'field', fieldname: 'name', value: 'India' }, IMAGE]),
      ),
    ).rejects.toThrow(/Unexpected field "name"/);
  });

  /**
   * Two files is ambiguous — which one is the asset? Refused rather than resolved by a
   * last-wins rule nobody could predict.
   */
  it('refuses a second file', async () => {
    await expect(
      readCountryImageMultipart(request([ISO, TYPE, IMAGE, IMAGE])),
    ).rejects.toThrow(/one image/i);
  });

  it('reports a truncated file as too large, not as invalid', async () => {
    await expect(
      readCountryImageMultipart(
        request([ISO, TYPE, { type: 'file', fieldname: 'image', truncated: true }]),
      ),
    ).rejects.toBeInstanceOf(CountryImageTooLarge);
  });

  it('maps Fastify’s stream-limit code to too-large', async () => {
    await expect(
      readCountryImageMultipart(
        request([], () => {
          throw Object.assign(new Error('too big'), { code: 'FST_REQ_FILE_TOO_LARGE' });
        }),
      ),
    ).rejects.toBeInstanceOf(CountryImageTooLarge);
  });

  /**
   * The parser's own message describes its internals and would be a disclosure, so it is
   * replaced with one that says only what the caller can act on.
   */
  it('replaces a parser error with a message that leaks nothing', async () => {
    const error = await readCountryImageMultipart(
      request([], () => {
        throw new Error('busboy: Unexpected end of form at Multipart._final (/app/node_modules)');
      }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CountryImageInvalid);
    expect((error as Error).message).toBe('The upload could not be read as multipart form data.');
    expect((error as Error).message).not.toContain('node_modules');
  });
});
