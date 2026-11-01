import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CountryImageInvalid, CountryImageTooLarge } from '../../src/country/country.errors';
import { normaliseCountryImage } from '../../src/country/country.processing';

/**
 * What the normaliser accepts, what it refuses, and what it strips.
 *
 * Images are GENERATED rather than committed as fixtures: a binary fixture is opaque in
 * review, and the properties under test here (format, dimensions, page count, embedded
 * metadata) are exactly the ones a reader could not verify by looking at a checked-in
 * file. Generating them makes each case's intent readable in the line that builds it.
 */

/** A square raster in the requested format. */
async function square(
  format: 'png' | 'jpeg' | 'webp' | 'avif',
  size = 64,
): Promise<Buffer> {
  const image = sharp({
    create: { width: size, height: size, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 1 } },
  });
  return format === 'png'
    ? image.png().toBuffer()
    : format === 'jpeg'
      ? image.jpeg().toBuffer()
      : format === 'webp'
        ? image.webp().toBuffer()
        : image.avif().toBuffer();
}

/** A little-endian 24-bit integer, as the WebP container encodes dimensions. */
function uint24(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

/** One RIFF chunk: a four-character tag, a length, the payload, and even-byte padding. */
function webpChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  const padding = payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, payload, padding]);
}

/** A two-frame animated WebP, assembled as VP8X + ANIM + two ANMF frames. */
async function animatedWebp(size = 64): Promise<Buffer> {
  const frames: Buffer[] = [];
  for (const background of ['red', 'blue']) {
    const frame = await sharp({ create: { width: size, height: size, channels: 3, background } })
      .webp({ lossless: true })
      .toBuffer();
    // Drop the 12-byte RIFF/WEBP preamble — an ANMF frame carries the bitstream alone.
    frames.push(frame.subarray(12));
  }

  const last = size - 1;
  const vp8x = Buffer.concat([Buffer.from([2, 0, 0, 0]), uint24(last), uint24(last)]);
  const animatedFrames = frames.map((frame) =>
    webpChunk(
      'ANMF',
      Buffer.concat([
        uint24(0),
        uint24(0),
        uint24(last),
        uint24(last),
        uint24(100),
        Buffer.from([0]),
        frame,
      ]),
    ),
  );

  const body = Buffer.concat([
    Buffer.from('WEBP'),
    webpChunk('VP8X', vp8x),
    webpChunk('ANIM', Buffer.alloc(6)),
    ...animatedFrames,
  ]);

  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('accepted content', () => {
  it.each(['png', 'jpeg', 'webp', 'avif'] as const)(
    'accepts %s and re-encodes it to WebP',
    async (format) => {
      const result = await normaliseCountryImage('round', await square(format));

      expect(result.sourceFormat).toBe(format.toUpperCase());
      expect(result.width).toBe(64);
      expect(result.height).toBe(64);

      // The OUTPUT is WebP whatever went in — which is what makes the stored key's
      // `.webp` extension a description rather than a guess.
      const out = await sharp(result.content).metadata();
      expect(out.format).toBe('webp');
    },
  );

  it('reports the byte length of what will actually be stored', async () => {
    const result = await normaliseCountryImage('square', await square('png'));
    expect(result.bytes).toBe(result.content.length);
  });

  it('accepts an image exactly at the dimension ceiling', async () => {
    await expect(normaliseCountryImage('round', await square('png', 512))).resolves.toBeDefined();
  });

  /**
   * ═══ METADATA IS STRIPPED, NOT PASSED THROUGH ══════════════════════════════
   *
   * An admin uploading a flag from a phone should not publish where they were standing.
   * The re-encode is what removes it — there is no explicit strip call, which is
   * precisely why this needs asserting: a future change to a passthrough would not fail
   * anything else.
   */
  it('strips EXIF from the stored bytes', async () => {
    const withExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD0: { Copyright: 'somebody', Software: 'a camera' } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await normaliseCountryImage('round', withExif);
    expect((await sharp(result.content).metadata()).exif).toBeUndefined();
  });
});

describe('refused content', () => {
  it('refuses an empty buffer', async () => {
    await expect(normaliseCountryImage('round', Buffer.alloc(0))).rejects.toThrow(
      CountryImageInvalid,
    );
  });

  /**
   * The single most important refusal on this surface: the bytes decide, not the
   * client. A text file arriving with `Content-Type: image/png` and a `.png` name is
   * refused because sharp cannot decode it — nothing in the pipeline ever consults the
   * declared type or the filename.
   */
  it('refuses a text file regardless of what the client called it', async () => {
    await expect(
      normaliseCountryImage('round', Buffer.from('#!/bin/sh\necho not an image\n')),
    ).rejects.toThrow(CountryImageInvalid);
  });

  it('refuses a GIF, which is outside the allow-list', async () => {
    const gif = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .gif()
      .toBuffer();

    await expect(normaliseCountryImage('round', gif)).rejects.toThrow(CountryImageInvalid);
  });

  /**
   * A flag does not animate, and a multi-frame file is also how a decode bomb presents.
   *
   * The container is hand-assembled because sharp's `WebpOptions` exposes no way to
   * ENCODE an animation from a still — the same reason src/wallet/core's own spec builds
   * one this way. The assertion below that `pages === 2` is what proves the fixture is
   * genuinely animated rather than merely malformed, which would make this a test of the
   * wrong rejection.
   */
  it('refuses an animated image', async () => {
    const animated = await animatedWebp();
    expect((await sharp(animated, { animated: true, pages: -1 }).metadata()).pages).toBe(2);

    await expect(normaliseCountryImage('round', animated)).rejects.toThrow(CountryImageInvalid);
  });

  it('refuses a non-square canvas', async () => {
    const wide = await sharp({
      create: { width: 128, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    await expect(normaliseCountryImage('round', wide)).rejects.toThrow(/square/i);
  });

  it('refuses an image past the dimension ceiling', async () => {
    const big = await sharp({
      create: { width: 513, height: 513, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    await expect(normaliseCountryImage('round', big)).rejects.toThrow(CountryImageInvalid);
  });

  it('refuses a source over the byte ceiling before it is decoded', async () => {
    await expect(
      normaliseCountryImage('square', Buffer.alloc(1_048_577, 1)),
    ).rejects.toThrow(CountryImageTooLarge);
  });

  it('names the slot in its message, so an operator knows which file to replace', async () => {
    await expect(normaliseCountryImage('square', Buffer.alloc(0))).rejects.toThrow(/square/);
  });
});
