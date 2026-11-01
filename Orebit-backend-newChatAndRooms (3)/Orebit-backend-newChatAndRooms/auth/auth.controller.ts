import { Inject, Injectable } from '@nestjs/common';
import type { LoginAttempt, Registration } from '@prisma/client';
import {
  CAPTCHA_ACTIONS,
  CAPTCHA_VERIFIER,
  type CaptchaAction,
  type CaptchaProvider,
  type CaptchaVerifier,
} from '../src/captcha/captcha.types';
import { ok, parseDto, ProblemException, type SuccessEnvelope } from '../src/http';
import { ERR } from '../src/contracts';
import { OTP } from './auth.constants';
import type {
  ClientContext,
  IssuedSession,
  OauthCallbackOutcome,
  Principal,
} from './auth.types';
import { UserService } from './services/user.service';
import { linkRequestSchema, type LinkPayload } from './dto/link.dto';
import {
  deviceRequestSchema,
  loginRequestSchema,
  toCaptchaPayload,
  passwordRequestSchema,
  registerRequestSchema,
  sessionRequestSchema,
  toPublicUserPayload,
  toSessionPayload,
  updateMyProfileRequestSchema,
  type EmptyPayload,
  type LoginPayload,
  type MePayload,
  type PublicUserPayload,
  type ReferralCheckPayload,
  type RegistrationStartPayload,
  type RegistrationStatePayload,
  type CaptchaPayload,
  type DeviceGroupPayload,
  type LogoutPayload,
  type SessionListPayload,
  type SessionPayload,
  type SessionStatusPayload,
} from './auth.dto';
import type { SessionCookie } from './security/session.cookie';
import { BffSessionService } from './security/bff.session';
import { SESSION_ACTION_MESSAGES, SESSION_MESSAGES } from './security/session.message';
import { LoginService, type LoginResult } from './services/login.service';
import { OauthService } from './services/oauth.service';
import { PasswordService } from './services/password.service';
import { RegistrationService } from './services/registration.service';
import { SessionService, type SessionGroup } from './services/session.service';


/**
 * Parse, delegate, serialise. No business logic.
 *
 * Each of the four POST methods parses its discriminated union and switches on the
 * discriminator. The switches are exhaustive and the `never` assignment in each
 * `default` is what enforces that: adding a variant to a schema without handling
 * it here fails the build rather than falling through to a runtime error.
 */
@Injectable()
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly login: LoginService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly oauth: OauthService,
    private readonly users: UserService,
    private readonly bff: BffSessionService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
  ) {}

  /**
   * Store a freshly-minted session and hand the browser its handle. THE one place a
   * session becomes a cookie.
   *
   * Every sign-in path funnels through here — password, email-OTP, OAuth, the final
   * registration step, and `POST /auth/2fa/verify` through its own controller — so
   * "create the record, then set the cookies, then serialise" cannot be got half
   * right in one of them. Before this, each path called `cookies.issue(session)` for
   * itself, and the failure mode of a new path forgetting was a client with a user
   * object and no credential.
   *
   * The record is written BEFORE the cookie, and the order matters: `create` is
   * fail-closed, so a browser never leaves holding a handle that names nothing.
   */
  private async mintCookies(
    cookies: SessionCookie,
    issued: IssuedSession,
  ): Promise<SessionPayload> {
    const handle = await this.bff.create(issued);
    const csrfToken = cookies.issue(handle);
    return toSessionPayload(issued, csrfToken);
  }

  // ─── POST /auth/register ──────────────────────────────────────────────────

  /**
   * All eight steps. `start` mints the continuation secret and RETURNS it as
   * `signupId`; every later step presents it in the body, and the service resolves
   * the registration from its hash.
   *
   * Nothing is set on the reply by the registration steps themselves — the only
   * cookies this method issues are the session pair, on the one step that creates
   * an account. That is what the removal of the `orebit_reg` port bought: seven of
   * the eight steps no longer touch HTTP state at all.
   */
  async register(
    body: unknown,
    client: ClientContext,
    sessionCookies: SessionCookie,
  ): Promise<
    SuccessEnvelope<RegistrationStartPayload | RegistrationStatePayload | ReferralCheckPayload>
  > {
    const input = parseDto(registerRequestSchema, body);

    switch (input.step) {
      case 'start': {
        await this.verifyCaptcha(
          input.captchaProvider,
          input.captchaToken,
          client,
          CAPTCHA_ACTIONS.REGISTER_START,
        );
        const { registration, continuationSecret } = await this.registration.start(input, client);
        // The one response that carries the handle. Every later step sends it back,
        // and nothing else in the flow ever returns it again — a client that loses
        // it starts over, which is the same outcome the browser-session cookie
        // produced when the tab closed.
        return ok(this.toStartPayload(registration, continuationSecret));
      }

      case 'resend-otp': {
        const registration = await this.registration.resendOtp(input.signupId);
        return ok(this.toStatePayload(registration));
      }

      case 'verify-email': {
        const registration = await this.registration.verifyEmail(input.signupId, input);
        return ok(this.toStatePayload(registration));
      }

      case 'trust-device': {
        const registration = await this.registration.setTrustDevice(input.signupId, input);
        return ok(this.toStatePayload(registration));
      }
      case 'check-referral': {
        const { registration, referrerUsername } = await this.registration.checkReferral(
          input.signupId,
          input,
        );
        const payload: ReferralCheckPayload = {
          valid: referrerUsername !== null,
          ...(referrerUsername !== null ? { referrerUsername } : {}),
          state: this.toStatePayload(registration),
        };
        return ok(payload);
      }

      case 'credentials': {
        const registration = await this.registration.setCredentials(input.signupId, input);
        return ok(this.toStatePayload(registration));
      }

      case 'country': {
        const { registration, session } = await this.registration.setCountry(
          input.signupId,
          input,
          client,
        );
        // Nothing to clear. The registration is closed and its hash is nulled in
        // the same transaction that creates the account, so the `signupId` the
        // client is holding is already dead — there is no browser state left over
        // to expire, which is one of the things moving it out of a cookie bought.
        //
        // The step that creates the account is also the step that issues the first
        // session, so it is where the session cookie starts.
        return ok(this.toStatePayload(registration, await this.mintCookies(sessionCookies, session)));
      }

      case 'state': {
        const registration = await this.registration.readState(input.signupId);
        return ok(this.toStatePayload(registration));
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── POST /auth/login ─────────────────────────────────────────────────────

  /**
   * All seven steps.
   *
   * ─── There is no `start` ──────────────────────────────────────────────────
   *
   * The FIRST REAL OPERATION opens the flow and returns the `loginId`. Three
   * steps can be first — `password`, `otp-request` and `oauth-start` — and each
   * mints the handle as part of doing its actual work, so a client reaches a
   * sign-in screen and posts a credential rather than posting an empty body to
   * collect an identifier and then posting the credential.
   *
   * Every later step presents the handle in the body and is resolved and
   * state-checked by `resolveFor` before it runs.
   *
   * Every in-progress outcome carries the handle back. That is enforced by the
   * TYPE — see `LoginResult` — rather than by this method remembering to add it:
   * a payload describing a flow the client cannot continue is not one worth being
   * able to construct.
   */
  async loginRequest(
    body: unknown,
    client: ClientContext,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<LoginPayload>> {
    const input = parseDto(loginRequestSchema, body);

    // ═══ ONE GATE, BEFORE ANY BRANCH RUNS ═══════════════════════════════════
    //
    // Resolved and state-checked here rather than inside each case, because a
    // branch that resolved its own flow would work perfectly while skipping
    // `assertLoginStep`, and nothing would report it until somebody noticed the
    // sign-in could be short-circuited. Hoisting it above the switch makes
    // forgetting it impossible rather than merely unlikely.
    //
    // `null` for the three steps that OPEN a flow — `password`, `oauth-start`,
    // and `otp-request` without a handle. There is nothing to resolve yet: they
    // create the row themselves, further down, once their own limiters have been
    // charged. The DTO is what guarantees the distinction rather than this line:
    // a `loginId` is absent from those bodies because the schema forbids it, not
    // because the controller chose not to look.
    const loginId = 'loginId' in input ? input.loginId : undefined;
    const flow = loginId === undefined ? null : await this.resolveFor(loginId, input.step, client);

    switch (input.step) {
      case 'password': {
        await this.verifyCaptcha(
          input.captchaProvider,
          input.captchaToken,
          client,
          CAPTCHA_ACTIONS.LOGIN_PASSWORD,
        );
        // No flow is passed in and none exists yet. `withPassword` opens one only
        // once the password has actually verified, so a wrong guess leaves no row.
        return this.toLoginPayload(await this.login.withPassword(input, client), sessionCookies);
      }

      case 'otp-request': {
        await this.verifyCaptcha(
          input.captchaProvider,
          input.captchaToken,
          client,
          CAPTCHA_ACTIONS.LOGIN_OTP_REQUEST,
        );
        // The one step that is either an entry point or a continuation. `flow` is
        // null on the first request and the resolved row on a resend; the service
        // opens one in the first case and reuses it in the second, so a resend
        // never changes the handle the client is holding.
        return this.toLoginPayload(
          await this.login.requestOtp(flow, loginId ?? null, input, client),
          sessionCookies,
        );
      }

      case 'otp-verify': {
        return this.toLoginPayload(
          await this.login.verifyOtp(flow as LoginAttempt, input.loginId, input, client),
          sessionCookies,
        );
      }

      case 'oauth-start': {
        // `url` is null for a provider with no authorization endpoint (Telegram),
        // and `flow` is what tells the client to render its Login Widget instead of
        // navigating. The state is minted either way — see `OauthService.start`.
        //
        // The flow is opened by the callback handed over here rather than before
        // the call, so the provider quotas are charged first and a refused request
        // writes no row.
        const started = await this.oauth.start(input, client, () =>
          this.login.openFlowFor(client),
        );
        return ok({
          outcome: 'redirect',
          loginId: started.loginId,
          url: started.url,
          state: started.state,
          flow: started.flow,
        });
      }

      case 'oauth-callback': {
        const outcome = await this.oauth.callback(flow as LoginAttempt, input, client);
        // A linked provider identity resolves to a login like any other, second
        // factor included — which is the whole point of routing it through the same
        // mapper. It used to mint a session inline, and that made "Continue with
        // Google" a documented way past a factor the user had switched on.
        if (outcome.kind === 'session') {
          return this.toLoginPayload(outcome, sessionCookies);
        }
        if (outcome.kind === 'mfa_required') {
          // The handle is added here rather than by the OAuth service, which does
          // not hold it: the caller presented it, and the flow it named is the one
          // that was just promoted.
          return this.toLoginPayload({ ...outcome, loginId: input.loginId }, sessionCookies);
        }
        // Anything else is a question for the user rather than an answer. The
        // callback never registers on its own any more — that is `oauth-register`.
        //
        // A null `email` with `canCreateNew: false` is the link-only case: the
        // provider supplied no address, so this identity can be attached to an
        // account but can never create one. `provider` is passed through so the
        // client can name it on screen without tracking the request it started.
        return ok({
          outcome: 'choice_required',
          loginId: input.loginId,
          linkToken: outcome.linkToken,
          email: outcome.email,
          canCreateNew: outcome.canCreateNew,
          provider: outcome.provider,
        });
      }

      case 'oauth-register': {
        const outcome = await this.oauth.chooseRegister(input.linkToken, client);
        // The sign-in is over — there is no account to sign in to — so the login
        // flow is retired and the caller is handed the SIGNUP handle instead. Two
        // flows, two handles, and the transition between them is explicit rather
        // than one credential quietly changing meaning.
        await this.login.abandonFlow(flow as LoginAttempt);
        return ok({
          outcome: 'registration_required',
          signupId: outcome.continuationSecret,
          email: outcome.email,
          emailVerified: outcome.emailVerified,
        });
      }

      case 'state': {
        return this.toLoginPayload(
          await this.login.describeFlow(flow as LoginAttempt, input.loginId),
          sessionCookies,
        );
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * Resolve the flow a `loginId` names, then assert the step is legal from its
   * state.
   *
   * Both halves in one place, and every caller uses it, for the reason given at
   * the call site: the failure mode of splitting them is silent.
   *
   * Three answers, none of which leaks anything the caller does not already hold.
   * `resolveFlow` throws `mfa_token_invalid` for a handle that is unknown, spent
   * or superseded — one answer for all three, so a caller cannot learn whether a
   * guess was ever valid — and `mfa_expired` for one that ran out of time.
   * `assertLoginStep` throws `mfa_step_invalid` and discloses the flow's state on
   * purpose, because it is the caller's own progress.
   */
  private async resolveFor(
    loginId: string,
    step: string,
    client: ClientContext,
  ): Promise<LoginAttempt> {
    const flow = await this.login.resolveFlow(loginId, client);
    this.login.assertLoginStep(flow, step);
    return flow;
  }

  // ─── POST /auth/session ───────────────────────────────────────────────────

  /**
   * ═══ THE ORDER IS REVOKE, THEN DESTROY, THEN CLEAR ═════════════════════════
   *
   * Postgres first, Redis second, the browser last, and each step is only allowed to
   * run because the one before it committed.
   *
   * Backwards — clearing the cookie first, say — a failure anywhere after it would
   * leave the user apparently signed out while the session stayed live and, worse,
   * unreachable: the handle in the cookie we just deleted was the only value naming
   * it. Nobody could revoke it afterwards, including its owner. So the durable
   * revocation happens first and the browser's copy is dropped only once there is
   * nothing left for it to name.
   *
   * ─── The one refusal that happens BEFORE any of it ────────────────────────
   *
   * A logout with no principal and an unreadable store. There is no principal when
   * the session is already dead (which is fine, and idempotent) — but "already dead"
   * and "Redis cannot tell us" are different, and `recordState` is what separates
   * them. Reporting a successful logout while the store that holds the mapping was
   * unreachable would be a lie about a security operation, so it answers 503 and
   * keeps the cookies. See `BffSessionService.recordState`.
   */
  async session(
    body: unknown,
    principal: Principal | null,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<LogoutPayload | EmptyPayload>> {
    const input = parseDto(sessionRequestSchema, body);
    const handle = sessionCookies.read();

    // CSRF is no longer checked here. It is asserted in `AuthGuard.authenticate` for
    // every unsafe method on every route, before the credential is spent — this route
    // stopped being the only cookie-authenticated one the moment the cookie went
    // root-scoped. See `assertCsrf` in security/guards.ts.

    if (input.action === 'revoke-session') {
      // The one action here that names a session other than the caller's, so it is
      // the one that cannot work on a dead session: there has to be a principal to
      // check ownership against.
      if (principal === null) {
        throw new ProblemException({ type: ERR.UNAUTHENTICATED });
      }
      await this.sessions.revokeSession(principal, input.sessionId);
      // Deliberately no cookie change. This ends some OTHER browser's session; the
      // caller's own credential is untouched and must keep working.
      return ok({ ok: true as const });
    }

    if (principal !== null) {
      if (input.action === 'logout') {
        await this.sessions.logout(principal);
      } else {
        await this.sessions.logoutAll(principal);
      }
    } else if (handle !== null) {
      // No principal, but a handle was presented — so the guard tolerated a dead
      // session. Confirm it is actually gone rather than merely unreadable.
      if ((await this.bff.recordState(handle)) === 'unknown') {
        throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
      }
    }

    if (handle !== null) await this.bff.destroy(handle);
    sessionCookies.clear();
    return ok({ message: SESSION_ACTION_MESSAGES.LOGGED_OUT });
  }

  // ─── GET /auth/session ────────────────────────────────────────────────────

  /**
   * Am I signed in, and if not, why not?
   *
   * The 200 is the easy half. The interesting half is the 401, which this method never
   * produces: the guard refuses first, and `@ExplainsSessionState()` is what makes that
   * refusal carry the reason — see `AuthGuard.canActivate` and
   * security/session.message.ts. So there is no "not signed in" branch here, and there
   * must not be one: a second place deciding that question would be a second answer to
   * disagree with.
   *
   * `lastActiveAt` comes off the request rather than from a query, because `assertLive`
   * read it on the way past.
   *
   * ─── The account read stays, even though the profile no longer ships ──────
   *
   * `user` left the payload — a liveness probe a client is invited to poll had no
   * business shipping a full profile, and `GET /auth/me` is the route that owns that
   * answer. The `getCurrentUser` call did not leave with it, because it was never only
   * a read for the payload: `requireCurrentUser` answers 401 when the row is gone, and
   * a token CAN outlive a soft-deleted account. Dropping it would make this route
   * report `authenticated: true` for an account that no longer exists — which is the
   * one thing it must never get wrong.
   *
   * ─── `ensureCsrf` is called for its effect, not for its value ─────────────
   *
   * `csrfToken` left the payload too, and a client that needs the token to echo reads
   * it from `me`. The CALL stays because it is also the repair: a request arriving
   * without a usable `orebit_csrf` gets one minted here, which is the documented
   * `Set-Cookie` on this response and the reason a page that reloads into a broken
   * double-submit pair recovers at all. It is read-don't-rotate, so a poll cannot
   * invalidate the token an in-flight save is carrying.
   */
  async sessionStatus(
    principal: Principal,
    lastUsedAt: Date | null,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<SessionStatusPayload>> {
    // Not reporting the token's claims: an account soft-deleted since the session was
    // minted must not be described by a fifteen-minute-old snapshot — the same reason
    // `me` re-reads. `getCurrentUser` throws its own refusal when the row is gone, and
    // that refusal IS the answer this route exists to give.
    await this.users.getCurrentUser(principal.userId);

    // Discarded deliberately — see the note above. Null for a bearer caller, who has
    // no cookie pair to repair.
    void sessionCookies.ensureCsrf();

    return ok({
      authenticated: true as const,
      lastActiveAt: lastUsedAt?.toISOString() ?? null,
      message: SESSION_MESSAGES.LOGGED_IN,
    });
  }

  // ─── POST /auth/password ──────────────────────────────────────────────────

  /**
   * Set or change a password. Authenticated — recovery moved to email-OTP login.
   */
  async password(
    body: unknown,
    principal: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<EmptyPayload>> {
    const input = parseDto(passwordRequestSchema, body);

    switch (input.action) {
      case 'request-code': {
        await this.passwords.requestCode(principal, client);
        return ok({ ok: true as const });
      }
      case 'set': {
        await this.passwords.set(principal, input, client);
        return ok({ ok: true as const });
      }
      case 'change': {
        await this.passwords.change(principal, input, client);
        return ok({ ok: true as const });
      }
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── GET /auth/me, PATCH /auth/me ─────────────────────────────────────────

  /**
   * Delegates to `UserService.getCurrentUser` rather than reading the account
   * here, so this read and `updateMe`'s cannot disagree about the same race.
   *
   * That race — a token outliving a soft-deleted account — resolves to a 401, not
   * a 500. It is a stale credential, which is the client's problem to fix by
   * signing in again, and an internal error would tell them to retry instead.
   * `requireCurrentUser` owns that reasoning; duplicating the read here is what
   * previously let this endpoint contradict it.
   */
  async me(
    principal: Principal,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<MePayload>> {
    const user = await this.users.getCurrentUser(principal.userId);
    return ok({
      user: toPublicUserPayload(user),
      // The family, not `principal.sessionId` — see `MePayload.session`.
      session: { familyId: principal.familyId },
      // Read, not rotated: this route is safe to call repeatedly, and minting a token
      // per call would invalidate the one an in-flight save is carrying.
      csrfToken: sessionCookies.ensureCsrf(),
    });
  }

  /**
   * The profile fields a user may change about themselves. Currently only
   * `country`; the DTO is `.strict()`, so adding a field is a deliberate edit
   * there rather than something a client can discover.
   *
   * Returns the bare user payload, not `MePayload`. A write echoes back what it
   * wrote — the session block in `me` answers "who am I and on what session",
   * which a PATCH did not touch and has no reason to restate.
   */
  // ─── POST /auth/device, GET /auth/sessions ────────────────────────────────

  /**
   * Remember this browser, or forget a remembered one.
   *
   * `trust` needs the client context because the device being trusted is the one
   * that sent the request — its cookie, not a body field.
   */
  async device(
    body: unknown,
    principal: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<EmptyPayload>> {
    const input = parseDto(deviceRequestSchema, body);

    switch (input.action) {
      case 'trust': {
        await this.sessions.trustDevice(principal, client);
        return ok({ ok: true as const });
      }
      case 'untrust': {
        await this.sessions.untrustDevice(principal, input.deviceId);
        return ok({ ok: true as const });
      }
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /** Live sessions, grouped by device — the account-security screen. */
  async sessionList(principal: Principal): Promise<SuccessEnvelope<SessionListPayload>> {
    const groups = await this.sessions.listSessions(principal);
    return ok({ devices: groups.map((group) => toDeviceGroupPayload(group, principal.sessionId)) });
  }

  async updateMe(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<PublicUserPayload>> {
    const input = parseDto(updateMyProfileRequestSchema, body);
    return ok(toPublicUserPayload(await this.users.updateMyProfile(principal.userId, input)));
  }

  // ─── POST /auth/link/preview ──────────────────────────────────────────────

  /**
   * What is waiting behind a `linkToken`, without spending it.
   *
   * Bearer only — deliberately NOT behind `ElevationGuard`. This used to share a
   * route with `linkConfirm`, and the guard on that shared handler spent the
   * single-use ticket before the body was parsed: previewing destroyed the ticket and
   * the confirm that followed failed. See the header of link.dto.ts.
   *
   * Safe to leave unelevated because it writes nothing and discloses nothing the
   * caller does not already hold: the token is theirs, and the identity it names
   * grants access to no account until `linkConfirm` writes the link.
   *
   * No rate limit either. `previewPending` reads a cache key the caller already has,
   * and grinding it gains nothing — `attachPending` is where the meter belongs and is
   * where it sits.
   */
  async linkPreview(
    body: unknown,
    _principal: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<LinkPayload>> {
    const input = parseDto(linkRequestSchema, body);
    const identity = await this.oauth.previewPending(input.linkToken, client);

    return ok({
      outcome: 'preview',
      provider: identity.provider,
      email: identity.email,
      emailVerifiedByProvider: identity.emailVerified,
    });
  }

  // ─── POST /auth/link ──────────────────────────────────────────────────────

  /**
   * Attach a verified provider identity to the calling account.
   *
   * Authenticated AND behind `ElevationGuard` — see the route declaration. This
   * method therefore assumes both: a principal exists, and a ticket proved for
   * `account.oauth.link` has already been spent on THIS request.
   *
   * The route performs exactly one action, which is the point of the split: the
   * guard's `@RequiresElevation` names one write and the handler under it can only
   * do that write. Reading the action from the body would put the choice back in the
   * caller's hands, one layer below where the credential is checked.
   *
   * The rate limit is keyed on the account rather than the IP because the caller is
   * authenticated.
   */
  async linkConfirm(
    body: unknown,
    principal: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<LinkPayload>> {
    const input = parseDto(linkRequestSchema, body);

    await this.oauth.rateLimitLink(principal.userId);
    await this.oauth.attachPending(principal.userId, input.linkToken, client);
    return ok({ outcome: 'linked' });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * The ONE place a login result becomes a response.
   *
   * Every path that can end in a session goes through here — password, email OTP,
   * a linked provider identity, and `POST /auth/2fa/verify` — and that is the point
   * rather than tidiness. The three properties below have to hold identically on
   * all of them, and each was previously written out per branch:
   *
   *   - `mfa_required` issues NO cookies. A half-finished sign-in that set a
   *     refresh cookie would be a session in everything but name.
   *   - a session ALWAYS issues them, so no path can mint tokens and forget to
   *     hand the client the refresh cookie it will need in fifteen minutes.
   *   - `expiresAt` is serialised the same way as every other date on the wire.
   *   - every IN-PROGRESS outcome carries the `loginId` back.
   *
   * That last property is enforced by the TYPE rather than by a parameter of this
   * method. `LoginResult`'s in-progress variants each declare a `loginId`, so an
   * outcome that a client could not continue from cannot be constructed at all —
   * which matters more now that some handles are MINTED by the step that returns
   * them and are not known to the caller beforehand.
   *
   * The `session` outcome deliberately carries none: the flow is over and its
   * handle was retired in the statement that completed it, so returning one would
   * be handing back a value that is already dead.
   *
   * A new login path gets all of it by calling this, and a path that skips it is
   * visible in review as the one that does something else.
   */
  private async toLoginPayload(
    result:
      | LoginResult
      | (Extract<OauthCallbackOutcome, { kind: 'mfa_required' }> & { loginId: string })
      | Extract<OauthCallbackOutcome, { kind: 'session' }>,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<LoginPayload>> {
    switch (result.kind) {
      case 'session':
        return ok({
          outcome: 'session',
          session: await this.mintCookies(sessionCookies, result.session),
        });

      case 'mfa_required':
        return ok({
          outcome: 'mfa_required',
          // Either the handle the caller presented, or the one the first factor
          // just minted. Both are the flow's ONLY handle — the row is promoted in
          // place and nothing new is issued for the second factor.
          loginId: result.loginId,
          methods: result.methods,
          expiresAt: result.expiresAt.toISOString(),
        });

      case 'otp_required':
      case 'otp_sent':
        return ok({
          outcome: result.kind,
          loginId: result.loginId,
          resendAvailableAt: result.resendAvailableAt?.toISOString() ?? null,
        });

      case 'started':
        // Only `step:'state'` produces this, reading back a flow parked mid-OAuth.
        // No step CREATES a flow and stops there any more — the request that opens
        // one always goes on to do something with it.
        return ok({ outcome: 'started', loginId: result.loginId });
    }
  }

  /**
   * Which captcha providers to render.
   *
   * A GET, and not a step on the login union, for two reasons. The registration
   * page needs the same answer and should not POST to `/auth/login` to read
   * configuration. And `register {step:'start'}` already means "a step that
   * CONSUMES a captcha", so reusing `start` to hand one out would be a genuine
   * footgun — the same word would mean opposite things on two routes.
   *
   * The server stays the single authority on which providers are live, so taking
   * one out of rotation never needs a frontend deploy.
   */
  captchaOptions(): SuccessEnvelope<CaptchaPayload> {
    return ok(toCaptchaPayload(this.captcha.describe()));
  }

  /** `provider` is already narrowed to a `CaptchaProvider` by the DTO's
   *  `z.enum(CAPTCHA_PROVIDERS)`, so no cast or re-check is needed here. */
  private async verifyCaptcha(
    provider: CaptchaProvider,
    token: string,
    client: ClientContext,
    action: CaptchaAction,
  ): Promise<void> {
    await this.captcha.verify({ provider, token, ip: client.ip, action });
  }

  /**
   * The `start` response: the state payload minus the fields no registration can
   * have answered yet.
   *
   * The surviving fields are listed rather than rest-spread out of the state
   * payload, which means adding one to `RegistrationStatePayload` breaks this
   * function at compile time. That is the intent — `start` withholding a new
   * field should be a decision someone makes, not the default.
   */
  private toStartPayload(
    registration: Registration,
    /** The plaintext continuation secret, returned to the client exactly once.
     *  Never read back from the row — only its hash is stored. */
    signupId: string,
  ): RegistrationStartPayload {
    const state = this.toStatePayload(registration);
    return {
      signupId,
      state: state.state,
      email: state.email,
      emailVerified: state.emailVerified,
      passwordSet: state.passwordSet,
      otpExpiresAt: state.otpExpiresAt,
      resendAvailableAt: state.resendAvailableAt,
      otpSendsRemaining: state.otpSendsRemaining,
    };
  }

  /**
   * The one response shape every registration step after `start` returns, so a
   * client always knows where it is without a second call.
   */
  private toStatePayload(
    registration: Registration,
    /** Already serialised, and already cookied — see `mintCookies`. Taking the payload
     *  rather than the `IssuedSession` keeps this mapper synchronous and keeps the one
     *  place that writes cookies at the call site, where it is visible. */
    session?: SessionPayload,
  ): RegistrationStatePayload {
    const resendAvailableAt =
      registration.lastOtpSentAt === null
        ? null
        : new Date(registration.lastOtpSentAt.getTime() + OTP.RESEND_COOLDOWN_SECONDS * 1000);

    return {
      // No `registrationId`. The client has no use for it now that the cookie
      // carries the identity, and returning it would invite a client to start
      // treating it as a credential again — which is exactly what this change
      // removed.
      state: registration.state,
      email: registration.email,
      emailVerified: registration.emailVerifiedAt !== null,
      passwordSet: registration.passwordSet,
      otpExpiresAt: registration.otpExpiresAt?.toISOString() ?? null,
      resendAvailableAt:
        resendAvailableAt !== null && resendAvailableAt.getTime() > Date.now()
          ? resendAvailableAt.toISOString()
          : null,
      otpSendsRemaining: Math.max(0, OTP.MAX_SENDS - registration.otpSentCount),
      countrySuggested: registration.countrySuggested,
      country: registration.country,
      referralApplied: registration.referralCodeEntered !== null,
      expiresAt: registration.expiresAt.toISOString(),
      ...(session !== undefined ? { session } : {}),
    };
  }
}


/** The one place a session group's Dates become strings. */
function toDeviceGroupPayload(group: SessionGroup, currentSessionId: string): DeviceGroupPayload {
  return {
    deviceId: group.deviceId,
    label: group.label,
    trusted: group.trustedUntil !== null,
    trustedUntil: group.trustedUntil?.toISOString() ?? null,
    current: group.current,
    sessions: group.sessions.map((session) => ({
      id: session.id,
      current: session.id === currentSessionId,
      ipClass: session.ipClass,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    })),
  };
}
