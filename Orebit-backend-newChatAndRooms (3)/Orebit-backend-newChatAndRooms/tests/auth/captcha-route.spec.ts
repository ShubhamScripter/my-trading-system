import { describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import { AuthRoutes } from '../../auth/auth.routes';
import { CaptchaService } from '../../src/captcha/captcha.service';
import { CaptchaSettingsService } from '../../src/captcha/captcha.settings';

/**
 * ═══ GET /auth/captcha ══════════════════════════════════════════════════════
 *
 * The read a page makes BEFORE it can build any captcha-bearing request. Two
 * properties, and both are load-bearing:
 *
 *   it must be PUBLIC — guarding it makes sign-in and registration unreachable;
 *   it must reflect the DATABASE — otherwise disabling a provider still needs a
 *   frontend deploy, which is the whole point of the toggle table.
 *
 * The second is asserted through the real chain — dboperation to settings to
 * verifier to controller to payload — with only the database itself doubled, so a
 * break anywhere along it fails here rather than in production.
 */

/**
 * tests/setup.ts configures no captcha secrets, so the real
 * `config.captchaProviders` is empty and there would be nothing to narrow.
 *
 * Only that ONE field is overridden, and the rest of config is passed through with
 * `importActual`. Replacing the module wholesale does not work here: importing
 * `AuthController` pulls in session.service -> jwt.ts, which reads
 * `config.JWT_PRIVATE_KEY` at module load and refuses to load without a real one.
 */
const { envProviders } = vi.hoisted(() => ({
  envProviders: [
    { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
    { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
  ],
}));

vi.mock('../../src/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/config')>('../../src/config');
  return { ...actual, config: { ...actual.config, captchaProviders: envProviders } };
});

/** The whole chain, with a doubled `admin.admin_captcha_providers`. */
async function readCaptchaRoute(disabled: readonly string[] | Error) {
  const db = {
    disabled:
      disabled instanceof Error
        ? vi.fn().mockRejectedValue(disabled)
        : vi.fn().mockResolvedValue(disabled),
  };
  const settings = new CaptchaSettingsService(db as never);
  await settings.refresh();

  const verifier = new CaptchaService({} as never, settings);
  // Only `captcha` is reached by this handler; the other seven collaborators are not
  // touched, and passing doubles for them keeps this a unit test rather than a
  // reason to stand up a database.
  const controller = new AuthController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    verifier,
  );

  return new AuthRoutes(controller).captcha();
}

describe('the route is public', () => {
  it('carries the same public marker as POST /auth/login', () => {
    // `IS_PUBLIC` is a module-private Symbol in security/guards.ts, so it is read
    // off a route already known to be public rather than imported. That is the
    // stronger assertion anyway: this route is public in exactly the way login is.
    const publicKey = Reflect.getMetadataKeys(AuthRoutes.prototype.login).find(
      (key) => typeof key === 'symbol' && key.description === 'isPublic',
    );
    expect(publicKey, 'POST /auth/login is no longer marked @Public()').toBeDefined();

    // Forget `@Public()` here and the global AuthGuard 401s an anonymous page
    // before it can read which widget to mount — sign-in and registration both
    // become unreachable, and the failure looks like a captcha problem.
    expect(Reflect.getMetadata(publicKey as symbol, AuthRoutes.prototype.captcha)).toBe(true);
  });
});

describe('the payload', () => {
  it('lists the env set when nothing is disabled', async () => {
    expect(await readCaptchaRoute([])).toEqual({
      data: {
        enabled: true,
        providers: [
          { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
          { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
        ],
      },
    });
  });

  it('drops a provider an operator disabled in the database', async () => {
    // The requirement in one assertion: a row written in psql, no redeploy, and the
    // page stops being offered a provider it can no longer use.
    expect(await readCaptchaRoute(['HCAPTCHA'])).toEqual({
      data: {
        enabled: true,
        providers: [{ provider: 'TURNSTILE', siteKey: 'site-turnstile' }],
      },
    });
  });

  it('serves the full env set when the database cannot be read', async () => {
    // The table lives in the admin service's schema. A missing GRANT, a dropped
    // connection or a table that does not exist yet must not take sign-in with it.
    expect(await readCaptchaRoute(new Error('permission denied for schema admin'))).toEqual({
      data: {
        enabled: true,
        providers: [
          { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
          { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
        ],
      },
    });
  });

  it('refuses to serve an empty list when every provider is disabled', async () => {
    // Anti-lockout. An empty list here would 503 sign-in and registration together.
    const payload = await readCaptchaRoute(['TURNSTILE', 'HCAPTCHA']);
    expect(payload.data.providers).toHaveLength(2);
    expect(payload.data.enabled).toBe(true);
  });
});
