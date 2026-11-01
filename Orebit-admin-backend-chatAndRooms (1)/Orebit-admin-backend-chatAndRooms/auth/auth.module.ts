import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AUTH_DB_OPERATIONS } from './auth.dboperation';
import { AuthRoutes } from './auth.routes';
import { AUTH_SERVICES } from './auth.service';
import { BffSessionService } from './security/bff.session';
import { AuthGuard, OptionalAuthGuard, SuperAdminGuard } from './security/guards';

/**
 * Nest's DI module for `auth/`.
 *
 * Not one of the README's seven convention files — it is a framework requirement,
 * the same way `*.module.ts` is for every other Nest module here.
 *
 * The provider lists come from the two barrels rather than being spelled out
 * again, so adding a service or a dboperation is one edit in one file instead of
 * two that can disagree.
 *
 * `imports` is empty. Everything this module depends on from outside — Prisma,
 * Redis, Mail, Captcha — is provided by a `@Global()` module, so there is nothing
 * to declare and no chance of a cycle.
 *
 * The guards are providers because they inject `SessionService` and `Reflector` —
 * a guard is instantiated by the container, so it has to be registered somewhere
 * that can supply those.
 *
 * `AuthGuard` is exported for one consumer in particular: src/app.module.ts binds
 * it to `APP_GUARD` with `useExisting`, which makes it the default for every route
 * in the service and reuses this instance rather than building a second one.
 * `OptionalAuthGuard` is exported for the ordinary `@UseGuards` case.
 */
@Module({
  controllers: [AuthRoutes],
  providers: [
    AuthController,
    ...AUTH_SERVICES,
    ...AUTH_DB_OPERATIONS,
    // Not in AUTH_SERVICES: it lives in security/ alongside the guards, and like
    // them it is infrastructure for the credential boundary rather than a step in
    // the sign-in ceremony. The barrel's one-way dependency note is about that
    // ceremony, and adding a fifth entry there would blur it.
    BffSessionService,
    AuthGuard,
    OptionalAuthGuard,
    SuperAdminGuard,
  ],
  // The dboperations are exported for src/2fa/, which reuses `AdminDbOperation`
  // and `MfaDbOperation` rather than opening a second writer onto the same two
  // factor tables — the drift that mfa.dboperation.ts's own header warns about.
  //
  // `BffSessionService` is exported for the same module: `POST /2fa` is where the
  // sign-in ceremony completes, so it is where the browser's session record is
  // created.
  exports: [
    AuthGuard,
    OptionalAuthGuard,
    SuperAdminGuard,
    BffSessionService,
    ...AUTH_SERVICES,
    ...AUTH_DB_OPERATIONS,
  ],
})
export class AuthModule {}
