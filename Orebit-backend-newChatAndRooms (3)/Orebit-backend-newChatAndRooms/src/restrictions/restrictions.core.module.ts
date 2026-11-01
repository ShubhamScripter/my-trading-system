import { Module } from '@nestjs/common';
import { RestrictionDbOperation } from './restrictions.dboperation';
import { SecurityRestrictionRiskEvaluator } from './restrictions.evaluator';
import { RestrictionService } from './restrictions.enforcement';
import { FeatureRestrictionGuard } from './restrictions.guard';
import { SecurityRestrictionService } from './restrictions.service';
import { RestrictionPolicySnapshotService } from './restrictions.snapshot';
import { SessionDbOperation } from '../../auth/persistence/session.dboperation';

/**
 * ═══ THE HALF `auth` IS ALLOWED TO DEPEND ON ═══════════════════════════════
 *
 * The same split, for the same reason, as `src/2fa/2fa.core.module.ts`. There is a
 * dependency in each direction and neither is avoidable:
 *
 *   `auth` needs restrictions, because `POST /auth/password` is one of the eight
 *     trigger actions — the second password-change path, alongside
 *     `POST /settings/security/password`.
 *
 *   restrictions need `auth`, because the evaluator reads session history and the
 *     capture step reads the acting session row.
 *
 * One Nest module for both is a cycle, resolvable only with `forwardRef` — which
 * works and which makes the provider graph something a reader has to hold in their
 * head rather than read off the imports.
 *
 *     AuthModule      ──────▶ RestrictionsCoreModule   (this file)
 *     SettingsModule  ──────▶ RestrictionsCoreModule
 *     SettingsModule  ──────▶ AuthModule
 *
 * ─── How the cycle is actually avoided ────────────────────────────────────
 *
 * `SessionDbOperation` is provided HERE as well as by `AuthModule`, rather than
 * imported from it. It injects nothing but `PrismaService` (which `DbModule` provides
 * globally), so a second instance is a second object holding a pointer to the same
 * connection pool — not a second pool and not a second source of truth. That is what
 * keeps this module free of any `auth` IMPORT, which is the property
 * `2fa.core.module.ts` states as the invariant that makes the split honest:
 *
 *   "If a provider in this module ever needs an `auth` service injected, the split has
 *    been broken and the cycle is back."
 *
 * Types and pure functions from `auth` are still fine — `ipClassOf`, `Principal`,
 * `RESTRICTION` — and none of those creates an edge in the provider graph.
 */
@Module({
  providers: [
    SessionDbOperation,
    RestrictionDbOperation,
    RestrictionPolicySnapshotService,
    SecurityRestrictionRiskEvaluator,
    SecurityRestrictionService,
    RestrictionService,
    // A provider AND an export because it is worn by routes in other modules. Nest
    // builds a route guard from the injector of the module declaring the controller,
    // so a guard that is not exported here is a boot-time resolution failure rather
    // than a type error — the note `2fa.core.module.ts` makes about `ElevationGuard`.
    FeatureRestrictionGuard,
  ],
  exports: [
    RestrictionDbOperation,
    RestrictionPolicySnapshotService,
    SecurityRestrictionService,
    RestrictionService,
    FeatureRestrictionGuard,
  ],
})
export class RestrictionsCoreModule {}
