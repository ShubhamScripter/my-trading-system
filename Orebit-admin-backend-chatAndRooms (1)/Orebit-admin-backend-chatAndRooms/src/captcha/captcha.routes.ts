import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { CaptchaAdminController } from './captcha.controller';
import type { CaptchaProvidersPayload } from './captcha.dto';

/**
 * THE route table for the `captcha` prefix. Declarative, zero logic.
 *
 * ─── Why a prefix of its own ───────────────────────────────────────────────
 *
 * Not under `/admins`, because every action there names an `adminId` and that
 * invariant is worth keeping true — it is what makes "what can touch another admin"
 * a question you can answer by reading one file. A captcha toggle targets no admin.
 *
 * Not under `/auth`, because everything there is part of signing in and this is
 * configuration. `POST /auth/login {"step":"start"}` reads the same underlying set,
 * but it is the anonymous read for a login page; these two are the operator's.
 *
 * ─── NOT `@Public()` ───────────────────────────────────────────────────────
 *
 * The global `AuthGuard` in src/app.module.ts covers both handlers and this file
 * says nothing about it. Its silence is the statement.
 *
 * `'captcha'` here must match the `captcha` entry in ROUTE_GROUPS (src/app.routes.ts).
 */
@Controller('captcha')
export class CaptchaRoutes {
  constructor(private readonly controller: CaptchaAdminController) {}

  /**
   * Every provider, and why each is or is not live.
   *
   * SUPER_ADMIN, but NO elevation ticket: this changes nothing, and demanding a
   * fresh factor proof to look at a settings screen would train operators to keep a
   * ticket in hand — which is exactly the habit the single-use ticket exists to
   * prevent. Same reasoning as `GET /admins/login-reviews`.
   *
   * A GET, so it is cacheable, linkable and safe to retry.
   */
  @Get('providers')
  @UseGuards(SuperAdminGuard)
  list(): Promise<SuccessEnvelope<CaptchaProvidersPayload>> {
    return this.controller.list();
  }

  /**
   * Switch one provider on or off.
   *
   * ─── NO ELEVATION TICKET, AND THAT IS A PRODUCT DECISION ───────────────────
   *
   * This route carried `@UseGuards(ElevationGuard)` and
   * `@RequiresElevation('admin.captcha.toggle')` when it was first written, on the
   * reasoning that it weakens an unauthenticated defence — turning a provider off
   * makes sign-in easier to attack for everyone. That requirement was reviewed and
   * dropped: an operator switching a provider off is usually responding to a vendor
   * incident, and making them re-prove a factor mid-incident costs more than it buys.
   *
   * Recorded here rather than merely removed, so the absence reads as a decision
   * instead of an oversight. What still stands between a caller and this write:
   *
   *  - a live session, via the global `AuthGuard`;
   *  - SUPER_ADMIN, re-read from the DATABASE by `SuperAdminGuard` — a
   *    fifteen-minute access token's `rol` claim may be stale, so a demoted admin is
   *    refused here even while their token lives;
   *  - the anti-lockout floor in `CaptchaSettingsService.toggle`, which refuses to
   *    disable the last live provider however privileged the caller.
   *
   * What is NOT: a stolen or hijacked super-admin session can now make this write on
   * its own. If that trade is ever revisited, restoring it is the two decorators
   * above plus `TwoFactorModule` back in captcha.module.ts.
   */
  @Post('providers')
  @UseGuards(SuperAdminGuard)
  toggle(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<CaptchaProvidersPayload>> {
    return this.controller.toggle(body, requirePrincipal(req));
  }
}
