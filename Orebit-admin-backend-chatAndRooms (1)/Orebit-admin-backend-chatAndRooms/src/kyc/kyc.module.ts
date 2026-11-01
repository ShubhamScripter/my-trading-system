import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { KycEntitlementController } from './kyc-entitlement.controller';
import { KycEntitlementDbOperation } from './kyc-entitlement.dboperation';
import { KycEntitlementRoutes } from './kyc-entitlement.routes';
import { KycEntitlementService } from './kyc-entitlement.service';
import { KycExemptionController } from './kyc-exemption.controller';
import { KycExemptionDbOperation } from './kyc-exemption.dboperation';
import { KycExemptionRoutes } from './kyc-exemption.routes';
import { KycExemptionService } from './kyc-exemption.service';
import { KycPolicyController } from './kyc-policy.controller';
import { KycPolicyDbOperation } from './kyc-policy.dboperation';
import { KycPolicyRoutes } from './kyc-policy.routes';
import { KycHistoryController } from './kyc-history.controller';
import { KycHistoryDbOperation } from './kyc-history.dboperation';
import { KycHistoryRoutes } from './kyc-history.routes';
import { KycHistoryService } from './kyc-history.service';
import { KycPolicyService } from './kyc-policy.service';
import { KycRenewalController } from './kyc-renewal.controller';
import { KycRenewalDbOperation } from './kyc-renewal.dboperation';
import { KycRenewalRoutes } from './kyc-renewal.routes';
import { KycRenewalService } from './kyc-renewal.service';
import { KycRequirementController } from './kyc-requirement.controller';
import { KycRequirementDbOperation } from './kyc-requirement.dboperation';
import { KycRequirementRoutes } from './kyc-requirement.routes';
import { KycRequirementService } from './kyc-requirement.service';

/**
 * The Admin KYC control plane.
 *
 * ─── Two controllers, one module ────────────────────────────────────────────
 *
 * Policy, the global renewal periods, and exemptions keep separate prefixes because
 * they target different things — a policy targets a region and level, the renewal
 * periods target the whole platform, an exemption targets one user — but they share one
 * module so the whole admin KYC surface is one directory to read, review or remove.
 * Nest is happy with two controllers on one module; `ROUTE_GROUPS` keys on the
 * controller prefix, so both still get their own row.
 *
 * ─── Why `AuthModule` is imported ───────────────────────────────────────────
 *
 * Nest builds a route guard from the injector of the module DECLARING the controller,
 * so a guard these routes wear has to be resolvable from here: `AuthModule` supplies
 * `SuperAdminGuard` and `AuthEventDbOperation`. `PrismaService` arrives transitively
 * through it.
 *
 * `TwoFactorModule` is deliberately NOT imported. It would only be needed for
 * `ElevationService`, and the elevation check on these writes is deferred to a later
 * phase — see `KycPolicyController` and `KycExemptionController`. Add it back when
 * that phase lands; an import for a dependency nothing injects is an edge in the
 * graph that reads as a requirement and is not one.
 *
 * ─── What this module writes, and what it must never write ──────────────────
 *
 * It writes `identity.kyc_policies` and `identity.kyc_policy_versions`
 * (configuration), `identity.kyc_renewal_settings` (the global validity periods),
 * `identity.kyc_exemptions` (administrative relief), `identity.kyc_requirements`
 * (manually imposed obligations), and — as of the entitlements surface —
 * `identity.kyc_level_entitlements` (what each level GRANTS) and
 * `identity.kyc_upgrade_requirements` (what reaching a level takes).
 *
 * The two entitlement tables sit firmly on the CONFIGURATION side of the line drawn
 * below: they target a level, never an account, and nothing on that surface carries a
 * `userId` at all. `identity.kyc_upgrade_achievements` is the one KYC table this module
 * READS without writing — a count, so an operator changing a threshold can see how many
 * accounts already cleared the old one. It is an observation of a balance, only the
 * consumer can make one, and an admin able to grant one could open an upgrade route
 * nobody earned.
 *
 * ═══ THE LINE IS CREDENTIALS VERSUS OBLIGATIONS, NOT ADMIN VERSUS CONSUMER ══
 *
 * This module used to say it never wrote `kyc_requirements`, on the reasoning that an
 * obligation is "a consequence of something an account did". That reasoning also said
 * an admin imposing one "would be a different feature with different rules" — and that
 * is what `/kyc-requirements` is. The boundary has been redrawn deliberately, not
 * eroded, and it now sits where the actual danger is:
 *
 *   CREDENTIALS — what an account PROVED. `kyc_verifications`, `kyc_level_states`,
 *     `kyc_verification_devices`, `kyc_provider_events`. This module has no statement
 *     that touches any of them and must never gain one. An admin surface able to edit
 *     these could manufacture a verification nobody performed, which is the one thing
 *     a compliance trail cannot survive.
 *
 *   OBLIGATIONS AND RELIEF — what an account OWES, and what it has been let off.
 *     `kyc_requirements` and `kyc_exemptions`. Both are administrable, because both
 *     are human decisions by nature, and both are audited per verb.
 *
 * `kyc_requirements` stays an OBLIGATION table under that split. Nothing reads a row
 * in it as evidence of standing; the consumer reads it only as something owed, and
 * closes a row when an approved verification discharges it.
 *
 * Note the two administrable writes point in opposite directions, and the safer one is
 * the new one: an exemption RAISES an account's effective level platform-wide with no
 * provider involved, while a requirement only ever WITHHOLDS standing.
 *
 * ─── What this module still decides nothing about ──────────────────────────
 *
 * Whether a recorded obligation currently BITES. `evaluate` in the consumer filters
 * open requirements against the account's effective level, and that calculation —
 * credentials, exemptions, renewal clocks, the ladder, supersession — exists in
 * exactly one place. Nothing here reads `kyc_level_states`, `kyc_exemptions` or
 * `kyc_renewal_settings` to second-guess it.
 *
 * ─── No exports ─────────────────────────────────────────────────────────────
 *
 * Nothing outside consumes this module, and nothing should: the enforcement half of
 * KYC lives in the other service and reads these tables directly from Postgres.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    KycPolicyRoutes,
    KycRenewalRoutes,
    KycHistoryRoutes,
    KycExemptionRoutes,
    KycRequirementRoutes,
    KycEntitlementRoutes,
  ],
  providers: [
    KycPolicyController,
    KycPolicyService,
    KycPolicyDbOperation,
    KycRenewalController,
    KycRenewalService,
    KycRenewalDbOperation,
    KycHistoryController,
    KycHistoryService,
    KycHistoryDbOperation,
    KycExemptionController,
    KycExemptionService,
    KycExemptionDbOperation,
    KycRequirementController,
    KycRequirementService,
    KycRequirementDbOperation,
    KycEntitlementController,
    KycEntitlementService,
    KycEntitlementDbOperation,
  ],
})
export class KycModule {}
