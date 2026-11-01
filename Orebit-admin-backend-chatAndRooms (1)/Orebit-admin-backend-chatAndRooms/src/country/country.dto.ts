import { z } from 'zod';
import {
  COUNTRY_IMAGE_SLOTS,
  COUNTRY_NAME_MAX,
  countryCodeSchema,
  type CountryImageSlot,
} from './country.constants';
import { parseCountryImageKey, type CountryImageAsset, type CountryView } from './country.types';

/**
 * Request schemas for the country surface.
 *
 * Zod, `.strict()`, applied by hand at the controller — the house convention. Every
 * refusal here happens before anything is written to the database or the bucket, which
 * is where a refusal is cheapest and where the operator gets the clearest message.
 */

/**
 * The display name.
 *
 * Trimmed, because a trailing space is invisible in a UI and would make two otherwise
 * identical names look different in a sorted list. NOT uniquely constrained and not
 * normalised beyond that: two territories can legitimately share a rendering, and the
 * ISO code is what carries identity.
 */
const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(COUNTRY_NAME_MAX, `Name must be ${COUNTRY_NAME_MAX} characters or fewer`);

/**
 * An object key naming one of OUR assets, in the expected slot.
 *
 * ═══ WHY A KEY AND NOT A URL ═══════════════════════════════════════════════
 *
 * The client picks an image and sends back a reference. If that reference were a URL,
 * validating it would mean parsing a string an attacker controls and deciding whether it
 * points into our bucket — a game of prefix comparisons against redirects, userinfo
 * tricks and unicode hostnames that is lost far more often than it is won. Worse, a
 * stored URL bakes today's CDN hostname into permanent data.
 *
 * A KEY has neither problem. It is a path inside a bucket we name ourselves, it cannot
 * express another origin at all, and `parseCountryImageKey` either recognises it as one
 * of our two layouts or refuses it. `https://random-site.com/x.png` does not parse, and
 * there is no field on this schema that would accept it if it did.
 *
 * The slot is checked against what the caller CLAIMED, so `roundImageKey` pointing at a
 * square asset is refused rather than quietly stored — otherwise a UI mix-up would show
 * a square flag in a round frame for the life of the row.
 *
 * Existence in the bucket is NOT checked here. It needs a network call, and a DTO that
 * reaches out to storage would make every schema test require a bucket. The service
 * asks, through the port.
 */
function imageKeySchema(expected: CountryImageSlot) {
  return z
    .string()
    .trim()
    .min(1, 'An image key is required')
    .max(255)
    .superRefine((value, ctx) => {
      const parts = parseCountryImageKey(value);

      if (parts === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Not a recognised image key. Use a `key` returned by GET /countries/images ' +
            'or POST /countries/images — a URL or an external address is not accepted.',
        });
        return;
      }

      if (parts.slot !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `That key is a ${parts.slot} image, but a ${expected} image is required here.`,
        });
      }
    });
}

/**
 * Creating a country, now that the images are chosen before the row exists.
 *
 * ═══ KEYS ARE ACCEPTED; URLs ARE NOT ═══════════════════════════════════════
 *
 * Both images are REQUIRED. A country in the catalogue is something a client renders,
 * and half a flag pair is a broken render — so the record is never created in a state
 * that needs a follow-up call to become usable. That is what the image library buys: by
 * the time this request is made the admin has already chosen or uploaded both.
 *
 * `.strict()` is load-bearing rather than tidy. It is what turns
 * `{"roundImageUrl": "https://random-site.com/x.png"}` into a 400 naming the field,
 * instead of a silently ignored property and an admin who believes they attached an
 * image. There is no URL field on this schema and there is not meant to be one.
 */
export const countryCreateSchema = z
  .object({
    name: nameSchema,
    isoCode: countryCodeSchema,
    roundImageKey: imageKeySchema('round'),
    squareImageKey: imageKeySchema('square'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The same object cannot be both flags. It would parse as one slot and fail the
    // other, so this is unreachable today — but it states the rule rather than relying
    // on the key layout to imply it.
    if (value.roundImageKey === value.squareImageKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['squareImageKey'],
        message: 'The round and square images must be different assets.',
      });
    }
  });

export type CountryCreateRequest = z.infer<typeof countryCreateSchema>;

/**
 * The query for the catalogue read.
 *
 * A query string is not a body — every value arrives as a string — so this schema is
 * separate from the create body's, following `loginReviewQuerySchema`.
 *
 * `isoCode` is OPTIONAL: absent lists every country, present narrows to one. One route
 * and one response shape for both.
 */
export const countryQuerySchema = z
  .object({
    isoCode: countryCodeSchema.optional(),
  })
  .strict();

export type CountryQueryRequest = z.infer<typeof countryQuerySchema>;

/**
 * The query for the image library.
 *
 * Both filters are optional and both are conveniences over the same listing: an admin
 * creating `IN` wants `IN`'s existing flags first, and a round-image picker has no use
 * for square ones. Filtering happens after the bucket is read, because object storage
 * has no query language beyond a key prefix and a second round trip per filter would
 * buy nothing at this scale.
 */
export const countryImageQuerySchema = z
  .object({
    isoCode: countryCodeSchema.optional(),
    type: z.enum(COUNTRY_IMAGE_SLOTS).optional(),
  })
  .strict();

export type CountryImageQueryRequest = z.infer<typeof countryImageQuerySchema>;

/**
 * The fields accompanying one uploaded image.
 *
 * ═══ NO COUNTRY NEEDS TO EXIST ═════════════════════════════════════════════
 *
 * `isoCode` is where the asset is FILED, not a country it belongs to and not a row it
 * requires. An upload puts an object in the library and returns its key; creating the
 * country is a separate, later request that may never happen, and that is a supported
 * outcome rather than a leak — the asset simply stays in the library for the next admin.
 *
 * `type` is declared by the caller because it cannot be derived: a round flag and a
 * square one are both square rasters, and nothing in the bytes says which frame it is
 * meant for. It is folded into the object key, so the library can report it later
 * without a database.
 */
export const countryImageUploadSchema = z
  .object({
    isoCode: countryCodeSchema,
    type: z.enum(COUNTRY_IMAGE_SLOTS),
  })
  .strict();

export type CountryImageUploadRequest = z.infer<typeof countryImageUploadSchema>;

/**
 * The catalogue payload.
 *
 * Always `{ countries: [...] }`, even for a single-country query, so a client has one
 * shape to parse. Every entry carries `name` AND `isoCode` beside both URLs.
 */
export interface CountriesPayload {
  readonly countries: readonly CountryView[];
}

/**
 * The image-library payload.
 *
 * ═══ NOT THE SAME THING AS `CountriesPayload` ══════════════════════════════
 *
 * These are ASSETS in a bucket, not countries. They carry no name, and their `isoCode`
 * is the segment of their own key rather than a country record — see `CountryImageAsset`.
 * Conflating the two would make an unused upload look like a country that exists.
 */
export interface CountryImagesPayload {
  readonly images: readonly CountryImageAsset[];
}
