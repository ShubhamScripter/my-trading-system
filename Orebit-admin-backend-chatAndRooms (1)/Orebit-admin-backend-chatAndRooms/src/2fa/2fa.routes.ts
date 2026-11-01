import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import type { ClientContext } from '../../auth/auth.types';
import {
  OptionalAuthGuard,
  Public,
  optionalPrincipal,
  requirePrincipal,
} from '../../auth/security/guards';
import { sessionCookie } from '../../auth/security/session.cookie';
import type { SuccessEnvelope } from '../http';
import { TwoFactorController } from './2fa.controller';
import type { FactorListPayload, TwoFactorPayload } from './2fa.dto';
import { elevationTicketOf } from './elevation';

/**
 * THE route table for the `2fa` prefix. Declarative, zero logic.
 *
 * TWO paths, and that is the entire second-factor surface of this service: read
 * what is enrolled, and everything else. All twelve actions are one route with a
 * discriminated-union body — see 2fa.dto.ts for the union, 2fa.types.ts for which
 * credential each demands, and 2fa.controller.ts for the dispatch.
 *
 * ─── Why POST is `@Public()` when most of it is not public at all ───────────
 *
 * The credential VARIES BY ACTION, and the action is in the body. Four sign-in
 * actions are reached with a `loginId` by a caller who has no access token yet —
 * the global `AuthGuard` would reject them before the controller ever saw the
 * body. So the guard is stood down and `TWO_FACTOR_REQUIRES` becomes the gate,
 * enforced by the three resolvers in the controller.
 *
 * `@Public()` here does NOT mean unguarded, exactly as on `POST /auth/login`. It
 * means a bearer token is the wrong question for some of these actions.
 *
 * `OptionalAuthGuard` alongside it does the softer job: it populates a principal
 * when a valid bearer is present, passes when none is, and still rejects a bearer
 * that is present but invalid. That is what lets one route serve both halves
 * without either half weakening the other.
 *
 * `GET` is deliberately NOT public — reading your factor list always needs a
 * session, so the global guard covers it and its absence from this file is the
 * statement.
 */
@Controller('2fa')
export class TwoFactorRoutes {
  constructor(private readonly controller: TwoFactorController) {}

  /** Everything enrolled on the calling admin's own account. */
  @Get()
  list(@Req() req: FastifyRequest): Promise<SuccessEnvelope<FactorListPayload>> {
    return this.controller.list(requirePrincipal(req));
  }

  /**
   * Prove a factor, earn an elevation ticket, or change the factor set.
   *
   * No action takes an `adminId`, so the factors being read or changed are always
   * the caller's own — one admin cannot touch another's even by accident.
   */
  @Public()
  @Post()
  @UseGuards(OptionalAuthGuard)
  mutate(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<TwoFactorPayload>> {
    return this.controller.mutate(
      body,
      optionalPrincipal(req),
      // The two verify actions mint a session, so this route needs the session
      // cookie port — the refresh token and its CSRF companion are the one thing on
      // this route that still travels in a cookie. It is a narrow port rather than a
      // FastifyReply, so the controller stays testable without an HTTP layer.
      sessionCookie(req, reply),
      elevationTicketOf(req),
      contextOf(req),
    );
  }
}

/** Built the same way as `auth/auth.routes.ts` does it — `req.ip` resolves through
 *  `trustProxy`, and every rate limit in the service is keyed on that value. */
function contextOf(req: FastifyRequest): ClientContext {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    headerValue(req.headers['accept-language']),
  );
}
