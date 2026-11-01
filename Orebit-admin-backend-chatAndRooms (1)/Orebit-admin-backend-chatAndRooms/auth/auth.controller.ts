import { Inject, Injectable } from '@nestjs/common';
import {
  CAPTCHA_ACTIONS,
  CAPTCHA_VERIFIER,
  type CaptchaAction,
  type CaptchaProvider,
  type CaptchaVerifier,
} from '../src/captcha/captcha.types';
import { ERR } from '../src/contracts';
import { ok, parseDto, ProblemException, type SuccessEnvelope } from '../src/http';
import {
  loginRequestSchema,
  sessionRequestSchema,
  toAdminPayload,
  toCaptchaPayload,
  toLoginPayload,
  type LogoutPayload,
  type LoginPayload,
  type MePayload,
  type SessionStatusPayload,
} from './auth.dto';
import type { ClientContext, LoginStep, Principal } from './auth.types';
import { toPublicAdmin } from './auth.utility';
import { AdminDbOperation } from './persistence/admin.dboperation';
import { BffSessionService } from './security/bff.session';
import {
  SESSION_ACTION_MESSAGES,
  SESSION_MESSAGES,
  signedOutStatus,
} from './security/session.message';
import { assertStep } from './security/stepup';
import type { SessionCookie } from './security/session.cookie';
import { LoginService, type ResolvedAttempt } from './services/login.service';
import { SessionService } from './services/session.service';

/**
 * Parse, delegate, serialise. No business logic.
 *
 * ─── The one thing this file DOES decide ────────────────────────────────────
 *
 * `login` is the whole sign-in ceremony, and the two lines that make it safe are
 * `logins.resolve()` followed by `assertStep`. Every step past `password` goes
 * through both, in that order, at exactly one place — the `resolveFor` helper
 * below. A step that resolved its own attempt would be a step that could forget to
 * check its state, so no step is allowed to.
 *
 * The switch is exhaustive and the `never` assignment in `default` is what
 * enforces that: adding a variant to `loginRequestSchema` without handling it here
 * fails the build rather than falling through to a runtime error.
 */
@Injectable()
export class AuthController {
  constructor(
    // `logins`, not `login` — the method below is `login()`, and a field of the
    // same name shadows it.
    private readonly logins: LoginService,
    private readonly sessions: SessionService,
    private readonly admins: AdminDbOperation,
    private readonly bff: BffSessionService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
  ) {}

  // ─── POST /auth/login ─────────────────────────────────────────────────────

  /**
   * The first half of the ceremony: password, emailed code, and the state read
   * that lets a desynchronised client resume. It ends at `EMAIL_VERIFIED` and never
   * mints a session — the second factor is proven on `POST /2fa`.
   *
   * `password` mints the sign-in credential and RETURNS it as `loginId`; every
   * later step presents it in the body, and the same value carries the caller on to
   * `/2fa`. Nothing is set on the reply — this method never touches a FastifyReply,
   * which is what keeps it testable without a live HTTP layer.
   *
   * `deviceId` arrives as a resolved value rather than a port, because unlike the
   * session cookies there is nothing to require and nothing to verify — the route
   * mints one when the browser presents none. It names the per-browser rate-limit
   * bucket; see security/device.cookie.ts.
   */
  async login(
    body: unknown,
    client: ClientContext,
    deviceId: string,
  ): Promise<SuccessEnvelope<LoginPayload>> {
    const input = parseDto(loginRequestSchema, body);

    switch (input.step) {
      case 'start': {
        // What the login page renders the captcha with. The server stays the
        // single authority on which provider is live. No `loginId` — there is no
        // attempt yet for one to name.
        return ok({ outcome: 'captcha' as const, captcha: toCaptchaPayload(this.captcha.describe()) });
      }

      case 'password': {
        await this.verifyCaptcha(input, client, CAPTCHA_ACTIONS.LOGIN_PASSWORD);
        // The only step the device bucket meters. The later ones are already bounded
        // by the attempt row they resolve from, and `start` has nothing to guess at.
        const { outcome, stepUpSecret } = await this.logins.withPassword(
          input,
          client,
          deviceId,
        );
        // Returned only after the password is proven, so a failed attempt hands the
        // caller nothing to continue with.
        return ok(toLoginPayload(outcome, stepUpSecret));
      }

      case 'resend-otp': {
        const resolved = await this.resolveFor(input.loginId, 'resend-otp', client);
        return ok(toLoginPayload(await this.logins.resendOtp(resolved, client), input.loginId));
      }

      case 'verify-email': {
        const resolved = await this.resolveFor(input.loginId, 'verify-email', client);
        return ok(
          toLoginPayload(await this.logins.verifyEmail(resolved, input.code), input.loginId),
        );
      }

      case 'state': {
        const resolved = await this.resolveFor(input.loginId, 'state', client);
        return ok(toLoginPayload(await this.logins.readState(resolved), input.loginId));
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── POST /auth/session ───────────────────────────────────────────────────

  /**
   * Logout and logout-all.
   *
   * `cookies` is the port declared in security/session.cookie.ts. Both actions clear
   * it, and `logout-all` especially: leaving a session cookie in the browser after
   * revoking every session means the next request presents a dead handle and gets a
   * confusing 401 rather than being cleanly signed out.
   *
   * ═══ THE ORDER IS REVOKE, THEN DESTROY, THEN CLEAR ═════════════════════════
   *
   * Server-side revocation first, because it is the only step that actually ends the
   * session — the other two just stop the browser presenting a credential it no
   * longer has any use for. If the process died between them, the session would be
   * revoked and the cookie stale, which is a confusing 401 and nothing worse. The
   * reverse order would leave a revocation that never happened and a browser that
   * thinks it is signed out, which is the one arrangement that is genuinely unsafe.
   *
   * ─── Idempotent, deliberately ─────────────────────────────────────────────
   *
   * A missing principal is usually not an error. The route is behind
   * `OptionalAuthGuard`, so an admin whose session expired while they were away
   * arrives with no principal at all — and the spec requires a repeated logout to
   * succeed. There is nothing left to revoke, so the cookies are cleared and the
   * answer is the same "it worked" the first call gave. `SessionService.logout` is
   * itself idempotent for the same reason.
   *
   * ═══ BUT "NO PRINCIPAL" HAS TWO CAUSES, AND ONLY ONE IS SUCCESS ════════════
   *
   * This block used to be a bare `if (principal !== null)`, and that was F02.
   *
   * The browser presents an opaque handle; the mapping from handle to session family
   * lives in Redis. `CacheService.get` swallows a connection failure and returns
   * null, so `BffSessionService.resolve` returns null, so `authenticate` finds no
   * credential, so `optionalPrincipal` is null — and the old code read that as
   * "already logged out" and returned `{ ok: true }` WITHOUT TOUCHING THE DATABASE.
   * The browser then discarded its cookie while the family sat in PostgreSQL with
   * `revoked_at IS NULL`, coming back to life the moment Redis recovered. A logout
   * that reports success and revokes nothing is worse than one that fails.
   *
   * So a null principal is now interrogated rather than trusted:
   *
   *   Redis answered      there genuinely is no record to act on. Success, and a
   *   ('absent'/'present')  repeat logout keeps working as the spec demands.
   *   Redis did not       we cannot tell WHICH family to revoke, so we cannot claim
   *   answer ('unknown')    to have revoked it. 503, and the cookie is KEPT — it is
   *                         the only value that still names the session, and
   *                         clearing it would strand a live family nobody could ever
   *                         revoke. Keeping it is what makes a retry possible.
   *
   * PostgreSQL is the authority throughout. Redis decides nothing about whether a
   * session is revoked; it is only asked whether it is in a position to answer.
   */
  async session(
    body: unknown,
    principal: Principal | null,
    cookies: SessionCookie,
  ): Promise<SuccessEnvelope<LogoutPayload>> {
    const input = parseDto(sessionRequestSchema, body);
    const handle = cookies.read();

    if (principal !== null) {
      if (input.action === 'logout') {
        await this.sessions.logout(principal, undefined);
      } else {
        await this.sessions.logoutAll(principal, undefined);
      }
    } else if (handle !== null) {
      // A handle was presented but resolved to nothing. Before reporting success,
      // establish WHY — see the note above. Only 'unknown' refuses; 'absent' is an
      // honest success and must stay one, or every repeat logout starts failing.
      //
      // Placed BEFORE any write, so it can never turn a committed revocation into a
      // false failure.
      if ((await this.bff.recordState(handle)) === 'unknown') {
        throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
      }
    }

    // Both side effects below are deliberately incapable of failing the request:
    // `destroy` swallows, and the revocation above is already durable in PostgreSQL.
    if (handle !== null) await this.bff.destroy(handle);
    cookies.clear();
    return ok({ message: SESSION_ACTION_MESSAGES.LOGGED_OUT });
  }

  // ─── GET /auth/session ────────────────────────────────────────────────────

  /**
   * Is this browser signed in, and as what.
   *
   * The endpoint the spec asks for: a standalone frontend cannot inspect an httpOnly
   * cookie, so on load it has one call to establish whether it should render the
   * signed-in application or the login screen.
   *
   * Answers exactly `role`, `permissions`, `authenticated`, `lastActiveAt` and `message`.
   * See `SessionStatusPayload` for why each of the five, and why nothing else — in
   * particular why the two session deadlines it used to carry are gone.
   *
   * `lastActiveAt` arrives as a parameter rather than being read here, because
   * `assertLive` loaded the row on the way in and the guard stashed the value. A
   * lookup of our own would be a second query per poll for a fact we were handed.
   *
   * ─── Reaching this method IS the 200 ──────────────────────────────────────
   *
   * There is no "is it valid" check in here, because the guard already did it. A
   * revoked, expired or unknown session never gets this far — `AuthGuard` answers
   * 401 with the specific slug (`session_revoked`, `token_expired`,
   * `unauthenticated`) that the spec wants a client to branch on. Re-checking here
   * would be a second, weaker copy of that logic.
   *
   * That is also why `message` is unconditionally `LOGGED_IN` here rather than
   * computed: the other four codes describe states this method cannot be reached in.
   * They are attached to the guard's 401 instead, by `@ExplainsSessionState()` — see
   * security/session.message.ts.
   *
   * The admin row is re-read rather than reconstructed from the token's claims, for
   * the same reason `GET /auth/me` re-reads: this is what a UI uses to decide what to
   * show, and a fifteen-minute-old snapshot of a role is not that.
   */
  async sessionStatus(
    principal: Principal,
    lastActiveAt: Date | null,
  ): Promise<SuccessEnvelope<SessionStatusPayload>> {
    const admin = await this.admins.findById(principal.adminId);

    // Either the account was soft-deleted or the row vanished under a live token.
    // A stale credential is the client's problem to fix by signing in again, so 401
    // rather than the 500 an absent row would otherwise produce.
    //
    // The status is attached HERE rather than by `explainSessionEnd`, because this
    // throw is inside the handler and the guard's catch has already returned. There
    // is no session to describe once the account is gone, so `NOT_LOGGED_IN` — and
    // the shape matches the guard's 401 exactly, which is the property that lets a
    // client read one field on every refusal from this route.
    if (admin === null) {
      throw new ProblemException({
        type: ERR.UNAUTHENTICATED,
        // The session row is still live and its activity instant is still true, so it
        // is reported: what vanished is the ACCOUNT, and a panel showing "last active
        // at" while it explains the sign-out is more use than a null.
        extra: signedOutStatus('NOT_LOGGED_IN', lastActiveAt),
      });
    }

    return ok({
      // `admin.role`, not `principal.role`. The claim is up to fifteen minutes old,
      // and this is the value a UI decides what to show from — see the note on the
      // payload type.
      role: admin.role,
      // Not implemented yet, and deliberately not derived from the role: a frontend
      // that inferred permissions from an empty array would break the day this
      // starts being populated, which is the point of shipping the field early.
      permissions: [],
      authenticated: true as const,
      // The STORED instant, handed over by the guard from the row `assertLive`
      // already read — not `now()`, which would report activity that has not been
      // written and would make the field a tautology.
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
      // Constant by construction — reaching this line IS the live session. The four
      // signed-out codes are attached to the guard's 401.
      message: SESSION_MESSAGES.LOGGED_IN,
    });
  }

  // ─── GET /auth/me ─────────────────────────────────────────────────────────

  /**
   * The current admin.
   *
   * Re-read rather than reconstructed from the token's claims. An access token
   * lives fifteen minutes, so its `rol` may be stale — and this endpoint is what a
   * UI uses to decide what to show, which should reflect the database rather than
   * a snapshot.
   *
   * A token outliving a soft-deleted account resolves to 401, not 500: it is a
   * stale credential, which is the client's problem to fix by signing in again,
   * and an internal error would tell them to retry.
   */
  async me(
    principal: Principal,
    stableSessionId: string | null,
    // Resolved by the route from the cookies on the request, not minted here: this
    // method has no reply to set one on, and the common case sets nothing anyway.
    // Null for a bearer caller — see `MePayload.csrfToken`.
    csrfToken: string | null,
  ): Promise<SuccessEnvelope<MePayload>> {
    const admin = await this.admins.findById(principal.adminId);
    if (admin === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return ok({
      admin: toAdminPayload(toPublicAdmin(admin)),
      // ═══ F14: THE ONLY WAY A CROSS-ORIGIN PANEL RELEARNS THIS ══════════════
      //
      // Reported on the bootstrap read because sign-in was previously the only
      // response that carried it, and a panel on another host cannot read the
      // cookie to recover it after a reload. Returning it does not rotate it.
      csrfToken,
      // ═══ THE SESSION FAMILY, NOT THE ROTATION GENERATION ═══════════════════
      //
      // This reported `principal.sessionId` — the current refresh generation — and
      // that was a value with no stable meaning to a client. The BFF refreshes in
      // the background, so it changed roughly every fifteen minutes, at moments the
      // browser cannot observe and for reasons it did not cause.
      //
      // The field exists so a panel listing sessions can mark which row is "this
      // device" (see `MePayload` in dto/response.dto.ts), and only the family can
      // answer that: it is the login, and it is what revocation acts on.
      //
      // `principal.sessionId` is deliberately left alone HERE, but no longer for the
      // reason this comment used to give. It said elevation tickets and reauth
      // challenges are "scoped to the credential rather than to the login" — they
      // were, and that was F08: a background rotation replaced the credential and
      // silently invalidated a proof the admin had just given. All of that state is
      // keyed on `principal.familyId` now.
      //
      // What is left alone is this ROUTE's fallback. `sessionId` on the wire means
      // the stable login, so the family is preferred; the generation remains only as
      // the answer for a request whose row was not read (the cached-revocation path),
      // where reporting nothing at all would be worse.
      //
      // Never null in practice: reaching this line means `AuthGuard` read a live
      // session row. The fallback exists because the type admits null on the cached
      // refusal path, which never reaches a route.
      session: { sessionId: stableSessionId ?? principal.sessionId },
    });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * ═══ THE GATE EVERY POST-PASSWORD STEP GOES THROUGH ════════════════════════
   *
   * Resolve the attempt the `loginId` names, then assert the step is legal from
   * that attempt's state.
   *
   * Both halves in one place, and every caller uses it, because the failure mode
   * of the alternative is silent: a step that resolved its own attempt would work
   * perfectly while skipping `assertStep`, and nothing would report it until
   * someone noticed the ceremony could be short-circuited.
   *
   * ─── Three answers, and a fourth that now arrives earlier ─────────────────
   *
   * `resolve` throws `step_up_invalid` / `step_up_expired`; `assertStep` throws
   * `step_up_step_invalid`. None leaks anything the caller does not already hold —
   * the state is disclosed on purpose, because it is their own progress.
   *
   * A MISSING credential never reaches here at all. `loginId` is required by the
   * DTO, so `parseDto` answers `validation_failed` before this method runs. That is
   * the honest description once the value is a body field rather than a cookie the
   * browser attaches invisibly: nothing was sent, so the request is malformed.
   * `ERR.STEP_UP_REQUIRED` is consequently unreachable on this route.
   */
  private async resolveFor(
    loginId: string,
    step: LoginStep,
    client: ClientContext,
  ): Promise<ResolvedAttempt> {
    const resolved = await this.logins.resolve(loginId, client);
    assertStep(resolved.attempt, step);
    return resolved;
  }

  /**
   * The captcha pair, on its way to the verifier.
   *
   * Two rules, deliberately split so neither place needs the other's knowledge:
   *
   *  - HERE: send both or send neither. That is unconditional — it does not depend
   *    on which providers are live, or on whether captcha is on at all — so it is
   *    a parse-level rule and belongs at the parse layer. It cannot live in the
   *    DTO because `.refine()` yields a ZodEffects, which `z.discriminatedUnion`
   *    will not accept as a member.
   *  - IN THE SERVICE: whether an absent pair is acceptable. `CaptchaService.verify`
   *    owns the enabled/disabled decision, and duplicating that check at this call
   *    site is how the two come to disagree.
   *
   * So an absent pair is passed through rather than short-circuited, and the
   * service refuses it when a provider is configured.
   */
  private async verifyCaptcha(
    input: { readonly captchaProvider?: CaptchaProvider; readonly captchaToken?: string },
    client: ClientContext,
    action: CaptchaAction,
  ): Promise<void> {
    const { captchaProvider, captchaToken } = input;

    if ((captchaProvider === undefined) !== (captchaToken === undefined)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: captchaProvider === undefined ? 'captchaProvider' : 'captchaToken',
            message: 'captchaProvider and captchaToken must be sent together',
          },
        ],
      });
    }

    await this.captcha.verify({
      provider: captchaProvider ?? null,
      token: captchaToken ?? '',
      ip: client.ip,
      action,
    });
  }
}
