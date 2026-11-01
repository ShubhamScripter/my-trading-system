import { Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Principal } from '../../../auth/auth.types';
import type { LinkClientContext } from '../../../auth/services/oauth.service';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  linkCallbackRequestSchema,
  linkStartRequestSchema,
  linkUnlinkRequestSchema,
  linkVerifyRequestSchema,
  type LinkChallengePayload,
  type LinkElevatedPayload,
  type LinkStartedPayload,
  type SocialAccountLinkedPayload,
  type SocialAccountsStatusPayload,
  type SocialAccountUnlinkScheduledPayload,
} from './link-accounts.dto';
import { LinkAccountsService } from './link-accounts.service';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every handler takes the acting account from the `Principal` and never from the
 * body, so a caller can only ever link a provider to their own account — the same
 * property `SettingsController` relies on, and the reason no action carries a user
 * id.
 */
@Injectable()
export class LinkAccountsController {
  constructor(private readonly links: LinkAccountsService) {}

  // ─── GET /settings/security/social-accounts ───────────────────────────────

  async status(principal: Principal): Promise<SuccessEnvelope<SocialAccountsStatusPayload>> {
    const status = await this.links.status(principal.userId);
    return ok({ outcome: 'social_accounts_status', ...status });
  }

  // ─── POST /settings/security/social-accounts/verify ───────────────────────

  /**
   * The two halves of the security check, on one action field.
   *
   * One route rather than two because the client is doing one thing, and — unlike
   * `start` next door — this route wears no guard, so nothing is spent before the
   * body is read and a discriminant is safe here. See the header of
   * link-accounts.dto.ts for why that distinction decides the shape of this module.
   */
  async verify(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<LinkChallengePayload | LinkElevatedPayload>> {
    const input = parseDto(linkVerifyRequestSchema, body);

    switch (input.action) {
      case 'challenge': {
        const { methods, options } = await this.links.challenge(principal.userId);
        return ok({
          outcome: 'social_link_challenge',
          methods,
          options,
          // A constant rather than a computed value: this ceremony always costs an
          // emailed code, and reporting it keeps a client from having to infer the
          // policy from an empty `methods` array.
          emailCodeRequired: true,
        });
      }

      case 'verify': {
        const granted = await this.links.verify(principal, {
          emailCode: input.emailCode,
          totpCode: input.totpCode,
          // The schema keeps the WebAuthn response `passthrough`, so its inferred
          // type is the one field it bounds rather than the library's. Same cast as
          // `passkey-add-verify` and `reauth-verify`, for the same reason: the
          // library owns the shape and verifies every field cryptographically.
          passkey: input.passkey as unknown as AuthenticationResponseJSON | undefined,
          // Which of the two social writes the ticket will be good for. Defaulted by
          // the schema, so a body written before unlink existed still says `link`.
          intent: input.intent,
        });
        return ok({ outcome: 'social_link_elevated', ...granted });
      }

      default: {
        // An unhandled action would fall through to a returned `undefined` — a 200
        // for a ceremony that never ran.
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── POST /settings/security/social-accounts/start ────────────────────────

  /**
   * Begin the provider round trip.
   *
   * `ElevationGuard` has already run and already spent the ticket by the time this
   * is called, so there is no credential check here — putting a second one in would
   * only be a second thing to keep in sync. Same placement argument as
   * `AuthController.linkConfirm`.
   */
  async start(
    body: unknown,
    principal: Principal,
    client: LinkClientContext,
  ): Promise<SuccessEnvelope<LinkStartedPayload>> {
    const input = parseDto(linkStartRequestSchema, body);
    const started = await this.links.start(principal, input, client);
    return ok({ outcome: 'social_account_link_started', ...started });
  }

  // ─── POST /settings/security/social-accounts/callback ─────────────────────

  /**
   * Finish it.
   *
   * Note what this returns and what it does not: the linked account, and no session
   * payload. There is no `SessionCookie` parameter on this method and none on the
   * route above it, which is what makes "the settings callback never signs anyone
   * in" a property of the signature rather than a promise in a comment.
   */
  async callback(
    body: unknown,
    principal: Principal,
    client: LinkClientContext,
  ): Promise<SuccessEnvelope<SocialAccountLinkedPayload>> {
    const input = parseDto(linkCallbackRequestSchema, body);
    const account = await this.links.complete(principal, input, client);
    return ok({ outcome: 'social_account_linked', ...account });
  }

  // ─── POST /settings/security/social-accounts/unlink ───────────────────────

  /**
   * Schedule a removal.
   *
   * `ipClass` rather than the whole `LinkClientContext`: nothing here starts a
   * provider round trip, so the only thing the request needs from the network is the
   * coarse location the notification email names. Taking the narrower value is what
   * keeps this handler from having a reason to touch anything device-shaped.
   *
   * The outcome says `scheduled`, not `unlinked` — see the payload's own note.
   */
  async unlink(
    body: unknown,
    principal: Principal,
    ipClass: string,
  ): Promise<SuccessEnvelope<SocialAccountUnlinkScheduledPayload>> {
    const input = parseDto(linkUnlinkRequestSchema, body);
    const scheduled = await this.links.requestUnlink(principal, input.provider, ipClass);
    return ok({ outcome: 'social_account_unlink_scheduled', ...scheduled });
  }
}
