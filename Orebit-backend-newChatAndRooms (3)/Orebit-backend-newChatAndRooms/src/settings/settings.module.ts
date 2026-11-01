import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { RestrictionsCoreModule } from '../restrictions/restrictions.core.module';
import { TwoFactorCoreModule } from '../2fa/2fa.core.module';
import { TwoFactorModule } from '../2fa/2fa.module';
import { AntiPhishingController } from './antiPhishing/antiPhishing.controller';
import { AntiPhishingRoutes } from './antiPhishing/antiPhishing.routes';
import { AntiPhishingService } from './antiPhishing/antiPhishing.service';
import { DeleteAccountController } from './delete-account/delete-account.controller';
import { DeleteAccountRoutes } from './delete-account/delete-account.routes';
import { DeleteAccountService } from './delete-account/delete-account.service';
import { AccountPurgeSweeper } from './delete-account/delete-account.sweeper';
import { PENDING_WITHDRAWALS_PORT } from './delete-account/delete-account.types';
import { NullPendingWithdrawalsProvider } from './delete-account/withdrawals.service';
import { EmailChangeController } from './email/email.controller';
import { EmailChangeRoutes } from './email/email.routes';
import { EmailChangeService } from './email/email.service';
import { NullKycProvider } from './kyc.service';
import { LinkAccountsController } from './link-accounts/link-accounts.controller';
import { LinkAccountsRoutes } from './link-accounts/link-accounts.routes';
import { LinkAccountsService } from './link-accounts/link-accounts.service';
import { SocialUnlinkSweeper } from './link-accounts/link-accounts.sweeper';
import { PasswordController } from './password/password.controller';
import { PasswordRoutes } from './password/password.routes';
import { PasswordSettingsService } from './password/password.service';
import { PaymentPinController } from './paymentPin/payment-pin.controller';
import { PaymentPinDbOperation } from './paymentPin/payment-pin.dboperation';
import { PaymentPinRoutes } from './paymentPin/payment-pin.routes';
import { PaymentPinService } from './paymentPin/payment-pin.service';
import { SettingsController } from './settings.controller';
import { SettingsRoutes } from './settings.routes';
import { SettingsService } from './settings.service';
import { KYC_PORT } from './settings.types';
import { NullPremiumProvider } from './username/premium.service';
import { UsernameComplianceService } from './username/username.compliance';
import { UsernameController } from './username/username.controller';
import { UsernameRoutes } from './username/username.routes';
import { UsernameService } from './username/username.service';
import { PREMIUM_PORT } from './username/username.types';

/**
 * Nest DI for `src/settings/`.
 *
 * ─── A leaf, and why that is worth stating ──────────────────────────────────
 *
 *     SettingsModule ──▶ AuthModule
 *     SettingsModule ──▶ TwoFactorModule ──▶ AuthModule
 *     SettingsModule ──▶ TwoFactorCoreModule
 *
 * Nothing imports this module, which is what keeps the graph acyclic without a
 * `forwardRef`. It composes and is not composed: settings depends on the mechanisms
 * (`TwoFactorService`) and on sessions (`SessionService`), while neither of those
 * has any reason to ask what a user's settings are. If an edge ever points back at
 * this module, that is the moment to check whether the policy has leaked downward
 * into the mechanism.
 *
 * `TwoFactorCoreModule` is imported alongside `TwoFactorModule` rather than relying
 * on the latter to re-export it: `TwoFactorModule` exports only `TwoFactorService`,
 * and `TwoFactorDbOperation` and `MfaService` come from the core module. Both edges
 * are declared so neither is an accident of what someone else happened to export.
 *
 * ─── Deliberately no `settings.dboperation.ts` ──────────────────────────────
 *
 * The README's seven-file convention has one, and its absence here is a decision
 * rather than an omission: this module owns no tables. The `passkey` and
 * `recoveryCode` rows it changes belong to `TwoFactorDbOperation`, which is the only
 * layer permitted to reach them, and re-providing Prisma access here would give the
 * process two access layers for one table — the same thing `AuthModule` avoids by
 * exporting its dboperations instead of letting `TwoFactorModule` re-provide
 * `UserDbOperation`.
 *
 * `paymentPin/payment-pin.dboperation.ts` is not an exception to that. The rule above
 * is about not becoming a SECOND access layer for somebody else's rows; `payment_pins`
 * is a table nothing outside that folder reaches, so its dboperation is the first and
 * only one. The module still owns no tables — the sub-feature owns exactly one.
 *
 * `email/` owns no table either, and deliberately: `retained_emails` is read by
 * `RegistrationService` as well, so it lives in `auth/persistence/` beside
 * `verification_challenges`, which has the same two-sided shape. See that file.
 *
 * ─── Three controllers on one prefix ────────────────────────────────────────
 *
 * `SettingsRoutes`, `PaymentPinRoutes` and `EmailChangeRoutes` all declare
 * `@Controller('settings')`, which Nest merges into one prefix. The split is containment
 * rather than decomposition: every line of a feature lives in its own directory, so it
 * reads, reviews and removes as one unit. All three are listed here and all three are in
 * `tests/auth/openapi.drift.spec.ts`, which is what stops a route from shipping
 * undocumented — a second class on an EXISTING prefix is invisible to a check that
 * enumerates prefixes rather than classes.
 *
 * ─── One thing worth knowing about `EmailChangeRoutes` ──────────────────────
 *
 * Two of its three routes are `@Public()`, which is unique in this module. The reason is
 * on the class itself: a completed email change sweeps every session, so the person who
 * needs the recovery flow is precisely the one who cannot authenticate. The
 * authentication for the non-recovery branches moves into the controller, per branch.
 *
 * `MailService` resolves because `MailModule` is `@Global()`, as do `CacheService`
 * and `QuotaService` from `RedisModule`. `PrismaService` resolves because `DbModule`
 * is `@Global()` too, and `CredentialService`, `SessionService`, `BlocklistService`,
 * `UserDbOperation` and `ChallengeDbOperation` because `AuthModule` exports them.
 */
@Module({
  imports: [AuthModule, TwoFactorModule, TwoFactorCoreModule, RestrictionsCoreModule],
  controllers: [
    SettingsRoutes,
    PaymentPinRoutes,
    EmailChangeRoutes,
    UsernameRoutes,
    PasswordRoutes,
    AntiPhishingRoutes,
    LinkAccountsRoutes,
    DeleteAccountRoutes,
  ],
  providers: [
    SettingsController,
    SettingsService,
    // The KYC capability does not exist yet, and this binding is the whole of what
    // changes when it does. See kyc.service.ts. Both the disable paths and the email
    // change read it through the same port.
    { provide: KYC_PORT, useClass: NullKycProvider },
    // The Payment PIN. A settings/security policy over the same mechanisms the two
    // factor surfaces use — see paymentPin/payment-pin.types.ts for why it is not a
    // third factor surface.
    PaymentPinController,
    PaymentPinService,
    PaymentPinDbOperation,
    // Changing the account's email, and recovering from a change that was not the
    // owner's doing. See email/email.types.ts.
    EmailChangeController,
    EmailChangeService,
    // Changing the account's username. A PROFILE setting rather than a security one —
    // see username/username.routes.ts for why that distinction is load-bearing and not
    // filing.
    //
    // `UsernameReservationDbOperation` is NOT provided here. It owns
    // `username_reservations`, which `UserDbOperation` reads too when it allocates a
    // username at signup, so it lives in auth/persistence/ and arrives through
    // `AuthModule`'s exports — the same two-sided shape that put `retained_emails`
    // there. Re-providing it would give the process two access layers for one table.
    UsernameController,
    UsernameService,
    // Premium does not exist yet, and this binding is the whole of what changes when it
    // does. See username/premium.service.ts. Both the length band and the expiry sweep
    // read it through the same port.
    { provide: PREMIUM_PORT, useClass: NullPremiumProvider },
    // The other half of the Premium rule: an entitlement that lapses leaves a username
    // shorter than a free account may hold, and this is what lengthens it without
    // waiting for the owner to open the screen.
    UsernameComplianceService,
    // The account password: set it, reset it knowing the current one, reset it without.
    // A settings/security policy over the same mechanisms the factor surfaces and the
    // Payment PIN use — see password/password.types.ts for why it belongs here rather
    // than in auth/, and what deliberately stays outside this folder.
    //
    // Named `PasswordSettingsService` rather than `PasswordService`: the latter is
    // `auth/services/password.service.ts`, which still serves the legacy
    // `POST /auth/password`. Two providers with one name in one injector is a wiring
    // bug waiting to happen, and the distinct name is what makes the delegation in
    // that file readable.
    PasswordController,
    PasswordSettingsService,
    // The anti-phishing code — the string printed in outbound mail so a reader can
    // recognise a genuine message. See antiPhishing/antiPhishing.types.ts for why it is
    // NOT a credential and why nothing may ever accept it as one.
    //
    // No dboperation, and that is the same rule `UsernameReservationDbOperation`
    // illustrates from the other side: the four sealed columns live on `users`, which
    // `UserDbOperation` owns and which every auth path reads, so the writes are three
    // methods there rather than a second access layer for that table here.
    AntiPhishingController,
    AntiPhishingService,
    // Attaching a social provider to an account that already exists, so it can be
    // used to sign in later. A settings/security policy over mechanisms that live
    // elsewhere: the second factors and the emailed code come from `src/2fa/`, and
    // the entire provider round trip from `OauthService`.
    //
    // No dboperation, and for the rule this module states twice already:
    // `oauth_links` is owned by `UserDbOperation`, which every auth path reads, so
    // the one read this feature needs is a method there rather than a second access
    // layer for that table here.
    //
    // Note what is NOT injected into `LinkAccountsService` — `SessionService` and
    // `BffSessionService`. A settings link must never mint a session, and leaving
    // the ports out is what makes that unreachable rather than merely uncalled.
    LinkAccountsController,
    LinkAccountsService,

    // The other half of the delayed unlink, and the only thing that completes one.
    // Listed here for `UsernameComplianceService`'s reason: it has no consumers — no
    // controller injects it — and is a provider purely so Nest constructs it and its
    // `OnApplicationBootstrap` runs. Remove this line and unlink requests are recorded
    // and never acted on, with nothing failing to say so.
    SocialUnlinkSweeper,

    // Ending the account, and bringing one back inside thirty days. A settings/security
    // policy over mechanisms that live elsewhere: the proof comes from `src/2fa/`, the
    // session sweep from `SessionService`, every row from `UserDbOperation`.
    //
    // No dboperation, for the rule this module states three times already: the columns
    // live on `users`, which `UserDbOperation` owns and which every auth path reads, so
    // the conditional updates are methods there rather than a second access layer here.
    //
    // Note what IS injected that `LinkAccountsService` deliberately refuses:
    // `SessionService`. That class omits it so minting a session is unreachable; this
    // one needs the opposite capability — it must END every session — and reaches for
    // `revokeAllForUser` alone. No path in it calls `issue`, and no handler on its
    // routes takes a `FastifyReply`, so a session cannot be minted there either.
    DeleteAccountController,
    DeleteAccountService,

    // The withdrawal subsystem does not exist — `src/wallet/` and `src/ledger/` are
    // zero-byte placeholders — and this binding is the whole of what changes when it
    // does. See delete-account/withdrawals.service.ts.
    //
    // The null provider answers `unavailable`, which is NOT `none`: it reports that
    // nobody can be asked about this account's funds, and must never be read as a
    // balance of zero. The Withdraw Funds API is a future task, and nothing in this
    // module withdraws, forfeits or records anything about funds.
    { provide: PENDING_WITHDRAWALS_PORT, useClass: NullPendingWithdrawalsProvider },

    // The other half of the delayed deletion, and the only thing that completes one.
    // Listed here for `SocialUnlinkSweeper`'s reason: it has no consumers — no
    // controller injects it — and is a provider purely so Nest constructs it and its
    // `OnApplicationBootstrap` runs. Remove this line and deletions are recorded and
    // never acted on, with nothing failing to say so: accounts would stay recoverable
    // for ever and no data would be erased.
    AccountPurgeSweeper,
  ],
})
export class SettingsModule {}
