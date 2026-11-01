import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ipClassOf } from '../../../auth/auth.utility';
import { requirePrincipal } from '../../../auth/security/guards';
import type { SuccessEnvelope } from '../../http';
import { AntiPhishingController } from './antiPhishing.controller';
import type {
  AntiPhishingStatusPayload,
  AntiPhishingUpdatedPayload,
} from './antiPhishing.dto';

/**
 * THE route table for the anti-phishing code. Declarative, zero logic.
 *
 * Two routes, and the whole feature: read whether one is set, then set or change it.
 *
 * ─── Why this is a sixth controller on the `settings` prefix ────────────────
 *
 * `SettingsRoutes` declares itself THE route table for `settings`, and this sits beside
 * it rather than inside it, exactly as `PaymentPinRoutes`, `EmailChangeRoutes`,
 * `UsernameRoutes` and `PasswordRoutes` do. Nest merges the prefix; the reason to use
 * that here is containment — every line of anti-phishing code lives under
 * `src/settings/antiPhishing/`, so the feature reads, reviews and removes as one
 * directory.
 *
 * All six classes are listed in `settings.module.ts` and in
 * `tests/auth/openapi.drift.spec.ts`, which is what stops a route shipping
 * undocumented — a second class on an EXISTING prefix is invisible to a check that
 * enumerates prefixes rather than classes.
 *
 * ─── Why two routes and not four ───────────────────────────────────────────
 *
 * The three operations share `POST /settings/security/anti-phishing` on an `action`
 * discriminant — the shape `POST /auth/2fa`, `POST /settings/security/payment-pin` and
 * `POST /settings/security/password` all use. They are one thing done to one value,
 * differing only in what the caller can produce, so separate paths would publish three
 * endpoints and invite a reader to ask what guards each one when the spine is identical.
 *
 * `GET` earns its own method rather than a `status` action for the ordinary reason: it
 * writes nothing, and it is the call a client makes before it knows whether to offer
 * `set` or the two replacing operations.
 *
 * ─── What is deliberately NOT here ─────────────────────────────────────────
 *
 * No route for the emailed code. `POST /auth/2fa {"action":"credential-otp"}` already
 * mints it, and an anti-phishing-shaped copy would be a second way to mint the same
 * credential, metered by a second bucket. The precedent and the argument are in
 * `paymentPin/payment-pin.routes.ts`.
 *
 * No route that returns the code. It is not withheld from its owner as a secret — it is
 * printed in their email — but an endpoint that reads it back would put it in a browser
 * cache and a proxy log for no benefit the email does not already give, and it would be
 * the one call an attacker with a stolen token would make to learn what to forge.
 *
 * ─── Why neither is `@Public()` ────────────────────────────────────────────
 *
 * Both read or change the caller's own settings and both need a session. The global
 * `AuthGuard` covers them, and their absence from this file is the statement —
 * `@Public()` is opt-out and fails closed.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('settings')
export class AntiPhishingRoutes {
  constructor(private readonly controller: AntiPhishingController) {}

  /** Whether a code is configured — the one fact a client needs to decide which of the
   *  three operations to offer. */
  @Get('security/anti-phishing')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<AntiPhishingStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  @Post('security/anti-phishing')
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AntiPhishingUpdatedPayload>> {
    // The class rather than the address, and derived here rather than in the controller
    // so the handler stays the only thing that touches the request. It labels the
    // notification email; see `ipClassOf` for why the prefix.
    //
    // `req.ip` alone rather than a full `ClientContext`, matching `PasswordRoutes.mutate`
    // and `PaymentPinRoutes.mutate`: the only thing needed downstream is what the mail
    // reports, and asking for a full context would additionally issue a device cookie as
    // a side effect of reading it.
    return this.controller.mutate(body, requirePrincipal(req), ipClassOf(req.ip));
  }
}
