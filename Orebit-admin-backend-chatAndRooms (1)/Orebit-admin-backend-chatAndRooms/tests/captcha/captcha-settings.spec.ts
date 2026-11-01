import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptchaService } from '../../src/captcha/captcha.service';
import { CaptchaSettingsService } from '../../src/captcha/captcha.settings';

/**
 * ═══ THE DATABASE MAY NARROW THE PROVIDER LIST. IT MAY NEVER EMPTY IT ═══════
 *
 * An operator can take a captcha provider out of rotation with one SQL statement,
 * and both backends honour it without a redeploy. Everything that can go wrong with
 * that — a bad row, a typo, a failed query, a table that does not exist yet, a
 * revoked SELECT, an operator who disables all four — has to land on the SAME safe
 * answer, which is the env set this service started with.
 *
 * ─── Why the config module is doubled ──────────────────────────────────────
 *
 * tests/setup.ts sets no `CAPTCHA_<PROVIDER>_SECRET`, so the real
 * `config.captchaProviders` is empty and every assertion below would pass
 * vacuously against it — "narrowed to nothing" and "was nothing to begin with"
 * would be the same observation. The double gives this file an env set with
 * something in it to narrow. Same `vi.hoisted` + `vi.mock` shape as
 * tests/mail/mail.service.spec.ts, and for the same reason: it must be in place
 * before the module under test imports config.
 */

interface Option {
  readonly provider: string;
  readonly siteKey: string;
}

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    captchaEnabled: true,
    // In `CAPTCHA_PROVIDERS` order, which the service must preserve — a page
    // rendering "the first one" should get the same provider across restarts.
    // Mutable so a test can shrink it to the no-provider deployment.
    captchaProviders: [
      { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
      { provider: 'RECAPTCHA_V2', siteKey: 'site-v2' },
      { provider: 'RECAPTCHA_V3', siteKey: 'site-v3' },
      { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
    ] as Option[],
  },
}));

vi.mock('../../src/config', () => ({ config: mockConfig }));

const TURNSTILE: Option = { provider: 'TURNSTILE', siteKey: 'site-turnstile' };
const ENV_SET: readonly Option[] = [...mockConfig.captchaProviders];
const ALL = ENV_SET.map((option) => option.provider);

/** The dboperation's only method, answering however a test tells it to. */
function makeDb(disabled: readonly string[] | Error) {
  return {
    disabled:
      disabled instanceof Error
        ? vi.fn().mockRejectedValue(disabled)
        : vi.fn().mockResolvedValue(disabled),
  };
}

function makeSettings(disabled: readonly string[] | Error): CaptchaSettingsService {
  return new CaptchaSettingsService(makeDb(disabled) as never);
}

function providersOf(settings: CaptchaSettingsService): string[] {
  return settings.live().map((option) => option.provider);
}

beforeEach(() => {
  // The double is module-level state shared by every test in this file, so both
  // fields are restored rather than only the one a given test touched.
  mockConfig.captchaEnabled = true;
  mockConfig.captchaProviders = [...ENV_SET];
  vi.restoreAllMocks();
});

describe('before any refresh has run', () => {
  it('already answers with the full env set', () => {
    // There is deliberately no "not loaded yet" state. `onModuleInit` is async and
    // Nest resolves providers before it completes, so a null-until-loaded snapshot
    // would put a window at boot in which the login page could be told there are no
    // providers at all.
    expect(providersOf(makeSettings([]))).toEqual(ALL);
  });
});

describe('an absent row means enabled', () => {
  it('returns the full env set when nothing is disabled', async () => {
    const settings = makeSettings([]);
    await settings.refresh();

    expect(providersOf(settings)).toEqual(ALL);
  });

  it('drops exactly the disabled provider, preserving order', async () => {
    const settings = makeSettings(['RECAPTCHA_V2']);
    await settings.refresh();

    expect(providersOf(settings)).toEqual(['TURNSTILE', 'RECAPTCHA_V3', 'HCAPTCHA']);
  });

  it('keeps the site key alongside each surviving provider', async () => {
    const settings = makeSettings(['TURNSTILE']);
    await settings.refresh();

    // The list is filtered, never rebuilt: a provider that loses its site key on the
    // way through would mount no widget in the browser.
    expect(settings.live()).toEqual([
      { provider: 'RECAPTCHA_V2', siteKey: 'site-v2' },
      { provider: 'RECAPTCHA_V3', siteKey: 'site-v3' },
      { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
    ]);
  });
});

describe('a database we cannot read', () => {
  it('retains the previous snapshot when the query throws', async () => {
    const settings = makeSettings(new Error('relation "admin_captcha_providers" does not exist'));
    await settings.refresh();

    // The missing table, the revoked SELECT and the dead database are one case, and
    // this is it: the snapshot is untouched, which on the first run is the env set.
    expect(providersOf(settings)).toEqual(ALL);
  });

  it('does not let a later failure undo an earlier success', async () => {
    const db = { disabled: vi.fn().mockResolvedValueOnce(['HCAPTCHA']) };
    const settings = new CaptchaSettingsService(db as never);
    await settings.refresh();
    expect(providersOf(settings)).toEqual(['TURNSTILE', 'RECAPTCHA_V2', 'RECAPTCHA_V3']);

    db.disabled.mockRejectedValueOnce(new Error('connection terminated'));
    await settings.refresh();

    // Still narrowed. A blip must not silently re-enable a provider an operator
    // turned off — that direction is the one nobody would notice.
    expect(providersOf(settings)).toEqual(['TURNSTILE', 'RECAPTCHA_V2', 'RECAPTCHA_V3']);
  });
});

describe('rows that name no known provider', () => {
  it('ignores them and warns', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);
    const settings = makeSettings(['NOT_A_PROVIDER', 'turnstile', 'HCAPTCHA']);
    await settings.refresh();

    // `turnstile` lower-case is a typo, not a match: the column is free text, so the
    // comparison is exact and TURNSTILE stays live.
    expect(providersOf(settings)).toEqual(['TURNSTILE', 'RECAPTCHA_V2', 'RECAPTCHA_V3']);
    expect(warn).toHaveBeenCalledWith(
      { unknown: ['NOT_A_PROVIDER', 'turnstile'] },
      expect.stringContaining('no known provider'),
    );
  });
});

describe('the anti-lockout rule', () => {
  it('refuses to narrow to empty, and says so at error level', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    const settings = makeSettings(ALL);
    await settings.refresh();

    // ═══ IF THIS EVER RETURNS [] THE CHANGE IS WRONG ═════════════════════════
    //
    // An empty set here takes away every captcha the login page could render, so no
    // admin can sign in — including whoever would have to sign in to write the row
    // that undid it. A database row must not be able to do that.
    expect(providersOf(settings)).toEqual(ALL);
    expect(error).toHaveBeenCalledWith(
      { disabled: ALL },
      expect.stringContaining('lock out every admin'),
    );
  });

  it('leaves a deployment with no provider configured alone', async () => {
    // Not the same case, and must not log an error. A development machine with no
    // secrets has nothing to narrow, and `captchaEnabled` is already false there.
    const error = vi.spyOn(Logger.prototype, 'error').mockReturnValue(undefined);
    mockConfig.captchaProviders = [];

    const settings = new CaptchaSettingsService(makeDb([]) as never);
    await settings.refresh();

    expect(settings.live()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('describe()', () => {
  /** The verifier, with a snapshot that answers however the test says. */
  function makeService(providers: readonly Option[]) {
    const settings = { live: vi.fn().mockReturnValue(providers) };
    return new CaptchaService({} as never, settings as never);
  }

  it('reports the snapshot as the provider list', () => {
    expect(makeService([TURNSTILE]).describe().providers).toEqual([TURNSTILE]);
  });

  it('takes `enabled` from config and NEVER from the list length', () => {
    // ═══ THE LINE THAT WOULD BE A CAPTCHA BYPASS ═════════════════════════════
    //
    // `enabled: providers.length > 0` reads as an obvious simplification and is not
    // one. `verify` skips verification entirely when this is false, so deriving it
    // from a DB-backed list means a bad row or a failed query turns captcha OFF on
    // the public login route. Env answers "does verification run"; the database
    // only ever answers "which providers are offered".
    expect(makeService([]).describe()).toEqual({ enabled: true, providers: [] });

    mockConfig.captchaEnabled = false;
    expect(makeService([TURNSTILE]).describe().enabled).toBe(false);
  });
});

describe('the refresh timer', () => {
  it('reads once at init and does not hold the process open', async () => {
    const db = makeDb([]);
    const settings = new CaptchaSettingsService(db as never);

    await settings.onModuleInit();
    expect(db.disabled).toHaveBeenCalledTimes(1);

    // `unref`'d, so vitest can exit. Asserted through the handle rather than by
    // waiting out five minutes.
    const timer = (settings as unknown as { refreshTimer: NodeJS.Timeout }).refreshTimer;
    expect(timer.hasRef()).toBe(false);

    settings.onModuleDestroy();
    expect((settings as unknown as { refreshTimer: unknown }).refreshTimer).toBeNull();
  });

  it('boots even when the first read fails', async () => {
    const settings = makeSettings(new Error('ECONNREFUSED'));

    // Must not reject: a table this service can live without must never be able to
    // stop the service from starting.
    await expect(settings.onModuleInit()).resolves.toBeUndefined();
    expect(providersOf(settings)).toEqual(ALL);

    settings.onModuleDestroy();
  });
});
