import { Module } from '@nestjs/common';
import { TwoFactorCoreModule } from '../src/2fa/2fa.core.module';
import { AuthController } from './auth.controller';
import { AUTH_DB_OPERATIONS } from './auth.dboperation';
import { AuthRoutes } from './auth.routes';
import { AUTH_SERVICES } from './auth.service';
import { MailUndoRegistrar } from './mail-undo.registrar';
import { RecentSecurityChangePolicy } from './services/recent-security-change.policy';
import { OAUTH_PROVIDERS } from './oauth';
import { BffSessionService } from './security/bff.session';
import { AuthGuard, OptionalAuthGuard } from './security/guards';
import { RestrictionsCoreModule } from '../src/restrictions/restrictions.core.module';
import { SafetyNetGuard } from './security/safety-net.guard';

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
 * `imports` carries exactly one entry, and its shape is the interesting part. This
 * module used to carry `forwardRef(() => UserModule)` against a `UserModule` that
 * carried `forwardRef(() => AuthModule)` back — a genuine cycle, and one that
 * existed only because accounts and authentication were two folders describing one
 * concern. Accounts now live in `services/user.service.ts` and
 * `persistence/user.dboperation.ts`, so there is no second module to point at.
 * `UserService`'s own dependency on `MailService` resolves because `MailModule` is
 * `@Global()`.
 *
 * `TwoFactorCoreModule` is imported WITHOUT a `forwardRef`, and that is deliberate
 * rather than lucky. The 2FA feature genuinely needs an edge in each direction —
 * login must ask whether an account owes a factor, and the verify route must mint a
 * session — so it is split into two Nest modules living in one folder. This one
 * provides `MfaService` and depends on nothing here; `TwoFactorModule`, the route
 * surface, is what imports `AuthModule`. See src/2fa/2fa.core.module.ts. If a
 * `forwardRef` ever appears on this line, that split has been broken.
 *
 * The guards are providers because they inject `SessionService` and `Reflector` —
 * a guard is instantiated by the container, so it has to be registered somewhere
 * that can supply those.
 *
 * `AuthGuard` is exported for one consumer in particular: src/app.module.ts binds
 * it to `APP_GUARD` with `useExisting`, which makes it the default for every route
 * in the service and reuses this instance rather than building a second one.
 * `OptionalAuthGuard` is exported for the ordinary `@UseGuards` case.
 *
 * `OAUTH_PROVIDERS` carries the five provider adapters and the registry that
 * resolves one. Deliberately NOT exported: `OauthService` is the only thing that
 * may reach an adapter, because it is where the shared controls live — the
 * single-use state, the PKCE verifier, the IP-class binding, the blocklist and the
 * second factor. A consumer holding an adapter directly could verify a provider
 * callback with none of them, which is the one way this feature can be got wrong
 * from outside. See auth/oauth/provider.port.ts.
 */
@Module({
  imports: [TwoFactorCoreModule, RestrictionsCoreModule],
  controllers: [AuthRoutes],
  providers: [
    AuthController,
    ...AUTH_SERVICES,
    ...AUTH_DB_OPERATIONS,
    ...OAUTH_PROVIDERS,
    // Registered here rather than in `AUTH_SERVICES`, deliberately: that barrel is
    // the module's FLOWS, and its own spec asserts every `*Service` under
    // `services/` appears in it. This is a boot-time provider that teaches the mail
    // worker how to undo a registration's charged OTP send — not a flow, and not a
    // service. See auth/mail-undo.registrar.ts.
    MailUndoRegistrar,
    // Registered by name for `MailUndoRegistrar`'s reason: `AUTH_SERVICES` is asserted
    // to be exactly the `*Service` classes under `services/` (see the spec), and this
    // is a POLICY — one rule, no flow, no state. It sits under `services/` beside
    // `otp-mail.charge.ts`, which is the existing precedent for a non-service file
    // there.
    //
    // Exported below because the freeze has to hold on every surface that can change a
    // protected setting, and three of the five live outside this module —
    // `SettingsService`, `PaymentPinService` and `TwoFactorService`. Both of their
    // modules already import `AuthModule`, so exporting it here is the whole of the
    // wiring: no new module, no new edge in the graph.
    RecentSecurityChangePolicy,
    // Under `security/` rather than `services/` for the same reason the guards are:
    // `AUTH_SERVICES` is asserted to be exactly the `*Service` classes under
    // `services/`, and this one is a credential mechanism sitting next to the cookie
    // and the JWT it exists between — not a flow.
    //
    // Exported because both session-minting sites need it: this module's controller,
    // and `TwoFactorController` in src/2fa, which completes a sign-in ceremony.
    BffSessionService,
    AuthGuard,
    OptionalAuthGuard,
    SafetyNetGuard,
  ],
  // The dboperations are exported alongside the services because `TwoFactorModule`
  // needs `UserDbOperation` to read the account behind a principal, and re-providing
  // it there would give the process two instances of one table's access layer.
  exports: [
    AuthGuard,
    OptionalAuthGuard,
    SafetyNetGuard,
    BffSessionService,
    RecentSecurityChangePolicy,
    ...AUTH_SERVICES,
    ...AUTH_DB_OPERATIONS,
  ],
})
export class AuthModule {}
