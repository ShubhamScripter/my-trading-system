import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { requirePrincipal } from '../../auth/security/guards';
import { RestrictionService } from './restrictions.enforcement';

/**
 * ═══ ROUTE-LEVEL SUGAR OVER `RestrictionService`, NOT A SECOND CHECK ═══════
 *
 * `@RequiresFeature('withdrawal', 'crypto')` beside `@UseGuards(FeatureRestrictionGuard)`,
 * modelled on `@RequiresElevation` / `ElevationGuard` in src/2fa/elevation.ts — the
 * same metadata-on-the-handler shape, for the same reason: the ROUTE decides what it
 * is, never the request body. A guard that read the feature from the body would let a
 * caller name a feature they are not restricted on.
 *
 * ─── Why a guard AND an injectable, rather than one or the other ──────────
 *
 * They suit different shapes and both call the same method, so there is one
 * implementation and one place the decision is made:
 *
 *   the GUARD, for a route whose entire purpose is one feature — the check is then
 *   visible in the route table, which is where a reviewer looks for it;
 *
 *   `RestrictionService.assertAllowed`, for a check inside a larger operation, where
 *   only part of the work is restricted or the sub-feature depends on the request.
 *
 * Nothing in either path queries restrictions directly. That is the rule this file
 * exists to keep.
 */

export const RESTRICTED_FEATURE = 'restrictions:feature';

/** The feature (and optionally sub-feature) a route's caller must not be restricted on. */
export const RequiresFeature = (feature: string, subFeature: string | null = null): MethodDecorator =>
  SetMetadata(RESTRICTED_FEATURE, { feature, subFeature });

interface FeatureTarget {
  readonly feature: string;
  readonly subFeature: string | null;
}

@Injectable()
export class FeatureRestrictionGuard implements CanActivate {
  constructor(
    private readonly restrictions: RestrictionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const target = this.reflector.getAllAndOverride<FeatureTarget | undefined>(RESTRICTED_FEATURE, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Wearing the guard without naming a feature is a wiring mistake, and it fails
    // OPEN — so it must never be silent. It is not thrown, because turning a
    // developer's mistake into a 500 for a user is worse than letting the request
    // through with the misconfiguration visible in the route table; the matching
    // decorator is one line away and a test asserting the pair is the real defence.
    if (target === undefined) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    // Runs after the global `AuthGuard`, so a principal is present. A throw here means
    // this guard was put on a `@Public()` route, which is a wiring mistake rather than
    // a client error — the same reading `SuperAdminGuard` gives it.
    const principal = requirePrincipal(req);

    await this.restrictions.assertAllowed(principal.userId, target.feature, target.subFeature);
    return true;
  }
}
