import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ipClassOf } from '../../../auth/auth.utility';
import { OptionalAuthGuard, Public, requirePrincipal } from '../../../auth/security/guards';
import { ElevationGuard, RequiresElevation } from '../../2fa/elevation';
import type { SuccessEnvelope } from '../../http';
import { DeleteAccountController } from './delete-account.controller';
import type {
  AccountDeletedPayload,
  AccountReactivatedPayload,
  DeleteAccountStatusPayload,
  DeleteChallengePayload,
  DeleteElevatedPayload,
  ReactivationRequestedPayload,
} from './delete-account.dto';

/**
 * THE route table for Settings → Delete account. Declarative, zero logic.
 *
 * Four operations, four paths: read the state, prove yourself, delete, and come back.
 *
 * ─── Why `delete` is its own path and not an action on `verify` ─────────────
 *
 * Because a Nest guard runs BEFORE the body is parsed. `ElevationGuard` reads the
 * ticket with GETDEL — so on a shared handler the guard would spend the single-use
 * ticket without knowing which action had been asked for, and a `verify` request would
 * destroy a ticket the delete was about to need.
 *
 * That is not a theoretical risk. `POST /auth/link` and `POST /auth/link/preview` were
 * one route with an `action` discriminator and had exactly this defect: the preview
 * genuinely consumed the ticket and the confirm that followed answered
 * `reauth_required`. Two paths is what lets the ROUTE define the action, so the handler
 * under `@RequiresElevation` can only perform the write it names.
 *
 * `verify` keeps an `action` discriminant precisely because it wears no guard.
 *
 * ─── Why this is a POST and not a DELETE ───────────────────────────────────
 *
 * Nothing in `src/settings/` uses any verb but GET and POST, and the reason is not
 * filing. This route takes a body, needs CSRF, and carries an elevation header; a
 * `DELETE` with a body is poorly served by intermediaries and by several HTTP clients,
 * and the one thing that must never happen to this endpoint is a request being replayed
 * or mangled by something in the middle.
 *
 * ─── Why `reactivate` is `@Public()` ───────────────────────────────────────
 *
 * Every other route in this module needs a session, and their absence from any
 * `@Public()` list is the statement. This one is the exception, deliberately, and for a
 * sharper version of the reason the two email-recovery routes are public: deleting an
 * account revokes every session it had and its `status` refuses every sign-in path, so
 * the person who most needs this route is — always, by construction, not merely
 * sometimes — somebody who cannot authenticate. Requiring a session here would close
 * the flow for its only possible user.
 *
 * What stands in for the session is a code mailed to the account's own address, which
 * is a stronger proof of "this mailbox" than a bearer token is, and it is the only
 * thing this route accepts without one.
 *
 * `@Public()` + `OptionalAuthGuard` is an existing combination rather than a new one —
 * see `POST /auth/session` and the email-change routes. The guard still enforces CSRF,
 * and `SafetyNetGuard` still meters by IP; the feature's own per-address and per-IP
 * budgets are charged in the service.
 *
 * The GET is NOT public: it reports the caller's own state and needs a principal to
 * have any meaning. Nothing in the recovery flow reads it — a client rendering the
 * restore screen has the address the user typed and needs nothing else.
 *
 * ─── No handler here takes a `FastifyReply` ────────────────────────────────
 *
 * So nothing on this path can set a cookie of any kind, let alone a session one. That
 * is the property the module exists to guarantee — a delete-account surface must never
 * mint a session, and a reactivation must hand the user back to the ordinary sign-in
 * rather than logging them straight in — and it is enforced by what is absent from
 * these signatures rather than by a check somebody could forget. `DeleteAccountService`
 * holds `SessionService` for `revokeAllForUser` alone and calls `issue` nowhere.
 *
 * `DEVICE.COOKIE_PATH` is `/auth`, so the browser never sends the device cookie to
 * `/settings/*` and calling `deviceCookie` on this prefix would MINT A NEW ONE every
 * request. Hence `ipClassOf(req.ip)` rather than a full client context.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS (src/app.routes.ts).
 * This is the fourth `@Controller('settings')` class; each keeps its feature whole in
 * one directory. All of them are listed in `tests/auth/openapi.drift.spec.ts`, which is
 * what stops a route shipping undocumented.
 */
@Controller('settings')
export class DeleteAccountRoutes {
  constructor(private readonly controller: DeleteAccountController) {}

  /** Whether the account is live or counting down, and what deleting it will cost. */
  @Get('security/delete-account')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<DeleteAccountStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  /**
   * Prove the mailbox and, when the account has one, a factor — and earn a ticket.
   *
   * No client context: this route sends no mail of its own (the code comes from
   * `POST /auth/2fa {"action":"credential-otp"}`), so asking for one would issue a
   * device cookie as a side effect of reading it.
   */
  @Post('security/delete-account/verify')
  verify(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<DeleteChallengePayload | DeleteElevatedPayload>> {
    return this.controller.verify(body, requirePrincipal(req));
  }

  /**
   * Delete the account. Elevated, irreversible from this session.
   *
   * The response is the last thing the caller's token will be answered with — the
   * service revokes every session before returning.
   */
  @Post('security/delete-account')
  @UseGuards(ElevationGuard)
  @RequiresElevation('account.delete')
  remove(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AccountDeletedPayload>> {
    // The class rather than the address, derived here so the handler stays the only
    // thing that touches the request. It labels the notification email; see `ipClassOf`
    // for why the prefix.
    return this.controller.remove(body, requirePrincipal(req), ipClassOf(req.ip));
  }

  /**
   * Restore a deleted account, inside its recovery window.
   *
   * Takes `req.ip` in full as well as the class: the full address keys the per-network
   * rate-limit bucket that bounds an enumeration sweep, and is recorded on the challenge
   * row as where the code was requested from. The class alone goes in the notification
   * email — a /24 is enough for "not where I live" and does not put a precise address in
   * somebody's inbox.
   */
  @Public()
  @UseGuards(OptionalAuthGuard)
  @Post('security/delete-account/reactivate')
  reactivate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<ReactivationRequestedPayload | AccountReactivatedPayload>> {
    return this.controller.reactivate(body, req.ip, ipClassOf(req.ip));
  }
}
