import sharp from 'sharp';
import {
  COUNTRY_IMAGE_DIMENSION,
  COUNTRY_IMAGE_MAX_BYTES,
  type CountryImageSlot,
} from './country.constants';
import { CountryImageInvalid, CountryImageTooLarge } from './country.errors';
import type { NormalisedCountryImage } from './country.types';

/**
 * Validation and normalisation for a country flag asset.
 *
 * Adapted from src/wallet/core/logo-processing.ts, which is this codebase's existing
 * answer to "accept an image from an admin". The rules are its rules; only the
 * dimension ceiling differs. Rederiving them here rather than importing because that
 * module is a separate nested workspace with its own package.json, its own Prisma schema
 * and ESM `.js` import specifiers — importing across that boundary would drag its whole
 * build into this one.
 *
 * ═══ THE CONTENT DECIDES, NOT THE CLIENT ══════════════════════════════════
 *
 * Nothing here trusts the filename or the multipart `Content-Type`. Both are
 * attacker-controlled, and a `.png` header on a ZIP is the oldest trick there is. The
 * format is whatever sharp DECODES, which is also why the allow-list is checked against
 * `metadata.format` and not against a MIME string.
 *
 * ─── Why everything is re-encoded, even a WebP that arrives as WebP ───────
 *
 * The output is always freshly encoded, lossless, metadata-free WebP. That is three
 * defences at once, and the reason a byte-for-byte passthrough is not offered:
 *
 *   1. EXIF and GPS are stripped. An admin uploading a flag from a phone should not
 *      publish where they were standing.
 *   2. A polyglot — a file that is a valid image AND a valid script or archive — does
 *      not survive a decode/encode round trip. Since these bytes are served from a
 *      public origin, that matters.
 *   3. The stored bytes are deterministic, so `countries/IN/round.webp` means the same
 *      thing however it was produced.
 *
 * SVG is absent from the allow-list, deliberately and permanently: it is a document
 * format with script and external-entity semantics, and serving one from a public
 * bucket is stored XSS against whatever origin fronts it. sharp would happily rasterise
 * it; that is not the risk.
 */

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'avif']);

/**
 * Lossless, and with `exact` set so fully transparent pixels keep their colour data.
 *
 * Flags are flat colour and hard edges — exactly the content lossy compression smears,
 * and exactly the content lossless WebP encodes well. The round asset is a circular crop
 * with a transparent surround, and `exact: false` would let the encoder rewrite those
 * invisible pixels, which shows up as a halo wherever the image is composited.
 */
const WEBP_OPTIONS = Object.freeze({
  lossless: true,
  quality: 100,
  alphaQuality: 100,
  effort: 6,
  nearLossless: false,
  smartSubsample: false,
  exact: true,
} as const);

type SourceFormat = NormalisedCountryImage['sourceFormat'];

/** AVIF decodes as an `heif` container; the codec is what distinguishes it. */
function decodedFormat(metadata: sharp.Metadata): string | null {
  if (metadata.format === 'heif' && metadata.compression === 'av1') return 'avif';
  return metadata.format ?? null;
}

function validate(metadata: sharp.Metadata): {
  sourceFormat: SourceFormat;
  width: number;
  height: number;
} {
  const format = decodedFormat(metadata);
  if (format === null || !SUPPORTED_FORMATS.has(format)) {
    throw new CountryImageInvalid('Image must be PNG, JPEG, WebP or AVIF content.');
  }

  // An animated flag is not a flag, and `pages > 1` is also how a multi-frame decode
  // bomb presents — one small frame described, thousands delivered.
  if ((metadata.pages ?? 1) !== 1) {
    throw new CountryImageInvalid('Animated or multi-page images are not accepted.');
  }

  const { width, height } = metadata;
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    throw new CountryImageInvalid('Image dimensions could not be read.');
  }

  // Square for BOTH slots: the round asset is a circular crop on a square canvas, not a
  // different aspect ratio. See the note in country.constants.ts.
  if (width !== height) {
    throw new CountryImageInvalid('Image must be square.');
  }

  if (width > COUNTRY_IMAGE_DIMENSION) {
    throw new CountryImageInvalid(
      `Image must be no larger than ${COUNTRY_IMAGE_DIMENSION} x ${COUNTRY_IMAGE_DIMENSION} pixels.`,
    );
  }

  return {
    sourceFormat: (format === 'jpeg' ? 'JPEG' : format.toUpperCase()) as SourceFormat,
    width,
    height,
  };
}

/**
 * Decodes one approved raster and returns deterministic, metadata-free WebP bytes.
 *
 * Throws `CountryImageInvalid` or `CountryImageTooLarge` and nothing else — sharp's own
 * errors are swallowed, because they describe the decoder's internals and would be a
 * disclosure if they reached a caller.
 */
export async function normaliseCountryImage(
  slot: CountryImageSlot,
  input: Buffer,
): Promise<NormalisedCountryImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new CountryImageInvalid(`The ${slot} image is empty.`);
  }
  if (input.length > COUNTRY_IMAGE_MAX_BYTES) {
    throw new CountryImageTooLarge(`The ${slot} image must not exceed 1 MiB.`);
  }

  try {
    // `limitInputPixels` is the decompression-bomb guard: a header claiming 50000x50000
    // is refused before any buffer is allocated for it. `failOn: 'warning'` additionally
    // rejects truncated and malformed files that sharp would otherwise repair silently —
    // repairing an image nobody can verify is how a crafted file gets stored.
    const options = {
      limitInputPixels: COUNTRY_IMAGE_DIMENSION * COUNTRY_IMAGE_DIMENSION,
      failOn: 'warning' as const,
    };

    // Read metadata with animation ENABLED, so a multi-frame file reports its true page
    // count and is caught. Encoding then reads page 1 only.
    const metadata = validate(
      await sharp(input, { ...options, animated: true, pages: -1 }).metadata(),
    );

    const content = await sharp(input, { ...options, pages: 1 }).webp(WEBP_OPTIONS).toBuffer();

    // Lossless encoding can grow a file — a photographic JPEG under the ceiling can
    // exceed it as lossless WebP. Checked on the OUTPUT because that is what gets stored
    // and served.
    if (content.length > COUNTRY_IMAGE_MAX_BYTES) {
      throw new CountryImageTooLarge(
        `The ${slot} image is too detailed to store losslessly under 1 MiB.`,
      );
    }

    return { slot, content, ...metadata, bytes: content.length };
  } catch (error) {
    if (error instanceof CountryImageInvalid || error instanceof CountryImageTooLarge) {
      throw error;
    }
    throw new CountryImageInvalid(`The ${slot} image could not be decoded.`);
  }
}
