import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import { kycRenewalRequestSchema, type KycRenewalPayload } from './kyc-renewal.dto';
import { KycRenewalService } from './kyc-renewal.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * Authorisation is declared on the route (`SuperAdminGuard`), so who may reach these
 * handlers is readable off the route table rather than buried here.
 *
 * Two handlers, and there will not be a third: reading the configuration and writing it
 * is the whole feature. There is no history handler — the renewal configuration keeps no
 * history of itself, and who changed it lives in the admin audit log.
 *
 * ═══ NO ELEVATION CHECK — DEFERRED, NOT OVERLOOKED ═════════════════════════
 *
 * `security-policies` spends a single-use elevation ticket on its write; the KYC
 * surfaces do not, by the decision `KycPolicyController` records. This module inherits
 * that stance so the whole KYC admin surface is gated the same way rather than two of
 * three routes being stricter than the third.
 *
 * What it costs, stated so the next reader does not have to work it out: a stolen or
 * left-open super-admin session can set a mandatory renewal period and de-verify the
 * platform's entire back book in one request. That is a larger blast radius than a
 * policy edit, and it is the strongest argument in the codebase for applying the second
 * factor to KYC.
 *
 * ─── Re-applying it ────────────────────────────────────────────────────────
 *
 * Unlike `kyc-policies` this body is NOT a union, so `@UseGuards(ElevationGuard)` on
 * the route would work. Prefer it here: the guard is visible in the route table, which
 * is where a reviewer looks. Spend `'admin.kyc-renewal.update'`.
 */
@Injectable()
export class KycRenewalController {
  constructor(private readonly service: KycRenewalService) {}

  async read(): Promise<SuccessEnvelope<KycRenewalPayload>> {
    return ok(await this.service.state());
  }

  async update(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<KycRenewalPayload>> {
    return ok(await this.service.update(parseDto(kycRenewalRequestSchema, body), actor, client));
  }
}
