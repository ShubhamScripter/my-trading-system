import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import type { KycEntitlementsPayload } from './kyc-entitlement.dto';
import { kycEntitlementRequestSchema } from './kyc-entitlement.dto';
import { KycEntitlementService } from './kyc-entitlement.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * Authorisation is declared on the route (`SuperAdminGuard`), so who may reach these
 * handlers is readable off the route table rather than buried here. The switch is
 * exhaustive and the `never` in `default` enforces it: adding an action to
 * `kycEntitlementRequestSchema` without handling it fails the build.
 *
 * ═══ NO ELEVATION CHECK — DEFERRED, NOT OVERLOOKED ═════════════════════════
 *
 * The whole KYC admin surface is gated by `SuperAdminGuard` alone; applying the second
 * factor to it is a later phase, and this module inherits that stance rather than being
 * stricter than the five surfaces beside it.
 *
 * What it costs, stated so the next reader does not have to work it out: a stolen or
 * left-open super-admin session can change what every account at a level may do, or
 * open an upgrade route by lowering a threshold. Both are platform-wide and take effect
 * on the next request with no rollout.
 *
 * It is NOT as sharp as `kyc-renewal`, where one request can de-verify the entire back
 * book, and it cannot manufacture standing the way `kyc-exemptions` can — nothing here
 * can reach a verification, a level state or an achievement. But it is the broadest of
 * the configuration surfaces, so it belongs in the first batch when elevation lands.
 *
 * ─── Re-applying it ───────────────────────────────────────────────────────
 *
 * Do NOT reach for `@UseGuards(ElevationGuard)`: the action lives in a union body,
 * which a guard cannot read, so the ticket has to be spent here — the arrangement
 * `KycPolicyController`, `KycExemptionController` and `KycRequirementController` all
 * document. Inject `ElevationService`, take the ticket from `elevationTicketOf(req)` in
 * the route, and spend it on the PARSED action:
 *
 *   await this.elevation.spend(ticket, actor.familyId,
 *     input.action === 'upgrade' ? 'admin.kyc-entitlement.upgrade'
 *                                : 'admin.kyc-entitlement.write');
 *
 * Two actions rather than one: a proof given to change an upgrade threshold must not be
 * spendable on rewriting the whole feature matrix, and the reverse.
 */
@Injectable()
export class KycEntitlementController {
  constructor(private readonly service: KycEntitlementService) {}

  /** The whole configuration — every level, every configured upgrade route, and the
   *  vocabularies a form needs. */
  async read(): Promise<SuccessEnvelope<KycEntitlementsPayload>> {
    return ok(await this.service.read());
  }

  async act(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycEntitlementsPayload>> {
    const input = parseDto(kycEntitlementRequestSchema, body);

    switch (input.action) {
      case 'entitlements':
        return ok(await this.service.writeEntitlements(input, actor, client));

      case 'upgrade':
        return ok(await this.service.writeUpgradeRequirement(input, actor, client));

      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }
}
