import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Country } from '@prisma/client';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { isUniqueViolation } from '../../db/client';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import type { CountryImageSlot } from './country.constants';
import { CountryDbOperation } from './country.dboperation';
import type {
  CountriesPayload,
  CountryCreateRequest,
  CountryImageQueryRequest,
  CountryImagesPayload,
} from './country.dto';
import {
  CountryImageInvalid,
  CountryImageStorageUnavailable,
  CountryImageTooLarge,
} from './country.errors';
import { normaliseCountryImage } from './country.processing';
import {
  COUNTRY_IMAGE_STORAGE,
  newCountryImageKey,
  type CountryImageAsset,
  type CountryImageStorage,
  type CountryView,
} from './country.types';

/**
 * ═══ R2 IS THE IMAGE LIBRARY; admin.countries IS THE CATALOGUE ═════════════
 *
 * The two are deliberately decoupled, and the whole flow follows from that:
 *
 *   browse or upload  →  an ASSET exists in the bucket, referenced by its key
 *   create a country  →  a ROW exists, holding two of those keys
 *
 * An upload never creates a row. A row can only be created from keys that already name
 * real objects. Nothing infers a country from a filename, from image content, or from
 * the ISO segment of a key — the binding is the key stored in the row, and that is the
 * only place it lives.
 *
 * What keeps a caller from binding a country to something that is not ours:
 *
 *   1. `parseCountryImageKey`, in the DTO, refuses anything outside our prefixes and
 *      checks the claimed slot against the key's own. A URL cannot parse at all.
 *   2. `storage.exists`, here, refuses a well-formed key for an object nobody uploaded.
 *   3. `UNIQUE(iso_code)` refuses a second row for the same country.
 */
@Injectable()
export class CountryService {
  private readonly logger = new Logger('Country');

  constructor(
    private readonly countries: CountryDbOperation,
    private readonly events: AuthEventDbOperation,
    @Inject(COUNTRY_IMAGE_STORAGE) private readonly storage: CountryImageStorage,
  ) {}

  /**
   * The image library: every country image in the bucket, optionally filtered.
   *
   * Reads object storage and NOTHING else — no database, no country records. An asset
   * here may be used by one country, by several, or by none at all, and the library
   * neither knows nor cares. That is what makes "select an existing image" possible for
   * a country that does not exist yet.
   *
   * A storage failure surfaces as 503 rather than an empty list: showing an admin an
   * empty library when the truth is "we could not ask" would invite them to re-upload
   * flags that are already there.
   */
  async listImages(filter: CountryImageQueryRequest): Promise<CountryImagesPayload> {
    let assets: readonly CountryImageAsset[];
    try {
      assets = await this.storage.listImages();
    } catch (error) {
      if (error instanceof CountryImageStorageUnavailable) {
        throw new ProblemException({ type: ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE });
      }
      throw error;
    }

    const images = assets.filter(
      (a) =>
        (filter.isoCode === undefined || a.isoCode === filter.isoCode) &&
        (filter.type === undefined || a.type === filter.type),
    );

    return { images };
  }

  /**
   * Stores one image in the library and returns its reference.
   *
   * ═══ THIS CREATES NO COUNTRY, AND REQUIRES NONE ════════════════════════════
   *
   * It touches object storage and the audit log, and never `admin.countries`. The
   * previous implementation looked the country up first and 404'd without it, which
   * forced an admin to create a half-built row before they could choose a flag for it.
   * Now the asset comes first and the row comes last, which is the order the form is
   * filled in.
   *
   * The returned key is what the client hands to `POST /countries`, and the returned URL
   * is what it renders as a preview in the meantime.
   *
   * Every upload mints a NEW key, so this can never overwrite an image already chosen by
   * a country or still sitting unused in the library.
   */
  async uploadImage(
    isoCode: string,
    slot: CountryImageSlot,
    bytes: Buffer,
    actor: Principal,
    client: ClientContext,
  ): Promise<CountryImageAsset> {
    const image = await this.normalise(slot, bytes);
    const key = newCountryImageKey(isoCode, slot);

    try {
      await this.storage.putWebp(key, image.content);
    } catch (error) {
      if (error instanceof CountryImageStorageUnavailable) {
        // The adapter has already logged the cause. Nothing about the endpoint, the
        // bucket or the credentials reaches the caller.
        throw new ProblemException({ type: ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE });
      }
      throw error;
    }

    this.logger.log(
      { actorAdminId: actor.adminId, isoCode, slot, key, bytes: image.bytes },
      'country image uploaded to the library',
    );

    await this.events.record({
      eventType: AUTH_EVENT.COUNTRY_IMAGE_UPLOADED,
      adminId: actor.adminId,
      client,
      metadata: {
        isoCode,
        type: slot,
        objectKey: key,
        bytes: image.bytes,
        sourceFormat: image.sourceFormat,
      },
    });

    return {
      key,
      url: this.storage.publicUrl(key, null),
      type: slot,
      isoCode,
      bytes: image.bytes,
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * Creates a country from two images the admin has already chosen.
   *
   * Order of operations:
   *
   *   1. Both keys are CONFIRMED to exist in the bucket. The DTO has already proved they
   *      are ours and in the right slots; this proves they are not well-formed references
   *      to objects nobody uploaded. Checked before the insert so a bad reference is a
   *      refusal rather than a row pointing at a 404.
   *   2. Insert, letting `UNIQUE(iso_code)` decide the duplicate question.
   *
   * `imagesUpdatedAt` is set to the creation instant: it records when the row's images
   * were last chosen, which for a create is now.
   */
  async create(
    input: CountryCreateRequest,
    actor: Principal,
    client: ClientContext,
  ): Promise<CountryView> {
    await this.assertAssetsExist(input);

    let row: Country;
    try {
      row = await this.countries.create({
        name: input.name,
        isoCode: input.isoCode,
        roundImageKey: input.roundImageKey,
        squareImageKey: input.squareImageKey,
        imagesUpdatedAt: new Date(),
      });
    } catch (error) {
      // The unique index is the authority, so the duplicate is recognised from the
      // violation rather than from a prior SELECT two admins could both pass.
      if (isUniqueViolation(error)) {
        throw new ProblemException({
          type: ERR.COUNTRY_ALREADY_EXISTS,
          detail: `A country with ISO code ${input.isoCode} already exists.`,
        });
      }
      throw error;
    }

    this.logger.log(
      {
        actorAdminId: actor.adminId,
        isoCode: row.isoCode,
        roundImageKey: row.roundImageKey,
        squareImageKey: row.squareImageKey,
      },
      'country created',
    );

    await this.events.record({
      eventType: AUTH_EVENT.COUNTRY_CREATED,
      adminId: actor.adminId,
      client,
      metadata: {
        isoCode: row.isoCode,
        name: row.name,
        roundImageKey: input.roundImageKey,
        squareImageKey: input.squareImageKey,
      },
    });

    return this.view(row);
  }

  /**
   * The catalogue: every country, or the one named.
   *
   * Reads the DATABASE, never the bucket. `GET /countries/images` is the other question
   * and they are not interchangeable: this one answers "which countries exist", that one
   * answers "which images can I choose from".
   */
  async list(isoCode?: string): Promise<CountriesPayload> {
    const rows = await this.countries.list(isoCode);

    if (isoCode !== undefined && rows.length === 0) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `No country is configured with ISO code ${isoCode}.`,
      });
    }

    return { countries: rows.map((row) => this.view(row)) };
  }

  /**
   * Both referenced objects must actually be in the bucket.
   *
   * Reported as a validation failure on the offending FIELD rather than a 404: from the
   * caller's side this is a bad value in a form they are submitting, and naming the
   * field is what lets a UI put the error next to the picker that produced it. A bare
   * 404 on `POST /countries` would also read as "no such route".
   *
   * A storage outage is NOT "the image does not exist" — `exists` throws rather than
   * returning false for anything that is not a clean 404, so an unreachable bucket
   * surfaces as 503 and the admin is told to retry instead of being told their image is
   * missing.
   */
  private async assertAssetsExist(input: CountryCreateRequest): Promise<void> {
    const checks = [
      ['roundImageKey', input.roundImageKey],
      ['squareImageKey', input.squareImageKey],
    ] as const;

    let present: readonly boolean[];
    try {
      present = await Promise.all(checks.map(([, key]) => this.storage.exists(key)));
    } catch (error) {
      if (error instanceof CountryImageStorageUnavailable) {
        throw new ProblemException({ type: ERR.COUNTRY_IMAGE_STORAGE_UNAVAILABLE });
      }
      throw error;
    }

    const missing = checks.filter((_, i) => present[i] !== true);
    if (missing.length === 0) return;

    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: missing.map(([path, key]) => ({
        path,
        message: `No image exists at "${key}". Choose one from GET /countries/images or upload it first.`,
      })),
    });
  }

  /** Normalisation failures, translated to the wire contract in one place. */
  private async normalise(
    slot: CountryImageSlot,
    bytes: Buffer,
  ): Promise<Awaited<ReturnType<typeof normaliseCountryImage>>> {
    try {
      return await normaliseCountryImage(slot, bytes);
    } catch (error) {
      if (error instanceof CountryImageTooLarge) {
        throw new ProblemException({ type: ERR.COUNTRY_IMAGE_TOO_LARGE, detail: error.message });
      }
      if (error instanceof CountryImageInvalid) {
        throw new ProblemException({ type: ERR.COUNTRY_IMAGE_INVALID, detail: error.message });
      }
      throw error;
    }
  }

  /**
   * One row as the API reports it.
   *
   * A URL is derived ONLY from a stored key, never guessed from the ISO code. Both keys
   * are non-null on every row the create path can produce, so a null URL here means
   * storage is unconfigured — not that the image is missing.
   */
  private view(row: Country): CountryView {
    return {
      id: row.id,
      name: row.name,
      isoCode: row.isoCode,
      roundImageUrl:
        row.roundImageKey === null
          ? null
          : this.storage.publicUrl(row.roundImageKey, row.imagesUpdatedAt),
      squareImageUrl:
        row.squareImageKey === null
          ? null
          : this.storage.publicUrl(row.squareImageKey, row.imagesUpdatedAt),
      imagesUpdatedAt: row.imagesUpdatedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
