/**
 * The country surface's vocabulary, its view types, and the object-storage port.
 */

import { uuidv7 } from '../utils/public.utils';
import {
  COUNTRY_ASSET_PREFIX,
  COUNTRY_IMAGE_SLOTS,
  COUNTRY_LEGACY_PREFIX,
  isCountryCode,
  type CountryImageSlot,
} from './country.constants';

/**
 * One country as the API reports it.
 *
 * Carries the ISO code AND the name on every row, beside both URLs, which is the whole
 * point of the catalogue: a caller must never have to infer which country an image
 * belongs to. The code is the stable identifier, the name is for people.
 *
 * `roundImageUrl` / `squareImageUrl` are absolute and browser-usable. They are NULL only
 * when storage is unconfigured — a country cannot be created without both images, so a
 * null here means "we could not build a link", never "there is no image".
 */
export interface CountryView {
  readonly id: string;
  readonly name: string;
  readonly isoCode: string;
  readonly roundImageUrl: string | null;
  readonly squareImageUrl: string | null;
  readonly imagesUpdatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A new object key for one uploaded asset.
 *
 * ═══ THE ONLY PLACE A KEY IS EVER CONSTRUCTED ══════════════════════════════
 *
 * Its inputs are a validated ISO code, a fixed slot name, and a fresh uuid. Consequences
 * worth stating plainly:
 *
 *   - An uploaded file's own name is never read. It is attacker-controlled, would be a
 *     path-traversal vector, and carries nothing the caller has not already told us.
 *   - The extension is always `.webp` because normalisation always produces WebP — it
 *     describes what IS stored, not what was uploaded.
 *   - The uuid makes every upload a NEW object. Nothing is ever overwritten, so an image
 *     already chosen by a country, or still sitting in the library unused, survives the
 *     next upload. That is the requirement the old deterministic key could not meet.
 *
 * Because the key is unique per upload it is also self-versioning: choosing a different
 * image changes the key, which changes the URL, so a CDN sees a new resource without any
 * cache-busting query.
 *
 * `isoCode` MUST already be uppercase and validated; `countryCodeSchema` guarantees that
 * and every caller sits behind it.
 */
export function newCountryImageKey(isoCode: string, slot: CountryImageSlot): string {
  return `${COUNTRY_ASSET_PREFIX}/${isoCode}/${slot}/${uuidv7()}.webp`;
}

/** What a key says about itself, once it has been proven to be one of ours. */
export interface CountryImageKeyParts {
  readonly slot: CountryImageSlot;
  /**
   * The ISO code the asset was uploaded under. METADATA, not ownership — an asset
   * uploaded for `IN` may legitimately be selected for another country. What binds an
   * image to a country is the key stored in `admin.countries`, and nothing else.
   */
  readonly isoCode: string;
}

/**
 * Reads an object key, or refuses it.
 *
 * ═══ THIS IS THE TRUST BOUNDARY FOR CLIENT-SUPPLIED KEYS ═══════════════════
 *
 * `POST /countries` takes image references FROM THE CLIENT, so something has to decide
 * whether a given string names an asset of ours. This is that something, and it is
 * deliberately a pure syntactic check with no network call:
 *
 *   - the key must sit under a prefix we own, so a caller cannot reference an arbitrary
 *     object elsewhere in the bucket;
 *   - it must have the exact shape one of our two layouts produces, so `../` and every
 *     other traversal attempt fails to PARSE rather than being sanitised;
 *   - the slot must be a real slot, which is what lets the caller's claim "this is the
 *     round image" be checked rather than believed.
 *
 * An absolute URL can never parse here, which is what makes
 * `{"roundImageUrl": "https://random-site.com/x.png"}` unusable even before the DTO's
 * `.strict()` rejects the field name itself. Whether the object EXISTS is a separate
 * question, answered by `CountryImageStorage.exists`.
 *
 * Returns null rather than throwing: the caller decides whether a bad key is a
 * validation failure on a named field or something else.
 */
export function parseCountryImageKey(key: string): CountryImageKeyParts | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) return null;

  // No traversal, no absolute path, no empty segment, no backslash. Checked before the
  // shape match so nothing can be smuggled past a permissive segment test.
  if (key.includes('..') || key.includes('//') || key.includes('\\') || key.startsWith('/')) {
    return null;
  }

  const segments = key.split('/');

  // country-assets/{ISO}/{slot}/{uuid}.webp
  if (segments.length === 4 && segments[0] === COUNTRY_ASSET_PREFIX) {
    const isoCode = segments[1] as string;
    const slot = segments[2] as string;
    const file = segments[3] as string;
    if (!isUppercaseCountryCode(isoCode) || !isImageSlot(slot)) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/.test(file)) {
      return null;
    }
    return { slot, isoCode };
  }

  // countries/{ISO}/{slot}.webp — the original layout, still selectable.
  if (segments.length === 3 && segments[0] === COUNTRY_LEGACY_PREFIX) {
    const isoCode = segments[1] as string;
    const file = segments[2] as string;
    if (!isUppercaseCountryCode(isoCode)) return null;
    if (!file.endsWith('.webp')) return null;
    const slot = file.slice(0, -'.webp'.length);
    if (!isImageSlot(slot)) return null;
    return { slot, isoCode };
  }

  return null;
}

function isUppercaseCountryCode(value: string): boolean {
  return value === value.toUpperCase() && isCountryCode(value);
}

function isImageSlot(value: string): value is CountryImageSlot {
  return (COUNTRY_IMAGE_SLOTS as readonly string[]).includes(value);
}

/**
 * One asset as the image library reports it.
 *
 * ═══ ASSET METADATA, NOT A COUNTRY RECORD ══════════════════════════════════
 *
 * Deliberately carries no `name` and no country identity beyond the ISO segment of its
 * own key. An object in a bucket is not a country: manufacturing a display name from a
 * filename would invent a fact the storage layer does not have, and would make the
 * library look like a catalogue it is not. `GET /countries` is the catalogue.
 *
 * `isoCode` is reported because the key layout genuinely contains one, and it is what
 * lets an admin creating `IN` find `IN`'s existing flags. It is a hint for filtering and
 * sorting — never a claim that this asset belongs to that country.
 */
export interface CountryImageAsset {
  /** The stable reference. What the client sends back to `POST /countries`. */
  readonly key: string;
  /** Absolute and browser-usable, or null when no public base URL is configured. */
  readonly url: string | null;
  readonly type: CountryImageSlot;
  readonly isoCode: string;
  readonly bytes: number;
  readonly uploadedAt: string | null;
}

/**
 * Object storage, as this module needs it.
 *
 * Mirrors `WalletLogoStorage` in src/wallet/core/logo-storage.ts, which is the proven
 * seam in this codebase: a port, so the R2 client is a deployment detail and the service
 * can be unit-tested without a bucket or a network.
 *
 * ─── There is deliberately no `delete` ────────────────────────────────────
 *
 * The bucket is a LIBRARY, so an asset nobody has selected yet is not garbage — it is
 * stock. An admin who uploads a flag and then abandons the form leaves an object the
 * very next admin can pick out of `GET /countries/images`, which is the feature working
 * rather than a leak. A delete would only add a way to destroy an image a live country
 * still references. Bucket growth is an operational concern and an R2 lifecycle rule is
 * the instrument for it, not application code.
 */
export interface CountryImageStorage {
  /** Stores normalised WebP bytes at a freshly minted, previously unused key. */
  putWebp(objectKey: string, bytes: Buffer): Promise<void>;

  /**
   * Every country image in the bucket, newest first.
   *
   * THROWS `CountryImageStorageUnavailable` — an unreachable bucket and an empty one are
   * emphatically different answers, and collapsing them would show an admin an empty
   * library and invite them to re-upload flags that already exist.
   */
  listImages(): Promise<readonly CountryImageAsset[]>;

  /**
   * Whether an object is actually there.
   *
   * The second half of validating a client-supplied key: `parseCountryImageKey` proves
   * the key is one of OURS, this proves it is one that EXISTS. Without it a caller could
   * point a country at a well-formed key for an object nobody ever uploaded, and that
   * flag would 404 in every client forever.
   */
  exists(objectKey: string): Promise<boolean>;

  /**
   * The public URL for a stored key, or null when storage is not configured.
   *
   * `version` becomes a `?v=` cache-buster. It stays on the signature for the legacy
   * `countries/{ISO}/{slot}.webp` objects, whose key is shared across uploads; keys
   * minted by `newCountryImageKey` carry a uuid and are already unique per image, so for
   * those it is redundant rather than wrong.
   */
  publicUrl(objectKey: string, version: Date | null): string | null;
}

/** DI token — the interface cannot be one, since it does not exist at runtime. */
export const COUNTRY_IMAGE_STORAGE = Symbol('COUNTRY_IMAGE_STORAGE');

/** One normalised image, ready to store. */
export interface NormalisedCountryImage {
  readonly slot: CountryImageSlot;
  readonly content: Buffer;
  readonly sourceFormat: 'PNG' | 'JPEG' | 'WEBP' | 'AVIF';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}
