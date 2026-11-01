import type { FastifyRequest } from 'fastify';
import { COUNTRY_IMAGE_MAX_BYTES } from './country.constants';
import { CountryImageInvalid, CountryImageTooLarge } from './country.errors';

/**
 * Reading one image, its type and its ISO code out of a multipart request.
 *
 * Kept here rather than in `country.routes.ts` because it is the one place in this
 * module that must touch a `FastifyRequest`. The routes layer hands plain values
 * downward everywhere else, which is what keeps the controller and service testable
 * without an HTTP request; this file is the seam where that stops being possible.
 *
 * ═══ ONE IMAGE PER REQUEST ════════════════════════════════════════════════
 *
 * The previous version took both flags at once, because both were being attached to a
 * country in a single write. In the library flow an upload is just "put this asset in
 * the bucket and tell me its key" — an admin may upload a round image, keep the square
 * one they already had, and never send a second file at all. Demanding both would make
 * the common case impossible.
 *
 * ═══ LIMITS ARE DECLARED TWICE, ON PURPOSE ════════════════════════════════
 *
 * `@fastify/multipart` is registered in country.module.ts with these same limits, and
 * they are restated on the call below. The registration's are what Fastify enforces
 * while the request is still streaming — they bound an untrusted upload before any of it
 * is in memory. The ones here are the handler asserting its own contract rather than
 * inheriting whatever a future plugin registration happens to say.
 */

/** The multipart surface of a Fastify request, once the plugin is registered. */
type MultipartRequest = FastifyRequest &
  Readonly<{
    parts(options?: {
      limits?: { fileSize?: number; files?: number; fields?: number; parts?: number };
    }): AsyncIterableIterator<MultipartPart>;
  }>;

type MultipartPart =
  | Readonly<{
      type: 'file';
      fieldname: string;
      file: { truncated: boolean };
      toBuffer(): Promise<Buffer>;
    }>
  | Readonly<{ type: 'field'; fieldname: string; value: unknown }>;

export interface CountryImageMultipart {
  /** Raw and unvalidated — `countryImageUploadSchema` is applied by the controller. */
  readonly fields: { readonly isoCode: unknown; readonly type: unknown };
  readonly image: Buffer;
}

/**
 * Consumes the whole multipart body and returns the file and its fields.
 *
 * ─── Why every part is drained before anything is validated ───────────────
 *
 * Multipart part ORDER IS NOT GUARANTEED. A client may legitimately send the file before
 * the fields, and a reader that checked for them first would reject valid requests
 * depending on how the sender happened to serialise them. So the loop runs to completion
 * and the validation happens after.
 *
 * That is safe because the byte ceiling is enforced by the STREAM, not by this loop: at
 * most one file of at most 1 MiB can be buffered whatever order things arrive in.
 * `file.truncated` is checked immediately after buffering, because Fastify signals the
 * overrun there rather than by throwing.
 *
 * An unexpected field name is rejected rather than ignored — the `.strict()` reflex
 * applied to a multipart body. A client sending `flag=` instead of `image=` should be
 * told, not handed a "missing image" error about a file it did send.
 */
export async function readCountryImageMultipart(
  request: MultipartRequest,
): Promise<CountryImageMultipart> {
  let image: Buffer | undefined;
  let isoCode: unknown;
  let type: unknown;

  try {
    for await (const part of request.parts({
      limits: { fileSize: COUNTRY_IMAGE_MAX_BYTES, files: 1, fields: 2, parts: 3 },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'image') {
          throw new CountryImageInvalid(
            `Unexpected file field "${part.fieldname}" — the file must be sent as "image".`,
          );
        }
        if (image !== undefined) {
          throw new CountryImageInvalid('Only one image may be uploaded per request.');
        }

        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new CountryImageTooLarge('The image must not exceed 1 MiB.');
        }
        image = buffer;
        continue;
      }

      if (part.fieldname === 'isoCode') {
        isoCode = part.value;
        continue;
      }
      if (part.fieldname === 'type') {
        type = part.value;
        continue;
      }
      throw new CountryImageInvalid(`Unexpected field "${part.fieldname}".`);
    }
  } catch (error) {
    if (error instanceof CountryImageInvalid || error instanceof CountryImageTooLarge) throw error;

    // Fastify signals a stream-level overrun with this code rather than by setting
    // `truncated`, depending on where the limit is hit.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      throw new CountryImageTooLarge('The image must not exceed 1 MiB.');
    }

    // A malformed body, a missing boundary, a truncated stream. The parser's own message
    // describes its internals, so it is replaced.
    throw new CountryImageInvalid('The upload could not be read as multipart form data.');
  }

  if (image === undefined) throw new CountryImageInvalid('An image file is required.');

  return { fields: { isoCode, type }, image };
}
