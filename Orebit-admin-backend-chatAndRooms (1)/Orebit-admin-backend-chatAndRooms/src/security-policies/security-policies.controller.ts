import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import {
  securityPolicyUpsertSchema,
  type SecurityPoliciesPayload,
} from './security-policies.dto';
import { SecurityPolicyService } from './security-policies.service';

/**
 * Parse, delegate, serialise. No business logic and no authorisation.
 *
 * The gate is DECLARED on the route — `@UseGuards(SuperAdminGuard, ElevationGuard)`
 * plus `@RequiresElevation(...)` — rather than checked here, and that is the same
 * split `CaptchaAdminController` documents: this surface targets no admin, so the
 * gate is identical for every caller and can be read off the route file instead of
 * trusted to a controller that remembered to check.
 *
 * Contrast `AdminsController`, which DOES authorise in the controller, because what it
 * must check depends on the body — which admin is being targeted, and whether that is
 * the caller. Nothing here targets anybody.
 */
@Injectable()
export class SecurityPolicyController {
  constructor(private readonly service: SecurityPolicyService) {}

  /** Every policy, configured or not, plus the vocabulary a form renders from. */
  async list(): Promise<SuccessEnvelope<SecurityPoliciesPayload>> {
    return ok(await this.service.state());
  }

  /**
   * Create or update one policy.
   *
   * The actor comes from the authenticated principal and never from the body — an
   * actor a caller could name would make the audit column worse than useless, which is
   * the note `CaptchaAdminController.toggle` makes about the same field.
   */
  async upsert(
    body: unknown,
    actor: Principal,
    client: ClientContext,
  ): Promise<SuccessEnvelope<SecurityPoliciesPayload>> {
    const input = parseDto(securityPolicyUpsertSchema, body);
    return ok(await this.service.upsert(input, actor, client));
  }
}
