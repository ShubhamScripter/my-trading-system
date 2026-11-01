import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TwoFactorController } from './2fa.controller';
import { TwoFactorDbOperation } from './2fa.dboperation';
import { TwoFactorRoutes } from './2fa.routes';
import { TWO_FACTOR_SERVICES } from './2fa.service';
import { ElevationGuard } from './elevation';

/**
 * Nest's DI module for `src/2fa/`.
 *
 * `imports: [AuthModule]` — this module reuses `AdminDbOperation`,
 * `MfaDbOperation` and `CredentialService` rather than reimplementing password
 * checking, factor counting or TOTP sealing. The dependency runs one way only:
 * auth knows nothing about this module, so there is no cycle. If that ever needs
 * to reverse, the shared pieces move down into a module both import — not a
 * second copy.
 *
 * Everything else it needs — Prisma, Redis, Mail — comes from a `@Global()`
 * module and needs no declaration here.
 *
 * Nothing is exported. This is a leaf: it consumes the domain, and no other
 * module has a reason to call into second-factor management.
 */
@Module({
  imports: [AuthModule],
  controllers: [TwoFactorRoutes],
  providers: [TwoFactorController, TwoFactorDbOperation, ...TWO_FACTOR_SERVICES, ElevationGuard],
  // `ElevationGuard` and `ElevationService` are the export list's whole purpose:
  // every future mutating admin route wears the guard, so those modules import
  // this one. Nothing else here is anyone else's business.
  exports: [ElevationGuard, ...TWO_FACTOR_SERVICES],
})
export class TwoFactorModule {}
