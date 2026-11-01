import { Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import {
  authenticatorRequestSchema,
  biometricsRequestSchema,
  disableProofsSchema,
  type AuthenticatorDisabledPayload,
  type AuthenticatorEnabledPayload,
  type AuthenticatorSecretPayload,
  type AuthenticatorStatusPayload,
  type BiometricsDisabledPayload,
  type BiometricsStatusPayload,
  type PasskeyChallengePayload,
  type PasskeyEnabledPayload,
} from './settings.dto';
import { SettingsService } from './settings.service';
import type { RequestFacts } from '../restrictions/restrictions.types';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every handler takes the acting account from the `Principal` and never from the
 * body, so a caller can only ever change their own settings — the same property
 * `TwoFactorController` relies on, and the reason no action carries a user id.
 */
@Injectable()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  async biometricsStatus(principal: Principal): Promise<SuccessEnvelope<BiometricsStatusPayload>> {
    const status = await this.settings.biometricsStatus(principal.userId);
    return ok({
      outcome: 'biometrics_status',
      ...status,
      // The pre-generalisation name for `factorCount`, still emitted — see
      // `BiometricsStatusPayload`.
      passkeyCount: status.factorCount,
    });
  }

  /**
   * The two halves of enabling, on one action field.
   *
   * One route rather than two because the client is doing one thing, and because the
   * challenge minted by the first half is what authorises the second — splitting
   * them across routes would invite a reader to ask what guards the second one.
   */
  async biometrics(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<PasskeyChallengePayload | PasskeyEnabledPayload>> {
    const input = parseDto(biometricsRequestSchema, body);

    switch (input.action) {
      case 'enable-challenge': {
        const options = await this.settings.enableChallenge(principal.userId, input.emailCode);
        return ok({ outcome: 'passkey_challenge', options });
      }

      case 'enable-verify': {
        const { factor, backupCodes } = await this.settings.enableVerify(
          principal.userId,
          // The library owns this shape and verifies every field cryptographically;
          // the schema passes it through. Same cast as `passkey-add-verify`.
          input.passkey as unknown as RegistrationResponseJSON,
          input.label,
        );
        return ok({
          outcome: 'passkey_enabled',
          factor: {
            id: factor.id,
            label: factor.label,
            createdAt: factor.createdAt.toISOString(),
          },
          backupCodes,
        });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * One atomic disable.
   *
   * `ipClass` rather than the full `ClientContext`: the only thing needed downstream
   * is what the notification email reports, and asking the route for a full context
   * would additionally issue a device cookie as a side effect of reading it — the
   * same reason `TwoFactorRoutes.mutate` passes `req.ip` alone.
   */
  async disableBiometrics(
    body: unknown,
    principal: Principal,
    facts: RequestFacts,
  ): Promise<SuccessEnvelope<BiometricsDisabledPayload>> {
    const input = parseDto(disableProofsSchema, body);

    const { removed, path } = await this.settings.disable(
      principal.userId,
      principal.sessionId,
      facts,
      {
        ...input,
        // The schema keeps the WebAuthn response `passthrough`, so its inferred type
        // is the one field it bounds rather than the library's. Same cast as
        // `passkey-add-verify` and `reauth-verify`, for the same reason: the library
        // owns the shape and verifies every field cryptographically.
        passkey: input.passkey as unknown as AuthenticationResponseJSON | undefined,
      },
    );

    return ok({
      outcome: 'biometrics_disabled',
      removed,
      path,
      otherSessionsRevoked: true,
    });
  }

  // ─── the authenticator app ────────────────────────────────────────────────

  async authenticatorStatus(
    principal: Principal,
  ): Promise<SuccessEnvelope<AuthenticatorStatusPayload>> {
    const status = await this.settings.authenticatorStatus(principal.userId);
    return ok({ outcome: 'authenticator_status', ...status });
  }

  /**
   * The two halves of enabling, on one action field — the same shape as
   * `biometrics` above, so a client that has implemented one has implemented both.
   *
   * The first half returns the shared secret in the clear; see
   * `AuthenticatorSecretPayload` for why that is inherent rather than careless.
   */
  async authenticator(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<AuthenticatorSecretPayload | AuthenticatorEnabledPayload>> {
    const input = parseDto(authenticatorRequestSchema, body);

    switch (input.action) {
      case 'enable-challenge': {
        const { secret, uri } = await this.settings.enableAuthenticatorChallenge(
          principal.userId,
          input.emailCode,
          input.label,
        );
        return ok({ outcome: 'authenticator_secret', secret, uri });
      }

      case 'enable-verify': {
        const { backupCodes } = await this.settings.enableAuthenticatorVerify(
          principal.userId,
          input.totpCode,
        );
        return ok({ outcome: 'authenticator_enabled', backupCodes });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /** One atomic disable. `ipClass` for the same reason as `disableBiometrics`. */
  async disableAuthenticator(
    body: unknown,
    principal: Principal,
    facts: RequestFacts,
  ): Promise<SuccessEnvelope<AuthenticatorDisabledPayload>> {
    const input = parseDto(disableProofsSchema, body);

    const { removed, path } = await this.settings.disableAuthenticator(
      principal.userId,
      principal.sessionId,
      facts,
      {
        ...input,
        passkey: input.passkey as unknown as AuthenticationResponseJSON | undefined,
      },
    );

    return ok({
      outcome: 'authenticator_disabled',
      removed,
      path,
      otherSessionsRevoked: true,
    });
  }
}
