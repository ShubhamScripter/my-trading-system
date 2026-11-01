import type { LoginState, OauthProvider, RegistrationState } from '@prisma/client';

/**
 * Internal domain types for `auth/`. Nothing here is a request or response shape
 * — those live in the dto files. These are what the services pass between
 * themselves.
 */

/** The explicit subset of a user record that may cross the API boundary. */
export interface PublicUser {
  readonly publicCode: string;
  readonly username: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly country: string | null;
  readonly referralCode: string;
  readonly hasPassword: boolean;
  readonly registeredAt: Date;
  readonly avatarUrl: string | null;
}

/** The authenticated caller, attached to the request by AuthGuard. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly publicCode: string;
  /**
   * The session's rotation family — constant across every refresh, unlike
   * `sessionId`, which changes on each one.
   *
   * Not a claim on the access token: it comes from the liveness lookup the guard
   * already performs on every authenticated request, so it costs nothing and needs no
   * change to tokens already issued. It is what session-administration quotas are
   * keyed on — see `SessionService.rateLimitSessionAdmin`.
   */
  readonly familyId: string;
}

/** JWT payload `typ`, and the Ed25519 keypair a token is signed with: the two are
 *  the same axis, so a token of the wrong type fails at the signature before this
 *  claim is read. Asserted anyway as defence in depth — see jwt.ts. */
export type TokenType = 'access' | 'refresh';

export interface AccessClaims {
  readonly sub: string;
  readonly sid: string;
  readonly pid: string;
  readonly typ: 'access';
}

export interface RefreshClaims {
  readonly sub: string;
  readonly sid: string;
  readonly fam: string;
  readonly typ: 'refresh';
}

/** What a request tells us about who is calling. The device ID is an opaque
 *  browser-profile grouping key; it never authorises anything. */
export interface ClientContext {
  readonly ip: string;
  readonly ipClass: string;
  /** The raw cookie secret. Needed to create or look up a trust record; never stored. */
  readonly deviceId: string;
  /** `pepperedHash(deviceId, 'device')`. The only form that reaches the database. */
  readonly deviceKey: string;
  readonly userAgent: string | null;
  /** See `RefreshContext.country` — same value, same rules. */
  readonly country: string | null;
}

/**
 * What a REFRESH knows about its caller — strictly less than a sign-in does.
 *
 * ═══ WHY THIS IS A NARROWER TYPE AND NOT JUST `ClientContext` ══════════════
 *
 * Because rotation moved. It used to happen on `POST /auth/session`, a route like any
 * other: it ran `deviceCookie(req, reply)`, which ISSUES a device cookie when there
 * is not a valid one, so `deviceKey` was always a real value. Rotation now happens
 * inside `AuthGuard`, on whichever request finds the stored access token near expiry
 * — and a guard must not emit a `Set-Cookie` as a side effect of authenticating. So
 * it reads the cookie without writing one (`readDeviceKey`), and on a browser that
 * has cleared its cookies there is genuinely nothing to read.
 *
 * `null` is therefore a real state on this path and not an error, which is why it is
 * in the type rather than papered over with an empty string. An empty string would
 * silently compare unequal to every stored fingerprint — quietly withdrawing every
 * trusted device's remember-me window — and would then be WRITTEN to the child
 * generation, breaking device-scoped logout for the rest of the session. See
 * `honourTrust` and `SessionDbOperation.rotate` for the two places that answer it.
 *
 * `ClientContext` is structurally assignable to this, so every sign-in path keeps
 * passing the context it already builds and nothing else has to change.
 */
export interface RefreshContext {
  readonly ipClass: string;
  /** Null when the request carried no usable device cookie. */
  readonly deviceKey: string | null;
  readonly userAgent: string | null;
  /**
   * The country Cloudflare reported for the request performing this rotation, or null.
   *
   * ─── Why it is on the CONTEXT and not resolved inside the rotation ────────
   *
   * Because only the request layer can read a header, and by design only the request
   * layer is allowed to: `cloudflareCountry` is gated on the deployment's proxy trust,
   * and threading the resolved value inward keeps that gate in one place rather than
   * letting a persistence method reach back for a header it cannot judge.
   *
   * Written onto each new generation, so `sessions.country` becomes a per-observation
   * history — the same shape `ip_class` already has, and the only thing that can answer
   * "has this account been seen from this country before". Null rows are ordinary and
   * carry no meaning beyond "nobody established a country for that request".
   */
  readonly country: string | null;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

/** A minted session, as returned to a client. */
export interface IssuedSession extends TokenPair {
  readonly sessionId: string;
  readonly user: PublicUser;
}


/** Why a session was revoked. Written to `Session.revokedReason`. */
export const REVOKE_REASON = {
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  REUSE_DETECTED: 'REUSE_DETECTED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  /**
   * Biometric sign-in was turned off. Every session but the one that turned it off
   * is swept, for the same reason a password change sweeps them: the credential a
   * session may have been established with no longer exists, and if the disable was
   * not the owner's doing, the sweep is what ends the other party's access.
   */
  PASSKEY_DISABLED: 'PASSKEY_DISABLED',
  /**
   * The authenticator app was turned off. Its own reason rather than a shared
   * "factor disabled" one, because the whole value of this column is answering
   * "why did my other devices sign out" precisely — and a user who turned off one
   * of two factors is owed the name of the one they turned off.
   *
   * Same sweep as `PASSKEY_DISABLED`, on the same argument: a TOTP code may have
   * been how a session was established, so the credential behind those sessions no
   * longer exists.
   */
  TOTP_DISABLED: 'TOTP_DISABLED',
  /**
   * The account's email address was changed.
   *
   * The same sweep as the two above, on the same argument, and it reaches further here
   * than anywhere else: the old address is a sign-in credential — email-OTP login is
   * the recovery path that replaced forgot-password — so a session may well have been
   * established by proving the mailbox that no longer belongs to this account. That is
   * precisely "the credential a session may have been established with no longer
   * exists".
   *
   * And if the change was not the owner's doing, the sweep is what ends the other
   * party's access, which is the half that matters most for an identifier change.
   */
  EMAIL_CHANGED: 'EMAIL_CHANGED',
  /**
   * A recent email change was undone or redirected from the released address.
   *
   * Its own reason rather than reusing `EMAIL_CHANGED`, for the reason `TOTP_DISABLED`
   * gives about naming precisely: "why did my devices sign out" has a different answer
   * here, and it is the more alarming one. A recovery is often a report that the
   * previous change was somebody else's doing.
   *
   * Sweeps EVERY session rather than all-but-one, which is the difference from every
   * other member: the caller has no session to keep. Recovery is authorised by a mailed
   * ticket, not by a bearer token, exactly so a locked-out owner can reach it.
   */
  EMAIL_RECOVERED: 'EMAIL_RECOVERED',
  /**
   * The owner deleted the account.
   *
   * Sweeps EVERY session, including the one that asked — `EMAIL_RECOVERED`'s property
   * rather than the all-but-one every other settings action uses, and for a stronger
   * reason. The others leave the caller signed in because the account is still theirs
   * to use; here there is no account left to stay signed in to, and a surviving session
   * would be a live credential for a state that is supposed to grant nothing.
   *
   * This is also the sweep that makes the deleted state hold at all. `AuthGuard` never
   * loads the user row, so `status` alone stops no request already carrying a token;
   * revoking seeds the Redis deny-flags and ends every one of them on its next call.
   * `SessionService.mint` refuses to issue new ones. Together those two are the whole
   * enforcement, and neither is sufficient alone.
   *
   * Written while `deletedAt` is still NULL, so a reactivation inside the window finds
   * its sessions revoked and its account intact — the owner signs in again rather than
   * resuming, which is the correct outcome for a deletion that was not theirs.
   */
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',
} as const;

export type RevokeReason = (typeof REVOKE_REASON)[keyof typeof REVOKE_REASON];

/**
 * The state a step requires to be legal.
 *
 * A table rather than a chain of `if` statements in the service: it is the one
 * place to look to answer "can a client do X now", so an illegal step cannot be
 * introduced by editing a single conditional.
 *
 * Note `country` requires `CREDENTIALS_SET` alone. The account is created *by*
 * the country step, in one transaction that also completes the registration —
 * there is no intermediate state in which a user row exists and the registration
 * is still open. `RegistrationState.ACCOUNT_CREATED` survives in the Prisma enum
 * from the flow that predated that change; nothing writes it.
 *
 * `check-referral` is legal from `CREDENTIALS_SET` as well, because a
 * provider-verified OAuth registration starts there — see `beginRegistration`.
 * Without that entry the social path would silently lose referral codes, which is
 * a product regression rather than a security property.
 */
export const STEP_REQUIRES: Readonly<Record<string, readonly RegistrationState[]>> = {
  'resend-otp': ['OTP_SENT'],
  'verify-email': ['OTP_SENT'],
  'check-referral': ['OTP_SENT', 'OTP_VERIFIED', 'CREDENTIALS_SET'],
  // Only from CREDENTIALS_SET: the question is asked on the screen immediately
  // before `country`, and answering it earlier would record a preference against a
  // registration that may still fail at the credentials step.
  'trust-device': ['CREDENTIALS_SET'],
  credentials: ['OTP_VERIFIED'],
  country: ['CREDENTIALS_SET'],
};

/**
 * The same idea for the sign-in flow: which `LoginState` each step of
 * `POST /auth/login` is legal from.
 *
 * This table is what makes a step unskippable. Holding a `loginId` is possession
 * of a handle, not permission to do anything with it — every step is checked
 * against the state of the row it resolves to, so an attacker who lifted a handle
 * from a flow that has only just started cannot jump to the step that mints a
 * session.
 *
 * ─── Only CONTINUATION steps are listed ───────────────────────────────────
 *
 * The three steps that can OPEN a flow — `password`, `otp-request` without a
 * handle, and `oauth-start` — are absent, and necessarily so: they create the row
 * this table asks about, so there is no prior state for them to require. They are
 * dispatched before the gate runs.
 *
 * `otp-request` appears anyway, because it is the one step that can be either:
 * with a `loginId` it is a resend and goes through the gate like any other
 * continuation.
 *
 * `state` is here even though it admits every live state, and listing them out
 * is deliberate. It was briefly left out on the reasoning that "legal
 * everywhere" needs no entry — which was wrong in a way that a comment cannot
 * fix, because `assertLoginStep` fails CLOSED on a step it does not recognise.
 * An absent key does not mean "always allowed"; it means "always refused", so
 * the step was unreachable in every state.
 *
 * That fail-closed direction is the right one and is why the fix is an entry
 * rather than an exemption: a new step added without a table entry should be
 * refused loudly on its first request, not run from any state at all.
 *
 * ─── What is deliberately NOT in this table ────────────────────────────────
 *
 * `POST /auth/2fa/verify`. It is a different route with its own table,
 * `TWO_FACTOR_STATE_REQUIRES`, and it admits `FACTOR_REQUIRED` and nothing else.
 * Splitting them is not duplication: the second factor is the one step that must
 * remain unreachable from every state the first factor has not yet left, and
 * keeping its rule beside the route that enforces it is what stops a well-meaning
 * edit here from widening it.
 */
export const LOGIN_STEP_REQUIRES: Readonly<Record<string, readonly LoginState[]>> = {
  /**
   * A resend, and the only entry point that is ALSO a continuation.
   *
   * `otp-request` with no `loginId` creates a flow and never reaches this table —
   * there is no row yet to check a state against. With one, it is a resend, and
   * the row already holds the address and the send budget, so it must land on the
   * same flow rather than opening a second.
   *
   * STARTED is legal alongside OTP_SENT because a flow can be at STARTED with a
   * handle already issued: `oauth-start` leaves it there across the provider round
   * trip. A caller who abandons that and asks for a code instead is resuming their
   * own sign-in, not skipping anything.
   */
  'otp-request': ['STARTED', 'OTP_SENT'],
  'otp-verify': ['OTP_SENT'],
  /**
   * The return leg of the provider round trip.
   *
   * Legal only from STARTED because the flow is bound into the OAuth `state`
   * stash at `oauth-start`, and nothing between the two advances it. A callback
   * arriving against a flow that has since proven a password is a flow being
   * REUSED, not resumed.
   */
  'oauth-callback': ['STARTED'],
  'oauth-register': ['STARTED'],
  // Every live state. A pure read of the caller's own progress, for a client
  // that holds a handle but has lost track of where it is — a reloaded page, or
  // the return leg of an OAuth round trip. The terminal states are absent
  // because `resolveFlow` refuses both before this table is consulted.
  state: ['STARTED', 'OTP_SENT', 'FACTOR_REQUIRED'],
};

/** How an OAuth callback resolved. The client renders a different screen for
 *  each, which is why it is a discriminated result rather than an error. */
/** Narrowings of `OauthOutcome`, so each entry point declares the outcomes it can
 *  actually produce and callers get no impossible branches to defend against. */
export type OauthCallbackOutcome = Extract<
  OauthOutcome,
  { kind: 'session' | 'choice_required' | 'mfa_required' }
>;
export type OauthRegisterOutcome = Extract<OauthOutcome, { kind: 'registration_required' }>;

export type OauthOutcome =
  | { readonly kind: 'session'; readonly session: IssuedSession }
  /**
   * The provider identity is linked and valid, and the account behind it has a
   * second factor. Structurally identical to `LoginResult`'s variant of the same
   * name, and that is on purpose: the controller maps both through one function, so
   * a provider sign-in cannot drift into skipping a ceremony the password path
   * enforces.
   */
  | {
      readonly kind: 'mfa_required';
      readonly methods: readonly string[];
      readonly expiresAt: Date;
    }
  /** A new person. `continuationSecret` is the plaintext the controller returns as
   *  `signupId` — the registration's id deliberately does not travel to the
   *  client. */
  | {
      readonly kind: 'registration_required';
      readonly continuationSecret: string;
      readonly email: string;
      readonly emailVerified: boolean;
    }
  /**
   * No link exists yet, so the caller has to choose: create an account, or sign in
   * to one they already have and attach the provider to it.
   *
   * `canCreateNew` is false in two distinct situations, and a client can tell them
   * apart by whether `email` is null:
   *
   *  - `email` present — the address already belongs to an account. Registration
   *    needs an unused one, so only the link branch is open.
   *  - `email` null — the PROVIDER gave no address. X and Telegram never do; Apple
   *    and Facebook sometimes do not. There is nothing to register with, so this
   *    identity is link-only for good.
   *
   * Both are facts about the world rather than policy, which is why they travel with
   * the choice instead of being re-derived by the client.
   */
  | {
      readonly kind: 'choice_required';
      readonly linkToken: string;
      /** Null when the provider supplies no address — see above. */
      readonly email: string | null;
      readonly canCreateNew: boolean;
      /** Which provider this identity came from, so a client can name it on screen
       *  without tracking the request it started. */
      readonly provider: OauthProvider;
    };

/** A verified third-party identity, normalised across providers. */
export interface OauthIdentity {
  readonly provider: OauthProvider;
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** The provider's display name, if any — the seed for username generation on
   *  the social path. */
  readonly name: string | null;
  /** The avatar URL asserted by the provider. */
  readonly avatarUrl: string | null;
}
