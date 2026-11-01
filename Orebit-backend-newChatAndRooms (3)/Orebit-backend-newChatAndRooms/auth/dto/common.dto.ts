import { z } from "zod";
import { CAPTCHA_PROVIDERS } from "../../src/captcha/captcha.types";
import { countrySchema } from "../../src/utils/country";
import {
  CONTINUATION,
  EMAIL,
  PASSWORD,
  PUBLIC_CODE,
  STEP_UP,
  USERNAME,
} from "../auth.constants";

/**
 * Field-level schemas shared across the auth DTOs. Every request schema is
 * assembled from these, so a rule like "what counts as a strong password" is
 * defined once.
 */

/**
 * ═══ THE TWO TEMPORARY FLOW HANDLES, AS FIELDS IN THE BODY ══════════════════
 *
 * `signupId` names an in-flight registration; `loginId` names an in-flight
 * sign-in. Each is minted by its flow's `start` step, returned in the response,
 * and echoed back by the client on every later step of that flow — and, for
 * `loginId`, on `POST /auth/2fa/verify` as well.
 *
 * ─── They are CREDENTIALS, despite the `Id` suffix ──────────────────────────
 *
 * Every other `*Id` in this codebase is a public handle that authorises nothing —
 * `deviceId` says so at length in auth.constants.ts, `publicCode` is printed on
 * screen. These two are the opposite: 256 bits of CSPRNG output each, and the only
 * thing standing between a stranger and someone else's half-finished signup or
 * half-authenticated sign-in. Treat them like the password field they sit next to,
 * not like a row id.
 *
 * They are NOT the database primary key of the row they name. That key never
 * leaves the server, so a leaked response body cannot be used to drive somebody
 * else's flow, and only a peppered hash of the handle is stored — a database dump
 * hands over nothing usable.
 *
 * ─── What moving them out of cookies traded away ────────────────────────────
 *
 * `signupId` used to live in the httpOnly `orebit_reg` cookie. That bought two
 * things this does not: script on the page could not read it, and `sameSite`
 * kept it off cross-site requests. Both are genuinely gone — an XSS on the signup
 * page can now lift an in-flight registration. The reasons it moved anyway are in
 * `CONTINUATION` in auth.constants.ts. (`loginId` lost nothing, because the cookie
 * its constants described was never actually implemented — see `STEP_UP`.)
 *
 * A client holds them in memory for the life of the flow. NOT in localStorage or
 * sessionStorage: persisting one converts a page-lifetime exposure into one that
 * outlives the tab, which is the whole of what the cookie was protecting against.
 */

/**
 * Derived rather than written out — 4 base64url characters per 3 bytes, rounded
 * up — so changing `SECRET_BYTES` cannot leave these validating the old length.
 */
const SIGNUP_ID_LENGTH = Math.ceil((CONTINUATION.SECRET_BYTES * 4) / 3);
const LOGIN_ID_LENGTH = Math.ceil((STEP_UP.SECRET_BYTES * 4) / 3);

/**
 * A shape check, not a security check.
 *
 * The authority is the peppered-hash lookup that resolves the handle to a row;
 * this only stops junk — or a 4KB string — from reaching sha256 and a database
 * round trip on every request. The real defences are elsewhere and are listed on
 * the flow rows themselves: secure generation, hash at rest, server-side lookup,
 * absolute expiry, state validation, context binding, and single use.
 *
 * Deliberately no `.trim()` and no whitespace strip, unlike `otpCodeSchema`. That
 * transform exists because a human retypes a six-digit code from an email; nobody
 * retypes 43 characters of base64url, so normalising here would only turn a client
 * bug into an unexplainable mismatch.
 */
function flowHandleSchema(length: number, label: string): z.ZodString {
  return z
    .string()
    .length(length, `Must be a ${label}`)
    .regex(/^[A-Za-z0-9_-]+$/, `Must be a ${label}`);
}

export const signupIdSchema = flowHandleSchema(SIGNUP_ID_LENGTH, "signup id");
export const loginIdSchema = flowHandleSchema(LOGIN_ID_LENGTH, "login id");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(EMAIL.MIN_LENGTH)
  // 254 is the RFC 5321 maximum for a forward path.
  .max(EMAIL.MAX_LENGTH)
  .email("Must be a valid email address");

/**
 * Captcha, as a reusable pair.
 *
 * Both fields are REQUIRED, and verification is real: `CaptchaService` calls the
 * provider's siteverify endpoint on every gated request, pins the hostname, checks
 * the v3 score, and runs an escalating per-IP penalty. There is no bypass in any
 * environment. A client that omits these fails validation, which is exactly the
 * signal a frontend author needs.
 */
export const captchaSchema = z.object({
  captchaProvider: z.enum(CAPTCHA_PROVIDERS),
  captchaToken: z.string().min(1, "Captcha token is required").max(4096),
});

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Must be a 6-digit code");

/**
 * Password strength.
 *
 * Length and all four character classes — lowercase, uppercase, digit, and
 * special character — are checked here; the checks that need to
 * compare against *other* fields — that it does not contain the email local-part
 * or the username — cannot live in a field schema and are applied in
 * credential.service.ts, which is the only place both values are in hand.
 */
export const passwordSchema = z
  .string()
  .min(
    PASSWORD.MIN_LENGTH,
    `Must be at least ${PASSWORD.MIN_LENGTH} characters`,
  )
  .max(PASSWORD.MAX_LENGTH, `Must be at most ${PASSWORD.MAX_LENGTH} characters`)
  .refine(
    (value) => characterClassCount(value) === PASSWORD.MIN_CHARACTER_CLASSES,
    "Must include a lowercase letter, uppercase letter, number, and special character",
  );

export function characterClassCount(value: string): number {
  let count = 0;
  if (/[a-z]/.test(value)) count += 1;
  if (/[A-Z]/.test(value)) count += 1;
  if (/\d/.test(value)) count += 1;
  if (/[^a-zA-Z0-9\s]/.test(value)) count += 1;
  return count;
}

/** Re-exported, not redefined: the rule and the list it checks against live
 *  together in src/utils/country.ts, because the registration step and the profile
 *  update below ask the same question and the two must not be able to disagree. */
export { countrySchema };

/**
 * Fields an authenticated user may currently update on their own profile.
 *
 * `.strict()` so an unknown key is a 400 rather than a silent no-op — a client
 * sending `{ username: "..." }` must learn that the field is not updatable here,
 * not get a 200 that changed nothing.
 */
export const updateMyProfileRequestSchema = z
  .object({
    country: countrySchema,
  })
  .strict();

export type UpdateMyProfileRequest = z.infer<typeof updateMyProfileRequestSchema>;

/**
 * A login identifier: email, username, or `OREBiT…` public code.
 *
 * Deliberately NOT a discriminated union of three named fields. The product shows
 * one input box, so the API takes one value and works out what it is — see
 * `classifyIdentifier` below. Making the client pre-classify would push a
 * question it cannot reliably answer (is `abc123` a username or a code?) onto the
 * frontend.
 */
export const identifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(EMAIL.MAX_LENGTH);

export type IdentifierKind = "email" | "publicCode" | "username";

/**
 * Which kind of identifier a string is.
 *
 * Order matters. An `@` can appear in none of the others, so email is
 * unambiguous and goes first. The public code has a fixed prefix, which no
 * username can have because `sanitiseUsernameSeed` lowercases and the comparison
 * here is case-insensitive on a prefix no generated username produces. Anything
 * else is treated as a username — including a string that matches nothing, which
 * simply fails to resolve and returns the same `invalid_credentials` as a wrong
 * password.
 */
export function classifyIdentifier(value: string): IdentifierKind {
  if (value.includes("@")) return "email";
  if (
    value.length === PUBLIC_CODE.PREFIX.length + PUBLIC_CODE.RANDOM_LENGTH &&
    value.toUpperCase().startsWith(PUBLIC_CODE.PREFIX.toUpperCase())
  ) {
    return "publicCode";
  }
  return "username";
}

/**
 * A username-SHAPED string. Not a username this caller is allowed to have.
 *
 * The lower bound is `PREMIUM_MIN_LENGTH` — the shortest username the product issues
 * to anyone — and deliberately not `DEFAULT_MIN_LENGTH`. The floor that actually
 * applies depends on whether the account holds Premium, which is an entitlement lookup
 * this layer cannot perform and must not guess: a DTO that assumed the free floor would
 * refuse a Premium user their two-character name before the service ever saw it, and
 * one that read the tier from the request body would take the client's word for what it
 * is owed.
 *
 * So the split is: shape here, policy in `UsernameService`, which re-runs the length
 * band against the tier it resolved itself. Same division as `resolvePaymentPinProof`,
 * which the DTO and the service both call.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME.PREMIUM_MIN_LENGTH)
  .max(USERNAME.MAX_LENGTH)
  .regex(
    /^[a-z0-9_]+$/,
    "May contain only lowercase letters, digits and underscores",
  );

export const referralCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4)
  .max(32);

/**
 * The same code, on the screens where entering one is the user's choice.
 *
 * A blank string normalises to "absent" rather than failing: a form field the user
 * left alone submits `""`, and requiring the client to omit the key entirely to
 * mean "no code" is a rule frontends get wrong — usually by sending `""` and
 * getting a validation error on a field the product calls optional. `undefined`,
 * a missing key, and `""` therefore all mean the same thing here.
 *
 * Note this only relaxes *presence*. A code that is actually typed still has to
 * satisfy `referralCodeSchema`, so a two-character entry is still a 400 rather
 * than a silently ignored referral.
 */
export const optionalReferralCodeSchema = z
  // A union rather than `z.preprocess`, which infers its input as `unknown` and
  // would push that `unknown` all the way out into `RegisterRequest`.
  .union([referralCodeSchema, z.string().trim().max(0)])
  .optional()
  .transform((value) =>
    value === undefined || value === "" ? undefined : value,
  );
