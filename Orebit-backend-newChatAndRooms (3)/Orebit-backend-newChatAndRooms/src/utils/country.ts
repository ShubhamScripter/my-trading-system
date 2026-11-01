/**
 * ISO 3166-1 alpha-2.
 *
 * A literal list rather than a runtime check against `Intl.supportedValuesOf` or
 * an npm package: the set of countries the platform recognises is a product
 * decision with regulatory weight, so it needs to be a reviewable diff in this
 * repository. A dependency bump must never silently change which countries can
 * register.
 *
 * The list is the current ISO assignment (249 codes) — not a filtered
 * "supported" set. Restricting where the platform operates is the geo policy
 * engine's job, not this file's; conflating the two would make "is this a real
 * country" and "do we serve it" the same question, and they are not.
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

/** Uppercased code, or null if it is not one. */
export function normaliseCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return CODE_SET.has(upper) ? upper : null;
}

/**
 * The request-boundary form of the same rule: trim, require two characters,
 * uppercase, then check the list above.
 *
 * It lives here rather than in one module's DTO file because two of them ask the
 * question — registration's country step and the profile update — and a country
 * accepted by one endpoint but not the other would be a bug nothing catches. The
 * schema belongs next to the list it validates against, for the same reason the
 * list is a literal: both are reviewable in one diff.
 */
export const countrySchema = z
  .string()
  .trim()
  .length(2, 'Must be a 2-letter ISO country code')
  .toUpperCase()
  .refine(isCountryCode, 'Unknown country code');
