import { Module } from '@nestjs/common';
import { TwoFactorDbOperation } from './2fa.dboperation';
import { ElevationGuard, ElevationService } from './elevation';
import { MfaService } from './mfa.service';

/**
 * The half of the 2FA module that `auth` is allowed to depend on.
 *
 * ─── Why this is split from `TwoFactorModule` ───────────────────────────────
 *
 * The feature has a dependency in each direction and neither is avoidable:
 *
 *   `auth` needs 2FA, because every login path has to ask "does this account owe a
 *   second factor?" before it mints a session. That is the entire enforcement.
 *
 *   2FA needs `auth`, because `POST /auth/2fa/verify` completes a sign-in, and
 *   minting a session means `SessionService`.
 *
 * Put both in one Nest module and that is a cycle, resolvable only with
 * `forwardRef` — which works, and which makes the provider graph something a reader
 * has to hold in their head rather than read off the imports.
 *
 * Splitting instead makes the graph acyclic and honest:
 *
 *     AuthModule ──────────────▶ TwoFactorCoreModule   (this file)
 *     TwoFactorModule ─────────▶ TwoFactorCoreModule
 *     TwoFactorModule ─────────▶ AuthModule
 *
 * Nothing here imports anything from `auth` that is not a pure function or a type,
 * which is the property that keeps it true. If a provider in this module ever needs
 * an `auth` service injected, the split has been broken and the cycle is back.
 */
@Module({
  // `ElevationGuard` is a provider AND an export because it is worn by routes in
  // other modules — `POST /auth/link` today. Nest builds a route guard from the
  // injector of the module declaring the controller, so a guard that is not
  // exported here is a runtime resolution failure at boot rather than a type error.
  providers: [TwoFactorDbOperation, MfaService, ElevationService, ElevationGuard],
  exports: [TwoFactorDbOperation, MfaService, ElevationService, ElevationGuard],
})
export class TwoFactorCoreModule {}
