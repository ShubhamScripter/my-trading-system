import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientContext } from '../../../auth/auth.types';
import type { RegistrationDbOperation } from '../../../auth/persistence/registration.dboperation';
import { GoogleAdapter } from '../../../auth/oauth/google.adapter';
import { OauthProviderRegistry } from '../../../auth/oauth/registry';
import { OauthService } from '../../../auth/services/oauth.service';
import type { SessionService } from '../../../auth/services/session.service';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import { config } from '../../../src/config';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { GeoResolver } from '../../../src/geo/geo.types';
import type { MfaService } from '../../../src/2fa/mfa.service';
import type { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import type { MailService } from '../../../src/mail/mail.service';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { makeLoginAttempt, rawUniqueViolation } from '../../harness';

/**
 * OauthService, limited to what is testable without dialling Google.
 *
 * That is a smaller surface than the file, but it is the security-critical half:
 * `resolveRedirectUri` and the single-use `state`. Both refuse *before* any
 * network call, which is exactly why they can be tested here — and exactly why
 * they matter, since both are what stop an attacker walking off with an
 * authorization code.
 *
 * `callback`'s outcomes past the state check need a doubled Google token exchange
 * and are still not covered here. The account-linking half that follows them is,
 * because `chooseRegister` and `attachPending` take the already-verified identity
 * from the cache rather than from Google — which is precisely what makes the
 * pending token worth having. Called out rather than left to be inferred from the
 * passing count.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

function createUsers() {
  return {
    findOauthLink: vi.fn().mockResolvedValue(null),
    findByEmail: vi.fn().mockResolvedValue(null),
    findWithCredential: vi.fn().mockResolvedValue(null),
    touchOauthLogin: vi.fn(),
    touchLastSeen: vi.fn(),
    emailExists: vi.fn().mockResolvedValue(false),
    linkOauth: vi.fn().mockResolvedValue(undefined),
  };
}

function createCache() {
  return {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    take: vi.fn().mockResolvedValue(null),
    consume: vi.fn().mockResolvedValue(undefined),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    clearIfValue: vi.fn().mockResolvedValue(undefined),
  };
}

let users: ReturnType<typeof createUsers>;
let registrations: {
  create: ReturnType<typeof vi.fn>;
  findResumableByOauth: ReturnType<typeof vi.fn>;
  setContinuationSecret: ReturnType<typeof vi.fn>;
};
let sessions: { issue: ReturnType<typeof vi.fn> };
let mail: { sendOtp: ReturnType<typeof vi.fn> };
let cache: ReturnType<typeof createCache>;
let quota: { consumeAll: ReturnType<typeof vi.fn> };
let blocklist: { assertNotBlocked: ReturnType<typeof vi.fn>; isBlocked: ReturnType<typeof vi.fn> };
let geo: { resolve: ReturnType<typeof vi.fn> };
let mfa: { challengeFor: ReturnType<typeof vi.fn> };
/**
 * The real adapter the registry hands back, kept so a spec can reach inside it.
 *
 * `doubleGoogle` replaces the `OAuth2Client` this holds. That used to be a field on
 * the service; it moved when the provider port was introduced, and the double moved
 * with it. Reaching into one object rather than doubling the whole adapter is
 * deliberate — the adapter's own logic (the nonce comparison, the identity mapping)
 * is what these cases are testing.
 */
let googleAdapter: GoogleAdapter;
let service: OauthService;

let attempts: {
  createFlow: ReturnType<typeof vi.fn>;
  promoteAttempt: ReturnType<typeof vi.fn>;
  completeAttempt: ReturnType<typeof vi.fn>;
  markOtpSent: ReturnType<typeof vi.fn>;
  findAttemptByTokenHash: ReturnType<typeof vi.fn>;
  expireAttempt: ReturnType<typeof vi.fn>;
};
/**
 * The login flow every OAuth step now resolves before it runs.
 *
 * `oauth-start` and `oauth-callback` are steps of a sign-in like any other, so
 * they take the flow the caller's `loginId` resolved to. The callback also binds
 * to it: the id is stashed with the OAuth `state` and compared on the way back,
 * which is what stops one tab's authorization being redeemed against another
 * tab's flow.
 */
/**
 * What `OauthService.start` calls to open the login flow.
 *
 * A factory rather than a row, because the service decides WHEN — after its own
 * quotas and after the provider resolves — so a refused request writes nothing.
 * Counting the calls is how the specs below assert that.
 */
const openFlow = vi.fn(async () => ({ loginId: 'l'.repeat(43), attempt: flow() }));

const flow = () =>
  makeLoginAttempt({ id: 'flow-1', state: 'STARTED', userId: null, identifierLower: null });


beforeEach(() => {
  users = createUsers();
  registrations = {
    create: vi.fn(),
    findResumableByOauth: vi.fn().mockResolvedValue(null),
    setContinuationSecret: vi.fn().mockResolvedValue(undefined),
  };
  sessions = { issue: vi.fn() };
  mail = { sendOtp: vi.fn().mockResolvedValue(true) };
  cache = createCache();
  quota = { consumeAll: vi.fn().mockResolvedValue({ token: 'quota', keys: [] }) };
  blocklist = {
    assertNotBlocked: vi.fn().mockResolvedValue(undefined),
    isBlocked: vi.fn().mockResolvedValue(false),
  };
  geo = { resolve: vi.fn().mockResolvedValue({ ip: client.ip, country: 'GB' }) };
  // Null = no second factor enrolled, so the linked-identity branch resolves to a
  // session exactly as it did before the gate. Its own suite covers the other case.
  mfa = { challengeFor: vi.fn().mockResolvedValue(null) };
  attempts = {
    createFlow: vi.fn(),
    promoteAttempt: vi.fn().mockResolvedValue(true),
    completeAttempt: vi.fn().mockResolvedValue(true),
    markOtpSent: vi.fn().mockResolvedValue(true),
    findAttemptByTokenHash: vi.fn().mockResolvedValue(null),
    expireAttempt: vi.fn().mockResolvedValue(undefined),
  };

  googleAdapter = new GoogleAdapter();

  service = new OauthService(
    users as unknown as UserDbOperation,
    registrations as unknown as RegistrationDbOperation,
    sessions as unknown as SessionService,
    mail as unknown as MailService,
    cache as unknown as CacheService,
    quota as unknown as QuotaService,
    blocklist as unknown as BlocklistService,
    mfa as unknown as MfaService,
    // A REAL registry holding a REAL GoogleAdapter, not a double. The adapter is
    // where `generateAuthUrl` now lives, so doubling it would delete exactly what
    // the PKCE and nonce assertions below are checking — that what Google is told
    // and what we stashed are two halves of one hash. `tests/setup.ts` supplies the
    // Google credentials that make `isConfigured()` true.
    attempts as unknown as TwoFactorDbOperation,
    new OauthProviderRegistry([googleAdapter]),
    geo as unknown as GeoResolver,
  );
});

/**
 * The authorization URL, asserted to exist.
 *
 * `start` returns `string | null` because Telegram has no authorization endpoint.
 * Every case in this file is Google, which always has one, so a null here is a bug
 * in the adapter rather than a case to handle — and failing on it beats a
 * non-null assertion that would report the same bug as a confusing URL parse error.
 */
function requireUrl(url: string | null): string {
  if (url === null) throw new Error('expected an authorization url');
  return url;
}

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('OauthService.start — the redirect URI is the open-redirect control', () => {
  it('rejects a redirectUri that does not exactly match the configured one', async () => {
    // THE control. The DTO's `z.string().url()` is only a shape check — it accepts
    // `javascript:` and any well-formed absolute URL — so this exact-match is the
    // only thing standing between a client-supplied redirect and an attacker
    // receiving the authorization code.
    const err = await problem(
      service.start(
      {
        step: 'oauth-start',
          provider: 'GOOGLE',
          redirectUri: 'https://evil.example.com/steal',
        },
        client,
        openFlow,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(err.errors?.[0]?.path).toBe('redirectUri');
    // Nothing was stashed, so no state exists for an attacker to redeem.
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('rejects a javascript: URI, which the DTO lets through', async () => {
    const err = await problem(
      service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
        redirectUri: 'javascript:alert(1)',
      },
        client,
        openFlow,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('rejects a redirectUri differing only by a trailing slash', async () => {
    // Exact string equality, not URL-normalised comparison. Strictness is the
    // intent: a normalising comparison is a place for a parser differential.
    const err = await problem(
      service.start(
      {
        step: 'oauth-start',
          provider: 'GOOGLE',
          redirectUri: `${config.GOOGLE_REDIRECT_URI}/`,
        },
        client,
        openFlow,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('accepts the configured redirectUri when sent explicitly', async () => {
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
        redirectUri: config.GOOGLE_REDIRECT_URI,
      },
      client,
      openFlow,
    );

    expect(result.url).toContain('accounts.google.com');
  });

  it('defaults to the configured redirectUri when none is sent', async () => {
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    expect(result.url).toContain(encodeURIComponent(config.GOOGLE_REDIRECT_URI));
  });
});

describe('OauthService.start — the state', () => {
  it('stashes the state server-side with the resolved redirectUri and the ip class', async () => {
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    expect(cache.set).toHaveBeenCalledTimes(1);
    const [key, value] = cache.set.mock.calls[0] as [string, string];

    // The key is `oauth:state:<tag(state)>` — the raw state is hashed, not
    // embedded, so a Redis dump does not hand over live states. Assert the
    // namespace and that the plaintext is absent, rather than that it is present.
    expect(key).toMatch(/^oauth:state:[0-9a-f]+$/);
    expect(key).not.toContain(result.state);

    expect(JSON.parse(value)).toEqual({
      // The provider the flow started with, checked at the callback so a state
      // minted for one provider cannot be redeemed against another's adapter.
      provider: 'GOOGLE',
      redirectUri: config.GOOGLE_REDIRECT_URI,
      ipClass: client.ipClass,
      deviceKey: client.deviceKey,
      // The login flow this authorization belongs to. `state` binds the callback
      // to the request that started it and the two above bind it to the browser;
      // neither can tell two tabs on one machine apart, which is exactly what a
      // flow id closes — an `oauth-start` from one tab must not be redeemable
      // against the other tab's `loginId`.
      loginAttemptId: 'flow-1',
      // The PKCE verifier and the OIDC nonce ride in the same entry, so all the
      // bindings expire and are spent together. `toEqual` rather than
      // `toMatchObject` on purpose: another field appearing here should make
      // somebody look at it.
      codeVerifier: expect.stringMatching(/^[\w-]{43,}$/) as unknown as string,
      nonce: expect.stringMatching(/^[\w-]{43,}$/) as unknown as string,
    });
  });

  it('never returns the verifier or the nonce to the caller', async () => {
    // The verifier is the whole PKCE guarantee and the nonce is the whole token-
    // injection guarantee. Both are ours; a client that could read either could
    // defeat the check it protects, so the response is asserted to carry only the
    // values the client actually needs.
    //
    // An exhaustive key list rather than two `not.toHaveProperty` assertions, so a
    // field added to this return type fails here and has to be justified. `flow`
    // was added that way — it tells a client whether to navigate or to render the
    // Telegram widget, and it discloses nothing a caller did not already send.
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    expect(Object.keys(result).sort()).toEqual(['flow', 'loginId', 'state', 'url']);
  });

  it('derives the same key from the same state, so the callback can find it', async () => {
    const { state } = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    const [storedKey] = cache.set.mock.calls[0] as [string];

    await problem(
      service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'c', state }, client),
    );

    expect(cache.take).toHaveBeenCalledWith(storedKey);
  });

  it('puts the state in the authorization URL and returns it to the caller', async () => {
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    expect(result.state).toHaveLength(43); // 32 random bytes, base64url
    expect(result.url).toContain(`state=${result.state}`);
  });

  it('mints a different state on every call', async () => {
    const a = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    const b = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    expect(a.state).not.toBe(b.state);
  });

  it('forces the account chooser, so a live Google session is recoverable', async () => {
    const result = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    expect(result.url).toContain('prompt=select_account');
  });
});

describe('OauthService.start — PKCE and the OIDC nonce', () => {
  /** The authorization URL's query, parsed. */
  async function authParams(): Promise<URLSearchParams> {
    const { url } = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    return new URL(requireUrl(url)).searchParams;
  }

  it('sends an S256 challenge, never the verifier and never a plain one', async () => {
    // `code_challenge_method` matters as much as the challenge itself: RFC 7636
    // says the method DEFAULTS to "plain" when it is omitted, and a plain challenge
    // is the verifier in the query string — i.e. PKCE that protects nothing while
    // looking exactly like PKCE that does.
    const params = await authParams();

    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('sends a challenge that is the SHA-256 of the stashed verifier', async () => {
    // The binding, end to end: what Google is told and what we kept have to be two
    // halves of one hash, or the exchange in `callback` will be refused by Google
    // and every sign-in breaks.
    const { url } = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    const [, stashed] = cache.set.mock.calls[0] as [string, string];
    const { codeVerifier } = JSON.parse(stashed) as { codeVerifier: string };

    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(new URL(requireUrl(url)).searchParams.get('code_challenge')).toBe(expected);
  });

  it('sends the nonce it stashed, so the ID token can be bound to this request', async () => {
    const { url } = await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    const [, stashed] = cache.set.mock.calls[0] as [string, string];
    const { nonce } = JSON.parse(stashed) as { nonce: string };

    expect(new URL(requireUrl(url)).searchParams.get('nonce')).toBe(nonce);
  });

  it('mints a fresh verifier and nonce on every call', async () => {
    await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );
    await service.start(
      {
        step: 'oauth-start',
        provider: 'GOOGLE',
      },
      client,
      openFlow,
    );

    const calls = cache.set.mock.calls as Array<[string, string]>;
    const [, first] = calls[0]!;
    const [, second] = calls[1]!;
    const a = JSON.parse(first) as { codeVerifier: string; nonce: string };
    const b = JSON.parse(second) as { codeVerifier: string; nonce: string };

    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('OauthService.callback — the ID token must answer this request', () => {
  /**
   * Double the `OAuth2Client` inside the real GoogleAdapter.
   *
   * The rest of this file stops at the state check for the reason its header gives,
   * but the nonce comparison is a refusal WE make on a token that has already
   * passed every check the library performs — signature, `aud`, `iss`. Nothing but
   * a doubled exchange can reach it, and a security refusal with no test is a
   * refusal that can be deleted by accident.
   *
   * The double is on the adapter's `client`, not on the adapter: replacing the whole
   * adapter would take `assertNonce` and the identity mapping with it, which is the
   * code under test.
   */
  function doubleGoogle(payload: Record<string, unknown>): { getToken: ReturnType<typeof vi.fn> } {
    const google = {
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'signed.id.token' } }),
      verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => payload }),
      generateAuthUrl: vi.fn(),
    };
    (googleAdapter as unknown as { client: unknown }).client = google;
    return google;
  }

  /** A stashed state entry carrying a known verifier and nonce. */
  function stash(nonce: string | undefined): void {
    cache.take.mockResolvedValue(
      JSON.stringify({
        provider: 'GOOGLE',
        redirectUri: config.GOOGLE_REDIRECT_URI,
        ipClass: client.ipClass,
        codeVerifier: 'verifier-from-start',
        nonce,
      }),
    );
  }

  function callback(): Promise<unknown> {
    return service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'auth-code', state: 'state' },
      client,
    );
  }

  it('hands the stashed verifier to the token exchange', async () => {
    stash('the-nonce');
    const google = doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true, nonce: 'the-nonce' });

    await callback();

    expect(google.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ codeVerifier: 'verifier-from-start' }),
    );
  });

  it('refuses a token whose nonce belongs to a different authorization request', async () => {
    // Token injection: the attacker completes their OWN sign-in at Google, then
    // feeds the resulting code into the victim's callback. Everything verifies —
    // the signature is Google's, the audience is us — and only the nonce says the
    // token was minted for a request we never started.
    stash('the-nonce');
    doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true, nonce: 'someone-elses' });

    const err = await problem(callback());

    expect(err.type).toBe(ERR.OAUTH_NONCE_INVALID);
  });

  it('refuses a token carrying no nonce at all', async () => {
    // Google echoes what it is given, so an absent claim means the token was minted
    // for a request that did not ask for one — which ours always does.
    stash('the-nonce');
    doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true });

    const err = await problem(callback());

    expect(err.type).toBe(ERR.OAUTH_NONCE_INVALID);
  });

  it('demands the second factor when the linked account has one', async () => {
    // ═══ THE BYPASS THIS TICKET EXISTS TO CLOSE ═══════════════════════════════
    //
    // A linked provider identity is the shortest path to a session in the whole
    // service — the blocklist comment in oauth.service.ts says so, and the same
    // argument applies to a factor. Before this, `callback` minted a session here
    // after checking only `status` and the blocklist, so a user who had switched
    // 2FA on would have found "Continue with Google" quietly turned it back off.
    //
    // Not reachable by curl without a live Google sign-in, which is exactly why it
    // is pinned here.
    stash('the-nonce');
    doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true, nonce: 'the-nonce' });
    users.findOauthLink.mockResolvedValue({
      id: 'link-1',
      userId: 'user-1',
      user: { status: 'ACTIVE', emailLower: 'a@b.com' },
    });
    users.findWithCredential.mockResolvedValue({ user: { id: 'user-1' }, credential: null });
    mfa.challengeFor.mockResolvedValue({
      mfaToken: 'mfa-1',
      methods: ['totp'],
      expiresAt: new Date(Date.now() + 600_000),
    });

    const outcome = await callback();

    expect(outcome).toMatchObject({ kind: 'mfa_required', mfaToken: 'mfa-1' });
    // The assertion that matters: no session came out of this door either.
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('still signs in normally when the linked account has no factor', async () => {
    // The other half. A gate that refused everyone would also pass the test above,
    // and 2FA is opt-in — the overwhelming majority of provider sign-ins must be
    // completely unaffected.
    stash('the-nonce');
    doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true, nonce: 'the-nonce' });
    users.findOauthLink.mockResolvedValue({
      id: 'link-1',
      userId: 'user-1',
      user: { status: 'ACTIVE', emailLower: 'a@b.com' },
    });
    users.findWithCredential.mockResolvedValue({ user: { id: 'user-1' }, credential: null });
    sessions.issue.mockResolvedValue({ sessionId: 'sess-1' });

    const outcome = await callback();

    expect(outcome).toMatchObject({ kind: 'session' });
    expect(users.touchLastSeen).toHaveBeenCalledWith('user-1');
  });

  it('tolerates a state entry from before this feature shipped', async () => {
    // A rolling deploy leaves in-flight sign-ins holding an entry with no nonce.
    // Refusing those would fail every one of them for the ten minutes
    // OAUTH.STATE_TTL_SECONDS allows. Delete this test with the tolerance.
    stash(undefined);
    doubleGoogle({ sub: 'g-1', email: 'a@b.com', email_verified: true });

    await expect(callback()).resolves.toMatchObject({ kind: 'choice_required' });
  });
});

describe('OauthService.callback — the state is single-use', () => {
  it('refuses an unknown, expired, or already-redeemed state identically', async () => {
    // `take` is a read-and-delete, so a replayed state comes back null — which is
    // what makes the state genuinely single-use rather than merely verified.
    cache.take.mockResolvedValue(null);

    const err = await problem(
      service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'auth-code', state: 'replayed' },
        client,
      ),
    );

    expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
  });

  it('refuses before exchanging the code, so a captured code is never redeemed', async () => {
    cache.take.mockResolvedValue(null);

    await problem(
      service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'auth-code', state: 'replayed' },
        client,
      ),
    );

    // No account lookup, no session, no registration — the refusal is total.
    expect(users.findOauthLink).not.toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
    expect(registrations.create).not.toHaveBeenCalled();
  });

  it('consumes the state via take, not get', async () => {
    cache.take.mockResolvedValue(null);

    await problem(
      service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'auth-code', state: 'st' },
        client,
      ),
    );

    // `take` is read-and-delete; a plain `get` would leave the state redeemable.
    // The double now owns a `get` (the pending-identity paths need one), so the
    // guard is no longer "there is no get" but "the state never goes through it".
    expect(cache.take).toHaveBeenCalledWith(KEYS.oauth.state('st'));
    expect(cache.get).not.toHaveBeenCalledWith(KEYS.oauth.state('st'));
  });
});

/**
 * The pending provider identity — the handle that survives between "Google says
 * who you are" and "tell me what you want done about it".
 *
 * Everything below reads the identity out of the cache double rather than out of
 * Google, which is the whole reason these paths are reachable in a unit test at
 * all. The identity is a fixed literal so a test that changes what gets linked has
 * to say so explicitly.
 */
const IDENTITY = {
  provider: 'GOOGLE' as const,
  subject: 'google-sub-1',
  email: 'Person@Example.com',
  emailVerified: true,
  name: 'Person',
};

/** What `cache.get`/`cache.take` return for a live pending token. */
function pending() {
  return JSON.stringify({
    identity: IDENTITY,
    ipClass: client.ipClass,
    deviceKey: client.deviceKey,
    purpose: 'oauth-choice',
  });
}

describe('OauthService.chooseRegister — the "create an account" branch', () => {
  it('refuses an unknown, expired, or already-spent token identically', async () => {
    cache.take.mockResolvedValue(null);

    const err = await problem(service.chooseRegister('nope', client));

    expect(err.type).toBe(ERR.OAUTH_LINK_INVALID);
  });

  it('spends the token, because a registration carries the identity onward itself', async () => {
    cache.take.mockResolvedValue(pending());
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });

    await service.chooseRegister('tok', client);

    expect(cache.take).toHaveBeenCalledWith(KEYS.oauth.pending('tok'));
  });

  it('refuses when the email was taken between the choice and the click', async () => {
    // The client should have read `canCreateNew`, but the window is real: an
    // account can be created in the gap. Registration needs an unused address, so
    // this has to fail rather than collide deeper in.
    cache.take.mockResolvedValue(pending());
    users.emailExists.mockResolvedValue(true);

    const err = await problem(service.chooseRegister('tok', client));

    expect(err.type).toBe(ERR.OAUTH_LINK_REQUIRED);
    expect(registrations.create).not.toHaveBeenCalled();
  });

  it('trusts a provider-verified email and skips our own code', async () => {
    cache.take.mockResolvedValue(pending());
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });

    const outcome = await service.chooseRegister('tok', client);

    expect(outcome.emailVerified).toBe(true);
    expect(registrations.create).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: true, otpHash: null }),
    );
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });

  it('starts a trusted attempt at CREDENTIALS_SET, so the client lands on country', async () => {
    // The provider IS the credential, so the `credentials` step has no decision
    // left to record and could only ever be called with `skip: true`. Starting
    // further along deletes that round trip — `country` is legal immediately.
    // This is a state assignment, not a relaxed guard: STEP_REQUIRES.country
    // still demands CREDENTIALS_SET of every caller.
    cache.take.mockResolvedValue(pending());
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });

    await service.chooseRegister('tok', client);

    expect(registrations.create).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'CREDENTIALS_SET' }),
    );
  });

  it('preselects a country, because the country step is the next thing shown', async () => {
    // The direct path has always resolved geo at `start`. An OAuth attempt lands
    // on that same screen with one fewer step in front of it, so leaving the
    // suggestion null would make the social path the worse experience.
    cache.take.mockResolvedValue(pending());
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });

    await service.chooseRegister('tok', client);

    expect(geo.resolve).toHaveBeenCalledWith(client.ip);
    expect(registrations.create).toHaveBeenCalledWith(
      expect.objectContaining({ countrySuggested: 'GB' }),
    );
  });

  it('survives a geo resolver that cannot tell', async () => {
    // `resolve` never throws and answers null when it does not know. A signup
    // must not fail because a geo provider had nothing to say.
    cache.take.mockResolvedValue(pending());
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });
    geo.resolve.mockResolvedValue({ ip: client.ip, country: null });

    await service.chooseRegister('tok', client);

    expect(registrations.create).toHaveBeenCalledWith(
      expect.objectContaining({ countrySuggested: null, state: 'CREDENTIALS_SET' }),
    );
  });

  it('sends our own code when the provider will not vouch for the email', async () => {
    // A provider's unverified email is a claim, not evidence. Accepting it would
    // let anyone who can name someone else's address at Google claim it here.
    cache.take.mockResolvedValue(
      JSON.stringify({
        identity: { ...IDENTITY, emailVerified: false },
        ipClass: client.ipClass,
        deviceKey: client.deviceKey,
        purpose: 'oauth-choice',
      }),
    );
    registrations.create.mockResolvedValue({ id: 'reg-1', email: IDENTITY.email });

    const outcome = await service.chooseRegister('tok', client);

    expect(outcome.emailVerified).toBe(false);
    expect(registrations.create).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'OTP_SENT', emailVerified: false }),
    );
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('re-secrets a resumable attempt rather than starting a second one', async () => {
    cache.take.mockResolvedValue(pending());
    registrations.findResumableByOauth.mockResolvedValue({
      id: 'reg-existing',
      email: IDENTITY.email,
      emailVerifiedAt: new Date(),
    });

    const outcome = await service.chooseRegister('tok', client);

    expect(registrations.setContinuationSecret).toHaveBeenCalledTimes(1);
    expect(registrations.create).not.toHaveBeenCalled();
    // A fresh secret every time: only the hash of the old one was ever stored, so
    // it could not be returned even if we wanted to.
    expect(outcome.continuationSecret).toEqual(expect.any(String));
  });
});

describe('OauthService.attachPending — the "link to an account I have" branch', () => {
  it('refuses an unknown, expired, or already-spent token', async () => {
    cache.get.mockResolvedValue(null);

    const err = await problem(service.attachPending('user-1', 'nope', client));

    expect(err.type).toBe(ERR.OAUTH_LINK_INVALID);
    expect(users.linkOauth).not.toHaveBeenCalled();
  });

  it('links the identity to the account that just proved itself', async () => {
    cache.get.mockResolvedValue(pending());
    cache.take.mockResolvedValue(pending());

    await service.attachPending('user-1', 'tok', client);

    expect(users.linkOauth).toHaveBeenCalledWith('user-1', {
      provider: 'GOOGLE',
      subject: 'google-sub-1',
      emailAtLink: 'Person@Example.com',
      emailVerifiedByProvider: true,
    });
  });

  it('spends the token BEFORE the link is written', async () => {
    // A link token is one-action capability. Consuming before the permanent write
    // removes the double-submit window between a read and a later delete.
    const order: string[] = [];
    cache.get.mockResolvedValue(pending());
    users.linkOauth.mockImplementation(async () => void order.push('link'));
    cache.take.mockImplementation(async () => {
      order.push('take');
      return pending();
    });

    await service.attachPending('user-1', 'tok', client);

    expect(order).toEqual(['take', 'link']);
  });

  it('retires the token when the link write fails', async () => {
    // Retrying a permanent credential write needs a fresh provider ceremony; a
    // retained capability is a replay window.
    cache.get.mockResolvedValue(pending());
    cache.take.mockResolvedValue(pending());
    users.linkOauth.mockRejectedValue(new Error('database is on fire'));

    await expect(service.attachPending('user-1', 'tok', client)).rejects.toThrow('database is on fire');
    expect(cache.take).toHaveBeenCalledWith(KEYS.oauth.pending('tok'));
  });

  it('reports a lost race against the unique index as already linked', async () => {
    // `ix_oauth_links_provider_subject_active` is a partial index in raw SQL, so it
    // surfaces as a bare 23505 rather than as Prisma's P2002 — which is why this
    // goes through `isUniqueViolation` and not an error-code equality check.
    cache.get.mockResolvedValue(pending());
    cache.take.mockResolvedValue(pending());
    users.linkOauth.mockRejectedValue(rawUniqueViolation());

    const err = await problem(service.attachPending('user-1', 'tok', client));

    expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
    expect(cache.take).toHaveBeenCalledWith(KEYS.oauth.pending('tok'));
  });
});

/**
 * ═══ THE FLOW MUST FINISH WHERE IT STARTED ═════════════════════════════════
 *
 * Every OAuth handle — the `state`, and the `linkToken` that outlives it — has been
 * parked with the caller's `ipClass` since those entries were first written, and
 * until this landed nothing read either. These are the reader.
 *
 * The handles travel through a browser: a redirect, a URL, a `Referer`, shared
 * history. Binding the return leg to the network the outbound leg came from is what
 * stops one being redeemed from somewhere else. It is defence in depth — PKCE
 * already covers the code, and linking already needs a session and a ticket — so
 * the tests below care as much about the FALSE POSITIVE half as the refusal half.
 */
describe('OauthService — the ipClass recorded with every parked handle', () => {
  const ELSEWHERE: ClientContext = { ...client, ip: '198.51.100.9', ipClass: '198.51.100.0/24' };

  function stashState(ipClass: string | undefined): void {
    cache.take.mockResolvedValue(
      JSON.stringify({
        provider: 'GOOGLE',
        redirectUri: config.GOOGLE_REDIRECT_URI,
        ipClass,
        codeVerifier: 'v',
        nonce: 'n',
      }),
    );
  }

  function callbackFrom(ctx: ClientContext): Promise<unknown> {
    return service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'GOOGLE', code: 'auth-code', state: 'state' },
      ctx,
    );
  }

  it('refuses a callback returning from a different subnet', async () => {
    stashState(client.ipClass);

    const err = await problem(callbackFrom(ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
  });

  it('refuses BEFORE spending a Google token exchange', async () => {
    // Ordering, and it is not just efficiency: a callback from elsewhere must never
    // become a verified identity that something downstream then has to decide what
    // to do with. The service's `google` client is untouched here, so reaching the
    // exchange at all would throw a different error than the one asserted.
    stashState(client.ipClass);

    const err = await problem(callbackFrom(ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
  });

  it('refuses the "create an account" branch from a different subnet', async () => {
    cache.take.mockResolvedValue(pending());

    const err = await problem(service.chooseRegister('tok', ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
    expect(registrations.create).not.toHaveBeenCalled();
  });

  it('refuses attaching a provider from a different subnet', async () => {
    // The one that matters most: an `OauthLink` outlives a password change, a
    // session sweep and an email change.
    cache.get.mockResolvedValue(pending());
    cache.take.mockResolvedValue(pending());

    const err = await problem(service.attachPending('user-1', 'tok', ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
    expect(users.linkOauth).not.toHaveBeenCalled();
  });

  it('refuses a preview from a different subnet too', async () => {
    // Reads nothing into the database, but it does disclose which provider account
    // is parked behind a handle — so it is checked on the same terms.
    cache.get.mockResolvedValue(pending());

    const err = await problem(service.previewPending('tok', ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
  });

  it('allows a different ADDRESS inside the same subnet', async () => {
    // The false-positive half, and the reason `ipClassOf` returns a prefix at all:
    // a mobile client's exact address changes constantly within one carrier block.
    // Comparing full addresses would refuse nearly every legitimate flow.
    const sameBlock: ClientContext = { ...client, ip: '203.0.113.200' };
    cache.get.mockResolvedValue(pending());
    cache.take.mockResolvedValue(pending());

    await expect(service.attachPending('user-1', 'tok', sameBlock)).resolves.toBeUndefined();
  });

  it('rejects a handle that predates mandatory device binding', async () => {
    // Security capabilities are never made compatible with unbound legacy entries.
    cache.get.mockResolvedValue(JSON.stringify({ identity: IDENTITY }));

    const err = await problem(service.attachPending('user-1', 'tok', ELSEWHERE));
    expect(err.type).toBe(ERR.OAUTH_LINK_INVALID);
  });
});
