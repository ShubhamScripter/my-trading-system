import { Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { ClientContext, IssuedSession, Principal } from '../../auth/auth.types';
import { BffSessionService } from '../../auth/security/bff.session';
import type { SessionCookie } from '../../auth/security/session.cookie';
import { LoginService, type ResolvedAttempt } from '../../auth/services/login.service';
import { MfaService } from '../../auth/services/mfa.service';
import { toSessionPayload, type SessionPayload } from '../../auth/auth.dto';
import { ERR } from '../contracts';
import { ok, parseDto, ProblemException, type SuccessEnvelope } from '../http';
import {
  toFactorPayload,
  twoFactorRequestSchema,
  type FactorListPayload,
  type SessionLike,
  type TwoFactorPayload,
} from './2fa.dto';
import { TwoFactorService } from './2fa.service';
import {
  assertTwoFactorState,
  TWO_FACTOR_REQUIRES,
  type TwoFactorAction,
} from './2fa.types';
import { ELEVATION_ANY, ElevationService } from './elevation';

/**
 * Parse, resolve the credential, delegate, serialise.
 *
 * ─── The one thing this file DOES decide ────────────────────────────────────
 *
 * Which credential each action needs. `TWO_FACTOR_REQUIRES` says, and the three
 * resolvers below are the only places that read it:
 *
 *  - `stepUpFor`  — sign-in actions. `logins.resolve(loginId)` then
 *                   `assertTwoFactorState`, in that order, exactly as
 *                   `AuthController.resolveFor` does. An action that resolved its
 *                   own attempt could forget the state check, so none is allowed to.
 *  - `bearerFor`  — a principal must be present.
 *  - `elevatedFor`— a principal AND a spent ticket.
 *
 * A switch case that reached for the wrong resolver would be a real hole, which is
 * why the resolvers assert the table rather than trusting the call site: each one
 * refuses if `TWO_FACTOR_REQUIRES` does not name it.
 *
 * The switch is exhaustive and the `never` in `default` enforces it — adding a
 * variant to `twoFactorRequestSchema` without handling it fails the build.
 */
@Injectable()
export class TwoFactorController {
  constructor(
    private readonly service: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly logins: LoginService,
    private readonly elevation: ElevationService,
    private readonly bff: BffSessionService,
  ) {}

  async list(principal: Principal): Promise<SuccessEnvelope<FactorListPayload>> {
    const { mfaEnrolled, factors } = await this.service.list(principal.adminId);
    return ok({ mfaEnrolled, factors: factors.map(toFactorPayload) });
  }

  /**
   * `session` is the port from auth/security/session.cookie.ts.
   *
   * This route is where a session is BORN — the two verify actions below are the
   * only places in the service that mint one — so it is where the refresh token has
   * to be put into its httpOnly cookie. Returning it in the body instead is the
   * whole of finding A3.
   */
  async mutate(
    body: unknown,
    principal: Principal | null,
    session: SessionCookie,
    ticket: string | null,
    client: ClientContext,
  ): Promise<SuccessEnvelope<TwoFactorPayload>> {
    const input = parseDto(twoFactorRequestSchema, body);

    switch (input.action) {
      // ─── sign-in: the four actions that moved off POST /auth/login ─────────

      case 'totp-enroll': {
        const resolved = await this.stepUpFor(input.loginId, 'totp-enroll', client);
        const totp = await this.mfa.totpEnroll(resolved.admin);
        return ok({ outcome: 'totp_enrollment' as const, totp: { ...totp, replacing: false } });
      }

      case 'totp-verify': {
        const resolved = await this.stepUpFor(input.loginId, 'totp-verify', client);
        const issued = await this.mfa.totpVerify(
          resolved.admin,
          resolved.attempt,
          input.code,
          client,
        );
        // Nothing to retire on the client. `AttemptDbOperation.complete` nulled the
        // secret hash in the same statement that set `completedAt`, so the `loginId`
        // the caller still holds resolves to nothing from here on.
        return ok({
          outcome: 'session' as const,
          session: (await this.mintCookies(session, issued)) as SessionLike,
        });
      }

      case 'passkey-challenge': {
        const resolved = await this.stepUpFor(input.loginId, 'passkey-challenge', client);
        const challenge = await this.mfa.passkeyChallenge(resolved.admin, resolved.attempt);
        return ok({
          outcome: 'passkey_challenge' as const,
          mode: challenge.mode,
          options: challenge.options,
        });
      }

      case 'passkey-verify': {
        const resolved = await this.stepUpFor(input.loginId, 'passkey-verify', client);
        const issued = await this.mfa.passkeyVerify(
          resolved.admin,
          resolved.attempt,
          input.response as unknown as RegistrationResponseJSON | AuthenticationResponseJSON,
          client,
        );
        return ok({
          outcome: 'session' as const,
          session: (await this.mintCookies(session, issued)) as SessionLike,
        });
      }

      // ─── re-auth: earn a ticket ────────────────────────────────────────────

      case 'reauth-challenge': {
        const who = this.bearerFor(principal, 'reauth-challenge');
        return ok({
          outcome: 'passkey_challenge' as const,
          mode: 'authenticate' as const,
          options: await this.service.reauthChallenge(who),
        });
      }

      case 'reauth-verify': {
        const who = this.bearerFor(principal, 'reauth-verify');
        // Exactly one proof. Enforced here rather than in the DTO because a
        // `.refine()` yields a ZodEffects, which `z.discriminatedUnion` rejects as
        // a member — the same reason config.ts keeps its cross-field rules out of
        // its schema.
        const hasPasskey = input.response !== undefined;
        const hasCode = input.code !== undefined;
        if (hasPasskey === hasCode) {
          throw new ProblemException({
            type: ERR.VALIDATION_FAILED,
            errors: [
              {
                path: '(root)',
                message: 'Send exactly one of "response" (passkey) or "code" (TOTP).',
              },
            ],
          });
        }

        const granted = await this.service.reauthVerify(
          who,
          hasPasskey
            ? {
                kind: 'passkey',
                response: input.response as unknown as AuthenticationResponseJSON,
              }
            : { kind: 'totp', code: input.code as string },
          // `ELEVATION_ANY` when the client did not say. Accepted by the management
          // actions on this route and by no `@RequiresElevation` route, so an
          // un-migrated client keeps working for the twelve factor actions and gets
          // nothing extra. See the note on `intent` in 2fa.dto.ts.
          input.intent ?? ELEVATION_ANY,
        );
        return ok({ outcome: 'elevated' as const, ...granted });
      }

      // ─── management ────────────────────────────────────────────────────────

      case 'totp-add': {
        const who = await this.elevatedFor(principal, ticket, 'totp-add');
        return ok({
          outcome: 'totp_enrollment' as const,
          totp: await this.service.totpAdd(who, input.label),
        });
      }

      case 'totp-confirm': {
        const who = this.bearerFor(principal, 'totp-confirm');
        const factor = await this.service.totpConfirm(who, input.code);
        return ok({ outcome: 'factor' as const, factor: toFactorPayload(factor) });
      }

      case 'passkey-add-challenge': {
        const who = await this.elevatedFor(principal, ticket, 'passkey-add-challenge');
        return ok({
          outcome: 'passkey_challenge' as const,
          mode: 'register' as const,
          options: await this.service.passkeyAddChallenge(who),
        });
      }

      case 'passkey-add-verify': {
        const who = this.bearerFor(principal, 'passkey-add-verify');
        const factor = await this.service.passkeyAddVerify(
          who,
          input.response as unknown as RegistrationResponseJSON,
          input.label,
        );
        return ok({ outcome: 'factor' as const, factor: toFactorPayload(factor) });
      }

      case 'remove': {
        const who = await this.elevatedFor(principal, ticket, 'remove');
        await this.service.remove(who, input.kind, input.factorId);
        return ok({ outcome: 'removed' as const, ok: true as const });
      }

      case 'rename': {
        const who = await this.elevatedFor(principal, ticket, 'rename');
        const factor = await this.service.rename(who, input.kind, input.factorId, input.label);
        return ok({ outcome: 'factor' as const, factor: toFactorPayload(factor) });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * Store the tokens server-side, put the handle that names them in its httpOnly
   * cookie, and return the body payload.
   *
   * This is where the sign-in ceremony crosses the browser boundary, and therefore
   * the one place that decides what the browser is given. It is given a handle. Both
   * tokens go into the record `BffSessionService.create` writes — see
   * auth/security/bff.session.ts — and neither appears in the payload.
   *
   * One helper for both verify actions rather than the three lines twice, because
   * the ORDER matters and is easy to get subtly wrong:
   *
   *   1. create the record, because the handle does not exist until it is stored,
   *      and a cookie naming a record that was never written is a session the admin
   *      cannot use. `create` is fail-closed for exactly this reason.
   *   2. set the cookies, because the CSRF token is derived from the handle.
   *   3. serialise, so the `csrfToken` the client is told to use is the one actually
   *      in the cookie. `toSessionPayload` takes it as a required parameter for the
   *      same reason — there is no way to serialise a session without having issued
   *      the cookies that make it usable.
   *
   * `reauthenticateAt`, not `refreshExpiresAt`, is what the cookie is scoped to: the
   * handle outlives every rotation and only the absolute ceiling bounds it.
   */
  private async mintCookies(
    cookie: SessionCookie,
    issued: IssuedSession,
  ): Promise<SessionPayload> {
    const handle = await this.bff.create(issued);
    const csrfToken = cookie.issue(handle, issued.reauthenticateAt);
    return toSessionPayload(issued, csrfToken);
  }

  // ─── credential resolvers ─────────────────────────────────────────────────

  /**
   * ═══ THE GATE EVERY SIGN-IN ACTION GOES THROUGH ════════════════════════════
   *
   * Resolve the attempt the `loginId` names, then assert the action is legal from
   * that attempt's state. Both halves in one place, and every caller uses it.
   *
   * The `loginId` is the SAME value `POST /auth/login` returned — one credential
   * for the whole ceremony across both routes, resolving through the same
   * `LoginService.resolve` and therefore the same liveness, review and status
   * gates.
   *
   * `resolve` throws `step_up_invalid` / `step_up_expired`; `assertTwoFactorState`
   * throws `step_up_step_invalid`. A missing `loginId` never arrives — the DTO
   * requires it, so `parseDto` answers `validation_failed` first.
   */
  private async stepUpFor(
    loginId: string,
    action: TwoFactorAction,
    client: ClientContext,
  ): Promise<ResolvedAttempt> {
    this.assertDeclared(action, 'step-up');
    const resolved = await this.logins.resolve(loginId, client);
    assertTwoFactorState(resolved.attempt, action);
    return resolved;
  }

  private bearerFor(principal: Principal | null, action: TwoFactorAction): Principal {
    const required = TWO_FACTOR_REQUIRES[action];
    if (required !== 'bearer' && required !== 'bearer+ticket') {
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
    if (principal === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return principal;
  }

  /**
   * A live session AND a fresh proof.
   *
   * The ticket is spent here, before the action runs — so a mutation that fails
   * downstream has still consumed it. That direction is deliberate: the
   * alternative, spending on success, would let a caller retry one proof against
   * many candidate writes until one landed.
   */
  private async elevatedFor(
    principal: Principal | null,
    ticket: string | null,
    action: TwoFactorAction,
  ): Promise<Principal> {
    this.assertDeclared(action, 'bearer+ticket');
    const who = this.bearerFor(principal, action);

    // ─── Why these four accept `ELEVATION_ANY` as well as their own name ──────
    //
    // A ticket bound to this exact action is the correct, specific case. A ticket
    // bound to `ELEVATION_ANY` is the un-migrated client: it asked for a proof
    // without saying what for, which is what every client did before `intent`
    // existed.
    //
    // Accepted here and NOWHERE else. `ElevationGuard` refuses `ELEVATION_ANY`
    // outright, so no future mutating route can be reached with an unscoped proof —
    // the compatibility is confined to the twelve factor actions that already
    // existed, and the surface that matters is scoped from the start.
    //
    // Tighten this to `spend(ticket, who.familyId, action)` once the panel sends
    // `intent`. That is the whole of the migration.
    await this.elevation.spendForAny(ticket, who.familyId, [action, ELEVATION_ANY]);
    return who;
  }

  /** A resolver used against an action the table does not assign to it is a wiring
   *  bug, not a client error — 500, loudly, rather than a quiet wrong answer. */
  private assertDeclared(action: TwoFactorAction, expected: string): void {
    if (TWO_FACTOR_REQUIRES[action] !== expected) {
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }
  }
}
