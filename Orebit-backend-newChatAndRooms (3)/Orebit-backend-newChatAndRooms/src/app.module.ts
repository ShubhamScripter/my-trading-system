import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { TwoFactorModule } from './2fa/2fa.module';
import { AuthGuard } from '../auth/security/guards';
import { SafetyNetGuard } from '../auth/security/safety-net.guard';
import { DbModule } from '../db/client';
import { RedisModule } from '../redis';
import { AppRoutes } from './app.routes';
import { AppService } from './app.service';
import { CaptchaModule } from './captcha/captcha.module';
import { GeoModule } from './geo/geo.module';
import { MailModule } from './mail/mail.module';
import { SettingsModule } from './settings/settings.module';
import { SocialModule } from './social/social.module';

/**
 * The composition root. Every module the service runs is wired here and nowhere
 * else, so this file is the answer to "what is actually in this deployment".
 *
 * Import order reads as layers: infrastructure, then the cross-cutting adapters
 * the domain depends on, then the domain itself.
 */
@Module({
  imports: [
    // infrastructure
    DbModule,
    RedisModule,
    // cross-cutting adapters
    MailModule,
    CaptchaModule,
    GeoModule,
    // domain — AuthModule owns accounts as well as authentication; TwoFactorModule
    // owns the second factor and hangs its routes under the same `auth` prefix.
    // The two are the only domain modules here until wallet/earning/merchant/social
    // are built.
    //
    // TwoFactorModule imports AuthModule and AuthModule imports TwoFactorCoreModule
    // — one feature split across two Nest modules so the edge in each direction is
    // not a cycle. See src/2fa/2fa.core.module.ts.
    AuthModule,
    TwoFactorModule,
    // A leaf: it composes AuthModule and TwoFactorModule and nothing imports it.
    // Last, because it depends on both of the above — see src/settings/settings.module.ts.
    SettingsModule,
    SocialModule,
  ],
  controllers: [AppRoutes],
  providers: [
    AppService,
    // Authentication is the default for every route in the service, and opting out
    // is `@Public()` on the handler. Registered here rather than in AuthModule
    // because APP_GUARD is scoped to the module that declares it and this is the
    // composition root — the file that answers "what is actually in this
    // deployment" should also answer "what is protected in it".
    //
    // `useExisting` rather than `useClass`: AuthModule already builds an AuthGuard
    // with its SessionService, and a second instance would be a second Redis
    // consumer for no reason.
    // ORDER MATTERS, and Nest applies APP_GUARD providers in declaration order.
    //
    // The safety net runs FIRST, so a caller flooding the service with junk bearer
    // tokens is refused before it costs a signature verification — `AuthGuard` throws
    // 401, so a limiter placed after it would never see that traffic at all. It also
    // means the one ceiling covering routes nobody metered individually cannot be
    // skipped by a `@Public()` handler.
    { provide: APP_GUARD, useExisting: SafetyNetGuard },
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
})
export class AppModule {}
