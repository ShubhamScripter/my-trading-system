import type { AdminRole } from '@prisma/client';
import type { CaptchaDescriptor, CaptchaProvider } from '../../src/captcha/captcha.types';
import type { IssuedSession, LoginOutcome, MfaMethod, PublicAdmin } from '../auth.types';
import type { SessionActionMessage, SessionMessage } from '../security/session.message';

/**
 * Response payloads.
 *
 * Interfaces plus mapping functions rather than Zod schemas: these are what we
 * produce, not what we accept, so there is nothing to validate. What they buy is
 * a compile-time list of exactly which fields cross the boundary — add a column
 * to `Admin` and it stays out of every response until someone adds it here.
 *
 * Dates are ISO strings at this boundary, never `Date` objects. Fastify would
 * serialise a Date to ISO anyway, but stating it in the type means a client's
 * contract does not depend on a framework's default.
 */

export interface AdminPayload {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: AdminRole;
  readonly emailVerified: boolean;
  readonly mfaEnrolled: boolean;
  readonly createdAt: string;
}

export function toAdminPayload(admin: PublicAdmin): AdminPayload {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    emailVerified: admin.emailVerified,
    mfaEnrolled: admin.mfaEnrolled,
    createdAt: admin.createdAt.toISOString(),
  };
}

/**
 * What a minted session returns to the client.
 *
 * ═══ NO TOKEN FIELDS AT ALL, AND THAT IS THE POINT ═══════════════════════════
 *
 * Neither token reaches the browser. Both are held server-side in the record named
 * by the `orebit_admin_session` cookie — see auth/security/bff.session.ts — and the
 * cookie is httpOnly, so script on the page can read neither.
 *
 * `refreshToken` left first, into a cookie, which closed the larger hole: it is a
 * twelve-hour grant of admin access. `accessToken` stayed, because it had to — it
 * went in an `Authorization` header, so script had to be able to read it. That is
 * what changed. The browser presents an opaque handle instead of a header, so
 * nothing has to be readable any more, and an XSS on the panel lifts a value that
 * authorises nothing off our origin.
 *
 * A client asserting this contract can assert it structurally: no field here is a
 * credential.
 *
 * `csrfToken` is the value to echo in `x-csrf-token` on every mutating request. It is
 * also set as a readable cookie — this field is here so a client that cannot read
 * cookies (a native app, a test) has the value without parsing `Set-Cookie`.
 * Returning it is not a leak: it authorises nothing and proves only that a request
 * came from a page on our origin.
 *
 * `refreshExpiresAt` is the IDLE deadline. Its name is now slightly wrong from the
 * client's side — there is no refresh token it can see — but it is kept rather than
 * renamed, because the value is unchanged and a rename would be a contract break for
 * no behavioural reason. It moves forward on ACTIVITY now, not on refresh.
 *
 * `reauthenticateAt` is the other half of the answer, and the two are not
 * interchangeable. A client watching only the idle deadline sees one that keeps
 * moving while the admin works and so can never warn anybody. `reauthenticateAt` is
 * the absolute ceiling from the original three-factor sign-in — fixed for the life of
 * the session — so it is the one a panel counts down to when it wants to say "you
 * will have to sign in again at 18:42" before dumping the admin on a login screen
 * mid-task.
 */
export interface SessionPayload {
  readonly refreshExpiresAt: string;
  readonly reauthenticateAt: string;
  readonly csrfToken: string;
  readonly admin: AdminPayload;
}

/**
 * `csrfToken` is a required parameter rather than an optional field, so a caller
 * cannot mint a session payload without having set the cookies that go with it —
 * the value comes back from `sessionCookie.issue()`. A payload built without them
 * would describe a session the client has no refresh token for.
 */
export function toSessionPayload(session: IssuedSession, csrfToken: string): SessionPayload {
  return {
    refreshExpiresAt: session.refreshExpiresAt.toISOString(),
    reauthenticateAt: session.reauthenticateAt.toISOString(),
    csrfToken,
    admin: toAdminPayload(session.admin),
  };
}

/**
 * The one response shape every step of `POST /auth/login` returns.
 *
 * `outcome` is the discriminator, and it mirrors `LoginOutcome`'s `kind`. A client
 * switches on it and always knows where it is without a second call.
 *
 * Only `outcome: 'session'` carries tokens. That is the whole contract in one
 * sentence, and a client can assert it.
 *
 * ═══ THE THREE IN-PROGRESS VARIANTS CARRY `loginId` ═════════════════════════
 *
 * It is the credential for every later step, on this route and on `POST /2fa`, so
 * a client that did not receive it cannot continue. It is REQUIRED on all three
 * rather than optional, for the same reason `csrfToken` is a required parameter of
 * `toSessionPayload` below: a payload without it describes a sign-in the client
 * has no way to finish.
 *
 * `captcha` is the deliberate exception — `step: 'start'` runs before any password
 * is proven, so there is no attempt to name yet.
 *
 * Note `LoginPayload` can no longer produce `outcome: 'session'` at all — the
 * second factor moved to `POST /2fa`, which is the only route that mints one. The
 * variant is kept because `toLoginPayload` maps an exhaustive `LoginOutcome` union
 * and removing it there would be a wider change than this scope. The same is true
 * of `totp_enrollment` and `passkey_challenge`, which is why neither gained a
 * `loginId` — adding a field to an unreachable arm is churn.
 */
export type LoginPayload =
  | { readonly outcome: 'captcha'; readonly captcha: CaptchaPayload }
  | {
      readonly outcome: 'email_otp_required';
      readonly loginId: string;
      readonly otpExpiresAt: string | null;
      readonly resendAvailableAt: string | null;
      readonly otpSendsRemaining: number;
    }
  | {
      readonly outcome: 'mfa_required';
      readonly loginId: string;
      readonly methods: readonly MfaMethod[];
    }
  | {
      readonly outcome: 'enrollment_required';
      readonly loginId: string;
      readonly methods: readonly MfaMethod[];
    }
  | { readonly outcome: 'totp_enrollment'; readonly totp: TotpEnrollmentPayload }
  | {
      readonly outcome: 'passkey_challenge';
      readonly mode: 'register' | 'authenticate';
      readonly options: Record<string, unknown>;
    }
  | { readonly outcome: 'session'; readonly session: SessionPayload };

/**
 * What the login page renders the captcha widget with.
 *
 * `providers` is a LIST because several may be live at once. A page renders the
 * first, or offers a choice, and echoes the one it used back as `captchaProvider`
 * on the `password` step. Site keys are public by design — they ship to the
 * browser either way.
 *
 * Empty with `enabled: false` in a local environment with no provider configured.
 */
export interface CaptchaPayload {
  readonly enabled: boolean;
  readonly providers: readonly CaptchaOptionPayload[];
}

export interface CaptchaOptionPayload {
  readonly provider: CaptchaProvider;
  readonly siteKey: string;
}

export function toCaptchaPayload(descriptor: CaptchaDescriptor): CaptchaPayload {
  return {
    enabled: descriptor.enabled,
    providers: descriptor.providers.map(({ provider, siteKey }) => ({ provider, siteKey })),
  };
}

/**
 * The TOTP secret, returned exactly once.
 *
 * Both fields carry the same secret — `uri` for a QR code, `secret` for manual
 * entry when a camera is unavailable. There is no endpoint that reads it back: the
 * stored copy is encrypted and only ever decrypted to verify a code, so an admin
 * who loses this screen has to restart enrollment rather than retrieve it.
 */
export interface TotpEnrollmentPayload {
  readonly secret: string;
  readonly uri: string;
}

/**
 * `GET /auth/me`.
 *
 * ═══ `sessionId` IS THE LOGIN, NOT THE CURRENT TOKEN GENERATION ══════════════
 *
 * It names the session FAMILY — one authenticated browser login — and it does not
 * change for the life of that login. In particular it does not change when the
 * backend refreshes tokens on the browser's behalf, which under the BFF happens
 * roughly every fifteen minutes without the client doing anything.
 *
 * It used to report the refresh generation, which did change on every one of those
 * refreshes. That was not what the field is for: it exists so a panel listing
 * sessions can mark which row is "this device", and an identifier that silently
 * changes underneath the page cannot answer that question.
 *
 * Not to be confused with the internal `principal.sessionId`, which IS the
 * generation and stays that way — elevation tickets and reauth challenges are bound
 * to the credential rather than to the login. The two are deliberately different.
 */
export interface MePayload {
  readonly admin: AdminPayload;
  readonly session: { readonly sessionId: string };
  /**
   * ═══ THE CSRF TOKEN, FOR A PANEL THAT CANNOT READ THE COOKIE ══════════════
   *
   * The value to echo in `x-csrf-token` on every mutating request — the same value
   * `SessionPayload.csrfToken` carries at sign-in, reported again here so it
   * survives a reload.
   *
   * This route is the bootstrap read: a panel calls it on load to learn who it is
   * signed in as. Before F14 that was all it learned, and a panel on a separate
   * origin from the API had no way to recover the token afterwards — the cookie is
   * host-only for the API and unreadable across origins, so a refreshed tab was
   * authenticated but unable to mutate anything, logout included. A same-origin
   * panel was unaffected, which is why local development never showed it.
   *
   * ─── Stable across calls ──────────────────────────────────────────────────
   *
   * Reading this does NOT rotate the token: an existing valid one is returned
   * unchanged and no cookie is set. A client may therefore call `GET /auth/me` as
   * often as it likes without invalidating a token an in-flight request is already
   * carrying. See `ensureCsrf` in security/session.cookie.ts.
   *
   * ─── Null for a bearer caller ─────────────────────────────────────────────
   *
   * Null, not absent, when the request authenticated with an `Authorization`
   * header rather than the cookie. A bearer is not attached ambiently, so there is
   * no cross-site request to forge and `assertCsrf` never demands a token from such
   * a caller — reporting one would invite a script or an integration test to start
   * sending a header nothing checks. Explicitly null rather than omitted so a
   * client can tell "this deployment has no CSRF" from "this field is new and your
   * server is old".
   */
  readonly csrfToken: string | null;
}

/**
 * `GET /auth/session` — "is this browser signed in, and as what".
 *
 * The endpoint a standalone frontend needs on load: it cannot inspect an httpOnly
 * cookie, so one call has to answer the question. A 200 is this payload; a 401
 * carries the reason as its `type` slug.
 *
 * ═══ FIVE FIELDS, AND NOTHING ELSE ═════════════════════════════════════════
 *
 * Deliberately the narrowest useful answer. It carried `admin`, `expiresAt` and
 * `reauthenticateAt`; all three are gone, because this route's one job is to let a
 * frontend decide what to RENDER, and none of them served it:
 *
 *   admin             duplicated `GET /auth/me`, which is where account details
 *                     belong. Two endpoints reporting one identity is two places to
 *                     keep in step.
 *   the two deadlines a client cannot act on either without a timer this route was
 *                     not the right place to feed. `SessionPayload` still reports
 *                     both at sign-in for a panel that wants an idle warning.
 *
 * No `sessionId` either — an internal identifier the frontend has no use for is one
 * more value to avoid logging. `GET /auth/me` reports one because a panel listing
 * sessions needs to mark which row is "this device"; establishing login state does
 * not.
 *
 * ─── `authenticated` is always `true` here ─────────────────────────────────────
 *
 * It is not a discriminator, and this route never answers `authenticated: false` with a
 * 200. A dead session is still a 401 whose `type` says WHY — `session_revoked` when
 * it was ended elsewhere, `token_expired` when it timed out, `unauthenticated` when
 * there was no usable cookie — and collapsing those to a 200 with a false flag would
 * throw away exactly the distinction a client needs. The field is here because a
 * frontend checking one truthy value is simpler than one checking a status code, and
 * because it makes the success shape self-describing.
 *
 * The 401 carries the SAME five fields, as `extra` on the problem document:
 * `{ authenticated: false, role: null, permissions: [], lastActiveAt, message }`. So a
 * client reads one shape either way and branches on `message.code`. See
 * security/session.message.ts.
 */
export interface SessionStatusPayload {
  /**
   * The admin's role, re-read from the database rather than taken from the token's
   * `rol` claim.
   *
   * An access token lives fifteen minutes, so a demoted admin's claim is stale for
   * that long — and this endpoint is precisely what a UI uses to decide what to show.
   * `GET /auth/me` and `SuperAdminGuard` re-read for the same reason. The row is
   * already loaded here to confirm the account still exists, so it costs nothing.
   */
  readonly role: AdminRole;
  /**
   * Always empty for now. Permission calculation is not implemented; the field
   * exists so a frontend can be written against its final shape and will not need a
   * contract change when it starts being populated.
   */
  readonly permissions: readonly string[];
  readonly authenticated: true;
  /**
   * When the backend last observed an eligible authenticated request on this
   * session, as an ISO string.
   *
   * The stored `AdminSession.lastActiveAt`, not `now()` — so it lags the caller's own
   * request by up to `ACTIVITY_WRITE_INTERVAL_SECONDS`, which is the write
   * optimisation being visible rather than a bug. A panel may render
   * `lastActiveAt + inactivity timeout` as a countdown.
   *
   * `null` only when no session row was read. On a 200 that cannot happen, so this is
   * effectively always present here; the field is nullable because the 401 shape in
   * security/session.message.ts is the same shape and there it can be null.
   *
   * NOT authoritative. A frontend may display it and must not conclude from it that
   * the caller is still authenticated — every protected call is still checked by the
   * backend.
   */
  readonly lastActiveAt: string | null;
  /**
   * WHY this authentication state exists — `LOGGED_IN` here, by construction.
   *
   * Present on the success shape as well as on the 401 so a frontend has one field
   * to switch on rather than a status code plus an error slug. `code` is the
   * contract; `text` is a default it may render or replace, and must never be
   * parsed. The other four codes and the whole derivation live in
   * security/session.message.ts.
   */
  readonly message: SessionMessage;
}

/**
 * `POST /auth/session` — what the logout actions answer with.
 *
 * This was `{ ok: true }`, and the field is gone rather than kept alongside. A
 * boolean that is `true` on every response it can appear on carries no information:
 * the 2xx already said it worked, and a client reading `ok` was reading the status
 * code twice. What a client actually needs is something to SHOW, and it now gets the
 * same `{ code, text }` shape the session-status route answers with — so the panel
 * has one message renderer rather than a special case for logout.
 *
 * `code` is the contract and `text` a default the panel may replace; it must never be
 * parsed. See `SESSION_ACTION_MESSAGES` in security/session.message.ts for why this
 * code lives beside the five session-state codes rather than among them.
 */
export interface LogoutPayload {
  readonly message: SessionActionMessage;
}

/**
 * Map a service-level outcome to its wire payload.
 *
 * Exhaustive by construction: the `never` assignment in the default arm means
 * adding a variant to `LoginOutcome` without handling it here fails the build.
 *
 * `loginId` is a required parameter rather than an optional field, exactly as
 * `csrfToken` is on `toSessionPayload`. Every outcome this function can produce is
 * a sign-in still in progress, so there is no branch that legitimately has nothing
 * to hand back — a caller that could omit it would be able to mint a payload
 * describing a ceremony the client cannot continue.
 */
export function toLoginPayload(outcome: LoginOutcome, loginId: string): LoginPayload {
  switch (outcome.kind) {
    case 'email_otp_required':
      return {
        outcome: 'email_otp_required',
        loginId,
        otpExpiresAt: outcome.otpExpiresAt?.toISOString() ?? null,
        resendAvailableAt: outcome.resendAvailableAt?.toISOString() ?? null,
        otpSendsRemaining: outcome.otpSendsRemaining,
      };
    case 'mfa_required':
      return { outcome: 'mfa_required', loginId, methods: outcome.methods };
    case 'enrollment_required':
      return { outcome: 'enrollment_required', loginId, methods: outcome.methods };
    // No `session` arm: `LoginOutcome` has no such variant. See the note in
    // auth/auth.types.ts — its absence is what makes "this route cannot mint a
    // session" a compile-time fact rather than a convention.
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
