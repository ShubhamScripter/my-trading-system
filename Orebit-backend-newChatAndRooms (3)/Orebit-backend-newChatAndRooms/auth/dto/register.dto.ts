import { z } from 'zod';
import {
  captchaSchema,
  countrySchema,
  emailSchema,
  optionalReferralCodeSchema,
  otpCodeSchema,
  passwordSchema,
  signupIdSchema,
} from './common.dto';

/**
 * `POST /auth/register` — one route, eight steps, one discriminated union on
 * `step`.
 *
 * ─── `signupId`, and why it is not the `registrationId` this used to have ───
 *
 * Six of the shapes below once carried a `registrationId`: the registration row's
 * own primary key, chosen by whoever was asking. That was removed, because a
 * client naming a row by its id can name any row — the value authorised nothing,
 * so possessing it was not evidence of anything.
 *
 * What replaced it was an opaque server-minted secret, and for a while that secret
 * travelled in the httpOnly `orebit_reg` cookie. It is now a field in the body
 * again, as `signupId` — but it is emphatically NOT a return to `registrationId`.
 * The distinction is the whole point and it is about the VALUE, not the transport:
 * a database id is guessable, enumerable, and names a row whether or not you were
 * ever given it, while `signupId` is 256 bits of CSPRNG output whose hash is the
 * only thing the row can be found by. See `signupIdSchema` in common.dto.ts for
 * what moving it out of the cookie cost.
 *
 * `step` is not a substitute for either, and the two were never interchangeable:
 * `step` says which operation to run, `signupId` says which registration to run it
 * against. Losing the second entirely would leave the email as the only candidate
 * key, and an email is public — anyone could then walk a stranger's verified
 * registration through `credentials` and `country` and be handed a session for it.
 *
 * So every schema below is either self-identifying (`start`, which creates the
 * registration) or carries `signupId`.
 *
 * `z.discriminatedUnion` dispatches on `step` and reports errors against the
 * matched variant only; a plain union would report all eight variants' failures
 * for one bad request, which is unusable for a client. It also makes an unknown
 * `step` a validation error naming the legal values rather than a silent no-op.
 * Cross-field rules cannot be `.refine`d onto a member (a refined member is a
 * ZodEffects, which `discriminatedUnion` rejects), so the password/skip interplay
 * is applied in `superRefine` on the assembled union.
 */

/**
 * `.strict()`, so `start` REFUSES a `signupId` rather than ignoring one.
 *
 * This is the step that mints a handle, so a body carrying one is a client that
 * has lost track of where it is in the flow. Silently dropping the field would
 * start a second registration and return a second handle while the caller
 * believed it was continuing the first — a loud error is the only honest answer.
 */
const startSchema = z
  .object({
    step: z.literal('start'),
    email: emailSchema,
  })
  .merge(captchaSchema)
  .strict();

const resendOtpSchema = z.object({
  step: z.literal('resend-otp'),
  signupId: signupIdSchema,
});

const verifyEmailSchema = z.object({
  step: z.literal('verify-email'),
  signupId: signupIdSchema,
  code: otpCodeSchema,
});

/**
 * The one place a referral code is entered.
 *
 * It both checks and stores: a code that resolves is remembered on the
 * registration, and one that does not is cleared. That is what makes
 * `referralApplied` mean "a real referrer is attached" rather than "the user
 * typed something", and it is why `credentials` carries no referral field —
 * two writers for one column gave the flag two different meanings.
 *
 * `code` is optional because the screen it backs is optional: the user may enter
 * a code, or clear one they already entered, or move on without ever touching the
 * field. Sending the step with no code is the "no referral" answer — it clears
 * whatever was stored and reports `valid: false` — which is why this is not simply
 * a step the client omits. Omitting it leaves a previously matched code applied.
 *
 * The step never advances `state` (see `STEP_REQUIRES` in auth.types.ts), so it
 * is safe to re-send as the user edits the field, and a client that skips it
 * entirely goes straight to `credentials` with no code attached. It is legal from
 * `OTP_SENT` and `OTP_VERIFIED`, which is what keeps it reachable on the social
 * path — an OAuth registration starts in one of exactly those two states.
 */
const checkReferralSchema = z.object({
  step: z.literal('check-referral'),
  signupId: signupIdSchema,
  code: optionalReferralCodeSchema,
});

/**
 * "Trust this device and stay signed in?" — asked before the country step.
 *
 * Like `check-referral`, it does not advance `state`, so `country` stays legal
 * from `CREDENTIALS_SET` and no new `RegistrationState` (and therefore no enum
 * migration) is needed. It is also re-sendable, which matters because the answer
 * is a toggle the user may flip twice before continuing.
 *
 * Skipping it entirely is a supported answer, not an error: an older client that
 * never sends this step completes with `trustDevice` at its `false` default and
 * gets an ordinary session. The alternative — making it mandatory — would break
 * every client that has not shipped the screen yet, to collect a "no".
 */
const trustDeviceSchema = z.object({
  step: z.literal('trust-device'),
  signupId: signupIdSchema,
  trust: z.boolean(),
});

/**
 * The set-password step.
 *
 * `skip` is an explicit boolean rather than "password absent means skip". The
 * product makes this a real choice the user makes on screen, and an explicit flag
 * means a client that drops the password field through a bug gets a validation
 * error instead of silently creating a passwordless account.
 */
const credentialsSchema = z.object({
  step: z.literal('credentials'),
  signupId: signupIdSchema,
  skip: z.boolean(),
  password: passwordSchema.optional(),
});

const countryStepSchema = z.object({
  step: z.literal('country'),
  signupId: signupIdSchema,
  country: countrySchema,
});

const stateSchema = z.object({
  step: z.literal('state'),
  signupId: signupIdSchema,
});

const registerUnion = z.discriminatedUnion('step', [
  startSchema,
  resendOtpSchema,
  verifyEmailSchema,
  checkReferralSchema,
  trustDeviceSchema,
  credentialsSchema,
  countryStepSchema,
  stateSchema,
]);

/**
 * The password/skip rules, enforced after discrimination.
 *
 * Both directions matter. Setting a password *and* skipping is contradictory and
 * must not resolve to one of them silently. Doing neither would create an account
 * whose owner believes they set a password.
 */
export const registerRequestSchema = registerUnion.superRefine((value, ctx) => {
  if (value.step !== 'credentials') return;

  if (value.skip && value.password !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['password'],
      message: 'Cannot set a password and skip at the same time',
    });
    return;
  }

  if (!value.skip && value.password === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['password'],
      message: 'Password is required unless skip is true',
    });
    return;
  }
});

export type RegisterRequest = z.infer<typeof registerUnion>;

export type RegisterStartRequest = z.infer<typeof startSchema>;
export type RegisterResendOtpRequest = z.infer<typeof resendOtpSchema>;
export type RegisterVerifyEmailRequest = z.infer<typeof verifyEmailSchema>;
export type RegisterCheckReferralRequest = z.infer<typeof checkReferralSchema>;
export type RegisterTrustDeviceRequest = z.infer<typeof trustDeviceSchema>;
export type RegisterCredentialsRequest = z.infer<typeof credentialsSchema>;
export type RegisterCountryRequest = z.infer<typeof countryStepSchema>;
export type RegisterStateRequest = z.infer<typeof stateSchema>;
