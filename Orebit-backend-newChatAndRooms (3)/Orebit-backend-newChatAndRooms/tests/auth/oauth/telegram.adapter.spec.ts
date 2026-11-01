import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../../auth/oauth/telegram.adapter';
import { config } from '../../../src/config';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';

/**
 * TelegramAdapter — the one added provider that is fully testable offline.
 *
 * The other three (Apple, Facebook, X) cannot be verified without a live
 * authorization round trip, so their adapters are written and unexercised until
 * credentials exist. Telegram is different in kind: its entire authentication is an
 * HMAC over a payload, with no exchange and no key fetch. So a spec can sign a
 * fixture with the same bot token the adapter reads and assert the real check — not
 * a doubled one.
 *
 * That makes this the file that actually proves the signature logic, and it is worth
 * being exhaustive here precisely because there is no integration test coming later
 * to catch a mistake.
 */

const adapter = new TelegramAdapter();

/** The fields Telegram would send for a fully-populated account. */
const FIELDS: Record<string, string> = {
  id: '987654321',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  photo_url: 'https://t.me/i/userpic/320/ada.jpg',
  auth_date: String(Math.floor(Date.now() / 1000)),
};

/**
 * Sign a payload exactly as Telegram does.
 *
 * Deliberately a re-implementation rather than a call into the adapter: a spec that
 * asked the adapter to produce the hash it then checks would pass no matter what the
 * algorithm was. This is the algorithm from Telegram's documentation, written
 * independently, and the test is that the two agree.
 */
function sign(fields: Record<string, string>): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('\n');

  const secret = createHash('sha256').update(config.TELEGRAM_BOT_TOKEN).digest();
  return createHmac('sha256', secret).update(checkString).digest('hex');
}

/** A signed payload as a query string — the redirect-mode shape. */
function signedQuery(fields: Record<string, string> = FIELDS): string {
  const params = new URLSearchParams({ ...fields, hash: sign(fields) });
  return params.toString();
}

function verify(code: string) {
  return adapter.verify({
    code,
    redirectUri: '',
    codeVerifier: undefined,
    expectedNonce: undefined,
  });
}

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('expected a ProblemException');
}

describe('TelegramAdapter.verify — the signature is the whole authentication', () => {
  it('accepts a correctly signed payload', async () => {
    const identity = await verify(signedQuery());

    expect(identity).toEqual({
      provider: 'TELEGRAM',
      subject: '987654321',
      email: null,
      emailVerified: false,
      name: 'Ada Lovelace',
      avatarUrl: 'https://t.me/i/userpic/320/ada.jpg',
    });
  });

  it('refuses a payload with one tampered field', async () => {
    // The attack this stops: take a genuine payload and change `id` to somebody
    // else's. The hash was computed over the original, so it no longer matches — and
    // the attacker cannot recompute it without the bot token.
    const params = new URLSearchParams(signedQuery());
    params.set('id', '111111111');

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  it('refuses a payload with no hash at all', async () => {
    const params = new URLSearchParams(signedQuery());
    params.delete('hash');

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  it('refuses a hash signed with a different bot token', async () => {
    // i.e. someone else's bot. The signature is well-formed and internally
    // consistent; it simply is not ours.
    const wrongSecret = createHash('sha256').update('999:someone-elses-bot').digest();
    const checkString = Object.keys(FIELDS)
      .sort()
      .map((key) => `${key}=${FIELDS[key] ?? ''}`)
      .join('\n');
    const hash = createHmac('sha256', wrongSecret).update(checkString).digest('hex');

    const params = new URLSearchParams({ ...FIELDS, hash });
    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  it('verifies a payload for an account with no last_name or username', async () => {
    // Telegram omits absent fields entirely rather than sending them empty, and the
    // check string has to omit them too. Signing `last_name=` would not match.
    const sparse = { id: '5', first_name: 'Ada', auth_date: FIELDS['auth_date'] as string };
    const params = new URLSearchParams({ ...sparse, hash: sign(sparse) });

    const identity = await verify(params.toString());
    expect(identity.name).toBe('Ada');
    expect(identity.avatarUrl).toBeNull();
  });

  it('falls back to the username when no first_name is sent', async () => {
    const sparse = { id: '5', username: 'ada', auth_date: FIELDS['auth_date'] as string };
    const params = new URLSearchParams({ ...sparse, hash: sign(sparse) });

    expect((await verify(params.toString())).name).toBe('ada');
  });

  it('ignores an unsigned field a caller appended', async () => {
    // The allowlist in the adapter is what makes this harmless. Hashing "every key
    // except hash" instead would fold the extra key into OUR check string but not
    // Telegram's, so the two would disagree and a stray query parameter would break
    // every login — failing closed, but for no reason and with no clue why.
    const params = new URLSearchParams(signedQuery());
    params.set('utm_source', 'newsletter');

    const identity = await verify(params.toString());
    expect(identity.subject).toBe('987654321');
  });
});

describe('TelegramAdapter.verify — freshness', () => {
  it('refuses a payload older than the window', async () => {
    // The signature never expires on its own, so without this a payload captured
    // from a URL or a log would be valid forever.
    const stale = { ...FIELDS, auth_date: String(Math.floor(Date.now() / 1000) - 3600) };
    const params = new URLSearchParams({ ...stale, hash: sign(stale) });

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
  });

  it('refuses a payload dated far in the future', async () => {
    const ahead = { ...FIELDS, auth_date: String(Math.floor(Date.now() / 1000) + 3600) };
    const params = new URLSearchParams({ ...ahead, hash: sign(ahead) });

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
  });

  it('refuses a payload with an unparseable auth_date', async () => {
    const bad = { ...FIELDS, auth_date: 'yesterday' };
    const params = new URLSearchParams({ ...bad, hash: sign(bad) });

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  it('checks the signature BEFORE the date, so auth_date is never trusted unsigned', async () => {
    // Ordering matters: reading `auth_date` first would be acting on a number the
    // caller chose. A stale payload with a BROKEN signature must fail as a signature
    // problem, not as a freshness one.
    const stale = { ...FIELDS, auth_date: String(Math.floor(Date.now() / 1000) - 3600) };
    const params = new URLSearchParams({ ...stale, hash: 'deadbeef' });

    const err = await problem(verify(params.toString()));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  /**
   * ═══ FINDING #3 ON THIS PATH ══════════════════════════════════════════════
   *
   * `hash` is checked for presence and non-emptiness and then handed straight to
   * `safeEqual` against a 64-character hex digest. It is not validated as hex, so a
   * caller could send any string at all.
   *
   * `safeEqual`'s length guard used to count UTF-16 code units while `timingSafeEqual`
   * compares bytes, so a `hash` of 64 two-byte characters passed the guard — 64 units
   * against 64 — and then threw `RangeError` on 128 bytes against 64. `problem()`
   * above rethrows anything that is not a `ProblemException`, so these would have
   * surfaced as raw errors rather than the ordinary refusal.
   *
   * Telegram's validation policy is deliberately unchanged: the point is that the
   * comparison primitive no longer throws for input the policy allows through.
   */
  it.each([
    ['64 two-byte characters — 64 code units, 128 bytes', 'é'.repeat(64)],
    ['32 surrogate pairs — 64 code units, 128 bytes', '\u{1F600}'.repeat(32)],
    ['a single multibyte character', 'é'],
    ['a three-byte character repeated to hex length', '€'.repeat(64)],
  ])('refuses a non-hex hash of %s as a signature failure', async (_case, hash) => {
    // The shapes that fooled the old guard: same code-unit count as a hex digest,
    // different byte count.
    const params = new URLSearchParams({ ...FIELDS, hash });

    const err = await problem(verify(params.toString()));

    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });

  it('still refuses a hex hash of the right length that is simply wrong', async () => {
    // The regression guard: equal byte lengths, so the comparison genuinely runs.
    const params = new URLSearchParams({ ...FIELDS, hash: 'a'.repeat(64) });

    const err = await problem(verify(params.toString()));

    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });
});

describe('TelegramAdapter.verify — payload shapes', () => {
  it('accepts the JSON shape the widget callback produces', async () => {
    const identity = await verify(JSON.stringify({ ...FIELDS, hash: sign(FIELDS) }));
    expect(identity.subject).toBe('987654321');
  });

  it('accepts a JSON payload whose id is a number, as the widget actually sends it', async () => {
    // The classic integration failure. The JS callback hands the client `id` as a
    // JSON number; the check string needs its decimal digits. `String(...)` is what
    // makes the two agree, and this pins it.
    const identity = await verify(
      JSON.stringify({ ...FIELDS, id: 987654321, hash: sign(FIELDS) }),
    );
    expect(identity.subject).toBe('987654321');
  });

  it('accepts a query string with a leading question mark', async () => {
    // What a client gets straight from `window.location.search`.
    const identity = await verify(`?${signedQuery()}`);
    expect(identity.subject).toBe('987654321');
  });

  it('refuses a payload that is not parseable at all', async () => {
    const err = await problem(verify('{not json'));
    expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
  });
});

describe('TelegramAdapter — the shape of the integration', () => {
  it('has no authorization URL, because Telegram has no authorization endpoint', async () => {
    expect(
      adapter.authorizationUrl({
        redirectUri: '',
        state: 'state',
        codeChallenge: null,
        nonce: null,
      }),
    ).toBeNull();
  });

  it('declares itself unable to supply an email, which is what closes the create branch', () => {
    // `OauthService` reads this rather than discovering a null email later, so it is
    // load-bearing rather than documentation.
    expect(adapter.capabilities.providesEmail).toBe('never');
    expect(adapter.capabilities.flow).toBe('signed-payload');
  });

  it('has an empty configured redirect URI, so every caller-supplied one mismatches', () => {
    // Telegram's callback is configured in the bot's domain settings, not here, so
    // there is nothing to compare against and a caller must not send one.
    expect(adapter.configuredRedirectUri).toBe('');
  });

  it('is configured in this environment, so the cases above exercise the real check', () => {
    expect(adapter.isConfigured()).toBe(true);
  });
});
