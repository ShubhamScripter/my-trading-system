import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { SuperAdminGuard } from '../../auth/security/guards';
import { requirePrincipal } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycPolicyController } from './kyc-policy.controller';
import type { KycPoliciesPayload, KycPolicyHistoryPayload } from './kyc-policy.dto';

/**
 * THE route table for KYC policy. Declarative, zero logic.
 *
 * ─── What these routes configure, and what they cannot touch ────────────────
 *
 * Policy only: WHAT verification is required, WHERE. They cannot write a user's
 * requirement rows, cannot edit a verification, and cannot move a profile's level.
 * What an account has actually proved is the provider's word arriving over a signed
 * webhook in ../Orebit-backend, and no configuration surface may overwrite it.
 *
 * ─── No elevation on the write, for now ─────────────────────────────────────
 *
 * `security-policies`, which this module is modelled on, demands a single-use
 * elevation ticket on its write. These routes do not: applying the second factor to
 * the KYC surface is a later phase, and until then `SuperAdminGuard` is the whole
 * gate. See `KycPolicyController` for what that costs and how to re-apply it.
 *
 * When it IS re-applied, the ticket belongs in the CONTROLLER rather than in a
 * `@UseGuards(ElevationGuard)` here — the action lives in a union body, which a guard
 * cannot read, and a guard plus a controller-side spend would consume a single-use
 * ticket twice and refuse every request.
 *
 * `'kyc-policies'` here must match the `kyc-policies` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-policies')
export class KycPolicyRoutes {
  constructor(private readonly controller: KycPolicyController) {}

  /** Every configured policy, plus the vocabularies a form needs. */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(): Promise<SuccessEnvelope<KycPoliciesPayload>> {
    return this.controller.list();
  }

  /**
   * The version history for one (region, level).
   *
   * Its own route rather than a field on the list: a read must be a GET, the target is
   * mandatory, and the versions table is a different resource. Folding an unbounded
   * per-policy history into the list would make the common read pay for the rare one.
   */
  @Get('history')
  @UseGuards(SuperAdminGuard)
  history(@Query() query: unknown): Promise<SuccessEnvelope<KycPolicyHistoryPayload>> {
    return this.controller.history(query);
  }

  /** Create, update or remove one policy. */
  @Post()
  @UseGuards(SuperAdminGuard)
  act(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycPoliciesPayload>> {
    return this.controller.act(
      body,
      requirePrincipal(req),
      // Built here rather than in the controller, so the request object stops at this
      // layer and the controller stays testable without a live HTTP request. Every
      // write records an auth event, and an audit row with no idea where the action
      // came from is half a row.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }
}
