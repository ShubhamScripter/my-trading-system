import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requestFactsOf } from '../../restrictions/restrictions.service';
import { requirePrincipal } from '../../../auth/security/guards';
import type { SuccessEnvelope } from '../../http';
import { PasswordController } from './password.controller';
import type { PasswordChangedPayload, PasswordStatusPayload } from './password.dto';

/**
 * THE route table for the account password. Declarative, zero logic.
 *
 * Two routes, and the whole feature: read what is possible, then do it.
 *
 * ─── Why this is a fourth controller on the `settings` prefix ───────────────
 *
 * `SettingsRoutes` declares itself THE route table for `settings`, and this sits
 * beside it rather than inside it, exactly as `PaymentPinRoutes`, `EmailChangeRoutes`
 * and `UsernameRoutes` do. Nest merges the prefix; the reason to use that here is
 * containment — every line of password-setting code lives under
 * `src/settings/password/`, so the feature reads, reviews and removes as one
 * directory. Two delegating methods bolted onto the neighbouring class would have put
 * this feature's public surface somewhere its implementation is not.
 *
 * All five classes are listed in `settings.module.ts` and in
 * `tests/auth/openapi.drift.spec.ts`, which is what stops a route shipping
 * undocumented — a second class on an EXISTING prefix is invisible to a check that
 * enumerates prefixes rather than classes.
 *
 * ─── Why two routes and not four ───────────────────────────────────────────
 *
 * The three operations share `POST /settings/security/password` on an `action`
 * discriminant — the shape `POST /auth/2fa`, `POST /settings/security/passkeys` and
 * `POST /settings/security/payment-pin` all use. They are one thing done to one
 * credential, differing only in what the caller can prove, so separate paths would
 * publish three endpoints and invite a reader to ask what guards each one when the
 * spine is identical.
 *
 * `GET` earns its own method rather than a `status` action for the ordinary reason:
 * it writes nothing, and it is the call a client makes before it knows which of the
 * three it is allowed to attempt.
 *
 * ─── What is deliberately NOT here ─────────────────────────────────────────
 *
 * No route for the emailed code, and none for the WebAuthn challenge. Both already
 * exist — `POST /auth/2fa {"action":"credential-otp"}` and
 * `{"action":"reauth-challenge"}` — and a password-shaped copy of either would be a
 * second way to mint the same credential, metered by a second bucket. The precedent
 * and the argument are in `paymentPin/payment-pin.routes.ts`.
 *
 * ─── Why neither is `@Public()` ────────────────────────────────────────────
 *
 * Both read or change the caller's own credential and both need a session. The
 * global `AuthGuard` covers them, and their absence from this file is the statement —
 * `@Public()` is opt-out and fails closed.
 *
 * That this feature is authenticated at all is the architecture's existing position
 * rather than this file's choice: the public forgot/reset pair was retired
 * deliberately, because email-only recovery makes the mailbox a second path into an
 * account that is otherwise gated on a password and a factor. A user who has
 * forgotten their password signs in with an emailed code — `POST /auth/login`,
 * `mode: otp-request` — and arrives here. See `auth/dto/password.dto.ts`.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('settings')
export class PasswordRoutes {
  constructor(private readonly controller: PasswordController) {}

  /** What the password screen renders: which of the three operations is open, and
   *  whether `forgot` will demand a factor. */
  @Get('security/password')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<PasswordStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  @Post('security/password')
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<PasswordChangedPayload>> {
    // The class rather than the address, and derived here rather than in the
    // controller so the handler stays the only thing that touches the request. It
    // labels the notification email; see `ipClassOf` for why the prefix.
    //
    // `req.ip` alone rather than a full `ClientContext`, matching
    // `PaymentPinRoutes.mutate`: the only thing needed downstream is what the mail
    // reports, and asking for a full context would additionally issue a device
    // cookie as a side effect of reading it.
    return this.controller.mutate(body, requirePrincipal(req), requestFactsOf(req));
  }
}
