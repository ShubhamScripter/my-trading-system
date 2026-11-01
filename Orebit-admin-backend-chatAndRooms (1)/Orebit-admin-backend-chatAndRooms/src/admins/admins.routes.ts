import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { elevationTicketOf } from '../2fa/elevation';
import { AdminsController } from './admins.controller';
import type { AdminActionPayload, LoginReviewListPayload } from './admins.dto';

/**
 * THE route table for the `admins` prefix. Declarative, zero logic.
 *
 * ONE path, and it is the first in this service that acts on an account other than
 * the caller's own. `POST /2fa` states as an invariant that no action takes an
 * `adminId`; every action here does. Keeping them on separate prefixes is what lets
 * that invariant stay true where it is claimed, and puts the exception somewhere a
 * reviewer looking for "what can touch another admin" will actually find it.
 *
 * ─── NOT `@Public()`, and no `OptionalAuthGuard` ───────────────────────────
 *
 * Unlike `/auth/login` and `/2fa`, every action here needs a full session, so the
 * global `AuthGuard` in src/app.module.ts covers the route and this file says
 * nothing. Its silence is the statement — compare `GET /2fa`, which is also
 * deliberately not public.
 *
 * ─── Why no `@UseGuards(ElevationGuard)` ───────────────────────────────────
 *
 * The required proof varies per action, and the action is in the body, so the
 * controller spends the ticket against `ADMIN_ELEVATION` instead. Exactly the same
 * arrangement as `POST /2fa`, and the reasoning is in src/2fa/elevation.ts.
 *
 * A future single-purpose route — `POST /admins/:id/something` — should use the
 * guard with `@RequiresElevation(...)`. That is the normal case; this route is the
 * union-body exception.
 *
 * --- Two paths now, and only one of them writes -----------------------------
 *
 * `GET /admins/login-reviews` was added alongside the union POST rather than folded
 * into it, and the reason is the HTTP method rather than taste: a read must be a GET so
 * it is cacheable, linkable and safe to retry, and a GET has no body to discriminate a
 * union on. It carries no elevation ticket because it changes nothing.
 *
 * `'admins'` here must match the `admins` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('admins')
export class AdminsRoutes {
  constructor(private readonly controller: AdminsController) {}

  /**
   * Administer another administrator: reset their second factors, disable, enable.
   *
   * SUPER_ADMIN only — enforced in the service against a freshly-read row rather
   * than the token's `rol` claim, because an access token lives fifteen minutes and
   * a demoted admin must not keep this reach until it expires.
   */
  @Post()
  act(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<AdminActionPayload>> {
    return this.controller.act(
      body,
      requirePrincipal(req),
      elevationTicketOf(req),
      // Built here rather than in the controller for the same reason every other route
      // does it: the request object stops at this layer, so the controller stays
      // testable without a live HTTP request. `resolve-login-review` records an auth
      // event, and an audit row with no idea where the action came from is half a row.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }

  /**
   * The accounts the lockout ladder has suspended, awaiting a decision.
   *
   * SUPER_ADMIN only, enforced in the service against a freshly-read row rather than
   * the token's `rol` claim - an access token lives fifteen minutes and a demoted admin
   * must not keep this reach until it expires.
   *
   * Declared BEFORE no other route on this controller by accident: `login-reviews` is a
   * literal segment and there is no `:id` path here for it to be captured by, so the
   * ordering is not load-bearing today. It would be the moment a `@Get(':id')` is
   * added, which is worth knowing before somebody adds one.
   */
  @Get('login-reviews')
  loginReviews(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<LoginReviewListPayload>> {
    return this.controller.loginReviews(query, requirePrincipal(req));
  }
}
