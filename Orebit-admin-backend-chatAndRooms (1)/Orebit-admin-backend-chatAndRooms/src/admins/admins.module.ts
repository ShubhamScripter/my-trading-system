import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TwoFactorModule } from '../2fa/2fa.module';
import { AdminsController } from './admins.controller';
import { AdminsDbOperation } from './admins.dboperation';
import { AdminsRoutes } from './admins.routes';
import { AdminsService } from './admins.service';

/**
 * Nest's DI module for `src/admins/`.
 *
 * `imports: [AuthModule, TwoFactorModule]`:
 *
 *  - `AuthModule` for `SessionService`, because every action here revokes the
 *    target's sessions. Reused rather than reimplemented — revocation also seeds
 *    the Redis cache that `AuthGuard` reads, and a second implementation that
 *    forgot to would produce a revocation that does not take effect for fifteen
 *    minutes.
 *  - `TwoFactorModule` for `ElevationService`, so the ticket is spent by the same
 *    code that mints it. This is the first consumer of that export, and the reason
 *    it exists.
 *
 * Both dependencies run one way. Neither of those modules knows about this one, so
 * there is no cycle.
 *
 * Nothing is exported. This is a leaf, like `TwoFactorModule`: it consumes the
 * domain and nobody has a reason to call into administering admins.
 */
@Module({
  imports: [AuthModule, TwoFactorModule],
  controllers: [AdminsRoutes],
  providers: [AdminsController, AdminsService, AdminsDbOperation],
})
export class AdminsModule {}
