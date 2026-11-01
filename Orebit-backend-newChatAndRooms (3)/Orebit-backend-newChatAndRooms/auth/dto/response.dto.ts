import type { RegistrationState } from '@prisma/client';
import type { CaptchaDescriptor, CaptchaProvider } from '../../src/captcha/captcha.types';
import type { IssuedSession, PublicUser } from '../auth.types';
import type { SessionActionMessage, SessionMessage } from '../security/session.message';

/**
 * Response shapes for `auth/`.
 *
 * Types, not zod schemas: these are produced by this service, so there is nothing
 * to validate — the compiler is the check. Requests are the opposite, and that
 * asymmetry is intentional.
 */

/**
 * The user representation returned by HTTP APIs.
 *
 * Distinct from `PublicUser` in auth.types.ts by one field: `registeredAt` is an
 * ISO string here and a `Date` there. That is the whole reason both exist — the
 * domain passes `Date` objects between services, and the boundary serialises
 * exactly once, in `toPublicUserPayload` below.
 */
export interface PublicUserPayload {
  readonly publicCode: string;
  readonly username: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly country: string | null;
  readonly referralCode: string;
  readonly hasPassword: boolean;
  readonly registeredAt: string;
  readonly avatarUrl: string | null;
}

export function toPublicUserPayload(user: PublicUser): PublicUserPayload {
  return {
    publicCode: user.publicCode,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    country: user.country,
    referralCode: user.referralCode,
    hasPassword: user.hasPassword,
    registeredAt: user.registeredAt.toISOString(),
    avatarUrl: user.avatarUrl,
  };
}

/**
 * The session, as a client sees it.
 *
 * ═══ NO TOKEN FIELDS AT ALL, AND THAT IS THE POINT ═════════════════════════
 *
 * The access token used to be here, because the client needed it for an
 * `Authorization` header — which meant it had to be readable by script, which meant an
 * XSS stole a working credential and, with the refresh cookie the browser attached
 * automatically, the ability to keep minting more.
 *
 * Both tokens now live in a server-side record named by the `orebit_session` httpOnly
 * cookie. The client sends no header and holds nothing, so there is nothing here to
 * return. A client asserting this contract can assert it structurally: no field below
 * is a credential.
 *
 * ─── What is left, and why each field earns its place ─────────────────────
 *
 *   user           who signed in. The only reason this payload existed for a client
 *                  that already had its tokens in cookies.
 *   csrfToken      the value to echo in `x-orebit-csrf` on every unsafe request. Also
 *                  in the readable `orebit_csrf` cookie — reported here as well
 *                  because the app is served from a different origin and cannot read
 *                  that cookie. See `SessionCookie.ensureCsrf`.
 *   expiresAt      when the session dies if nothing else happens, as an absolute ISO
 *                  instant rather than an `expiresIn` duration, so a client with a
 *                  slow connection or a suspended tab cannot miscompute it. It is a
 *                  sliding deadline, not a promise: activity pushes it out and a
 *                  revocation ignores it entirely.
 *
 * Both TOKEN expiries are gone with the tokens. They described a refresh cycle the
 * client no longer participates in — nothing on the page can observe a rotation, so a
 * timestamp to schedule against would be a timer for work that already happened.
 */
export interface SessionPayload {
  readonly user: PublicUserPayload;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * The answer from `GET /auth/session` when the caller IS signed in.
 *
 * Deliberately the same field names as `SignedOutStatus`, which is what the 401
 * carries in `extra`, so a frontend reads ONE shape either way — see
 * security/session.message.ts. `authenticated` is the discriminant and is a literal
 * on both sides.
 *
 * ─── Three fields, because this route answers exactly one question ────────
 *
 * `user` and `csrfToken` are deliberately NOT here any more. This is the liveness
 * probe — "am I signed in, and if not, why not" — and a client that wants the profile
 * or the CSRF token to echo asks `GET /auth/me`, which returns both and re-reads the
 * account for the purpose. Returning them from a route documented as pollable meant
 * every poll shipped a full profile to answer a yes/no question, and it left a
 * frontend with two authorities on the same user record to disagree with each other.
 *
 * The cross-origin CSRF recovery the old field existed for still works, from `me`:
 * `ensureCsrf` is read-don't-rotate, so learning the token there is exactly what
 * learning it here was. This route still REPAIRS a broken pair as a side effect — see
 * `AuthController.sessionStatus` — it just no longer reports the value.
 */
export interface SessionStatusPayload {
  readonly authenticated: true;
  /** When this session was last active, as the row records it — not `now`. Null only
   *  when the row was not read — see `sessionLastUsedAt`.
   *
   *  `lastActiveAt` on the wire, `lastUsedAt` in the database and everywhere inside
   *  the service. The rename stops at this boundary deliberately: the column name is a
   *  statement about token USE, which includes a background rotation nobody performed,
   *  and what a client shows a user is the last time that person was ACTIVE. */
  readonly lastActiveAt: string | null;
  readonly message: SessionMessage;
}

/** The answer from `POST /auth/session`. Says what happened, not what the state is. */
export interface LogoutPayload {
  readonly message: SessionActionMessage;
}

/**
 * Returned by `POST /auth/register` after the initial `start` step, so a client
 * always knows where it is without a separate read. `session` is present only on
 * the final `country` step, after the User row has been created.
 */
export interface RegistrationStatePayload {
  readonly state: RegistrationState;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly passwordSet: boolean;
  /** Absolute instant the current code dies. Null when there is no live code. */
  readonly otpExpiresAt: string | null;
  /** When a resend becomes possible. Null when one can be sent right now. */
  readonly resendAvailableAt: string | null;
  readonly otpSendsRemaining: number;
  /** What the geo lookup suggested for the country step. Always null while
   *  `NullGeoResolver` is the bound implementation. */
  readonly countrySuggested: string | null;
  readonly country: string | null;
  readonly referralApplied: boolean;
  readonly expiresAt: string;
  readonly session?: SessionPayload;
}

/**
 * The initial `start` response excludes values that cannot be meaningfully set
 * until later registration steps.
 */
export type RegistrationStartPayload = Omit<
  RegistrationStatePayload,
  'countrySuggested' | 'country' | 'referralApplied' | 'expiresAt'
> & {
  /**
   * The handle for this registration, returned exactly once.
   *
   * Every later step of `POST /auth/register` sends it back in the body. It is
   * NOT the registration's database id — that never leaves the server — but 32
   * bytes of CSPRNG output whose peppered hash is the only thing the row can be
   * found by. See `signupIdSchema` in common.dto.ts.
   *
   * A client holds it in memory for the life of the signup, and starting over is
   * the remedy for losing it. Not in localStorage: persisting it turns a
   * page-lifetime exposure into one that outlives the tab.
   */
  readonly signupId: string;
};

/**
 * The answer from `check-referral` — the only step that resolves a code.
 *
 * `valid` is the resolved truth, not an echo of what was sent: it is false for a
 * well-formed code belonging to nobody, and the registration's stored code is
 * cleared to match. A client can therefore render its "referred by" state
 * directly from this, and `state.referralApplied` will agree.
 */
export interface ReferralCheckPayload {
  readonly valid: boolean;
  /** The referrer's username when the code matched, so the client can show who
   *  referred them. Absent on a miss — nothing about a non-matching code is
   *  disclosed. */
  readonly referrerUsername?: string;
  readonly state: RegistrationStatePayload;
}

/**
 * The result of `POST /auth/login`, discriminated on `outcome`.
 *
 * A discriminated result rather than a bare session or an error, because three of
 * these are ordinary successful paths that simply require the client to render a
 * different screen. Modelling `registration_required` as an error would force a
 * client to parse an error body to continue a happy path.
 */
export type LoginPayload =
  /**
   * A flow exists and nothing has been proven on it yet.
   *
   * Reached only by `step: 'state'`, reading back a sign-in parked mid-OAuth — no
   * request opens a flow and stops there, because the step that opens one always
   * goes on to do its actual work.
   *
   * `loginId` is the handle for it, and every later step of `POST /auth/login`
   * plus `POST /auth/2fa/verify` sends it back in the body. Like `signupId` it is
   * an opaque 32-byte secret rather than a row id, and like `signupId` it belongs
   * in memory for the life of the flow and nowhere more durable.
   */
  | { readonly outcome: 'started'; readonly loginId: string }
  /** The flow is over and its handle is retired, which is why this is the one
   *  outcome carrying no `loginId`. */
  | { readonly outcome: 'session'; readonly session: SessionPayload }
  /** This account has no password. A code has been emailed; continue with
   *  `step: otp-verify` — which needs no identifier, because the flow already
   *  knows which address the code went to. */
  | {
      readonly outcome: 'otp_required';
      readonly loginId: string;
      readonly resendAvailableAt: string | null;
    }
  /** A code was sent (or silently was not, if the identifier matched nothing —
   *  the response is identical either way, and so is the flow's state). */
  | {
      readonly outcome: 'otp_sent';
      readonly loginId: string;
      readonly resendAvailableAt: string | null;
    }
  /**
   * Where to send the user to authorize, and the `state` binding this attempt.
   *
   * `url` is null for a provider whose `flow` is `signed-payload` — Telegram, which
   * has no authorization endpoint. There is nothing to redirect to: the client
   * renders the Telegram Login Widget instead, with `data-auth-url` pointing at its
   * own callback page carrying this `state` in the query string. Telegram appends its
   * signed fields to that URL, so the state survives the round trip and the callback
   * is an ordinary `oauth-callback`.
   *
   * `flow` is returned rather than left for the client to infer from the provider,
   * so adding a provider does not oblige every client to learn which kind it is.
   */
  | {
      readonly outcome: 'redirect';
      readonly loginId: string;
      readonly url: string | null;
      readonly state: string;
      readonly flow: 'oidc-code' | 'oauth2-code' | 'signed-payload';
    }
  /**
   * No linked account and no account for this email. Continue on
   * `POST /auth/register` at `step: credentials`.
   *
   * The LOGIN flow ends here and a SIGNUP flow begins, so the handle changes with
   * it: `loginId` is retired and `signupId` names the registration that was just
   * opened. Two flows, two handles — one credential quietly changing meaning
   * would be the harder thing to reason about, not the easier one.
   */
  | {
      readonly outcome: 'registration_required';
      readonly signupId: string;
      readonly email: string;
      readonly emailVerified: boolean;
    }
  /**
   * A provider sign-in with nothing linked yet. Render the choice:
   *
   *  - create an account — resend as `mode: oauth-register` with this `linkToken`
   *  - link to an existing one — log in as normal, then run the link ceremony:
   *    `POST /auth/2fa {action:'reauth-verify', intent:'account.oauth.link'}` for a
   *    ticket, then `POST /auth/link` with this `linkToken` and that ticket
   *
   * `canCreateNew` is false in two situations, told apart by `email`:
   *
   *  - `email` present — that address already belongs to an account, and
   *    registration needs an unused one. Taking the create branch anyway returns
   *    `oauth_link_required`.
   *  - `email` null — the PROVIDER supplied no address. X and Telegram never do;
   *    Apple and Facebook sometimes do not. Nothing can be registered from this
   *    identity, so only the link branch will ever be open, and taking the other
   *    one returns `oauth_email_unavailable`.
   *
   * A client that treats `canCreateNew: false` uniformly is correct in both cases.
   * The distinction only changes the wording: "you already have an account" versus
   * "X cannot create one — sign up with an email first".
   */
  | {
      readonly outcome: 'choice_required';
      readonly loginId: string;
      readonly linkToken: string;
      /** Null when the provider supplies no address. */
      readonly email: string | null;
      readonly canCreateNew: boolean;
      /** Which provider the identity came from, so it can be named on screen. */
      readonly provider: string;
    }
  /**
   * The first factor was accepted and this account has a second one enrolled.
   *
   * NO session was issued and no cookies were set. The `loginId` echoed back is
   * the SAME one the caller presented — the flow row was promoted in place rather
   * than a second handle being minted — and it completes the sign-in at
   * `POST /auth/2fa/verify`, which returns the `session` outcome this one stands
   * in for.
   *
   * `methods` is what this account can actually prove RIGHT NOW, so a client can
   * render the available prompts without a second call — `totp`, `passkey`, and
   * `recovery_code` when unspent codes remain. For the passkey path, ask
   * `POST /auth/2fa/verify {method:'passkey'}` with no assertion first to receive
   * the WebAuthn options.
   *
   * A 2xx and not a 4xx, deliberately: this is a successful step in a working
   * sign-in, exactly like `otp_required` beside it, and modelling it as an error
   * would force a client to parse an error body to continue a happy path.
   */
  | {
      readonly outcome: 'mfa_required';
      readonly loginId: string;
      readonly methods: readonly string[];
      readonly expiresAt: string;
    };

export interface MePayload {
  readonly user: PublicUserPayload;
  /**
   * `familyId`, not the generation id, and the rename is not cosmetic.
   *
   * This field exists so a client can mark which row in the session list is "this
   * device". A generation id could never answer that under the BFF: it changes every
   * time the backend rotates in the background, which is roughly every fifteen minutes
   * and never at a moment the client can observe — so the value a page was holding
   * would stop matching any row in the list it was about to render.
   *
   * The family is the id of the first generation and survives every rotation, which is
   * also what `GET /auth/sessions` groups by.
   */
  readonly session: { readonly familyId: string };
  /**
   * The value to echo in `x-orebit-csrf`. Null for a bearer caller, which needs none.
   *
   * Reported here as well as in the readable cookie because the app is served from a
   * different origin and cannot read that cookie — see `SessionCookie.ensureCsrf`.
   * This route and `GET /auth/session` are the two a reloaded page calls before it
   * attempts any mutation, which is what makes them the right places to recover it.
   */
  readonly csrfToken: string | null;
}

export interface EmptyPayload {
  readonly ok: true;
}

/**
 * One live session, as the account-security screen shows it.
 *
 * No token, no family id, no device key. This is a list a user acts on — "that is
 * not me, end it" — so it carries only what identifies a session to a human, plus
 * the id needed to revoke it.
 */
export interface SessionSummaryPayload {
  readonly id: string;
  /** The session making this request. The client needs it to say "this device"
   *  and to warn before revoking the one the user is sitting on. */
  readonly current: boolean;
  readonly ipClass: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
}

/**
 * A browser, with the sessions on it.
 *
 * Grouped rather than flat because a device is what a user recognises: "my phone"
 * is one row with three tabs under it, not three unexplained sessions. Trust is a
 * property of the group, which is also the only level at which it can be revoked.
 */
export interface DeviceGroupPayload {
  /** Null when this device was never trusted — most of them. Present ids are what
   *  `POST /auth/device { action: "untrust" }` accepts. */
  readonly deviceId: string | null;
  readonly label: string | null;
  readonly trusted: boolean;
  /** When trust lapses. Null when the device is not trusted. */
  readonly trustedUntil: string | null;
  /** True when the caller's own session is in this group. */
  readonly current: boolean;
  readonly sessions: readonly SessionSummaryPayload[];
}

export interface SessionListPayload {
  readonly devices: readonly DeviceGroupPayload[];
}

/**
 * A session, as it goes over the wire.
 *
 * No tokens at all — see `SessionPayload`. Both live in the server-side record that
 * `SessionCookie.issue` hands the browser a handle to, so the only thing this function
 * can still leak is the CSRF token, which is not a credential and is in a readable
 * cookie anyway.
 *
 * `csrfToken` is a PARAMETER rather than derived here, and that is deliberate: it
 * comes from `SessionCookie.issue`, which is the one place that mints it and sets the
 * cookie in the same breath. Deriving a second one here would emit a token whose
 * cookie was never written, so every mutation the client then attempted would fail
 * the double-submit check.
 *
 * Here rather than in auth.controller.ts because it is not only the auth controller's:
 * `POST /auth/2fa/verify` mints the session at the end of a ceremony and has to
 * serialise it identically. A second copy would be a second place for a credential to
 * find its way back into a body.
 */
export function toSessionPayload(session: IssuedSession, csrfToken: string): SessionPayload {
  return {
    user: toPublicUserPayload(session.user),
    csrfToken,
    // `refreshExpiresAt` IS `Session.expiresAt` — the refresh token is signed to the
    // row's deadline rather than to a constant, see `SessionService.mint` — so this
    // reports the session's own clock and not a second opinion about it.
    expiresAt: session.refreshExpiresAt.toISOString(),
  };
}

/**
 * What the login and registration pages render the captcha widget with.
 *
 * `providers` is a LIST because several may be live at once. A page renders the
 * first, or offers a choice, and echoes the one it used back as `captchaProvider`
 * on the request that spends the token. Site keys are public by design — they ship
 * to the browser either way.
 *
 * Empty with `enabled: false` in a local environment with no provider configured.
 * `enabled` is a rendering hint and gates nothing server-side; see the note on
 * `CaptchaDescriptor`.
 *
 * The payload is restated here rather than returning the descriptor directly, so
 * the wire shape is one this file owns and a field added to the descriptor cannot
 * appear in a response by accident.
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
