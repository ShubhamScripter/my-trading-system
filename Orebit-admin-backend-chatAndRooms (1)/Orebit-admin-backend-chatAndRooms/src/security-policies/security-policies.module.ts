import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TwoFactorModule } from '../2fa/2fa.module';
import { SecurityPolicyController } from './security-policies.controller';
import { SecurityPolicyDbOperation } from './security-policies.dboperation';
import { SecurityPolicyRoutes } from './security-policies.routes';
import { SecurityPolicyService } from './security-policies.service';

/**
 * Configuring the platform's security-restriction policy.
 *
 * Imports `AuthModule` for `SuperAdminGuard` and `AuthEventDbOperation`, and
 * `TwoFactorModule` for `ElevationGuard` — Nest builds a route guard from the injector
 * of the module declaring the controller, so a guard this module's routes wear has to
 * be resolvable from here.
 *
 * This module owns no tables in THIS service's schema. Its persistence layer writes
 * `identity.*` by raw SQL — see `SecurityPolicyDbOperation`.
 */
@Module({
  imports: [AuthModule, TwoFactorModule],
  controllers: [SecurityPolicyRoutes],
  providers: [SecurityPolicyController, SecurityPolicyService, SecurityPolicyDbOperation],
})
export class SecurityPolicyModule {}
