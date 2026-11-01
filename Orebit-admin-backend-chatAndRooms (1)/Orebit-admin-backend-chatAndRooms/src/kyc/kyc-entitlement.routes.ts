import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { clientContextOf, headerValue } from '../../auth/auth.utility';
import { requirePrincipal, SuperAdminGuard } from '../../auth/security/guards';
import type { SuccessEnvelope } from '../http';
import { KycEntitlementController } from './kyc-entitlement.controller';
import type { KycEntitlementsPayload } from './kyc-entitlement.dto';

/**
 * THE route table for what each KYC level grants. Declarative, zero logic.
 *
 * ═══ THE SIXTH KYC PREFIX, AND WHY IT IS ITS OWN ═══════════════════════════
 *
 * `kyc-policies` decides WHERE verification is required. `kyc-renewal` decides how long
 * one lasts. `kyc-history` reads one account. `kyc-requirements` obligates one account.
 * `kyc-exemptions` relieves one account. This one decides what a level is WORTH.
 *
 * It is not fields on `kyc-policies`, and the reason is the key: that table is
 * `@@unique([region, level])` and an entitlement is GLOBAL. A platform-wide withdrawal
 * ceiling stored on one row per country would have as many authorities as there are
 * countries, and they could disagree — which is precisely the failure that forced the
 * renewal periods out of `kyc_policies` and onto their own table. Same argument, same
 * conclusion, so the same shape.
 *
 * ─── What these routes can and cannot do ───────────────────────────────────
 *
 * They write two configuration tables — `identity.kyc_level_entitlements` and
 * `identity.kyc_upgrade_requirements` — and nothing else.
 *
 * They cannot mark anybody verified, cannot move a level state, cannot grant an
 * exemption, cannot impose a requirement, and cannot grant an upgrade achievement. The
 * last one is the least obvious and the most important: an achievement is an OBSERVATION
 * of an account's balance, only the consumer holds the port that can observe one, and
 * `KycEntitlementDbOperation` has no INSERT against that table at all. An admin surface
 * able to grant one could open an upgrade route nobody earned, with no reason, no expiry
 * and no revocation path.
 *
 * ─── It targets a RULE, never an account ──────────────────────────────────
 *
 * There is no `userId` on this surface — not in a body, not in a query, not in a path.
 * That is what makes "which accounts can this reach" answerable in one word: none.
 *
 * ─── No path parameter, deliberately ──────────────────────────────────────
 *
 * The level is a validated field in the body. `tests/app.routes.spec.ts` asserts this
 * across every controller in the service, and the stated reason applies here too: a
 * path parameter naming a target spreads the answer to "what can this reach" across
 * decorators instead of keeping it in one validated place.
 *
 * ─── No elevation on the write, for now ───────────────────────────────────
 *
 * Deferred to a later phase; `SuperAdminGuard` is currently the whole gate. See
 * `KycEntitlementController` for what that costs and the exact spend to restore.
 *
 * `'kyc-entitlements'` here must match the `kyc-entitlements` entry in ROUTE_GROUPS
 * (src/app.routes.ts).
 */
@Controller('kyc-entitlements')
export class KycEntitlementRoutes {
  constructor(private readonly controller: KycEntitlementController) {}

  /**
   * The whole configuration in one read: every level's matrix, every configured upgrade
   * route, and the vocabularies a form needs.
   *
   * One GET rather than one per level, because a config screen renders all three
   * side by side — an operator sets what L1 grants by comparing it with NONE and L2.
   * Three requests to build one screen would also let the three arrive from either side
   * of a concurrent write.
   */
  @Get()
  @UseGuards(SuperAdminGuard)
  read(): Promise<SuccessEnvelope<KycEntitlementsPayload>> {
    return this.controller.read();
  }

  /**
   * Write one level's entitlements, or one target's upgrade routes.
   *
   * A FULL-STATE write in both cases: a field sent as null sets that ceiling to
   * unconfigured, it does not mean "leave unchanged". Compare-and-swap on
   * `expectedVersion`, so two operators editing at once produce a refusal rather than a
   * silent last-write-wins.
   *
   * There is deliberately no route that DELETES a level's entitlements — a level always
   * has a row, and "grants nothing" is expressed by writing every switch false rather
   * than by removing the row and leaving the consumer to guess.
   */
  @Post()
  @UseGuards(SuperAdminGuard)
  act(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SuccessEnvelope<KycEntitlementsPayload>> {
    return this.controller.act(
      body,
      requirePrincipal(req),
      // Built here rather than in the controller, so the request object stops at this
      // layer and the controller stays testable without a live HTTP request. Every
      // write records an auth event, and an audit row with no idea where the action
      // came from is half a row — which matters more here than on most surfaces,
      // because this event stream IS the configuration history.
      clientContextOf(
        req.ip,
        headerValue(req.headers['user-agent']),
        headerValue(req.headers['accept-language']),
      ),
    );
  }
}
