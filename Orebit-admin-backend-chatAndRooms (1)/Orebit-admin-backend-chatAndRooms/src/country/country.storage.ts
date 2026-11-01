import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { config } from '../config';
import { COUNTRY_ASSET_PREFIXES } from './country.constants';
import { CountryImageStorageUnavailable } from './country.errors';
import {
  parseCountryImageKey,
  type CountryImageAsset,
  type CountryImageStorage,
} from './country.types';

/**
 * Cloudflare R2, through its S3-compatible API.
 *
 * ═══ TWO URLs, AND CONFUSING THEM IS THE FAILURE MODE ══════════════════════
 *
 *   R2_ENDPOINT         the authenticated S3 API. Every request to it is signed. A
 *                       browser cannot read an object from here, and this host is
 *                       never returned to a client.
 *   R2_PUBLIC_BASE_URL  the r2.dev address or custom domain that serves the bucket
 *                       publicly. This is what a stored key is joined onto.
 *
 * They are different hosts doing different jobs, and `publicUrl` uses only the second.
 * This is the misconfiguration the config layer's combination rule exists to catch at
 * boot rather than at the first upload.
 *
 * ─── Credentials ─────────────────────────────────────────────────────────
 *
 * Read from `config`, which parses them once at boot from the environment. Nothing is
 * hardcoded, nothing is logged, and no failure raised by this class carries the
 * endpoint, bucket, key id or the SDK's own message — every one of them collapses to
 * `CountryImageStorageUnavailable`, which has no message a caller can read.
 */
@Injectable()
export class R2CountryImageStorage implements CountryImageStorage, OnModuleDestroy {
  private readonly logger = new Logger('CountryImageStorage');

  /**
   * Null when R2 is not configured, which is only reachable outside production —
   * `config.load()` refuses to boot a production process without a bucket.
   *
   * Held as an instance field so the connection pool inside it is reused across requests
   * and torn down with the module, the lifecycle `CaptchaService` gives its https.Agent.
   * Constructing a client per upload would leak sockets under load.
   */
  private readonly client: S3Client | null;

  /** Validated once at construction, so a malformed value fails at boot, not at read. */
  private readonly base: URL | null;

  constructor() {
    this.client = config.r2Enabled
      ? new S3Client({
          // R2 is not region-partitioned, but the SDK requires the field and refuses to
          // sign without one. 'auto' is what Cloudflare documents.
          region: 'auto',
          endpoint: config.R2_ENDPOINT,
          credentials: {
            accessKeyId: config.R2_ACCESS_KEY_ID,
            secretAccessKey: config.R2_SECRET_ACCESS_KEY,
          },
        })
      : null;

    this.base = config.R2_PUBLIC_BASE_URL === '' ? null : validBase(config.R2_PUBLIC_BASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.destroy();
  }

  /**
   * Writes normalised WebP bytes, replacing whatever is at `objectKey`.
   *
   * A plain overwrite, with no read-before-write and no conditional header: the key is a
   * pure function of the country, so the object being replaced is always the previous
   * version of the SAME country's SAME slot. There is no key under which another
   * country's image could be reached, which is what makes an unconditional PUT safe here
   * and would make it reckless in a random-key scheme.
   *
   * `ContentType` is stated rather than inferred because a bucket serving
   * `application/octet-stream` makes a browser download the flag instead of rendering
   * it. `CacheControl` is long because the URL carries a `?v=` that changes whenever the
   * bytes do — see `publicUrl`.
   */
  async putWebp(objectKey: string, bytes: Buffer): Promise<void> {
    if (this.client === null) throw new CountryImageStorageUnavailable();

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: config.R2_BUCKET,
          Key: objectKey,
          Body: bytes,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (error) {
      // Logged in full, reported as nothing. The SDK's message names the endpoint and
      // frequently the access key id, neither of which may reach a response.
      this.logger.error({ err: error, objectKey }, 'country image upload failed');
      throw new CountryImageStorageUnavailable();
    }
  }

  /**
   * The public URL for a stored key, with a cache-buster.
   *
   * ─── Why `?v=` is not optional ────────────────────────────────────────────
   *
   * Objects are written at deterministic keys, so replacing a country's flag does not
   * change its URL. Combined with the year-long `CacheControl` above, a CDN would serve
   * the old image until the object expired. `version` is the country's
   * `imagesUpdatedAt`, so the query changes exactly when the bytes do: caches treat it
   * as a new resource, and the bucket still holds one object per slot.
   *
   * Returns null when no public base is configured, so a missing URL is reported as a
   * null field rather than as a broken link.
   */
  /**
   * Every country image in the bucket, newest first.
   *
   * ═══ THE BUCKET IS THE IMAGE LIBRARY ══════════════════════════════════════
   *
   * There is no database table of assets, and deliberately so: a second store of what
   * the bucket already knows is a second source of truth that goes stale the moment
   * anyone uploads out of band. `ListObjectsV2` IS the library.
   *
   * Both prefixes are listed — the current `country-assets/` layout and the original
   * `countries/` one — because an object written before the library existed is still a
   * perfectly good flag. Anything whose key does not PARSE is skipped rather than
   * guessed at: the bucket may hold objects this module did not write, and inventing a
   * type or a country for one of them would be worse than omitting it.
   *
   * Paginated to exhaustion. A truncated first page would silently hide flags an admin
   * is looking for, which reads as "that image is gone" rather than "we stopped early".
   */
  async listImages(): Promise<readonly CountryImageAsset[]> {
    if (this.client === null) throw new CountryImageStorageUnavailable();

    const assets: CountryImageAsset[] = [];

    try {
      for (const prefix of COUNTRY_ASSET_PREFIXES) {
        let token: string | undefined;

        do {
          const page = await this.client.send(
            new ListObjectsV2Command({
              Bucket: config.R2_BUCKET,
              Prefix: `${prefix}/`,
              ContinuationToken: token,
            }),
          );

          for (const object of page.Contents ?? []) {
            const key = object.Key;
            if (key === undefined) continue;

            // The key is the only metadata we trust, and it either parses or it is not
            // one of ours. No fallback, no inference from the filename.
            const parts = parseCountryImageKey(key);
            if (parts === null) continue;

            assets.push({
              key,
              url: this.publicUrl(key, object.LastModified ?? null),
              type: parts.slot,
              isoCode: parts.isoCode,
              bytes: object.Size ?? 0,
              uploadedAt: object.LastModified?.toISOString() ?? null,
            });
          }

          token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
        } while (token !== undefined);
      }
    } catch (error) {
      // Logged in full, reported as nothing. An unreachable bucket must NOT surface as
      // an empty library — that would invite an admin to re-upload flags that exist.
      this.logger.error({ err: error }, 'country image listing failed');
      throw new CountryImageStorageUnavailable();
    }

    // Newest first: the asset an admin just uploaded is the one they are looking for.
    return assets.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''));
  }

  /**
   * Whether an object is actually there.
   *
   * A HEAD, not a GET: the question is existence, and downloading a megabyte to answer
   * it would make creating a country cost two image downloads.
   *
   * A 404 is a clean `false`. Anything else — a network failure, a revoked credential —
   * is NOT false, because reporting "that image does not exist" when the truth is "we
   * could not ask" would tell an admin to re-upload a flag that is sitting right there.
   */
  async exists(objectKey: string): Promise<boolean> {
    if (this.client === null) throw new CountryImageStorageUnavailable();

    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      this.logger.error({ err: error, objectKey }, 'country image head failed');
      throw new CountryImageStorageUnavailable();
    }
  }

  publicUrl(objectKey: string, version: Date | null): string | null {
    if (this.base === null) return null;
    return composePublicUrl(this.base, objectKey, version);
  }
}

/**
 * A missing object, as the SDK reports it.
 *
 * R2 answers a HEAD for an absent key with 404 and an empty body, so there is no error
 * `name` to match on the way `NoSuchKey` would give a GET — the status is the signal.
 * Both shapes are checked because the SDK moved the field between major versions and a
 * silent miss here would turn every existence check into a storage failure.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey';
}

/**
 * Joins a validated base onto an object key, with the cache-buster.
 *
 * A free function rather than a method so it is testable without an environment: the
 * class reads the frozen `config` singleton at construction, which a spec cannot vary.
 * The adapter is then a thin wrapper over this and `validBase`, and both are exercised
 * directly.
 */
export function composePublicUrl(base: URL, objectKey: string, version: Date | null): string {
  // Resolved against the base's own path, so a base with a prefix (`https://cdn/assets/`)
  // keeps it. Each segment is encoded individually — `encodeURIComponent` on the whole
  // key would escape the slashes and flatten the path into one filename.
  const url = new URL(objectKey.split('/').map(encodeURIComponent).join('/'), base);

  if (version !== null) url.searchParams.set('v', String(version.getTime()));
  return url.toString();
}

/**
 * The public base, validated.
 *
 * https only — these URLs are embedded in pages and an http one would be a mixed-content
 * block at best. No userinfo, because credentials in a public asset URL are a leak. No
 * query and no fragment, because `publicUrl` appends its own `?v=` and a base carrying
 * either would produce a URL that silently drops the cache-buster or the base's own
 * parameters.
 *
 * A trailing slash is forced: `new URL('countries/IN/round.webp', 'https://cdn/assets')`
 * resolves against `/` and loses `assets`, which would point every image at the wrong
 * prefix without erroring.
 *
 * Borrowed wholesale from `validBase` in src/wallet/core/logo-storage.ts.
 */
export function validBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid environment:\n  R2_PUBLIC_BASE_URL: must be a valid URL');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Invalid environment:\n  R2_PUBLIC_BASE_URL: must be https with no credentials,' +
        ' query string or fragment',
    );
  }

  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
