import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { TwoFactorCoreModule } from './2fa.core.module';
import { TwoFactorController } from './2fa.controller';
import { TwoFactorRoutes } from './2fa.routes';
import { TwoFactorService } from './2fa.service';

/**
 * The route surface for `auth/2fa`.
 *
 * This is the half of the feature that MAY depend on `auth`, and does: completing a
 * ceremony means minting a session, and re-authentication means checking a password
 * against `CredentialService`. `TwoFactorCoreModule` is the half that may not — see
 * the note there for why one feature is two modules and what breaks if they are
 * merged.
 *
 *     AuthModule ──────────▶ TwoFactorCoreModule
 *     TwoFactorModule ─────▶ TwoFactorCoreModule
 *     TwoFactorModule ─────▶ AuthModule
 *
 * Acyclic, and readable off these two files. No `forwardRef` anywhere.
 */
@Module({
  imports: [TwoFactorCoreModule, AuthModule],
  controllers: [TwoFactorRoutes],
  providers: [TwoFactorController, TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
