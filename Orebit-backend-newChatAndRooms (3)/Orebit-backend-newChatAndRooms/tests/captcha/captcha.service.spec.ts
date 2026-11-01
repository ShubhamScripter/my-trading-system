import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../../auth/limits';
import type { CaptchaAction } from '../../src/captcha/captcha.types';
import type { CacheService } from '../../redis';

type Provider = 'TURNSTILE' | 'RECAPTCHA_V2' | 'RECAPTCHA_V3' | 'HCAPTCHA';

/** The provider snapshot's default answer: everything the env configures is live.
 *  Site keys are arbitrary here — nothing in this file reads them. */
const ALL_PROVIDERS: readonly { provider: Provider; siteKey: string }[] = [
  { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
  { provider: 'RECAPTCHA_V2', siteKey: 'site-v2' },
  { provider: 'RECAPTCHA_V3', siteKey: 'site-v3' },
  { provider: 'HCAPTCHA', siteKey: 'site-hcaptcha' },
];

const baseEnvironment = {
  WEB_APP_URL: 'https://app.example.test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/orebit_test',
  DATABASE_DIRECT_URL: 'postgresql://test:test@localhost:5432/orebit_test',
  REDIS_URL: 'redis://localhost:6379',
  PASSWORD_PEPPER: 'test-password-pepper-must-be-at-least-32-characters',
  JWT_PRIVATE_KEY: process.env.JWT_PRIVATE_KEY as string,
  SMTP_FROM: 'noreply@app.example.test',
} as const;

const captchaEnvironment = [
  ...Object.keys(baseEnvironment),
  'CAPTCHA_TURNSTILE_SECRET',
  'CAPTCHA_RECAPTCHA_V2_SECRET',
  'CAPTCHA_RECAPTCHA_V3_SECRET',
  'CAPTCHA_HCAPTCHA_SECRET',
  'CAPTCHA_ALLOWED_HOSTNAMES',
  'CAPTCHA_RECAPTCHA_V3_MIN_SCORE',
] as const;

const originalEnvironment = Object.fromEntries(
  captchaEnvironment.map((name) => [name, process.env[name]]),
) as Record<(typeof captchaEnvironment)[number], string | undefined>;

/**
 * The slice of CacheService the penalty uses. `cooldownRemaining` returning 0 is
 * "no penalty running", and `increment` returning a number is the failure count —
 * both match the real fail-open behaviour on a Redis error.
 */
function createCache() {
  return {
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    increment: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue(undefined),
    // Refreshes the strike TTL from the newest strike. `increment` sets the expiry
    // with `NX`, so without this the ladder's memory stayed anchored to the FIRST
    // strike and expired regardless of how many followed.
    expire: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

async function createService(cache = createCache()) {
  Object.assign(process.env, baseEnvironment);
  process.env.CAPTCHA_TURNSTILE_SECRET = 'turnstile-secret';
  process.env.CAPTCHA_RECAPTCHA_V2_SECRET = 'recaptcha-v2-secret';
  process.env.CAPTCHA_RECAPTCHA_V3_SECRET = 'recaptcha-v3-secret';
  process.env.CAPTCHA_HCAPTCHA_SECRET = 'hcaptcha-secret';
  process.env.CAPTCHA_ALLOWED_HOSTNAMES = 'app.example.test';
  process.env.CAPTCHA_RECAPTCHA_V3_MIN_SCORE = '0.5';

  vi.resetModules();
  const { CaptchaService } = await import('../../src/captcha/captcha.service.js');
  // The provider snapshot. Answers with all four by default, so every existing
  // assertion in this file behaves exactly as it did before the toggle table — a
  // test that cares about a DISABLED provider narrows it explicitly.
  const settings = { live: vi.fn().mockReturnValue(ALL_PROVIDERS) };
  return {
    service: new CaptchaService(cache as unknown as CacheService, settings as never),
    cache,
    settings,
  };
}

function successfulResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ success: true, hostname: 'app.example.test', ...overrides }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterAll(() => {
  for (const name of captchaEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('CaptchaService', () => {
  it.each([
    ['TURNSTILE', 'register_start', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'],
    ['RECAPTCHA_V2', 'login_password', 'https://www.google.com/recaptcha/api/siteverify'],
    ['RECAPTCHA_V3', 'login_password', 'https://www.google.com/recaptcha/api/siteverify'],
    ['HCAPTCHA', 'password_forgot', 'https://api.hcaptcha.com/siteverify'],
  ] satisfies readonly [Provider, CaptchaAction, string][])('verifies %s with its provider endpoint', async (provider, action, expectedUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(
      successfulResponse(provider === 'RECAPTCHA_V3' ? { action, score: 0.9 } : {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { service, cache } = await createService();

    await expect(
      service.verify({ provider, token: 'provider-token', ip: '203.0.113.7', action }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('response')).toBe('provider-token');
    expect((body as URLSearchParams).get('remoteip')).toBe('203.0.113.7');
    expect(cache.increment).not.toHaveBeenCalled();
    // A solved captcha wipes the streak rather than letting it expire.
    expect(cache.clear).toHaveBeenCalledWith(expect.stringMatching(/^captcha:failures:ip:/));
  });

  it('rejects a reCAPTCHA v3 token issued for another action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ action: 'other_action', score: 0.9 })));
    const { service, cache } = await createService();

    await expect(
      service.verify({
        provider: 'RECAPTCHA_V3',
        token: 'provider-token',
        ip: '203.0.113.7',
        action: 'login_password',
      }),
    ).rejects.toMatchObject({ type: 'captcha_failed' });
    // Read from the policy rather than hardcoded: the window is admin-configurable,
    // and a literal here would fail the next time it is tuned without saying anything
    // about whether the failure was actually counted.
    expect(cache.increment).toHaveBeenCalledWith(
      expect.stringMatching(/^captcha:failures:ip:/),
      policy().CAPTCHA.FAILURES_BY_IP.windowSeconds,
    );
  });

  it('rejects a token from an untrusted hostname', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ hostname: 'attacker.example.test' })));
    const { service, cache } = await createService();

    await expect(
      service.verify({
        provider: 'TURNSTILE',
        token: 'provider-token',
        ip: '203.0.113.7',
        action: 'register_start',
      }),
    ).rejects.toMatchObject({ type: 'captcha_failed' });
    expect(cache.increment).toHaveBeenCalledOnce();
  });

  it('counts a provider-rejected token as a CAPTCHA failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ success: false, 'error-codes': ['invalid-input-response'] })));
    const { service, cache } = await createService();

    await expect(
      service.verify({
        provider: 'TURNSTILE',
        token: 'invalid-token',
        ip: '203.0.113.7',
        action: 'register_start',
      }),
    ).rejects.toMatchObject({ type: 'captcha_failed' });

    expect(cache.increment).toHaveBeenCalledOnce();
    // Under the threshold, so no penalty yet.
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('does not count a CAPTCHA-provider outage as a user failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    const { service, cache } = await createService();

    await expect(
      service.verify({
        provider: 'TURNSTILE',
        token: 'provider-token',
        ip: '203.0.113.7',
        action: 'register_start',
      }),
    ).rejects.toMatchObject({ type: 'captcha_provider_unavailable' });

    // The line that stops a Cloudflare incident becoming a self-inflicted lockout.
    expect(cache.increment).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

});

describe('CaptchaService — the failure penalty', () => {
  const attempt = { provider: 'TURNSTILE', token: 't', ip: '203.0.113.7', action: 'register_start' } as const;

  it('refuses BEFORE calling the provider while a penalty is running', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cache = createCache();
    cache.cooldownRemaining.mockResolvedValue(42);
    const { service } = await createService(cache);

    await expect(service.verify(attempt)).rejects.toMatchObject({
      type: 'rate_limited',
      retryAfterSeconds: 42,
    });

    // THE assertion for this whole feature. A penalty that still spent a
    // siteverify call would not protect the quota it exists to protect.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the exact remaining wait, not the window length', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = createCache();
    cache.cooldownRemaining.mockResolvedValue(7);
    const { service } = await createService(cache);

    await expect(service.verify(attempt)).rejects.toMatchObject({ retryAfterSeconds: 7 });
  });

  it('starts a penalty once the threshold is crossed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ success: false })));
    const cache = createCache();
    cache.increment.mockResolvedValueOnce(10).mockResolvedValueOnce(1); // failures, then strike
    const { service } = await createService(cache);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^captcha:block:ip:/),
      '1',
      60,
    );
    // The spent window is dropped, or the next failure would trip the next rung
    // the instant the block lifts.
    expect(cache.clear).toHaveBeenCalledWith(expect.stringMatching(/^captcha:failures:ip:/));
  });

  it.each([
    [1, 60],
    [2, 5 * 60],
    [3, 15 * 60],
    [4, 60 * 60],
    [5, 60 * 60],
    [99, 60 * 60],
  ])('climbs the ladder: strike %i serves %i seconds', async (strike, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ success: false })));
    const cache = createCache();
    cache.increment.mockResolvedValueOnce(10).mockResolvedValueOnce(strike);
    const { service } = await createService(cache);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    // Past the last rung the wait stops growing rather than running off the end
    // of the array and setting a TTL of undefined.
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), '1', expected);
  });

  it('does NOT clear the strike count on success, so the ladder keeps its memory', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse()));
    const cache = createCache();
    const { service } = await createService(cache);

    await expect(service.verify(attempt)).resolves.toBeUndefined();

    const cleared = cache.clear.mock.calls.map((c) => c[0] as string);
    expect(cleared.some((k) => k.startsWith('captcha:failures:ip:'))).toBe(true);
    // Otherwise one solved token would buy an attacker unlimited first offences.
    expect(cleared.some((k) => k.startsWith('captcha:strikes:ip:'))).toBe(false);
  });

  it('fails OPEN when Redis is down — verification still runs, no penalty applied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal('fetch', fetchMock);
    const cache = createCache();
    // What the real CacheService returns when it cannot reach Redis.
    cache.cooldownRemaining.mockResolvedValue(0);
    cache.increment.mockResolvedValue(0);
    const { service } = await createService(cache);

    // A Redis outage must never become a captcha bypass, and must never lock out
    // everyone either. The provider call still happens and still decides.
    await expect(service.verify(attempt)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cache.set).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE PENALTY, DRIVEN THROUGH THE REAL CacheService ══════════════════════
 *
 * Every test above doubles `CacheService` wholesale, which is right for asserting the
 * ladder's arithmetic and wrong for asserting what a Redis fault does — a double that
 * resolves `increment` to 0 models the fixed behaviour and would pass against the bug.
 *
 * So these build the REAL `CacheService` over a doubled ioredis and let a genuine
 * `[error, value]` reply travel the whole path: `exec()` → `increment` → `recordFailure`.
 *
 * The two faults, and what they used to do here:
 *
 *   A COMMAND ERROR read as 0, silently, so `recordFailure` returned early and the
 *   ladder never ran. The captcha itself still decided every request — that promise
 *   held — but the siteverify quota protection was off with nothing logged.
 *
 *   A DROPPED TRANSACTION read as `NaN`, which is worse than fail-open: `NaN < limit`
 *   is false, so the early return did NOT happen and the code walked into
 *   `BLOCK_LADDER_SECONDS[NaN]` → `undefined` → a block key set with no expiry.
 */
describe('CaptchaService — a Redis fault reaches the real increment()', () => {
  const attempt = {
    provider: 'TURNSTILE',
    token: 'invalid-token',
    ip: '203.0.113.7',
    action: 'register_start',
  } as const;

  /**
   * ioredis, doubled at the command level. `exec` is what each test varies; every
   * other command answers as a healthy Redis would, so the only fault in play is the
   * one under test.
   */
  function createRedis(exec: () => Promise<unknown>) {
    const chain = { incr: vi.fn(() => chain), expire: vi.fn(() => chain), exec };
    return {
      multi: vi.fn(() => chain),
      ttl: vi.fn().mockResolvedValue(-2), // no penalty running
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      exists: vi.fn().mockResolvedValue(0),
    };
  }

  async function serviceOver(exec: () => Promise<unknown>) {
    const redis = createRedis(exec);
    const { CacheService } = await import('../../redis/cache.js');
    const cache = new CacheService(redis as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulResponse({ success: false })));

    Object.assign(process.env, baseEnvironment);
    process.env.CAPTCHA_TURNSTILE_SECRET = 'turnstile-secret';
    process.env.CAPTCHA_ALLOWED_HOSTNAMES = 'app.example.test';

    const { CaptchaService } = await import('../../src/captcha/captcha.service.js');
    const settings = { live: vi.fn().mockReturnValue(ALL_PROVIDERS) };
    return { service: new CaptchaService(cache, settings as never), redis };
  }

  /** Every `SET` the penalty path could have written, as `[key, value, 'EX', ttl]`. */
  const blockWrites = (redis: ReturnType<typeof createRedis>): unknown[][] =>
    redis.set.mock.calls.filter((call) => String(call[0]).startsWith('captcha:block:ip:'));

  it('a command error follows the documented fail-open path, applying no penalty', async () => {
    const { service, redis } = await serviceOver(async () => [
      [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null],
      [null, 1],
    ]);

    // The captcha verdict is unaffected — the token really was rejected.
    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    // `increment` returned its documented 0, so the threshold was not met. The
    // difference from the bug is that the error was detected and logged on the way.
    expect(blockWrites(redis)).toHaveLength(0);
  });

  it('a dropped transaction cannot write a block key at all', async () => {
    // ═══ THE NaN REGRESSION ═══════════════════════════════════════════════════
    const { service, redis } = await serviceOver(async () => null);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    // Under the bug this wrote `SET captcha:block:ip:… 1 EX undefined`.
    expect(blockWrites(redis)).toHaveLength(0);
  });

  it('a dropped transaction cannot create a key with a missing expiry', async () => {
    // ═══ THE TTL REGRESSION ═══════════════════════════════════════════════════
    //
    // Stated against EVERY write rather than just the block key: the property that
    // matters is that no penalty key can outlive its intended window, and an
    // undefined TTL is how a transient fault became a permanent IP ban.
    const { service, redis } = await serviceOver(async () => null);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    for (const call of redis.set.mock.calls) {
      // `CacheService.set` calls `redis.set(key, value, 'EX', ttlSeconds)`.
      if (call[2] !== 'EX') continue;
      expect(Number.isFinite(call[3])).toBe(true);
      expect(call[3]).toBeGreaterThan(0);
    }
  });

  it('never indexes the ladder with a non-integer rung', async () => {
    // `BLOCK_LADDER_SECONDS[NaN]` is `undefined`, and `undefined` was reaching Redis
    // as a TTL. Any block that IS written must carry a real rung from the ladder.
    const { BLOCK_LADDER_SECONDS } = policy().CAPTCHA;
    const { service, redis } = await serviceOver(async () => null);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    for (const call of blockWrites(redis)) {
      expect(BLOCK_LADDER_SECONDS).toContain(call[3]);
    }
  });

  it('still applies the penalty normally when Redis is healthy', async () => {
    // The other half of the regression: the fix must not have broken the ladder it
    // exists to protect. A healthy reply at the threshold still blocks, with a real
    // TTL from the first rung.
    const { FAILURES_BY_IP, BLOCK_LADDER_SECONDS } = policy().CAPTCHA;
    // `recordFailure` increments twice — the failure counter, then the strike counter —
    // so the double has to answer them separately. One canned reply for both would
    // report a tenth STRIKE and legitimately serve the ladder's last rung.
    const replies = [
      [[null, FAILURES_BY_IP.limit], [null, 1]],
      [[null, 1], [null, 1]],
    ];
    let call = 0;
    const { service, redis } = await serviceOver(async () => replies[call++]);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    const writes = blockWrites(redis);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[3]).toBe(BLOCK_LADDER_SECONDS[0]);
  });

  it('reads the real counter on a healthy reply below the threshold', async () => {
    const { service, redis } = await serviceOver(async () => [
      [null, 2],
      [null, 1],
    ]);

    await expect(service.verify(attempt)).rejects.toMatchObject({ type: 'captcha_failed' });

    expect(blockWrites(redis)).toHaveLength(0);
  });
});

/**
 * ═══ A PROVIDER AN OPERATOR HAS TAKEN OUT OF ROTATION ══════════════════════
 *
 * The provider list is `env ∩ ¬disabled`, where the disablements live in
 * `admin.admin_captcha_providers` and are re-read on a timer. Naming a provider
 * that has been withdrawn must be a REFUSAL — never a skip, and never a strike.
 */
describe('a disabled provider', () => {
  const attempt = {
    provider: 'HCAPTCHA',
    token: 'provider-token',
    ip: '203.0.113.7',
    action: 'login_password',
  } as const;

  it('is refused with 503, without contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { service, settings } = await createService();
    settings.live.mockReturnValue(ALL_PROVIDERS.filter((o) => o.provider !== 'HCAPTCHA'));

    await expect(service.verify(attempt)).rejects.toMatchObject({
      type: 'captcha_provider_unavailable',
    });

    // Before the network call, deliberately: a withdrawn provider has no verdict to
    // give, and asking for one would spend siteverify quota to learn nothing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT count toward the failure ladder', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = createCache();
    const { service, settings } = await createService(cache);
    settings.live.mockReturnValue(ALL_PROVIDERS.filter((o) => o.provider !== 'HCAPTCHA'));

    await expect(service.verify(attempt)).rejects.toMatchObject({
      type: 'captcha_provider_unavailable',
    });

    // The caller used a provider that was live when their page loaded. Charging them
    // for our configuration change would turn a routine toggle into a lockout of
    // everyone whose tab was already open.
    expect(cache.increment).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('still verifies a provider that is left live', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { service, settings } = await createService();
    settings.live.mockReturnValue(ALL_PROVIDERS.filter((o) => o.provider !== 'HCAPTCHA'));

    await expect(
      service.verify({ ...attempt, provider: 'TURNSTILE' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('is checked AFTER the penalty, so a blocked IP still serves its wait', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = createCache();
    cache.cooldownRemaining.mockResolvedValue(42);
    const { service, settings } = await createService(cache);
    settings.live.mockReturnValue([]);

    // Ordering matters: naming a disabled provider must not be a way to find out
    // whether you are currently penalised, nor a cheaper error to probe with.
    await expect(service.verify(attempt)).rejects.toMatchObject({
      type: 'rate_limited',
      retryAfterSeconds: 42,
    });
  });
});

describe('describe()', () => {
  it('reports the snapshot, and `enabled` tracks whether it is empty', async () => {
    const { service, settings } = await createService();

    expect(service.describe()).toEqual({ enabled: true, providers: ALL_PROVIDERS });

    // ─── This is NOT the admin backend's rule ────────────────────────────────
    //
    // There, `enabled` is `config.captchaEnabled` and gates a real skip-verification
    // branch, so deriving it from the list length would be a captcha bypass. This
    // service has no such branch — `verify` always runs — so here it is a rendering
    // hint and the length is the honest answer.
    settings.live.mockReturnValue([]);
    expect(service.describe()).toEqual({ enabled: false, providers: [] });
  });
});
