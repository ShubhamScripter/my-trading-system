import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══ TRUSTED_PROXIES IS A TRUST BOUNDARY, AND IT WAS NOT VALIDATED ══════════
 *
 * `config.trustedProxies` becomes Fastify's `trustProxy`, which is what decides whose
 * `X-Forwarded-For` the service believes. `req.ip` falls out of that, and every per-IP
 * control in the system is keyed on `req.ip`: the rate limits, the captcha penalty
 * ladder, the login-attempt device/network binding.
 *
 * The string reached Fastify unchecked. Three failures, in increasing order of quiet:
 *
 *   MALFORMED — `proxy-addr` threw when Fastify compiled the list, so this was never a
 *   live hazard. But it failed from inside a library, naming neither the variable nor
 *   the deployment that set it.
 *
 *   TOO BROAD — the dangerous one. `proxy-addr` refuses a literal `0.0.0.0/0`, so
 *   "trust everything" cannot be spelled the obvious way — but it ACCEPTS `0.0.0.0/1`,
 *   which is half the IPv4 internet, and a pair of `/1`s is all of it. Trust a range
 *   containing the caller and `proxy-addr` returns the LEFTMOST forwarded entry, which
 *   the client wrote. Every per-IP control then meters a number the attacker chooses.
 *
 *   EMPTY IN PRODUCTION — silent. `trustProxy: false`, so `req.ip` is the socket
 *   address, which behind a load balancer is the balancer's for every caller. One
 *   shared bucket looks exactly like a working rate limiter.
 *
 * ─── How these tests work ──────────────────────────────────────────────────
 *
 * `src/config.ts` parses `process.env` at IMPORT time and throws, so each case sets an
 * environment, resets the module registry, and re-imports. That exercises the real
 * `load()` — the production path included — rather than a re-implementation.
 */

/** Everything production demands, so a case fails on TRUSTED_PROXIES and nothing else. */
const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_FROM: 'noreply@app.example.test',
  PASSWORD_PEPPER: 'a-real-production-pepper-at-least-32-characters-long',
  CAPTCHA_TURNSTILE_SECRET: 'turnstile-secret',
  CAPTCHA_TURNSTILE_SITE_KEY: 'turnstile-site',
  CAPTCHA_RECAPTCHA_V2_SECRET: 'v2-secret',
  CAPTCHA_RECAPTCHA_V2_SITE_KEY: 'v2-site',
  CAPTCHA_RECAPTCHA_V3_SECRET: 'v3-secret',
  CAPTCHA_RECAPTCHA_V3_SITE_KEY: 'v3-site',
  CAPTCHA_HCAPTCHA_SECRET: 'hcaptcha-secret',
  CAPTCHA_HCAPTCHA_SITE_KEY: 'hcaptcha-site',
} as const;

const TOUCHED = [...Object.keys(PRODUCTION_BASE), 'TRUSTED_PROXIES'] as const;
const ORIGINAL = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

/** Load `src/config.ts` fresh under `env`. Rejects exactly as boot would. */
async function loadConfig(env: Record<string, string>): Promise<{ trustedProxies: string[] }> {
  Object.assign(process.env, env);
  vi.resetModules();
  const { config } = await import('../../src/config.js');
  return config as { trustedProxies: string[] };
}

const inProduction = (trusted: string): Promise<{ trustedProxies: string[] }> =>
  loadConfig({ ...PRODUCTION_BASE, TRUSTED_PROXIES: trusted });

/** The message for a rejected load, or a failure if it was accepted. */
async function refusal(trusted: string): Promise<string> {
  try {
    await inProduction(trusted);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected TRUSTED_PROXIES=${JSON.stringify(trusted)} to be refused in production`);
}

// ─── what production accepts ──────────────────────────────────────────────────

describe('valid production configurations', () => {
  it.each([
    ['a single IPv4 host', '10.0.0.1', ['10.0.0.1']],
    ['an IPv4 CIDR', '10.0.0.0/8', ['10.0.0.0/8']],
    ['a narrow public CIDR', '104.16.0.0/13', ['104.16.0.0/13']],
    ['a single IPv6 host', '2001:db8::1', ['2001:db8::1']],
    ['an IPv6 CIDR', '2001:db8::/32', ['2001:db8::/32']],
    ['an explicit /32', '10.0.0.1/32', ['10.0.0.1/32']],
    ['multiple entries', '10.0.0.0/8,172.16.0.0/12', ['10.0.0.0/8', '172.16.0.0/12']],
    ['mixed families', '10.0.0.1,2001:db8::/48', ['10.0.0.1', '2001:db8::/48']],
  ])('accepts %s', async (_case, value, expected) => {
    expect((await inProduction(value)).trustedProxies).toEqual(expected);
  });

  it.each(['loopback', 'linklocal', 'uniquelocal'])(
    'accepts the proxy-addr named range %s',
    async (name) => {
      // Existing supported syntax, and all three are non-routable — they cannot
      // contain an arbitrary internet client, so the breadth rule does not apply.
      expect((await inProduction(name)).trustedProxies).toEqual([name]);
    },
  );

  it('preserves the existing whitespace and empty-segment handling', async () => {
    // Unchanged parsing: trim each entry, drop the empties. Pinned because the
    // validation now runs on the result and must not have altered it.
    expect((await inProduction(' 10.0.0.1 , , 10.0.0.2 ')).trustedProxies).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });
});

// ─── what production refuses ──────────────────────────────────────────────────

describe('unsafe production configurations', () => {
  it('refuses an empty value', async () => {
    // ═══ THE SILENT ONE ══════════════════════════════════════════════════════
    // No error before this change, and `trustProxy: false` — so `req.ip` is the load
    // balancer's address for every caller and per-IP limiting stops distinguishing
    // anyone.
    const message = await refusal('');

    expect(message).toContain('TRUSTED_PROXIES');
    expect(message).toContain('required in production');
  });

  it('refuses a value that is only separators and whitespace', async () => {
    // Parses to the same empty list, so it has to be refused for the same reason.
    expect(await refusal('  ,  , ')).toContain('required in production');
  });

  it.each([
    ['half the IPv4 internet', '0.0.0.0/1'],
    ['the whole of it, in two entries', '0.0.0.0/1,128.0.0.0/1'],
    ['an over-wide public range', '0.0.0.0/4'],
    ['a /7', '2.0.0.0/7'],
    ['an over-wide IPv6 range', '2000::/16'],
    ['a broad range hidden among good ones', '10.0.0.0/8,0.0.0.0/2'],
  ])('refuses %s', async (_case, value) => {
    // ═══ THE DANGEROUS ONE ═══════════════════════════════════════════════════
    // `proxy-addr` accepts every one of these. Trusting a range that contains the
    // caller makes `req.ip` the leftmost forwarded entry — the client's own choice.
    const message = await refusal(value);

    expect(message).toContain('TRUSTED_PROXIES');
    expect(message).toContain('too much of the internet');
  });

  it.each([
    ['a wildcard', '*'],
    ['a hostname', 'proxy.example.test'],
    ['a malformed address', '10.0.0.999'],
    ['a truncated address', '10.0.0.'],
    ['a boolean, as if it were a flag', 'true'],
    ['a comma-joined mess', '10.0.0.1;10.0.0.2'],
  ])('refuses %s', async (_case, value) => {
    expect(await refusal(value)).toContain('not a valid IP address or CIDR');
  });

  it.each([
    ['an out-of-range IPv4 prefix', '10.0.0.0/33'],
    ['an out-of-range IPv6 prefix', '2001:db8::/129'],
    ['a non-numeric prefix', '10.0.0.0/eight'],
    ['an empty prefix', '10.0.0.0/'],
    ['a negative prefix', '10.0.0.0/-8'],
  ])('refuses %s', async (_case, value) => {
    expect(await refusal(value)).toContain('invalid prefix length');
  });

  it('names the offending entry without dumping the environment', async () => {
    // The message has to be actionable and must not become a place secrets surface.
    const message = await refusal('10.0.0.1,not-an-ip');

    expect(message).toContain('not-an-ip');
    expect(message).not.toContain(PRODUCTION_BASE.PASSWORD_PEPPER);
    expect(message).not.toContain(PRODUCTION_BASE.CAPTCHA_TURNSTILE_SECRET);
  });

  it('fails the load itself, so nothing can start with the unsafe value', async () => {
    // Fail-fast: the throw is at module import, before Fastify is constructed and long
    // before the server accepts traffic.
    await expect(inProduction('0.0.0.0/1')).rejects.toThrow(/Invalid environment/);
  });
});

// ─── development and test are not production ──────────────────────────────────

describe('development and test environments', () => {
  it.each(['development', 'test'])('allows an empty value in %s', async (nodeEnv) => {
    // The default everywhere outside production, and the correct one for a service
    // reached directly. Breaking it would break every laptop and every CI run.
    const config = await loadConfig({ NODE_ENV: nodeEnv, TRUSTED_PROXIES: '' });

    expect(config.trustedProxies).toEqual([]);
  });

  it.each(['development', 'test'])('allows a wide range in %s', async (nodeEnv) => {
    // Breadth is a production rule. A developer pointing at a wide range on a laptop is
    // not a trust boundary, and refusing it would be a check people work around.
    const config = await loadConfig({ NODE_ENV: nodeEnv, TRUSTED_PROXIES: '0.0.0.0/1' });

    expect(config.trustedProxies).toEqual(['0.0.0.0/1']);
  });

  it.each(['development', 'test'])('still refuses a MALFORMED value in %s', async (nodeEnv) => {
    // Not a new refusal: `proxy-addr` already threw on this when Fastify compiled the
    // list. What changed is that the error now names the variable, and arrives before
    // anything else starts.
    await expect(
      loadConfig({ NODE_ENV: nodeEnv, TRUSTED_PROXIES: 'not-an-ip' }),
    ).rejects.toThrow(/TRUSTED_PROXIES/);
  });
});

// ─── the value still means what it meant ──────────────────────────────────────

describe('the trusted-proxy boundary is unchanged for valid configuration', () => {
  it('hands Fastify the same list it always did', async () => {
    // `main.ts` reads `config.trustedProxies` and passes it as `trustProxy` when
    // non-empty, `false` otherwise. Validation must not have changed the shape.
    const config = await inProduction('104.16.0.0/13,2400:cb00::/32');

    expect(config.trustedProxies).toEqual(['104.16.0.0/13', '2400:cb00::/32']);
  });

  it('produces an empty list, and therefore trustProxy false, outside production', async () => {
    const config = await loadConfig({ NODE_ENV: 'test', TRUSTED_PROXIES: '' });

    expect(config.trustedProxies).toHaveLength(0);
  });

  it('accepts every entry that @fastify/proxy-addr accepts and we consider narrow', async () => {
    // The two lists have to agree: a value this validation permits must not then throw
    // from inside the library at boot, which would be a worse failure than before.
    const { trustedProxies } = await inProduction('10.0.0.1,10.0.0.0/8,2001:db8::/32,loopback');
    const { compile } = await import('@fastify/proxy-addr');

    expect(() => compile(trustedProxies)).not.toThrow();
  });
});
