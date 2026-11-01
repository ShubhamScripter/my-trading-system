import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requestFactsOf } from '../restrictions/restrictions.service';
import { requirePrincipal } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { SettingsController } from './settings.controller';
import type {
  AuthenticatorDisabledPayload,
  AuthenticatorEnabledPayload,
  AuthenticatorSecretPayload,
  AuthenticatorStatusPayload,
  BiometricsDisabledPayload,
  BiometricsStatusPayload,
  PasskeyChallengePayload,
  PasskeyEnabledPayload,
} from './settings.dto';

/**
 * The route table for the two FACTOR settings. Declarative, zero logic.
 *
 * Two factors, three routes each, one shape: read the setting, turn it on in two
 * halves, turn it off atomically.
 *
 * Not the complete `settings` prefix: `paymentPin/payment-pin.routes.ts` declares
 * `@Controller('settings')` as well and owns `/settings/security/payment-pin`. That
 * feature is kept whole in its own directory rather than having its three routes
 * declared here — see the note in settings.module.ts.
 *
 * ─── Why disabling has its own path and enabling does not ───────────────────
 *
 * Enabling is two halves of one ceremony discriminated by `action`, the same shape
 * `POST /auth/2fa` uses. Disabling is a separate path because it is not another
 * action on the same object — it takes a different body with no discriminant (the
 * combination of proofs IS the discriminant), it has four alternative
 * authorisations, and it has effects beyond the setting: every credential retired
 * and every other session signed out. Folding it into the union would put an action
 * that revokes sessions next to one that returns a WebAuthn challenge and give a
 * reader no reason to expect the difference.
 *
 * ─── Why the two factors are two routes and not one with a parameter ────────
 *
 * `/settings/security/{factor}` would be one route table entry and a worse API: the
 * two enable ceremonies differ in body and response (an attestation versus six
 * digits; a challenge versus a shared secret), so a parameterised route would
 * publish a union whose legal half depends on the path segment. Separate paths let
 * openapi.json describe each one exactly. The DISABLE bodies are identical, and
 * those do share a schema — see `disableProofsSchema`.
 *
 * ─── Why none of these is `@Public()` ───────────────────────────────────────
 *
 * All six change or read the caller's own settings and every one needs a session.
 * The global `AuthGuard` covers them, and their absence from this file is the
 * statement — `@Public()` is opt-out and fails closed.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('settings')
export class SettingsRoutes {
  constructor(private readonly controller: SettingsController) {}

  @Get('security/passkeys')
  biometricsStatus(@Req() req: FastifyRequest): Promise<SuccessEnvelope<BiometricsStatusPayload>> {
    return this.controller.biometricsStatus(requirePrincipal(req));
  }

  @Post('security/passkeys')
  biometrics(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<PasskeyChallengePayload | PasskeyEnabledPayload>> {
    return this.controller.biometrics(body, requirePrincipal(req));
  }

  @Post('security/passkeys/disable')
  disableBiometrics(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<BiometricsDisabledPayload>> {
    // The class rather than the address, and derived here rather than in the
    // controller so the handler stays the only thing that touches the request. It
    // labels the notification email; see `ipClassOf` for why the prefix.
    return this.controller.disableBiometrics(body, requirePrincipal(req), requestFactsOf(req));
  }

  @Get('security/authenticator')
  authenticatorStatus(
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AuthenticatorStatusPayload>> {
    return this.controller.authenticatorStatus(requirePrincipal(req));
  }

  @Post('security/authenticator')
  authenticator(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AuthenticatorSecretPayload | AuthenticatorEnabledPayload>> {
    return this.controller.authenticator(body, requirePrincipal(req));
  }

  @Post('security/authenticator/disable')
  disableAuthenticator(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AuthenticatorDisabledPayload>> {
    return this.controller.disableAuthenticator(body, requirePrincipal(req), requestFactsOf(req));
  }
}
