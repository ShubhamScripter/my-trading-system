import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard } from '../auth/security/guards';
import { DbModule } from '../db/client';
import { RedisModule } from '../redis';
import { TwoFactorModule } from './2fa/2fa.module';
import { AdminsModule } from './admins/admins.module';
import { KycModule } from './kyc/kyc.module';
import { SecurityPolicyModule } from './security-policies/security-policies.module';
import { AppRoutes } from './app.routes';
import { AppService } from './app.service';
import { CaptchaModule } from './captcha/captcha.module';
import { CountryModule } from './country/country.module';
import { MailModule } from './mail/mail.module';
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
    // domain. The remaining admin surfaces (users, merchants, ledger review)
    // come after authentication, and each adds one row to ROUTE_GROUPS and one
    // import here.
    AuthModule,
    // Second-factor management for an admin who is already signed in. Imports
    // AuthModule, so it must come after it — Nest resolves this list in order.
    TwoFactorModule,
    // Administering OTHER admins: factor recovery, disable, enable. Imports both of
    // the above — SessionService to revoke the target's sessions, ElevationService
    // to spend the per-action proof — so it comes last.
    //
    // This is the only module whose writes are aimed at an account other than the
    // caller's own. It exists so that recovering an admin who lost their
    // authenticator is an audited API call rather than an UPDATE typed into a psql
    // prompt on production.
    AdminsModule,
    // Configuring the platform security-restriction policy. Imports AuthModule for
    // SuperAdminGuard and TwoFactorModule for ElevationGuard, so it comes last.
    SecurityPolicyModule,
    // The KYC control plane: policy configuration and administrative exemptions.
    // Imports AuthModule for SuperAdminGuard and TwoFactorModule for ElevationService,
    // so like SecurityPolicyModule it comes after both.
    //
    // It writes three tables in the `identity` schema that ../Orebit-backend owns and
    // enforces. There is no API or event bus between the two services — the shared
    // database IS the interface, the same arrangement SecurityPolicyModule uses.
    KycModule,
    // The country catalogue and its flag images. Imports AuthModule for
    // SuperAdminGuard, so it comes after it. Unlike every other module here it also
    // registers a Fastify plugin (@fastify/multipart) on init — see the note in
    // country.module.ts about the 64 KiB global body limit it works around.
    CountryModule,
    // Social chat room management, access control, cosmetics, moderation and broadcasts.
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
    // This matters more here than in a consumer backend: every future route in an
    // admin service is a privileged operation, so the failure mode of opt-in
    // guarding would be an unauthenticated door into platform administration.
    //
    // `useExisting` rather than `useClass`: AuthModule already builds an AuthGuard
    // with its SessionService, and a second instance would be a second Redis
    // consumer for no reason.
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
})
export class AppModule {}
