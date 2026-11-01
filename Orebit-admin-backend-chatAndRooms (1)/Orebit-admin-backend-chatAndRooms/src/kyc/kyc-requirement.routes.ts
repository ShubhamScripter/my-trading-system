import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycRequirementController } from './kyc-requirement.controller';
import type { KycRequirementsPayload } from './kyc-requirement.dto';

/**
 * THE route table for manually imposed KYC obligations. Declarative, zero logic.
 *
 * ═══ THE FOURTH KYC PREFIX, AND WHY IT IS ITS OWN ══════════════════════════
 *
 * `kyc-policies` targets a region and level. `kyc-renewal` targets the platform.
 * `kyc-history` reads one account. `kyc-exemptions` RELIEVES one account. This one
 * OBLIGATES one account — the mirror of exemptions, pointing the other way — and it
 * earns its own prefix by the argument `AdminsRoutes` makes and `kyc-exemptions`
 * repeats: an action that targets a platform user is a different kind of thing from
 * one that targets a rule, and keeping "which accounts can this reach" answerable from
 * one route table is worth a prefix.
 *
 * ─── What these routes can and cannot do ───────────────────────────────────
 *
 * They record an obligation and they discharge one. They cannot mark anybody verified:
 * `KycRequirementDbOperation` has no statement touching `kyc_level_states`,
 * `kyc_verifications`, `kyc_verification_devices` or `kyc_provider_events`. What an
 * account has actually PROVED is the provider's word arriving over a signed webhook in
 * ../Orebit-backend, and no admin surface may edit it.
 *
 * They also decide nothing about whether the obligation currently bites. That is the
 * consumer's evaluator, and deliberately not reproduced here — see
 * `KycRequirementService`.
 *
 * ─── No path parameter, deliberately ──────────────────────────────────────
 *
 * The account is a validated field in the body, or a parsed query on the read, never a
 * path segment. `tests/app.routes.spec.ts` asserts this across every controller in the
 * service, and the stated reason applies here exactly: a path parameter naming a
 * target spreads the answer to "who can this reach" across decorators instead of
 * keeping it in one validated place.
 *
 * ─── No elevation on the write, for now ───────────────────────────────────
 *
 * Deferred to a later phase; `SuperAdminGuard` is currently the whole gate. See
 * `KycRequirementController` for what that costs and the exact spend to restore.
 *
 * `'kyc-requirements'` here must match the `kyc-requirements` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-requirements')
export class KycRequirementRoutes {
  constructor(private readonly controller: KycRequirementController) {}

  /**
   * One account's obligations, open first then newest.
   *
   * `userId` is REQUIRED, unlike the exemption listing. Requirements have no
   * one-per-account ceiling and closed rows are kept forever, so an unfiltered listing
   * would be an unbounded scan — see `kycRequirementQuerySchema`.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(@Query() query: unknown): Promise<SuccessEnvelope<KycRequirementsPayload>> {
    return this.controller.list(query);
  }

  /** Impose or discharge. There is deliberately no route that EDITS a requirement —
   *  changing one is a waiver plus a new one, so both facts stay on the record. */
  @Post()
  @UseGuards(SuperAdminGuard)
  act(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycRequirementsPayload>> {
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
