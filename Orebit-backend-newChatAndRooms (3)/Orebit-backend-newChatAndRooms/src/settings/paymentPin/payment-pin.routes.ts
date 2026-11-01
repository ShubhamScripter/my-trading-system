import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../../auth/security/guards';
import { requestFactsOf } from '../../restrictions/restrictions.service';
import type { SuccessEnvelope } from '../../http';
import { PaymentPinController } from './payment-pin.controller';
import type {
  PaymentPinDisabledPayload,
  PaymentPinEnabledPayload,
  PaymentPinStatusPayload,
  PaymentPinUpdatedPayload,
  PaymentPinVerifiedPayload,
} from './payment-pin.dto';

/**
 * THE route table for the Payment PIN. Declarative, zero logic.
 *
 * Three routes, and the whole feature: read the setting, verify a credential, act.
 *
 * ─── Why this is a second controller on the `settings` prefix ───────────────
 *
 * `SettingsRoutes` declares itself THE route table for `settings`, and this sits beside
 * it rather than inside it. Nest is happy to have two classes share a prefix, and the
 * reason to use that here is containment: every line of Payment PIN code lives under
 * `src/settings/paymentPin/`, so the feature can be read, reviewed, or removed as one
 * directory. Three delegating methods bolted onto the neighbouring class would have put
 * the feature's public surface somewhere its implementation is not.
 *
 * The two files are cross-referenced so neither reads as the complete list on its own.
 *
 * ─── Why three routes and not six ──────────────────────────────────────────
 *
 * The two halves of enabling are ONE half here: enabling is authorised by an emailed
 * code plus the existence of a factor, and a state check needs no ceremony. Update and
 * disable share `POST /settings/security/payment-pin` on an `action` discriminant — the
 * same shape `POST /auth/2fa` and `POST /settings/security/passkeys` use — because both
 * are authorised by the same challenge from the same verify route, so separate paths
 * would publish two endpoints with one guard between them.
 *
 * `verify` is the one route that genuinely earns its own path. It does not change the
 * setting; it converts a proof into a single-use authorisation, and folding it into the
 * `action` union would put a call that writes nothing next to two that do, sharing a
 * response shape with neither.
 *
 * ─── What is deliberately NOT here ─────────────────────────────────────────
 *
 * No route for the emailed code and none for the WebAuthn challenge. Both already
 * exist — `POST /auth/2fa {"action":"credential-otp"}` and
 * `{"action":"reauth-challenge"}` — and a Payment-PIN-shaped copy of either would be a
 * second way to mint the same credential, metered by a second bucket.
 *
 * ─── Why none of these is `@Public()` ──────────────────────────────────────
 *
 * All three read or change the caller's own setting and every one needs a session. The
 * global `AuthGuard` covers them, and their absence from this file is the statement —
 * `@Public()` is opt-out and fails closed.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('settings')
export class PaymentPinRoutes {
  constructor(private readonly controller: PaymentPinController) {}

  @Get('security/payment-pin')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<PaymentPinStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  @Post('security/payment-pin')
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<
    SuccessEnvelope<PaymentPinEnabledPayload | PaymentPinUpdatedPayload | PaymentPinDisabledPayload>
  > {
    // The class rather than the address, and derived here rather than in the controller
    // so the handler stays the only thing that touches the request. It labels the
    // notification email; see `ipClassOf` for why the prefix.
    return this.controller.mutate(body, requirePrincipal(req), requestFactsOf(req));
  }

  @Post('security/payment-pin/verify')
  verify(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<PaymentPinVerifiedPayload>> {
    // No `ipClass`: this route sends no mail. It mints a challenge, and the email that
    // reports the change is sent by the action that spends it.
    return this.controller.verify(body, requirePrincipal(req));
  }
}
