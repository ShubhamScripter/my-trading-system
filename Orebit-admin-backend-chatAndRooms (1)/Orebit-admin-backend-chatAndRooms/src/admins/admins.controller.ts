import { Injectable } from '@nestjs/common';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { toAdminPayload } from '../../auth/auth.dto';
import { toPublicAdmin } from '../../auth/auth.utility';
import { ok, parseDto, type SuccessEnvelope } from '../http';
import { ElevationService } from '../2fa/elevation';
import {
  adminRequestSchema,
  loginReviewQuerySchema,
  type AdminActionPayload,
  type LoginReviewListPayload,
} from './admins.dto';
import { AdminsService } from './admins.service';
import { ADMIN_ELEVATION } from './admins.types';

/**
 * Parse, spend the ticket, delegate, serialise. No business logic — the
 * authorisation gate lives in `AdminsService.authorise`, deliberately, because it
 * depends on a freshly-read database row rather than on anything the request
 * carries.
 *
 * ═══ WHY THE TICKET IS SPENT HERE AND NOT BY `ElevationGuard` ══════════════
 *
 * Because the action is in the BODY. `@RequiresElevation(...)` is handler metadata,
 * so it can name one action per route — which is right for a route that does one
 * thing, and cannot express a discriminated union that does three.
 *
 * This is the same shape `POST /2fa` uses and for the same reason; `elevation.ts`
 * documents the split. What matters is that the action spent comes from
 * `ADMIN_ELEVATION` keyed on the PARSED action, never from a field the client
 * chooses — so a caller cannot present a ticket for `admin.status.enable` and have
 * it accepted for a reset.
 *
 * ─── Spent BEFORE the action runs ──────────────────────────────────────────
 *
 * So a write that fails downstream has still consumed the proof. The alternative —
 * spending on success — would let one proof be retried against several candidate
 * writes until one landed. Same reasoning as `2fa.controller.ts`'s `elevatedFor`.
 *
 * The switch is exhaustive and the `never` in `default` enforces it: adding a
 * variant to `adminRequestSchema` without handling it fails the build.
 */
@Injectable()
export class AdminsController {
  constructor(
    private readonly service: AdminsService,
    private readonly elevation: ElevationService,
  ) {}

  async act(
    body: unknown,
    actor: Principal,
    ticket: string | null,
    client: ClientContext,
  ): Promise<SuccessEnvelope<AdminActionPayload>> {
    const input = parseDto(adminRequestSchema, body);

    // Keyed on the parsed action, so the proof required is decided by what the
    // caller is actually asking to do rather than by what they say they proved.
    // No `ELEVATION_ANY` fallback here: this surface is new, so it is scoped from
    // the first commit and an un-migrated client has nothing to be compatible with.
    // `familyId`: the proof belongs to this LOGIN, so a background token rotation
    // between the proof and this write does not invalidate it. See src/2fa/elevation.ts.
    await this.elevation.spend(ticket, actor.familyId, ADMIN_ELEVATION[input.action]);

    switch (input.action) {
      case 'reset-factors': {
        const { admin, retired } = await this.service.resetFactors(
          actor,
          input.adminId,
          input.reason,
        );
        return ok({
          outcome: 'factors_reset' as const,
          admin: toAdminPayload(toPublicAdmin(admin)),
          retired,
        });
      }

      case 'disable': {
        const admin = await this.service.setStatus(actor, input.adminId, 'DISABLED', input.reason);
        return ok({ outcome: 'status_changed' as const, admin: toAdminPayload(toPublicAdmin(admin)) });
      }

      case 'enable': {
        const admin = await this.service.setStatus(actor, input.adminId, 'ACTIVE', undefined);
        return ok({ outcome: 'status_changed' as const, admin: toAdminPayload(toPublicAdmin(admin)) });
      }

      case 'resolve-login-review': {
        const { admin, decision, reviewVersion } = await this.service.resolveLoginReview(
          actor,
          {
            adminId: input.adminId,
            decision: input.decision,
            reason: input.reason,
            expectedVersion: input.expectedVersion,
          },
          client,
        );
        return ok({
          outcome: 'login_review_resolved' as const,
          admin: toAdminPayload(toPublicAdmin(admin)),
          decision,
          reviewVersion,
        });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  /**
   * GET /admins/login-reviews
   *
   * Parsed with its own schema rather than the union above, because a query string is
   * not a body: every value arrives as a string, so `limit` needs coercion, and there
   * is no `action` to discriminate on.
   *
   * No ticket is spent. This route reads and changes nothing - see
   * `AdminsService.listLoginReviews` for why an elevation proof would be theatre here.
   */
  async loginReviews(
    query: unknown,
    actor: Principal,
  ): Promise<SuccessEnvelope<LoginReviewListPayload>> {
    return ok(await this.service.listLoginReviews(actor, parseDto(loginReviewQuerySchema, query)));
  }
}
