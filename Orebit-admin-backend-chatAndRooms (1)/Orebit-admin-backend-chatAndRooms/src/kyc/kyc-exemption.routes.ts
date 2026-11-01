import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycExemptionController } from './kyc-exemption.controller';
import type { KycExemptionsPayload } from './kyc-exemption.dto';

/**
 * THE route table for KYC exemptions. Declarative, zero logic.
 *
 * ─── Why this is its own prefix and not part of `kyc-policies` ──────────────
 *
 * The same argument `AdminsRoutes` makes for itself: these actions target a PLATFORM
 * USER, and a policy targets nobody. That is a bigger difference than the one which
 * already earned `admins` its own prefix, and it keeps "which accounts can this reach"
 * answerable from one route table rather than spread across a shared one.
 *
 * ─── No path parameter, deliberately ────────────────────────────────────────
 *
 * The account is a validated field in the body (or a parsed query on the read), never
 * a path segment. `tests/app.routes.spec.ts` asserts this across every controller, and
 * the stated reason applies here exactly: a path parameter naming a target spreads the
 * answer to "who can this reach" across decorators instead of keeping it in one
 * validated place.
 *
 * ─── No elevation on the write, for now ─────────────────────────────────────
 *
 * Deferred to a later phase; `SuperAdminGuard` is currently the whole gate. This is
 * the surface where that matters most — a grant raises one account's effective KYC
 * level platform-wide — so `KycExemptionController` states the gap and how to close
 * it rather than leaving it to be discovered.
 *
 * `'kyc-exemptions'` here must match the `kyc-exemptions` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-exemptions')
export class KycExemptionRoutes {
  constructor(private readonly controller: KycExemptionController) {}

  /**
   * One account's exemption history, or every account currently holding relief.
   *
   * Without `userId` this answers the compliance-review question — who is exempt right
   * now — which is bounded, because the partial unique index permits one live row per
   * account.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(@Query() query: unknown): Promise<SuccessEnvelope<KycExemptionsPayload>> {
    return this.controller.list(query);
  }

  /** Grant or revoke. There is deliberately no route that EDITS a granted exemption —
   *  changing one is revoke then grant, so both facts stay on the record. */
  @Post()
  @UseGuards(SuperAdminGuard)
  act(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycExemptionsPayload>> {
    return this.controller.act(
      body,
      requirePrincipal(req),
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }
}
