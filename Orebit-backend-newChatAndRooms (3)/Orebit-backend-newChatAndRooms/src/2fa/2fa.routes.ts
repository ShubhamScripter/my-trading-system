import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ClientContext } from '../../auth/auth.types';
import type { LoginPayload } from '../../auth/auth.dto';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { Public, requirePrincipal } from '../../auth/security/guards';
import { deviceCookie } from '../../auth/security/device.cookie';
import { sessionCookie } from '../../auth/security/session.cookie';
import type { SuccessEnvelope } from '../http';
import { TwoFactorController } from './2fa.controller';
import type { FactorListPayload, TwoFactorPayload } from './2fa.dto';
import { elevationTicketOf } from './elevation';
import { cloudflareCountry } from '../geo/cloudflare';

/**
 * THE route table for `auth/2fa`. Declarative, zero logic.
 *
 * Three paths, and that is the entire second-factor surface: read what is
 * enrolled, finish a sign-in, and everything else. The nine management actions are
 * one route with a discriminated-union body — see 2fa.dto.ts for the union,
 * 2fa.types.ts for which credential each demands, and 2fa.controller.ts for the
 * dispatch. Same shape as `POST /auth/login` next door, for the same reason.
 *
 * ─── Why the prefix is `auth/2fa` and the folder is `src/2fa` ───────────────
 *
 * The URL belongs with the rest of authentication, because that is what a client
 * is doing when it calls this. The CODE belongs in its own folder, because 2FA is
 * a feature with four tables, a WebAuthn dependency and a hand-written RFC 6238
 * implementation, and burying that inside `auth/` would make the auth module the
 * place where everything lives. Nest lets those two decisions be independent, so
 * they are made independently.
 *
 * `'auth/2fa'` here must match the `auth/2fa` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 *
 * ─── Why `verify` is `@Public()` ───────────────────────────────────────────
 *
 * Because the caller has no access token — the whole point of the ceremony is that
 * they are halfway to one. The global `AuthGuard` would reject them before the
 * controller ever saw the `loginId`. `@Public()` here does NOT mean unguarded,
 * exactly as on `POST /auth/login`: it means a bearer token is the wrong question,
 * and the `loginId` naming a live server-side flow is the right one.
 *
 * `GET` and the management `POST` are deliberately NOT public — both always need a
 * session, so the global guard covers them and their absence from this file is the
 * statement.
 */
@Controller('auth/2fa')
export class TwoFactorRoutes {
  constructor(private readonly controller: TwoFactorController) {}

  /** Everything enrolled on the calling user's own account. */
  @Get()
  list(@Req() req: FastifyRequest): Promise<SuccessEnvelope<FactorListPayload>> {
    return this.controller.list(requirePrincipal(req));
  }

  /**
   * Finish a sign-in that stopped at `mfa_required`.
   *
   * Takes the reply because this is where the session is finally minted, so it is
   * where the refresh and CSRF cookies start — the same port `POST /auth/login`
   * uses, so both doors set cookies through one implementation.
   */
  @Public()
  @Post('verify')
  verify(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LoginPayload | TwoFactorPayload>> {
    return this.controller.verify(body, contextOf(req, reply), sessionCookie(req, reply));
  }

  /**
   * Prove a factor for a ticket, or change which factors exist.
   *
   * No action takes a user id, so the factors being changed are always the caller's
   * own — one account cannot touch another's even by accident.
   */
  @Post()
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<TwoFactorPayload>> {
    // `req.ip` rather than a full `contextOf`: the only action here that needs client
    // context is `credential-otp`, which records the requesting address on the
    // challenge row, and `contextOf` would additionally ISSUE a device cookie — a
    // side effect that belongs on a login, not on a factor-management call.
    return this.controller.mutate(
      body,
      requirePrincipal(req),
      elevationTicketOf(req),
      req.ip,
    );
  }
}

/** Built exactly as `auth/auth.routes.ts` does it — `req.ip` resolves through
 *  `trustProxy`, and every rate limit in the service is keyed on that value. */
function contextOf(req: FastifyRequest, reply: FastifyReply): ClientContext {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    deviceCookie(req, reply),
    cloudflareCountry(req.headers),
  );
}
