import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { SettingsRoutes } from '../src/settings/settings.routes';
import { SettingsService } from '../src/settings/settings.service';
import { TwoFactorService } from '../src/2fa/2fa.service';
import { ElevationGuard } from '../src/2fa/elevation';
import { DeleteAccountService } from '../src/settings/delete-account/delete-account.service';
import { AccountPurgeSweeper } from '../src/settings/delete-account/delete-account.sweeper';
import { PENDING_WITHDRAWALS_PORT } from '../src/settings/delete-account/delete-account.types';

/**
 * ═══ THE PROVIDER GRAPH MUST RESOLVE ════════════════════════════════════════
 *
 * A missing or unexported provider is not a type error. Nest builds the injector at
 * boot, so the failure mode is a process that compiles, passes every unit suite, and
 * then dies on startup — which is the one class of defect this repository's comments
 * warn about repeatedly and nothing checked. `2fa.core.module.ts` says it outright
 * about `ElevationGuard`: "a guard that is not exported here is a runtime resolution
 * failure at boot rather than a type error."
 *
 * `compile()` builds the injector and instantiates every provider WITHOUT running
 * lifecycle hooks, so nothing connects to Postgres, Redis or SMTP. That is what makes
 * this affordable to run in the unit suite: it is the real composition root, and it
 * costs milliseconds.
 *
 * Note that importing the modules individually is NOT equivalent. `DbModule`,
 * `RedisModule`, `MailModule`, `CaptchaModule` and `GeoModule` are `@Global()`, and a
 * global module still has to be imported once for its providers to be registered
 * anywhere — so a narrower test fails for reasons that say nothing about the module
 * under test. The composition root is the only honest subject.
 */
describe('AppModule', () => {
  it('resolves every provider in the real composition root', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // Spot the providers whose wiring is load-bearing and non-obvious rather than
    // enumerating all of them: `compile()` has already instantiated the whole graph,
    // so reaching this line at all is the assertion. These name the edges a reader
    // would most want to know are real.
    expect(moduleRef.get(SettingsService)).toBeInstanceOf(SettingsService);
    expect(moduleRef.get(SettingsRoutes)).toBeInstanceOf(SettingsRoutes);
    expect(moduleRef.get(TwoFactorService)).toBeInstanceOf(TwoFactorService);
    // Provided AND exported by TwoFactorCoreModule because routes in other modules
    // wear it; a guard resolved from the wrong injector fails at boot.
    expect(moduleRef.get(ElevationGuard)).toBeInstanceOf(ElevationGuard);

    // Delete account. Three non-obvious edges in one feature: it injects a DI TOKEN
    // rather than a class (`PENDING_WITHDRAWALS_PORT`, bound to the null provider), it
    // is the only settings service that takes `SessionService`, and the sweeper has no
    // consumers at all — it is a provider purely so Nest constructs it and its
    // `OnApplicationBootstrap` runs. A token left unbound and a sweeper left out of the
    // providers array are both silent: the first dies at boot, the second never fails,
    // it simply means no deleted account is ever erased.
    expect(moduleRef.get(DeleteAccountService)).toBeInstanceOf(DeleteAccountService);
    expect(moduleRef.get(AccountPurgeSweeper)).toBeInstanceOf(AccountPurgeSweeper);
    expect(moduleRef.get(PENDING_WITHDRAWALS_PORT)).toBeDefined();

    await moduleRef.close();
  }, 30_000);
});
