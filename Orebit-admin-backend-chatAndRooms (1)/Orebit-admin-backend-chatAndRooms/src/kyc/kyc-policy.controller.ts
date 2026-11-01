import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import type { KycPoliciesPayload, KycPolicyHistoryPayload } from './kyc-policy.dto';
import { kycPolicyHistoryQuerySchema, kycPolicyRequestSchema } from './kyc-policy.dto';
import { KycPolicyService } from './kyc-policy.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * Authorisation is declared on the route (`SuperAdminGuard`), so who may reach these
 * handlers is readable off the route table rather than buried here.
 *
 * The switch is exhaustive and the `never` in `default` enforces it: adding a variant
 * to `kycPolicyRequestSchema` without handling it fails the build.
 *
 * ═══ NO ELEVATION CHECK — DEFERRED, NOT OVERLOOKED ═════════════════════════
 *
 * `security-policies`, the module this one is modelled on, spends a single-use
 * elevation ticket on its write. These routes do not, by decision: the second factor
 * is being applied to the KYC surface in a later phase, and until then a valid
 * SUPER_ADMIN session is the whole credential.
 *
 * What that costs, stated so the next reader does not have to work it out: a stolen or
 * left-open super-admin session can rewrite KYC policy for every region with no fresh
 * proof of presence. The exemption surface is the sharper half of the same gap — see
 * `KycExemptionController`.
 *
 * ─── Re-applying it ────────────────────────────────────────────────────────
 *
 * Do NOT reach for `@UseGuards(ElevationGuard)`: the action lives in a union body,
 * which a guard cannot read, so the ticket has to be spent here — the arrangement
 * `AdminsController.act` uses and documents. Inject `ElevationService`, take the
 * ticket from `elevationTicketOf(req)` in the route, and spend it on the PARSED
 * action so the proof required is decided by what the caller is actually asking to do:
 *
 *   await this.elevation.spend(ticket, actor.familyId,
 *     input.action === 'delete' ? 'admin.kyc-policy.delete' : 'admin.kyc-policy.update');
 *
 * Two actions rather than one, because removing a policy silently re-exposes the
 * global rule for that region and must not be buyable with a proof given for an edit.
 */
@Injectable()
export class KycPolicyController {
  constructor(private readonly service: KycPolicyService) {}

  async list(): Promise<SuccessEnvelope<KycPoliciesPayload>> {
    return ok(await this.service.state());
  }

  async history(query: unknown): Promise<SuccessEnvelope<KycPolicyHistoryPayload>> {
    return ok(await this.service.history(parseDto(kycPolicyHistoryQuerySchema, query)));
  }

  async act(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycPoliciesPayload>> {
    const input = parseDto(kycPolicyRequestSchema, body);

    switch (input.action) {
      case 'upsert':
        return ok(await this.service.upsert(input, actor, client));

      case 'delete':
        return ok(await this.service.remove(input, actor, client));

      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }
}
