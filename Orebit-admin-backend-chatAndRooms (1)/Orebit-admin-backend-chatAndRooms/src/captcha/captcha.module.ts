import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CaptchaAdminController } from './captcha.controller';
import { CaptchaProviderDbOperation } from './captcha.dboperation';
import { CaptchaRoutes } from './captcha.routes';
import { CaptchaService } from './captcha.service';
import { CaptchaSettingsService } from './captcha.settings';
import { CAPTCHA_VERIFIER } from './captcha.types';

/**
 * The production verifier binding, plus the operator surface that decides which
 * providers it will accept.
 *
 * ─── The imports ───────────────────────────────────────────────────────────
 *
 * `AuthModule`, for `SuperAdminGuard` — so the role is checked by the same code that
 * reads an admin everywhere else rather than a second copy of the rule.
 *
 * `TwoFactorModule` was here too, for `ElevationGuard`, until the elevation
 * requirement on the toggle was dropped as a product decision — see the note on
 * `CaptchaRoutes.toggle`. Restoring it means importing that module again.
 *
 * The dependency runs one way. `AuthModule` does not know about this one — it
 * reaches the verifier through the `@Global()` binding below, not through an import
 * — so there is no cycle. `DbModule` and `RedisModule` are global too.
 *
 * ─── Why this stays `@Global()` now that it has controllers ────────────────
 *
 * The export is still only `CAPTCHA_VERIFIER`, and it is global because `auth/`
 * consumes it without importing this module. Controllers are unaffected by
 * globality — Nest registers them from `controllers` either way.
 *
 * `CaptchaSettingsService` is deliberately NOT exported. The snapshot is read
 * through the verifier's `describe()` and written through this module's own route,
 * so there is exactly one way in from outside and no second place for the `enabled`
 * flag to be derived wrongly.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CaptchaRoutes],
  providers: [
    CaptchaProviderDbOperation,
    CaptchaSettingsService,
    CaptchaAdminController,
    CaptchaService,
    { provide: CAPTCHA_VERIFIER, useExisting: CaptchaService },
  ],
  exports: [CAPTCHA_VERIFIER],
})
export class CaptchaModule {}
