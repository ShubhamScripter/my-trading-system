import { z } from 'zod';
import { CAPTCHA_PROVIDERS } from '../../src/captcha/captcha.types';
import { EMAIL, OTP, PASSWORD, STEP_UP } from '../auth.constants';

/**
 * Field schemas shared across the DTOs.
 *
 * Every request body in this service is parsed by one of these at the controller,
 * via `parseDto`. Defining the fields once means "what counts as a valid email"
 * has one answer rather than one per endpoint.
 */

/**
 * ═══ THE IN-FLIGHT SIGN-IN, AS A FIELD IN THE BODY ═══════════════════════════
 *
 * The value that identifies a half-finished sign-in. Minted by `step: 'password'`,
 * returned in the response, and echoed back on every later step of `POST
 * /auth/login` and on the four sign-in actions of `POST /2fa`.
 *
 * ─── Two names for one value, and that is deliberate ────────────────────────
 *
 * On the wire it is `loginId`. Inside the service it is `stepUpSecret`, and at
 * rest it is `AdminLoginAttempt.stepUpSecretHash`. The internal names were left
 * alone on purpose: a third name for one value is worse than two, and the hash
 * domain tag (`pepperedHash(value, 'stepup')`) is mixed into the digest, so
 * renaming it would silently invalidate every live attempt row.
 *
 * ─── It is a CREDENTIAL, despite the `Id` suffix ────────────────────────────
 *
 * Every other `*Id` in this codebase is a public handle that authorises nothing —
 * `deviceId` says so at length in auth.constants.ts, `factorId` in 2fa.types.ts.
 * This one is the opposite: 256 bits of CSPRNG output, and the only thing standing
 * between a stranger and a half-authenticated admin sign-in. Treat it like the
 * password field it sits next to, not like a row id.
 *
 * ─── What moving it out of the cookie traded away ───────────────────────────
 *
 * It used to live in the httpOnly `orebit_admin_step` cookie. That bought two
 * things this does not: script on the page could not read it, and `sameSite:
 * 'strict'` kept it off cross-site requests. Both are genuinely gone — an XSS on
 * the admin panel can now lift an in-flight sign-in.
 *
 * It was moved anyway, for three reasons the cookie could not answer: the cookie's
 * path was root, so an in-flight secret rode on every authenticated request; two
 * tabs shared one cookie, so a second sign-in silently clobbered the first; and
 * the documented header alternative never worked, because the server only ever
 * READ that header and never set it — leaving no way for a native client to drive
 * the ceremony at all.
 *
 * ─── What still bounds it ───────────────────────────────────────────────────
 *
 *  - the row expires in `STEP_UP.TTL_SECONDS` (10 minutes) and `assertLive`
 *    refuses it after that;
 *  - it is single-use: `AttemptDbOperation.complete` nulls the hash in the SAME
 *    statement that sets `completedAt`, so there is no interval in which a spent
 *    secret is still matchable;
 *  - it authorises no step by itself — `STEP_REQUIRES` and
 *    `TWO_FACTOR_STATE_REQUIRES` gate every operation on the attempt's state;
 *  - CORS admits exactly one origin, so a cross-site page cannot read a response
 *    to learn one.
 *
 * A client must hold it in memory for the life of the sign-in. NOT in
 * localStorage or sessionStorage — persisting it converts a page-lifetime
 * exposure into one that outlives the tab, which is the whole of what the cookie
 * was protecting against.
 */

/**
 * Derived rather than written out — 4 base64url characters per 3 bytes, rounded
 * up — so changing `SECRET_BYTES` cannot leave this validating the old length.
 * The same technique as `DEVICE_ID_LENGTH` in auth.utility.ts.
 */
const LOGIN_ID_LENGTH = Math.ceil((STEP_UP.SECRET_BYTES * 4) / 3);

/**
 * A shape check, not a security check. The authority is the peppered-hash lookup
 * in `AttemptDbOperation.findBySecretHash`; this only stops junk — or a 4KB
 * string — from reaching sha256 and a database round trip on every request.
 *
 * Deliberately no `.trim()` and no whitespace strip, unlike `otpSchema`. That
 * transform exists because a human retypes a six-digit code from an email; nobody
 * retypes 43 characters of base64url, so normalising here would only turn a
 * client bug into an unexplainable mismatch.
 */
export const loginIdSchema = z
  .string()
  .length(LOGIN_ID_LENGTH, 'must be a login id')
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a login id');

/**
 * An email address.
 *
 * Zod's `.email()` is deliberately the only structural check — no MX lookup, no
 * disposable-domain list. This service has no signup: every address that matters
 * was written by a seed script, so validating shape is all a request body needs.
 *
 * `.max(EMAIL.MAX_LENGTH)` is the RFC 5321 limit and, more practically, stops an unbounded
 * string reaching argon2's policy comparison.
 */
export const emailSchema = z
  .string()
  .trim()
  .min(EMAIL.MIN_LENGTH)
  .max(EMAIL.MAX_LENGTH)
  .email('must be a valid email address');

/**
 * A one-time code: exactly `OTP.LENGTH` digits.
 *
 * Whitespace is stripped before validation rather than rejected, because a code
 * pasted from an email or an authenticator app frequently arrives as `123 456`
 * and telling someone that is malformed is a bug, not a defence.
 */
export const otpSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(
    z
      .string()
      .length(OTP.LENGTH, `must be ${OTP.LENGTH} digits`)
      .regex(/^\d+$/, 'must be digits only'),
  );

/**
 * A new password.
 *
 * Length and character classes only. The rules that compare a password against
 * the account's own values — its email, its name — live in
 * `CredentialService.assertPolicy`, because a field schema structurally cannot see
 * the account it is for.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD.MIN_LENGTH, `must be at least ${PASSWORD.MIN_LENGTH} characters`)
  .max(PASSWORD.MAX_LENGTH, `must be at most ${PASSWORD.MAX_LENGTH} characters`)
  .regex(/[a-z]/, 'must contain a lowercase letter')
  .regex(/[A-Z]/, 'must contain an uppercase letter')
  .regex(/\d/, 'must contain a digit')
  .regex(/[^a-zA-Z0-9\s]/, 'must contain a special character');

/**
 * A password being PRESENTED rather than chosen.
 *
 * Bounded but not policy-checked, which is the distinction that matters: applying
 * `passwordSchema` at the login step would reject a wrong password with
 * `validation_failed` and a list of complaints about its composition — telling a
 * caller their guess did not even meet the policy, which narrows the search
 * space, and telling a legitimate admin whose password predates a policy change
 * that their own password is invalid rather than that it is wrong.
 */
export const presentedPasswordSchema = z.string().min(1).max(PASSWORD.MAX_LENGTH);

/**
 * The captcha pair: which provider issued the token, and the token.
 *
 * ─── Why the client names the provider ──────────────────────────────────────
 *
 * Several providers may be live at once (see src/captcha/captcha.types.ts), so
 * the server cannot infer which one minted a given token. The client renders a
 * widget and reports which — matching the consumer backend's contract, so a
 * frontend that already talks to that API needs no second shape.
 *
 * This is not a client choosing whether to be verified. The server holds one
 * secret per provider: an unconfigured provider is `captcha_provider_unavailable`,
 * and a token minted by one provider fails another's siteverify. The field
 * selects WHICH check runs, never WHETHER one runs.
 *
 * ─── Why both are optional ──────────────────────────────────────────────────
 *
 * So a local environment with no provider configured can drive the flow.
 * `CaptchaService.verify` short-circuits only when NO provider is configured, and
 * config.ts refuses to boot in production without one, so this cannot become a way
 * to skip a live captcha.
 *
 * They are optional INDIVIDUALLY here but required TOGETHER once captcha is on —
 * a combination rule, which cannot live in a field schema and would break
 * `z.discriminatedUnion` if bolted on with `.refine()` (that yields a ZodEffects,
 * not a ZodObject). `AuthController.verifyCaptcha` enforces the pairing, the same
 * way config.ts keeps its cross-variable rules out of its schema.
 */
export const captchaProviderSchema = z.enum(CAPTCHA_PROVIDERS).optional();

export const captchaTokenSchema = z.string().min(1).max(4096).optional();

/**
 * A WebAuthn response, passed through to `@simplewebauthn/server` unaltered.
 *
 * Typed as a permissive record on purpose. The real validation is cryptographic
 * and happens inside the library — it checks the signature, the origin, the RP ID
 * and the challenge — so a hand-written Zod shape here would duplicate the
 * library's own parsing while being the thing that goes stale when the WebAuthn
 * spec adds a field.
 *
 * What IS enforced: it must be an object with a string `id`. That is the field
 * this service itself reads, to look up which passkey is being asserted, so it is
 * the one field a schema has any business demanding.
 */
export const webauthnResponseSchema = z
  .object({ id: z.string().min(1).max(1024) })
  .passthrough();
