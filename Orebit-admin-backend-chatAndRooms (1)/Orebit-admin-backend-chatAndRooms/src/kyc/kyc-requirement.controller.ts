import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import type { KycRequirementsPayload } from './kyc-requirement.dto';
import { kycRequirementQuerySchema, kycRequirementRequestSchema } from './kyc-requirement.dto';
import { KycRequirementService } from './kyc-requirement.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * Authorisation is declared on the route (`SuperAdminGuard`), so who may reach these
 * handlers is readable off the route table rather than buried here. The switch is
 * exhaustive and the `never` in `default` enforces it: adding a verb to
 * `kycRequirementRequestSchema` without handling it fails the build.
 *
 * ═══ NO ELEVATION CHECK — DEFERRED, NOT OVERLOOKED ═════════════════════════
 *
 * The whole KYC admin surface is gated by `SuperAdminGuard` alone; applying the second
 * factor to it is a later phase, and this module inherits that stance rather than
 * being stricter than the three beside it.
 *
 * What it costs, stated so the next reader does not have to work it out: a stolen or
 * left-open super-admin session can impose a permanent verification obligation on any
 * account, or lift one somebody imposed for a reason. Neither is as sharp as
 * `kyc-renewal`, where one request can de-verify the entire back book, and neither
 * raises standing the way `kyc-exemptions` does — an obligation only ever withholds.
 *
 * ─── Re-applying it ───────────────────────────────────────────────────────
 *
 * Do NOT reach for `@UseGuards(ElevationGuard)`: the action lives in a union body,
 * which a guard cannot read, so the ticket has to be spent here — the arrangement
 * `KycPolicyController` and `KycExemptionController` both document. Inject
 * `ElevationService`, take the ticket from `elevationTicketOf(req)` in the route, and
 * spend it on the PARSED action:
 *
 *   await this.elevation.spend(ticket, actor.familyId,
 *     input.action === 'waive' ? 'admin.kyc-requirement.waive'
 *                              : 'admin.kyc-requirement.require');
 *
 * Two actions rather than one: a proof given to LIFT an obligation must not be
 * spendable on imposing one, and the reverse.
 */
@Injectable()
export class KycRequirementController {
  constructor(private readonly service: KycRequirementService) {}

  async list(query: unknown): Promise<SuccessEnvelope<KycRequirementsPayload>> {
    return ok(await this.service.list(parseDto(kycRequirementQuerySchema, query)));
  }

  async act(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycRequirementsPayload>> {
    const input = parseDto(kycRequirementRequestSchema, body);

    switch (input.action) {
      case 'require':
        return ok(await this.service.require(input, actor, client));

      case 'waive':
        return ok(await this.service.waive(input, actor, client));

      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }
}
