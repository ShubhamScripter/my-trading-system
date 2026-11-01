import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycRenewalController } from './kyc-renewal.controller';
import type { KycRenewalPayload } from './kyc-renewal.dto';

/**
 * THE route table for the global KYC renewal periods. Declarative, zero logic.
 *
 * ─── What these routes configure, and what they cannot touch ────────────────
 *
 * Two numbers: how long a verification stays valid, and how long before its holder may
 * voluntarily redo it. They cannot write a user's level state, cannot edit a
 * verification, and cannot mark anyone verified or expired. What an account has proved
 * is the provider's word arriving over a signed webhook in ../Orebit-backend; these
 * routes decide when that word goes stale, never whether it was said.
 *
 * ─── Global, and the route shape says so ────────────────────────────────────
 *
 * No region, no level, no path parameter and no body field for either. The periods are
 * platform-wide by product decision, and a surface that could not express a per-country
 * or per-level value is the cheapest way to keep them that way — which is also why they
 * are NOT three more columns on `kyc_policies`, whose key is `(region, level)`.
 *
 * `tests/app.routes.spec.ts` asserts this service takes no path parameters anywhere.
 *
 * ─── Two routes, and no history route ───────────────────────────────────────
 *
 * `GET /kyc-renewal/history` existed and was removed with the versions table behind it.
 * The renewal configuration keeps no history of itself; `KYC_RENEWAL_SETTINGS_UPDATED`
 * in the admin audit log is where a change is recorded, and that log is read through the
 * audit surface rather than through this one.
 *
 * `'kyc-renewal'` here must match the `kyc-renewal` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-renewal')
export class KycRenewalRoutes {
  constructor(private readonly controller: KycRenewalController) {}

  /** The live periods — `{ mandatoryPeriodDays, voluntaryPeriodDays }`, both nullable. */
  @Get()
  @UseGuards(SuperAdminGuard)
  read(): Promise<SuccessEnvelope<KycRenewalPayload>> {
    return this.controller.read();
  }

  /**
   * Set both periods. A full-state write: a field sent as null turns that half off, and
   * null/null disables renewal entirely.
   */
  @Post()
  @UseGuards(SuperAdminGuard)
  update(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycRenewalPayload>> {
    return this.controller.update(
      body,
      requirePrincipal(req),
      // Built here so the request object stops at this layer and the controller stays
      // testable without a live HTTP request. Every write records an auth event, and an
      // audit row with no idea where the action came from is half a row.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }
}
