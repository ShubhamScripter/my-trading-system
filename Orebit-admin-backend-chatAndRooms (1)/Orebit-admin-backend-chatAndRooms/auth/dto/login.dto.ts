import { z } from 'zod';
import {
  captchaProviderSchema,
  captchaTokenSchema,
  emailSchema,
  loginIdSchema,
  otpSchema,
  presentedPasswordSchema,
} from './common.dto';

/**
 * ═══ THE FIRST HALF OF THE SIGN-IN CEREMONY ══════════════════════════════════
 *
 * Five steps of `POST /auth/login`, as one discriminated union on `step`. That is
 * the convention this codebase uses for every multi-step flow — one route, one
 * union, an exhaustive switch in the controller whose `default` assigns to `never`
 * so adding a variant here without handling it fails the build.
 *
 * ─── This route no longer finishes the ceremony ─────────────────────────────
 *
 * It ends at `EMAIL_VERIFIED`: password proven, emailed code proven, no session.
 * The second factor is proven on `POST /2fa`, which is the only place a session is
 * minted. `verify-email` returning `mfa_required` or `enrollment_required` means
 * "go there" rather than "call me again".
 *
 * The four factor steps that used to live here — `totp-enroll`, `totp-verify`,
 * `passkey-challenge`, `passkey-verify` — moved to that route's union. They kept
 * their credential (the same `loginId`) and their state requirement
 * (`EMAIL_VERIFIED`); only the path changed.
 *
 * ─── What a union buys, and what it costs ───────────────────────────────────
 *
 * It buys a small surface: one route to guard, one route to rate-limit at the
 * edge, one place to look for the whole flow. It costs the per-route guard a wide
 * surface would get for free — which is why `STEP_REQUIRES` in auth.types.ts and
 * `assertStep` in security/stepup.ts exist, and why they are the code a reviewer
 * should read first.
 *
 * ─── `loginId`, and what the variants still do NOT carry ────────────────────
 *
 * Every step past `password` carries `loginId` — the opaque handle to the
 * in-flight attempt, minted by `password` and returned in its response. It
 * replaced the httpOnly `orebit_admin_step` cookie; see `loginIdSchema` in
 * common.dto.ts for what that trade bought and what still bounds it.
 *
 * No variant carries an `adminId`, a `mode`, or a state value. Those are read from
 * the attempt row the `loginId` resolves to, never from the request. So the only
 * fields below are secrets the caller is meant to prove they know, and values that
 * cannot change what the server decides to do — a client asserting `{ step:
 * 'verify-email' }` is stating which operation it wants, not which state it is in.
 *
 * `loginId` is REQUIRED on the three steps that take it, so an absent one is
 * `validation_failed` (400) from `parseDto` rather than a credential error. That is
 * the honest answer once the value is a body field: nothing was presented, so the
 * request is malformed, not unauthenticated.
 *
 * Every variant is `.strict()`, so an unrecognised field is a 400 rather than
 * something silently ignored — and that cuts both ways here on purpose. A client
 * that lazily attaches `loginId` to `start` or `password` is told it is wrong,
 * rather than having it quietly dropped on the two steps that must stay anonymous.
 */

/**
 * `start` — what the login page needs to render.
 *
 * Anonymous, and carries nothing. A POST for what is semantically a read, because
 * the alternative is a second route, and the surface rule says a step of a flow
 * does not earn one. It is also the natural place to put anything else the login
 * screen needs to bootstrap later.
 */
const startSchema = z.object({ step: z.literal('start') }).strict();

/** `password` — email, password, captcha. Anonymous; mints the step-up cookie. */
const passwordStepSchema = z
  .object({
    step: z.literal('password'),
    email: emailSchema,
    password: presentedPasswordSchema,
    captchaProvider: captchaProviderSchema,
    captchaToken: captchaTokenSchema,
  })
  .strict();

/** `resend-otp` — send another sign-in code. Identified by `loginId`. */
const resendOtpSchema = z
  .object({ step: z.literal('resend-otp'), loginId: loginIdSchema })
  .strict();

/** `verify-email` — the emailed code. Advances to EMAIL_VERIFIED; issues nothing. */
const verifyEmailSchema = z
  .object({ step: z.literal('verify-email'), loginId: loginIdSchema, code: otpSchema })
  .strict();

/**
 * `state` — where this attempt is, so a desynchronised client can resume.
 *
 * ─── This no longer survives a page refresh, and that is accepted ───────────
 *
 * It used to. The step-up cookie was sent by the browser automatically, so a
 * refreshed login page could ask "where was I" and pick up mid-ceremony. `loginId`
 * lives in the client's memory, so a refresh loses it and the sign-in restarts.
 *
 * The alternative — have the client persist it in sessionStorage — is exactly the
 * script-readable storage that moving off the cookie otherwise avoids, and it
 * would outlive the tab. Restarting a ten-minute ceremony is the cheaper cost.
 *
 * The step still earns its place for the case it was really written for: a client
 * that has the `loginId` but has lost track of its own progress — a duplicated tab,
 * a component remount, a retry after a dropped response.
 */
const stateSchema = z
  .object({ step: z.literal('state'), loginId: loginIdSchema })
  .strict();

export const loginRequestSchema = z.discriminatedUnion('step', [
  startSchema,
  passwordStepSchema,
  resendOtpSchema,
  verifyEmailSchema,
  stateSchema,
]);

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PasswordStepRequest = z.infer<typeof passwordStepSchema>;
