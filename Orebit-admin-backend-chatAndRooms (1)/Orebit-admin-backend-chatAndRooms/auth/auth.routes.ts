import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SuccessEnvelope } from '../src/http';
import { AuthController } from './auth.controller';
import type {
  LogoutPayload,
  LoginPayload,
  MePayload,
  SessionStatusPayload,
} from './auth.dto';
import type { ClientContext } from './auth.types';
import { clientContextOf, headerValue } from './auth.utility';
import { deviceCookie } from './security/device.cookie';
import { ExplainsSessionState, NotActivity, OptionalAuthGuard, Public, optionalPrincipal, requirePrincipal, sessionFamilyId, sessionLastActiveAt } from './security/guards';
import { sessionCookie } from './security/session.cookie';

/**
 * THE route table for the `auth` prefix. Declarative, zero logic — every method
 * extracts what the framework can extract and delegates.
 *
 * THREE paths, and that is the entire authenticated surface of this service:
 * sign-in, session lifecycle, and the current-admin read. The five-step sign-in
 * ceremony is one route with a discriminated-union body rather than a route per
 * step — see auth.dto.ts for the union and auth.controller.ts for the dispatch.
 *
 * There is deliberately NO recovery route. `POST /auth/password` used to carry
 * `forgot` / `reset`, and it was removed rather than fixed: email-only recovery
 * makes the mailbox a second path to an account that is otherwise gated on a
 * password AND a second factor. Recovering a locked-out admin is now an operator
 * action — see db/seed.ts — and if a self-service route ever returns, it needs a
 * credential that is not the mailbox.
 *
 * What that buys, and what it costs: the surface is small and each flow's
 * invariants live in one place, but the per-route guard and per-route rate limit
 * that a wide surface gets for free have to be explicit instead. Guards are
 * visible below; the step/state matrix is `STEP_REQUIRES` in auth.types.ts; limits
 * are keyed on the discriminator inside the services.
 *
 * `'auth'` here must match the `auth` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('auth')
export class AuthRoutes {
  constructor(private readonly controller: AuthController) {}

  /**
   * Sign-in, all five steps.
   *
   * Public, and it cannot be otherwise: the first step is by definition anonymous.
   * From `password` onward the credential is the `loginId` in the request body —
   * minted and returned by `password`, and retired the moment a second factor
   * completes the ceremony on `POST /2fa`.
   *
   * `@Public()` here does NOT mean unguarded. It means the global `AuthGuard` is
   * stood down because a bearer token is the wrong credential for this route; the
   * actual gate is `resolveFor` in the controller, which every step past
   * `password` goes through.
   *
   * `reply` is still needed — not for the sign-in credential, which no longer
   * travels in a cookie, but for `deviceCookie`, which mints the per-browser
   * rate-limit bucket when the caller presents none.
   */
  @Public()
  @Post('login')
  login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LoginPayload>> {
    return this.controller.login(body, contextOf(req), deviceCookie(req, reply));
  }

  /**
   * Session lifecycle: logout and logout-all.
   *
   * `refresh` used to live here and is gone — the backend rotates the tokens it
   * holds on the browser's behalf, mid-request, so there is nothing for a client to
   * ask for. See auth/dto/session.dto.ts.
   *
   * `OptionalAuthGuard` rather than `AuthGuard`, and the reason changed with it.
   * It was here for `refresh`, which had to work with an expired access token. It is
   * here now for the logout actions, which must succeed even when the session behind
   * them is already gone: the spec requires a repeated logout to succeed, and a
   * mandatory guard would answer 401 to an admin signing out of a session that
   * expired while they were away. The optional guard populates a principal when
   * there is one, passes when there is not, and still rejects a credential that is
   * present but invalid.
   *
   * `@Public()` AND `@UseGuards(OptionalAuthGuard)` together, which is not a
   * contradiction: `@Public()` stands the global `AuthGuard` down, and the optional
   * guard then does the softer job in its place.
   */
  @Public()
  @Post('session')
  @UseGuards(OptionalAuthGuard)
  session(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LogoutPayload>> {
    return this.controller.session(body, optionalPrincipal(req), sessionCookie(req, reply));
  }

  /**
   * Is this browser signed in, as what, and — when it is not — why not. Answers
   * exactly `role`, `permissions`, `authenticated`, `lastActiveAt` and `message`; see
   * `SessionStatusPayload` for the 200 and security/session.message.ts for the 401.
   *
   * Guarded by the global `AuthGuard`, which is the whole design: a dead session
   * never reaches the handler, and the 401 the guard throws already carries the
   * reason as its `type` slug — `session_revoked` when it was ended elsewhere,
   * `token_expired` when it timed out, `unauthenticated` when there was no cookie.
   * Those are exactly the cases the spec asks a client to distinguish, so re-deriving
   * them in a `@Public()` handler would be a second, weaker copy of the guard.
   *
   * `@ExplainsSessionState()` is what turns those slugs into the five-code `message`
   * the frontend switches on, attached as `extra` on the same problem document. It is
   * a marker on THIS route only: no other endpoint's 401 changes shape, and the
   * enrichment reads the reason the guard already resolved rather than deriving it
   * a second time.
   *
   * `@NotActivity()` because this is a POLL. The spec is explicit that background
   * session checks must not extend the idle deadline: a client that rechecks on tab
   * focus and reconnect — which is the behaviour the spec recommends — would
   * otherwise hold an abandoned session open indefinitely by asking whether it was
   * still open.
   *
   * `Cache-Control: no-store` because a cached "you are signed in" is a wrong answer
   * that outlives the session, and a shared cache holding one admin's status is worse
   * than merely stale.
   */
  @Get('session')
  @NotActivity()
  @ExplainsSessionState()
  async sessionStatus(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<SessionStatusPayload>> {
    void reply.header('cache-control', 'no-store');
    return this.controller.sessionStatus(requirePrincipal(req), sessionLastActiveAt(req));
  }

  /**
   * The current admin, and the CSRF token to mutate with.
   *
   * No `@UseGuards(AuthGuard)` here, and its absence is the whole design: the
   * global guard in src/app.module.ts already covers this, and the two routes
   * above had to say `@Public()` to get out of it. Re-declaring the guard would
   * also run `authenticate` twice per request — two session lookups for one call —
   * because a global guard and a route guard both fire.
   *
   * ─── Why this route carries the CSRF token (F14) ──────────────────────────
   *
   * It is the bootstrap read — the call a panel makes on load — and it is the only
   * authenticated response a client is guaranteed to see after a reload. A panel
   * served from `config.ADMIN_APP_URL` is a different origin from the API and so
   * cannot read `orebit_admin_csrf` with script, which left a refreshed tab
   * authenticated but unable to mutate anything. `ensureCsrf` reads the cookie the
   * browser did send and reports it; see security/session.cookie.ts.
   *
   * Deliberately NOT on `GET /auth/session`. That route is the POLL — it is marked
   * `@NotActivity()` for exactly that reason — and its payload is five fields by
   * design. A token on a poll is also the shape most likely to grow a rotation
   * later, which is the thing that must not happen here.
   *
   * `reply` is needed only for the repair path, where there is no usable token to
   * report and one has to be minted and set. The common path sets no cookie.
   *
   * `Cache-Control: no-store` is NOT set here, and that is not an omission — it was
   * F15. The global `onRequest` hook in src/cache.ts stamps it on every response
   * before routing, which is the only way to cover this route's guard refusals as
   * well as its 200.
   */
  @Get('me')
  me(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<MePayload>> {
    // The family id comes from the guard's stash rather than from the principal,
    // because it is not a claim — see `sessionFamilyId`. `assertLive` already read
    // the row it comes from, so this costs no query.
    return this.controller.me(
      requirePrincipal(req),
      sessionFamilyId(req),
      sessionCookie(req, reply).ensureCsrf(),
    );
  }
}

/**
 * Build the client context from the request.
 *
 * `req.ip` rather than the socket address, because Fastify resolves it through
 * `trustProxy` — behind Cloudflare that means `CF-Connecting-IP`. Every rate limit
 * in the service is keyed on this value, so getting it from anywhere else would
 * put all traffic in one bucket.
 */
function contextOf(req: FastifyRequest): ClientContext {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    headerValue(req.headers['accept-language']),
  );
}
