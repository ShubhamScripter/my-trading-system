import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycHistoryController } from './kyc-history.controller';
import type { KycHistoryAttemptPayload, KycHistoryPayload } from './kyc-history.dto';

/**
 * THE route table for KYC history. Declarative, zero logic.
 *
 * ═══ READ-ONLY BY CONSTRUCTION, NOT BY CONVENTION ══════════════════════════
 *
 * Two GETs and nothing else. There is no POST, PATCH or DELETE on this controller, no
 * mutating method on the service behind it, and no write statement in its dboperation —
 * so an admin cannot edit history, cannot approve a case, and cannot manufacture a
 * verification result from here. A case under review is decided by Didit and arrives
 * over a signed webhook; this surface observes that and never short-circuits it.
 *
 * ─── Query parameters only ──────────────────────────────────────────────────
 *
 * `tests/app.routes.spec.ts` asserts this service takes no path parameters anywhere,
 * and the reason applies with force here: a path segment naming a target spreads the
 * answer to "which accounts can this reach" across decorators instead of keeping it in
 * one validated place. So the attempt detail takes `?verificationId=`, not `/:id`.
 *
 * ─── Why a flat prefix ─────────────────────────────────────────────────────
 *
 * `kyc-history` sits beside `kyc-policies`, `kyc-renewal` and `kyc-exemptions`. The
 * versioned `/v1/admin/...` shape belongs to `src/admin-audits/`, which is a separate
 * composition not mounted by `app.module.ts`; borrowing it here would put one KYC
 * surface on a different convention from the other three.
 *
 * `'kyc-history'` here must match the `kyc-history` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-history')
export class KycHistoryRoutes {
  constructor(private readonly controller: KycHistoryController) {}

  /**
   * Every KYC attempt, newest first, filtered and paginated.
   *
   * Keyset pagination on `(created_at, id)` — history only grows, and an OFFSET would
   * repeat or skip rows as attempts land underneath a paging operator.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  list(@Query() query: unknown, @Req() req: FastifyRequest): Promise<SuccessEnvelope<KycHistoryPayload>> {
    return this.controller.list(query, requirePrincipal(req), contextOf(req));
  }

  /** One attempt, with the devices observed during it and the deliveries that settled it. */
  @Get('attempt')
  @UseGuards(SuperAdminGuard)
  attempt(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycHistoryAttemptPayload>> {
    return this.controller.attempt(query, requirePrincipal(req), contextOf(req));
  }
}

/** Built here so the request object stops at this layer and the controller stays
 *  testable without a live HTTP request. Both reads are audited, and an audit row with
 *  no idea where the request came from is half a row. */
function contextOf(req: FastifyRequest) {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    headerValue(req.headers['accept-language']),
  );
}
