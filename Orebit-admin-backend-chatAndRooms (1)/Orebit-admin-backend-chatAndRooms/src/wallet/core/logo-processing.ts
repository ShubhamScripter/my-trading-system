import { createRequire } from 'node:module';
import type SharpModule = require('./node_modules/sharp/lib/index');
import { WalletLogoInvalid, WalletLogoTooLarge } from './wallet-core.errors.js';

const sharp = createRequire(__filename)('sharp') as typeof SharpModule;

export const WALLET_LOGO_MAX_INPUT_BYTES = 1_048_576;
export const WALLET_LOGO_DIMENSION = 500;
const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp', 'avif']);
const WEBP_OPTIONS = Object.freeze({
  lossless: true,
  quality: 100,
  alphaQuality: 100,
  effort: 6,
  nearLossless: false,
  smartSubsample: false,
  exact: true,
} as const);
export type WalletLogoSourceFormat = 'PNG' | 'JPEG' | 'WEBP' | 'AVIF';
export interface NormalizedWalletLogo {
  readonly content: Buffer;
  readonly sourceFormat: WalletLogoSourceFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

function format(metadata: SharpModule.Metadata): string | null {
  if (metadata.format === 'heif' && metadata.compression === 'av1') return 'avif';
  return metadata.format ?? null;
}

function validate(metadata: SharpModule.Metadata): Readonly<{
  sourceFormat: WalletLogoSourceFormat;
  width: number;
  height: number;
}> {
  const decodedFormat = format(metadata);
  if (decodedFormat === null || !SUPPORTED_FORMATS.has(decodedFormat)) {
    throw new WalletLogoInvalid('Logo must use PNG, JPEG, WebP, or AVIF content.');
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new WalletLogoInvalid('Animated or multi-page logos are not accepted.');
  }
  if (metadata.width === undefined || metadata.height === undefined
    || metadata.width < 1 || metadata.width > WALLET_LOGO_DIMENSION
    || metadata.width !== metadata.height) {
    throw new WalletLogoInvalid('Logo must be square and no larger than 500 x 500 pixels.');
  }
  const sourceFormat = decodedFormat === 'jpeg' ? 'JPEG' : decodedFormat.toUpperCase();
  return { sourceFormat: sourceFormat as WalletLogoSourceFormat,
    width: metadata.width, height: metadata.height };
}

/** Decodes one approved raster and returns deterministic metadata-free WebP bytes. */
export async function normalizeWalletLogo(input: Buffer): Promise<NormalizedWalletLogo> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new WalletLogoInvalid('Logo bytes are required.');
  }
  if (input.length > WALLET_LOGO_MAX_INPUT_BYTES) {
    throw new WalletLogoTooLarge('Logo must not exceed 1 MiB.');
  }
  try {
    const metadata = validate(await sharp(input, {
      animated: true,
      pages: -1,
      limitInputPixels: WALLET_LOGO_DIMENSION * WALLET_LOGO_DIMENSION,
      failOn: 'warning',
    }).metadata());
    const output = await sharp(input, {
      pages: 1,
      limitInputPixels: WALLET_LOGO_DIMENSION * WALLET_LOGO_DIMENSION,
      failOn: 'warning',
    }).webp(WEBP_OPTIONS).toBuffer();
    if (output.length > WALLET_LOGO_MAX_INPUT_BYTES) {
      throw new WalletLogoTooLarge('Normalized logo must not exceed 1 MiB.');
    }
    return { content: output, ...metadata, bytes: output.length };
  } catch (error) {
    if (error instanceof WalletLogoInvalid || error instanceof WalletLogoTooLarge) throw error;
    throw new WalletLogoInvalid('Logo content could not be decoded.');
  }
}
