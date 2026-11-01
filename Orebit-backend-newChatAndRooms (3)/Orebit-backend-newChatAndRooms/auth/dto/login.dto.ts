import { z } from 'zod';
import { captchaSchema, identifierSchema, loginIdSchema, otpCodeSchema } from './common.dto';

/**
 * `POST /auth/login` — one route, seven steps, one discriminated union on `step`.
 *
 * ─── Why this is a step machine and not a set of independent modes ─────────
 *
 * It used to discriminate on `mode`, and the six modes were genuinely independent
 * — each one identified its own subject from the request body. `password` and
 * `otp-request` took an identifier; `otp-verify` took the identifier BACK, and
 * trusted it. An email address names an account and proves nothing about the
 * person asking, so "which sign-in is this" had no trustworthy answer, and the
 * only in-flight state with a server-side row was the gap before a second factor.
 *
 * The server now opens a `LoginAttempt` row and mints the opaque `loginId` naming
 * it, and every continuation step carries that handle. Each declares which states
 * it is legal from — see `LOGIN_STEP_REQUIRES` in auth.types.ts. Two things follow
 * that could not be arranged before: the identity of a flow is fixed by the server
 * at the moment it resolves the first credential and cannot be re-stated by a
 * later body, and the same handle carries into `POST /auth/2fa/verify`, so there
 * is no second token minted half way through.
 *
 * ─── There is no `start` step, and there was one for exactly one release ───
 *
 * The row used to be opened by `POST /auth/login {step:'start'}`, a request that
 * presented no credential and did nothing but hand back a handle. It was removed:
 * a round trip whose only product is an identifier for the NEXT round trip is
 * latency on the critical path of every sign-in, and it bought nothing the first
 * real request could not do itself.
 *
 * So the FIRST REAL OPERATION creates the flow. Three steps can be first —
 * `password`, `otp-request` and `oauth-start` — and none of them takes a
 * `loginId`, because there is not one yet. Everything after resolves the handle
 * the first one returned.
 *
 * What that costs, stated plainly: `password` and `otp-request` are no longer
 * separable into "open a flow" and "spend a credential", so the limiter that used
 * to guard row creation on its own is gone and each entry point's own limiter
 * bounds it instead. See the note on `LOGIN_FLOW` in auth/limits.ts for why that
 * is the same bound and not a weaker one.
 *
 * The OAuth steps live here rather than on their own route because a provider
 * callback *is* a login attempt. It resolves to a session, or to a choice between
 * registering and linking — outcomes of the same question `step: password` asks.
 *
 * ─── Where `linkToken` went ─────────────────────────────────────────────────
 *
 * It used to be an optional field on the three steps that end in a session, on the
 * argument that "prove you own that account" and "log in to that account" are the
 * same act. That argument is wrong, and this is the correction.
 *
 * Linking writes an `OauthLink`, which is a credential that outlives a password
 * change, a session sweep and an email change. Riding on a login made it a side
 * effect of presenting ONE factor — so anyone who could read a mailbox could sign
 * in with an emailed code, attach their own Google account, and keep access after
 * the victim had done everything the product tells them to do about a compromise.
 *
 * Linking is now `POST /auth/link`, authenticated and behind a single-use
 * elevation ticket. The re-derivation the old design was avoiding does not happen:
 * the caller reaches that route by logging in through these very steps, so lockout,
 * rate limits, captcha and the passwordless fallthrough all still apply — they just
 * apply to the login rather than being smuggled into it.
 *
 * `oauth-register` keeps its own `linkToken` below, and that is not the same thing:
 * it consumes a pending identity to start a NEW registration, so there is no
 * existing account to take over.
 */

/**
 * The first factor, and one of the three steps that can OPEN a flow.
 *
 * No `loginId`, and `.strict()` refuses one: there is no flow yet, and a body
 * carrying a handle here is a client that has lost its place. Accepting it would
 * mean either ignoring the value — silently starting a second sign-in while the
 * caller believed it was continuing the first — or resolving it, which would give
 * this step two quite different meanings depending on a field's presence.
 */
const passwordStepSchema = z
  .object({
    step: z.literal('password'),
    identifier: identifierSchema,
    // Deliberately NOT `passwordSchema`. Policy is enforced when a password is
    // *set*, never when one is checked: applying the strength rules here would
    // lock out a legitimate password that predates a policy change, and would
    // also tell an attacker which guesses were policy-compliant before any
    // credential check ran.
    password: z.string().min(1).max(1024),
  })
  .merge(captchaSchema)
  // `.strict()` on the three session-minting steps, added with the removal of
  // `linkToken`. Without it an unknown key is silently dropped, so a client still
  // sending the old field would get a 201 and a session and believe it had linked a
  // provider that was never attached. A loud validation error is the only honest
  // answer to a field that used to do something and now does not.
  .strict();

/**
 * Ask for an emailed sign-in code. Opens a flow, or resends on one that exists.
 *
 * ─── Why `loginId` is OPTIONAL here and nowhere else ───────────────────────
 *
 * This step is both an entry point and a continuation, which no other step is. A
 * caller who has never signed in has no handle and gets a new flow. A caller
 * looking at a "didn't get the code?" button already has one, and a resend must
 * land on the SAME flow — otherwise every resend would strand the previous row at
 * `OTP_SENT` with a live handle, and the client would have to notice its
 * `loginId` had silently changed under it.
 *
 * Optional rather than a fourth step (`otp-resend`) because the server-side work
 * is identical: same quotas, same budget, same cooldown, same response. A second
 * step would be a second place for those to drift.
 *
 * When present it is resolved and state-checked through the same gate as every
 * other continuation, so an unknown or spent handle is refused here exactly as it
 * is everywhere else — passing one is never a way to skip a check.
 */
const otpRequestSchema = z
  .object({
    step: z.literal('otp-request'),
    /** Absent on the first request, present on a resend. */
    loginId: loginIdSchema.optional(),
    identifier: identifierSchema,
  })
  .merge(captchaSchema)
  .strict();

/**
 * ─── No `identifier` here, and that is the security change ──────────────────
 *
 * This step used to take the address back from the client, because there was
 * nothing else to say which sign-in was being completed. An email address names
 * an account; it proves nothing about the person asking. So a caller who had
 * requested a code for their own address could present it alongside somebody
 * else's — and the pairing was checked only against whatever the body said, not
 * against what the flow had actually asked for.
 *
 * `loginId` resolves to the row `otp-request` wrote, and the address it stored is
 * the one the code was sent to. The client cannot influence it, so the code and
 * the recipient can no longer be separated.
 */
const otpVerifySchema = z
  .object({
    step: z.literal('otp-verify'),
    loginId: loginIdSchema,
    code: otpCodeSchema,
  })
  .strict();

/**
 * All five providers, with configuration rather than validation deciding which are
 * actually offered.
 *
 * This used to be narrowed to `GOOGLE`, on the reasoning that accepting a provider
 * nothing implemented would turn a client mistake into a 502 from a missing adapter.
 * The reasoning was right; adapters now exist for all five, so the mechanism moved
 * rather than the intent. `OauthProviderRegistry.require` refuses a provider whose
 * credentials are absent with `oauth_provider_unsupported` — a 400 that names it.
 *
 * The gain is that the wire contract no longer changes when a deployment gains
 * credentials: staging can offer Apple and production not, from one build. The enum
 * is the set of providers that EXIST; the registry decides which are OFFERED.
 *
 * Worth knowing before building a client: `X` and `TELEGRAM` cannot create accounts,
 * because neither supplies an email address. They sign in an account that has
 * already linked them, and they can be attached to an existing one. See
 * `oauth_email_unavailable`.
 */
const oauthProviderSchema = z.enum(['GOOGLE', 'X', 'TELEGRAM', 'APPLE', 'FACEBOOK']);

/**
 * Begin a provider sign-in. The third step that can open a flow.
 *
 * No `loginId` for the same reason `password` has none. The response carries the
 * one this request mints, and `oauth-callback` must present it — the flow id is
 * stashed alongside the OAuth `state`, so an authorization started by one tab
 * cannot be redeemed against another tab's sign-in.
 */
const oauthStartSchema = z
  .object({
    step: z.literal('oauth-start'),
    provider: oauthProviderSchema,
    /** Where the provider sends the user back. Checked against the configured
     *  redirect URI in oauth.service.ts — accepting an arbitrary value here would
     *  be an open redirect that hands an attacker the authorization code. */
    redirectUri: z.string().url().max(2048).optional(),
  })
  .strict();

const oauthCallbackSchema = z
  .object({
    step: z.literal('oauth-callback'),
    loginId: loginIdSchema,
    provider: oauthProviderSchema,
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(512),
  })
  .strict();

/**
 * The "create a new account" branch of the choice the callback returns.
 *
 * No captcha: the user has already been through the provider, which is a stronger
 * gate than a captcha, and the token this carries was minted by us one step ago.
 */
const oauthRegisterSchema = z
  .object({
    step: z.literal('oauth-register'),
    loginId: loginIdSchema,
    linkToken: z.string().min(1).max(512),
  })
  .strict();

/**
 * Read the flow's own state back.
 *
 * For a client that holds a live `loginId` but has lost track of which step it is
 * on — a reloaded page, a resumed app, a request whose response never arrived. It
 * runs through the same resolution gate as every other step, so it is not a way
 * to learn anything about a handle you were not already given: an unknown, spent
 * or expired one answers exactly as it does everywhere else.
 */
const stateSchema = z
  .object({
    step: z.literal('state'),
    loginId: loginIdSchema,
  })
  .strict();

export const loginRequestSchema = z.discriminatedUnion('step', [
  passwordStepSchema,
  otpRequestSchema,
  otpVerifySchema,
  oauthStartSchema,
  oauthCallbackSchema,
  oauthRegisterSchema,
  stateSchema,
]);

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginPasswordRequest = z.infer<typeof passwordStepSchema>;
export type LoginOtpRequestRequest = z.infer<typeof otpRequestSchema>;
export type LoginOtpVerifyRequest = z.infer<typeof otpVerifySchema>;
export type LoginOauthStartRequest = z.infer<typeof oauthStartSchema>;
export type LoginOauthCallbackRequest = z.infer<typeof oauthCallbackSchema>;
export type LoginOauthRegisterRequest = z.infer<typeof oauthRegisterSchema>;
export type LoginStateRequest = z.infer<typeof stateSchema>;
