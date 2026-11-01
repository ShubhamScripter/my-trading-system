import { Body, Controller, Get, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SuccessEnvelope } from '../src/http';
import { ElevationGuard, RequiresElevation } from '../src/2fa/elevation';
import { AuthController } from './auth.controller';
import type { LinkPayload } from './dto/link.dto';
import type {
  EmptyPayload,
  LoginPayload,
  LogoutPayload,
  MePayload,
  PublicUserPayload,
  ReferralCheckPayload,
  RegistrationStartPayload,
  RegistrationStatePayload,
  SessionListPayload,
  SessionStatusPayload,
} from './auth.dto';
import type { CaptchaPayload } from './auth.dto';
import { clientContextOf, headerValue } from './auth.utility';
import type { ClientContext } from './auth.types';
import {
  ExplainsSessionState,
  NotActivity,
  OptionalAuthGuard,
  Public,
  optionalPrincipal,
  requirePrincipal,
  sessionLastUsedAt,
} from './security/guards';
import { sessionCookie } from './security/session.cookie';
import { deviceCookie } from './security/device.cookie';
import { cloudflareCountry } from '../src/geo/cloudflare';

/**
 * THE route table for the `auth` prefix. Declarative, zero logic — every method
 * extracts what the framework can extract and delegates.
 *
 * Eight paths, and that is the whole authentication surface on this prefix:
 * registration, login, session lifecycle, password, the current-user read plus
 * profile update, devices, sessions, and provider linking. The second factor hangs
 * under the same prefix from its own module — see src/2fa/2fa.routes.ts.
 * Multi-step flows are one route with a discriminated-union body rather than a
 * route per step — see auth.dto.ts for the unions and auth.controller.ts for the
 * dispatch.
 *
 * What that buys, and what it costs: the surface is small and each flow's
 * invariants live in one place, but the per-route guard and per-route rate limit
 * that a wide surface gets for free have to be explicit instead. Guards are
 * visible below; limits are keyed on the discriminator inside the services.
 *
 * `'auth'` here must match the `auth` entry in ROUTE_GROUPS (src/app.routes.ts).
 * Nothing enforces that mechanically yet — tests/app.routes.spec.ts asserts it.
 */
@Controller('auth')
export class AuthRoutes {
  constructor(private readonly controller: AuthController) {}

  /**
   * Registration, all eight steps.
   *
   * Public, and it cannot be otherwise: the first step is by definition anonymous.
   * From `start` onward the credential is the `signupId` in the request body — an
   * opaque server-minted secret, retired the moment the `country` step completes
   * the row. It used to be an httpOnly `orebit_reg` cookie; see `CONTINUATION` in
   * auth.constants.ts for what that traded away and why.
   */
  @Public()
  @Post('register')
  register(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<
    SuccessEnvelope<RegistrationStartPayload | RegistrationStatePayload | ReferralCheckPayload>
  > {
    return this.controller.register(
      body,
      contextOf(req, reply),
      sessionCookie(req, reply),
    );
  }

  /**
   * Which captcha providers to render, and their public site keys.
   *
   * `@Public()`, and it cannot be otherwise: this is what an anonymous page reads
   * BEFORE it can build a request that carries a captcha token. Guarding it would
   * make sign-in and registration unreachable.
   *
   * Safe to serve anonymously — every field in it is already public. Site keys ship
   * to the browser in the widget either way, and the list of providers is
   * observable by loading the login page. It exposes no secret and no user data.
   */
  @Public()
  @Get('captcha')
  captcha(): SuccessEnvelope<CaptchaPayload> {
    return this.controller.captchaOptions();
  }

  /** Login and third-party login. Public by definition — these ARE the
   *  authentication. */
  @Public()
  @Post('login')
  login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LoginPayload>> {
    // The reply is needed for one thing only now: the branches that end in a
    // session set the session and CSRF cookies. `registration_required` used to
    // set a continuation cookie here too and no longer does — it returns a
    // `signupId` in the body like every other way of starting a signup.
    return this.controller.loginRequest(
      body,
      contextOf(req, reply),
      sessionCookie(req, reply),
    );
  }

  /**
   * Session lifecycle: logout, logout-all, revoke-session.
   *
   * `refresh` is gone from this union — the backend rotates its own tokens now, and
   * there is nothing for a client to ask for. See dto/session.dto.ts.
   *
   * `OptionalAuthGuard` rather than `AuthGuard`, and it is the LOGOUT actions that
   * need it now rather than refresh. A repeated logout has to keep succeeding, and a
   * user whose session expired while they were away must still end up signed out —
   * so a mandatory guard would answer 401 to exactly the requests whose whole purpose
   * is to clean up after a session that is already over. The optional guard populates
   * a principal when the credential is live, passes when it is dead or absent, and
   * still rejects one that is present but malformed.
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
  ): Promise<SuccessEnvelope<LogoutPayload | EmptyPayload>> {
    return this.controller.session(body, optionalPrincipal(req), sessionCookie(req, reply));
  }

  /**
   * Am I signed in, and if not, why?
   *
   * ─── The three decorators, each doing something the others do not ────────
   *
   * No `@Public()`, deliberately: this route is GUARDED, and the guard's refusal IS
   * the answer for a caller who is not signed in. Making it public would mean writing
   * a second, parallel liveness check inside the controller — a second authority on
   * the one question this route exists to answer.
   *
   * `@NotActivity()` because a client polling "am I still signed in?" is the
   * application talking to itself. Counting it would make the idle timeout
   * unenforceable: an abandoned tab with a poll on a timer would hold its session open
   * forever, which is the exact failure the decorator exists to prevent.
   *
   * `@ExplainsSessionState()` is what turns the 401 into an answer, attaching which of
   * the five states explains it — see security/session.message.ts.
   *
   * `cache-control: no-store` on both paths: here for the 200, and in the guard's
   * catch for the 401, which never reaches this handler. An intermediary caching
   * "you are logged in" would serve it to the next person on that connection.
   */
  @Get('session')
  @NotActivity()
  @ExplainsSessionState()
  sessionStatus(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<SessionStatusPayload>> {
    void reply.header('cache-control', 'no-store');
    return this.controller.sessionStatus(
      requirePrincipal(req),
      sessionLastUsedAt(req),
      sessionCookie(req, reply),
    );
  }

  /**
   * Set or change a password. **Authenticated** — this route is no longer recovery.
   *
   * The public forgot/reset pair is gone. A user who has forgotten their password
   * signs in with an emailed code (see `POST /auth/login`, `mode: otp-request`)
   * and comes here. That raises the bar rather than lowering it: the old flow
   * needed only the mailbox, this needs the mailbox and a session.
   */
  @Post('password')
  password(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<EmptyPayload>> {
    return this.controller.password(body, requirePrincipal(req), contextOf(req, reply));
  }

  /**
   * The current account: read and update.
   *
   * No `@UseGuards(AuthGuard)` here, and their absence is the whole design: the
   * global guard in src/app.module.ts already covers these, and the four routes
   * above had to say `@Public()` to get out of it. Re-declaring the guard would
   * also run `authenticate` twice per request — two session lookups in Redis for
   * one call — because a global guard and a route guard both fire.
   */
  @Get('me')
  me(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<MePayload>> {
    // The reply is here only so `ensureCsrf` can repair a missing CSRF cookie. It
    // emits nothing on the common path, where the token the client already has is
    // still valid and is simply reported back.
    return this.controller.me(requirePrincipal(req), sessionCookie(req, reply));
  }

  @Patch('me')
  updateMe(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<PublicUserPayload>> {
    return this.controller.updateMe(body, requirePrincipal(req));
  }

  /**
   * Remember this browser, or forget one. Authenticated, like `me` above.
   *
   * Takes the reply because `contextOf` may issue the device cookie — a client
   * that reached here without one is about to be trusted, and the trust has to
   * hang off an identifier that will come back on the next request.
   */
  @Post('device')
  device(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<EmptyPayload>> {
    return this.controller.device(body, requirePrincipal(req), contextOf(req, reply));
  }

  /** Live sessions grouped by device — read-only, so no client context needed. */
  @Get('sessions')
  sessions(@Req() req: FastifyRequest): Promise<SuccessEnvelope<SessionListPayload>> {
    return this.controller.sessionList(requirePrincipal(req));
  }

  /**
   * Attach a third-party provider to this account.
   *
   * ─── Why this is the most heavily guarded route in the file ────────────────
   *
   * Authenticated by the global guard, and `confirm` additionally needs a
   * single-use elevation ticket proved for `account.oauth.link`.
   *
   * An `OauthLink` is a credential that outlives everything a user is told to do
   * about a compromise — a password change, a session sweep, an email change.
   * Attaching one used to be an optional `linkToken` field on `POST /auth/login`,
   * which made it a side effect of presenting a single factor: whoever could read a
   * mailbox could sign in with an emailed code, attach their own Google account, and
   * still be in afterwards. So it is its own route, and it costs a deliberate second
   * proof naming this specific write.
   *
   * ─── Why preview is a SEPARATE route ───────────────────────────────────────
   *
   * Because a Nest guard runs before the body is parsed. These two used to share one
   * handler with an `action` discriminator, and `ElevationGuard` sat on it — so the
   * guard spent the single-use ticket without knowing which action had been asked
   * for. `ElevationService.spend` reads the ticket with GETDEL, so a `preview` call
   * genuinely destroyed it and the `confirm` that followed got `reauth_required`.
   *
   * The comment that used to sit here defended the arrangement as "a client asks for
   * one proof and uses it for the confirm that follows". That is exactly what the
   * mechanism forbids, and it was wrong rather than a trade-off: a working client had
   * to obtain two tickets or skip `preview` entirely.
   *
   * Two routes means the ROUTE defines the action. `@RequiresElevation` names one
   * write, and the handler beneath it can only perform that write — the choice is no
   * longer something a caller can express in a body parsed after the credential
   * check.
   */
  @Post('link/preview')
  linkPreview(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LinkPayload>> {
    // Bearer only. No `ElevationGuard`: this reads a token the caller already holds
    // and writes nothing.
    return this.controller.linkPreview(body, requirePrincipal(req), contextOf(req, reply));
  }

  @Post('link')
  @UseGuards(ElevationGuard)
  @RequiresElevation('account.oauth.link')
  linkConfirm(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SuccessEnvelope<LinkPayload>> {
    // The client context is what carries `ipClass`, which is checked against the
    // one recorded when the provider identity was parked — the flow has to finish
    // from the network it started on. See `OauthService.assertSameNetwork`.
    return this.controller.linkConfirm(body, requirePrincipal(req), contextOf(req, reply));
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
function contextOf(req: FastifyRequest, reply: FastifyReply): ClientContext {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    deviceCookie(req, reply),
    cloudflareCountry(req.headers),
  );
}
