/**
 * ISO 3166-1 alpha-2, and the limits every country image is held to.
 *
 * ═══ THIS LIST IS A COPY, AND tests/country/country.drift.spec.ts IS WHY ═══
 *
 * The same 249 codes live in `../Orebit-backend/src/utils/country.ts`, which is the
 * consumer's registration validator. There is no shared package between the two
 * services — no workspace, no monorepo — and every other shared constant in this
 * platform is copied the same way, with a drift spec holding the two halves together.
 *
 * The duplication matters here more than usual because the value is STORED AND KEYED
 * ON: an admin creates `IN`, its assets are filed under `country-assets/IN/...`, and the
 * consumer matches the stored code against `users.country_declared`. A code accepted by
 * one service and not the other is a country whose flag never renders, and TypeScript
 * would say nothing in either repository.
 *
 * It is a literal rather than `Intl.supportedValuesOf` or an npm package for the reason
 * the consumer's copy gives: which countries the platform recognises is a product
 * decision with regulatory weight, so it has to be a reviewable diff. A dependency bump
 * must never silently change it.
 *
 * The list is the current ISO assignment, NOT a filtered "supported" set. Deciding
 * where the platform operates is the geo and KYC policy engines' job; conflating the
 * two would make "is this a real country" and "do we serve it" the same question, and
 * they are not — a country can be catalogued here, flag and all, while policy declines
 * to serve it.
 */

import { z } from 'zod';

const CODES = [
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW',
] as const;

const CODE_SET: ReadonlySet<string> = new Set(CODES);

export const COUNTRY_CODES: readonly string[] = CODES;

/** True for a valid alpha-2 code. Case-insensitive; callers store uppercase. */
export function isCountryCode(value: string): boolean {
  return CODE_SET.has(value.toUpperCase());
}

/**
 * The request-boundary form of the rule: trim, require two characters, uppercase, then
 * check the list.
 *
 * `.toUpperCase()` runs BEFORE the refinement, so `in` and `IN` are the same country and
 * only one of them can ever reach storage. That normalisation is what lets a key be
 * MINTED from the parsed value without re-checking it, and what lets one be PARSED back
 * with a plain string comparison — see `parseCountryImageKey`, which refuses a lowercase
 * code precisely because nothing should ever have produced one.
 */
export const countryCodeSchema = z
  .string()
  .trim()
  .length(2, 'Must be a 2-letter ISO country code')
  .toUpperCase()
  .refine(isCountryCode, 'Unknown country code');

/**
 * The display name's bounds.
 *
 * 80 characters fits the longest official ISO short name — "The United Kingdom of Great
 * Britain and Northern Ireland" is 66 — with room for a longer rendering, and matches
 * `countries.name`'s VARCHAR(80).
 */
export const COUNTRY_NAME_MAX = 80;

/**
 * ═══ IMAGE LIMITS ═════════════════════════════════════════════════════════
 *
 * Both assets are SQUARE canvases. The "round" one is a circular crop carried on a
 * square canvas with alpha, not an image with a different aspect ratio — so one rule
 * covers both and a non-square upload is a mistake rather than a variant.
 *
 * 512 rather than the wallet logo's 500: flags are rendered at more sizes than a coin
 * icon and 512 is the power-of-two every asset pipeline already emits. The ceiling is
 * on the SOURCE, and it also bounds the decode — it is passed to sharp as
 * `limitInputPixels`, which is what makes a decompression bomb fail before it allocates.
 */
export const COUNTRY_IMAGE_DIMENSION = 512;

/** 1 MiB, before and after normalisation. A flag that needs more is not a flag. */
export const COUNTRY_IMAGE_MAX_BYTES = 1_048_576;

/** The two assets every country carries. Also the `type` the image library reports. */
export const COUNTRY_IMAGE_SLOTS = ['round', 'square'] as const;

export type CountryImageSlot = (typeof COUNTRY_IMAGE_SLOTS)[number];

/**
 * ═══ WHERE COUNTRY IMAGES LIVE IN THE BUCKET ═══════════════════════════════
 *
 * `country-assets/{ISO}/{slot}/{uuid7}.webp`
 *
 * The uuid is what makes an upload NON-DESTRUCTIVE, and that is the whole reason this
 * prefix exists. The bucket is an image LIBRARY: an admin browses it, picks a flag, or
 * uploads a new one — and a new upload must never destroy a flag some other country is
 * already using, or one this admin might still want. A key of `countries/{ISO}/round.webp`
 * has exactly one slot per country and type, so the second round image uploaded for `IN`
 * would overwrite the first, silently, including one already referenced by a live row.
 *
 * Both the slot and the ISO code stay READABLE from the key, which is what lets the
 * library answer "round or square?" and "which country was this uploaded for?" without a
 * database. `parseCountryImageKey` in country.types.ts is the only reader.
 *
 * The ISO segment is organisational, not a claim of ownership: an asset uploaded under
 * `IN` may legitimately be selected for any country. What binds an image to a country is
 * the key stored in `admin.countries`, and nothing else.
 */
export const COUNTRY_ASSET_PREFIX = 'country-assets';

/**
 * The ORIGINAL layout: `countries/{ISO}/{slot}.webp`.
 *
 * Still listed by the image library and still selectable, because objects written under
 * it before the library existed are perfectly good flags and deleting them to tidy a
 * naming scheme would be vandalism. Nothing WRITES here any more — every upload goes to
 * `COUNTRY_ASSET_PREFIX` — so these objects are now immutable in practice.
 */
export const COUNTRY_LEGACY_PREFIX = 'countries';

/**
 * Every prefix the image library reads, and the only prefixes a client-supplied key may
 * sit under. A key outside both is refused before it reaches storage — see
 * `parseCountryImageKey`.
 */
export const COUNTRY_ASSET_PREFIXES = [COUNTRY_ASSET_PREFIX, COUNTRY_LEGACY_PREFIX] as const;
