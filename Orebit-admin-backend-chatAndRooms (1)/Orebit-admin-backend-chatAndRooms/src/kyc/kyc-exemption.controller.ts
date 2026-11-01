import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import type { KycExemptionsPayload } from './kyc-exemption.dto';
import { kycExemptionQuerySchema, kycExemptionRequestSchema } from './kyc-exemption.dto';
import { KycExemptionService } from './kyc-exemption.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * ═══ NO ELEVATION CHECK — DEFERRED, AND THIS IS THE SHARPER HALF ═══════════
 *
 * Applying the second factor to the KYC surface is a later phase. Until then a valid
 * SUPER_ADMIN session is the whole credential for these writes.
 *
 * The cost is higher here than on the policy surface, and is worth stating plainly.
 * A grant does not merely configure a rule: the user backend folds a live exemption
 * into an account's EFFECTIVE verification level on every evaluation, so this raises
 * one specific account's standing platform-wide the moment it commits, with no
 * provider attesting anything. With no elevation, a super-admin session left open is
 * enough to do that — and the only trace is the audit event and the row's own
 * `granted_by`.
 *
 * What still holds in the meantime: SUPER_ADMIN is re-read from the database rather
 * than taken from the token, every grant and revoke writes an auth event, `reason` is
 * mandatory on both, and one live exemption per account is enforced by a partial
 * unique index rather than by this code.
 *
 * ─── Re-applying it ────────────────────────────────────────────────────────
 *
 * Not `@UseGuards(ElevationGuard)` — the action is in a union body, which a guard
 * cannot read. Inject `ElevationService`, take the ticket from `elevationTicketOf(req)`
 * in the route, and spend it on the parsed action:
 *
 *   await this.elevation.spend(ticket, actor.familyId,
 *     input.action === 'grant' ? 'admin.kyc-exemption.grant' : 'admin.kyc-exemption.revoke');
 *
 * Separate actions, so a proof given to withdraw relief cannot be spent granting it.
 */
@Injectable()
export class KycExemptionController {
  constructor(private readonly service: KycExemptionService) {}

  async list(query: unknown): Promise<SuccessEnvelope<KycExemptionsPayload>> {
    return ok(await this.service.list(parseDto(kycExemptionQuerySchema, query)));
  }

  async act(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycExemptionsPayload>> {
    const input = parseDto(kycExemptionRequestSchema, body);

    switch (input.action) {
      case 'grant':
        return ok(await this.service.grant(input, actor, client));

      case 'revoke':
        return ok(await this.service.revoke(input, actor, client));

      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }
}
