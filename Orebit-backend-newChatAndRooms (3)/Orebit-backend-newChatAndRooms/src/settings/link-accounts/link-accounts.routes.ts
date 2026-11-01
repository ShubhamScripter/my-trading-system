import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ipClassOf } from '../../../auth/auth.utility';
import { requirePrincipal } from '../../../auth/security/guards';
import type { LinkClientContext } from '../../../auth/services/oauth.service';
import { ElevationGuard, RequiresElevation } from '../../2fa/elevation';
import type { SuccessEnvelope } from '../../http';
import { LinkAccountsController } from './link-accounts.controller';
import type {
  LinkChallengePayload,
  LinkElevatedPayload,
  LinkStartedPayload,
  SocialAccountLinkedPayload,
  SocialAccountsStatusPayload,
  SocialAccountUnlinkScheduledPayload,
} from './link-accounts.dto';

/**
 * THE route table for Settings → Social accounts. Declarative, zero logic.
 *
 * Five operations, four paths: read what is linked, prove yourself, the two legs of
 * the provider round trip, and schedule a removal.
 *
 * The removal needs no legs of its own — there is no provider to ask, only a deadline
 * to write — which is why unlink is one path where linking is two.
 *
 * ─── Why `start` and `callback` are separate paths ─────────────────────────
 *
 * Because a Nest guard runs BEFORE the body is parsed. `start` wears
 * `ElevationGuard`, which reads the ticket with GETDEL — so on a shared handler the
 * guard would spend the single-use ticket without knowing which action had been
 * asked for, and a `callback` request would destroy the ticket a `start` was about
 * to need.
 *
 * That is not a theoretical risk. `POST /auth/link` and `POST /auth/link/preview`
 * were one route with an `action` discriminator and had exactly this defect: the
 * preview genuinely consumed the ticket and the confirm that followed answered
 * `reauth_required`. Two paths is what lets the ROUTE define the action, so the
 * handler under `@RequiresElevation` can only perform the write it names.
 *
 * `verify` keeps an `action` discriminant precisely because it wears no guard.
 *
 * ─── Why `callback` is not elevated ────────────────────────────────────────
 *
 * A ticket lives sixty seconds; a trip to a provider does not. The proof is spent at
 * departure and carried across the redirect by the link state, which is server-side,
 * single-use and bound to the account, the login, the device and the network. See
 * `OauthService.startLink`.
 *
 * ─── Why none of these is `@Public()` ──────────────────────────────────────
 *
 * All four act on the caller's own account and every one needs a session. The global
 * `AuthGuard` covers them, and their absence from this file is the statement —
 * `@Public()` is opt-out and fails closed. It also means the two POSTs carry CSRF
 * enforcement for free.
 *
 * ─── No handler here takes a `FastifyReply` ────────────────────────────────
 *
 * Which means nothing on this path can set a cookie of any kind, let alone a session
 * one. That is the property the whole module exists to guarantee, and it is enforced
 * by what is absent from these signatures rather than by a check somebody could
 * forget. `LinkAccountsService` is likewise constructed without `SessionService` or
 * `BffSessionService`.
 *
 * `POST /auth/link` does take a reply, and the difference is instructive rather than
 * inconsistent: it needs `deviceCookie` to build a full `ClientContext`. That is not
 * available here and must not be faked — `DEVICE.COOKIE_PATH` is `/auth`, so the
 * browser never sends the device cookie to `/settings/*`, and calling `deviceCookie`
 * on this prefix MINTS A NEW ONE every request. A link state bound to it would
 * record one device at `start` and see a different one at `callback`, so no link
 * could ever complete. The ceremony binds to the session family instead, which is
 * the stronger claim anyway — see `LinkClientContext`.
 *
 * `'settings'` here must match the `settings` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('settings')
export class LinkAccountsRoutes {
  constructor(private readonly controller: LinkAccountsController) {}

  /** Which providers are linked, and which are left to link. */
  @Get('security/social-accounts')
  status(@Req() req: FastifyRequest): Promise<SuccessEnvelope<SocialAccountsStatusPayload>> {
    return this.controller.status(requirePrincipal(req));
  }

  /**
   * Prove the mailbox and, when the account has one, a factor — and earn a ticket.
   *
   * No client context: this route sends no mail of its own (the code comes from
   * `POST /auth/2fa {"action":"credential-otp"}`) and starts no provider flow, so
   * asking for one would issue a device cookie as a side effect of reading it. Same
   * reasoning as `TwoFactorRoutes.mutate`.
   */
  @Post('security/social-accounts/verify')
  verify(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<LinkChallengePayload | LinkElevatedPayload>> {
    return this.controller.verify(body, requirePrincipal(req));
  }

  @Post('security/social-accounts/start')
  @UseGuards(ElevationGuard)
  @RequiresElevation('account.social.link')
  start(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<LinkStartedPayload>> {
    return this.controller.start(body, requirePrincipal(req), contextOf(req));
  }

  @Post('security/social-accounts/callback')
  callback(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<SocialAccountLinkedPayload>> {
    // The context carries `ipClass`, checked against what was recorded when the
    // ceremony started — the flow has to finish from the network it began on. The
    // account and login bindings come from the principal, not from here. See
    // `OauthService.completeLink`.
    return this.controller.callback(body, requirePrincipal(req), contextOf(req));
  }

  /**
   * Schedule the removal of a linked provider. Elevated, and NOT a delete.
   *
   * ─── Why this is a fifth path and not a discriminant on `verify` ───────────
   *
   * The same reason `start` and `callback` are separate paths, stated at the top of
   * this file: `ElevationGuard` runs before the body is parsed, so a handler shared
   * with `verify` would spend the single-use ticket without knowing which action had
   * been asked for. The ROUTE has to name the action, which means the action needs a
   * route.
   *
   * ─── Why there is no cancel route beside it ────────────────────────────────
   *
   * Because the link ceremony already is one. Re-linking the same provider account
   * takes the request back, so a dedicated endpoint would be a second way to reach a
   * state that is already reachable — see `OauthService.attachToAccount`.
   *
   * Takes `ipClassOf(req.ip)` and not `contextOf(req)`: this route starts no provider
   * flow, so it needs no redirect context, and the class note above about never
   * minting a device cookie applies here as it does everywhere on this prefix.
   */
  @Post('security/social-accounts/unlink')
  @UseGuards(ElevationGuard)
  @RequiresElevation('account.social.unlink')
  unlink(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<SocialAccountUnlinkScheduledPayload>> {
    return this.controller.unlink(body, requirePrincipal(req), ipClassOf(req.ip));
  }
}

/**
 * What a link ceremony needs from the request.
 *
 * `req.ip` rather than the socket address, because Fastify resolves it through
 * `trustProxy` — behind Cloudflare that means `CF-Connecting-IP`. Every rate limit
 * in the service is keyed on this value, so getting it from anywhere else would put
 * all traffic in one bucket.
 *
 * Two fields and no device id, which is what makes this a plain read of the request
 * rather than a mint — see the note on the class, and `LinkClientContext`.
 */
function contextOf(req: FastifyRequest): LinkClientContext {
  return { ip: req.ip, ipClass: ipClassOf(req.ip) };
}
