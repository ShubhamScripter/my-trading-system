import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type SharpModule = require('../node_modules/sharp/lib/index');
import { WalletLogoInvalid, WalletLogoTooLarge } from '../wallet-core.errors.js';
import { normalizeWalletLogo } from '../logo-processing.js';

const sharp = createRequire(__filename)('sharp') as typeof SharpModule;

const image = (width = 500, height = 500) => sharp({
  create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 0.8 } },
});

async function raster(format: 'png' | 'jpeg' | 'webp' | 'avif', width = 500, height = 500) {
  return image(width, height)[format]().toBuffer();
}

function uint24(value: number): Buffer {
  return Buffer.from([value & 255, (value >> 8) & 255, (value >> 16) & 255]);
}

function webpChunk(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(name, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

async function animatedWebp(): Promise<Buffer> {
  const frames: Buffer[] = [];
  for (const background of ['red', 'blue']) {
    const frame = await sharp({
      create: { width: 500, height: 500, channels: 3, background },
    }).webp({ lossless: true }).toBuffer();
    frames.push(frame.subarray(12));
  }
  const vp8x = Buffer.concat([Buffer.from([2, 0, 0, 0]), uint24(499), uint24(499)]);
  const animation = Buffer.alloc(6);
  const animatedFrames = frames.map((frame) => webpChunk('ANMF', Buffer.concat([
    uint24(0), uint24(0), uint24(499), uint24(499), uint24(100), Buffer.from([0]), frame,
  ])));
  const body = Buffer.concat([
    Buffer.from('WEBP'), webpChunk('VP8X', vp8x), webpChunk('ANIM', animation), ...animatedFrames,
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('Wallet logo raster normalization', () => {
  it('accepts decoded PNG, JPEG/JPG, WebP, and AVIF content as deterministic WebP', async () => {
    for (const format of ['png', 'jpeg', 'webp', 'avif'] as const) {
      const input = await raster(format);
      const first = await normalizeWalletLogo(input);
      const second = await normalizeWalletLogo(input);
      const metadata = await sharp(first.content, { pages: -1 }).metadata();

      assert.deepEqual(first.content, second.content, format);
      assert.deepEqual({
        sourceFormat: first.sourceFormat, width: first.width, height: first.height,
        bytes: first.bytes,
      }, {
        sourceFormat: format === 'jpeg' ? 'JPEG' : format.toUpperCase(),
        width: 500, height: 500, bytes: first.content.length,
      });
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, 500);
      assert.equal(metadata.height, 500);
      assert.equal(metadata.pages ?? 1, 1);
    }
  });

  it('accepts a smaller positive square and preserves its dimensions', async () => {
    const output = await normalizeWalletLogo(await raster('png', 300, 300));
    const metadata = await sharp(output.content).metadata();
    assert.deepEqual({ sourceFormat: output.sourceFormat, width: output.width,
      height: output.height, bytes: output.bytes },
    { sourceFormat: 'PNG', width: 300, height: 300, bytes: output.content.length });
    assert.equal(metadata.width, 300);
    assert.equal(metadata.height, 300);
  });

  it('strips EXIF, ICC, and XMP metadata', async () => {
    const input = await image().jpeg().withExif({ IFD0: { Artist: 'OREBiT test' } })
      .withIccProfile('srgb').withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>').toBuffer();
    const before = await sharp(input).metadata();
    assert.ok(before.exif || before.icc || before.xmp);

    const metadata = await sharp((await normalizeWalletLogo(input)).content).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.hasProfile, false);
  });

  it('rejects oversized/non-square geometry, spoofed SVG, malformed bytes, and multi-frame content', async () => {
    const animated = await animatedWebp();
    assert.equal((await sharp(animated, { animated: true, pages: -1 }).metadata()).pages, 2);
    const stackedAvif = await raster('avif', 500, 1000);
    for (const input of [
      await raster('png', 500, 499), await raster('png', 499, 500), await raster('png', 501, 501),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"/>'),
      Buffer.from('not an image'), animated, stackedAvif,
    ]) await assert.rejects(() => normalizeWalletLogo(input), WalletLogoInvalid);
  });

  it('rejects more than 1 MiB before attempting decode', async () => {
    const input = Buffer.alloc(1_048_577, 0xff);
    await assert.rejects(() => normalizeWalletLogo(input), WalletLogoTooLarge);
  });

  it('keeps normalized WebP output within the same 1 MiB ceiling', async () => {
    let value = 0x13579bdf;
    const pixels = Buffer.alloc(500 * 500 * 4);
    for (let index = 0; index < pixels.length; index += 1) {
      value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
      pixels[index] = value & 0xff;
    }
    const input = await sharp(pixels, {
      raw: { width: 500, height: 500, channels: 4 },
    }).png().toBuffer();
    assert.ok(input.length <= 1_048_576);
    const output = await normalizeWalletLogo(input);
    assert.ok(output.content.length <= 1_048_576);
    assert.equal(output.bytes, output.content.length);
  });
});
