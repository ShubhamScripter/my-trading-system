import { Global, Module } from '@nestjs/common';
import { CaptchaProviderDbOperation } from './captcha.dboperation';
import { CaptchaService } from './captcha.service';
import { CaptchaSettingsService } from './captcha.settings';
import { CAPTCHA_VERIFIER } from './captcha.types';

/**
 * The production verifier binding. The service dispatches to the selected
 * provider's server-side siteverify endpoint; callers depend only on the port.
 *
 * No `imports`: `DbModule` and `RedisModule` are both `@Global()`.
 *
 * `CaptchaSettingsService` is not exported. Which providers are live is read
 * through `CAPTCHA_VERIFIER.describe()`, so there is exactly one way to ask.
 */
@Global()
@Module({
  providers: [
    CaptchaProviderDbOperation,
    CaptchaSettingsService,
    CaptchaService,
    { provide: CAPTCHA_VERIFIER, useExisting: CaptchaService },
  ],
  exports: [CAPTCHA_VERIFIER],
})
export class CaptchaModule {}
