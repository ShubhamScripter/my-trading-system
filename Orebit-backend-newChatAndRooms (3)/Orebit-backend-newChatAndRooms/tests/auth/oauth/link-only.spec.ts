import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientContext, OauthIdentity } from '../../../auth/auth.types';
import type { RegistrationDbOperation } from '../../../auth/persistence/registration.dboperation';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
} from '../../../auth/oauth/provider.port';
import { OauthProviderRegistry } from '../../../auth/oauth/registry';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import { OauthService } from '../../../auth/services/oauth.service';
import type { SessionService } from '../../../auth/services/session.service';
import type { MfaService } from '../../../src/2fa/mfa.service';
import { makeLoginAttempt } from '../../harness';
import type { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import { type CacheService, type QuotaService } from '../../../redis';
import { ERR } from '../../../src/contracts';
import type { GeoResolver } from '../../../src/geo/geo.types';
import { ProblemException } from '../../../src/http';
import type { MailService } from '../../../src/mail/mail.service';

/**
 * The shared flow's handling of a provider that cannot supply an email.
 *
 * X and Telegram never can, and Apple and Facebook sometimes cannot. This is the one
 * piece of genuinely new logic in `OauthService` — everything else about the adapter
 * refactor was a behaviour-preserving move — and it is testable now, with no
 * credentials, because the flow's decision depends only on `identity.email` being
 * null and not on which provider produced it.
 *
 * A hand-written adapter rather than one of the real four, deliberately. The real X
 * adapter would need a doubled token exchange and a doubled userinfo call to reach
 * the same branch, and those doubles would be asserting my own idea of X's response
 * shape — which is exactly the thing that cannot be verified without credentials.
 * This fake asserts what the SERVICE does with an emailless identity, which is
 * verifiable today and is where the product decision lives.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

const EMAILLESS_IDENTITY: OauthIdentity = {
  provider: 'X',
  subject: 'x-subject-1',
  email: null,
  emailVerified: false,
  name: 'Ada',
  avatarUrl: null,
};

/** An adapter that verifies successfully and returns no email — X's real shape. */
class FakeEmaillessAdapter implements OauthProviderAdapter {
  readonly provider = 'X' as const;
  readonly capabilities: ProviderCapabilities = {
    flow: 'oauth2-code',
    providesEmail: 'never',
    supportsPkce: true,
    supportsNonce: false,
    assertsEmailVerified: false,
  };
  readonly configuredRedirectUri = 'https://app.example.test/auth/x/callback';

  isConfigured(): boolean {
    return true;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    return `https://x.example.test/authorize?state=${request.state}`;
  }

  verify(): Promise<OauthIdentity> {
    return Promise.resolve(EMAILLESS_IDENTITY);
  }
}

let users: {
  findOauthLink: ReturnType<typeof vi.fn>;
  findWithCredential: ReturnType<typeof vi.fn>;
  touchOauthLogin: ReturnType<typeof vi.fn>;
  touchLastSeen: ReturnType<typeof vi.fn>;
  emailExists: ReturnType<typeof vi.fn>;
  linkOauth: ReturnType<typeof vi.fn>;
};
let cache: {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  take: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
};
let blocklist: { assertNotBlocked: ReturnType<typeof vi.fn> };
let sessions: { issue: ReturnType<typeof vi.fn> };
let mfa: { challengeFor: ReturnType<typeof vi.fn> };
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
const flow = () =>
  makeLoginAttempt({ id: 'flow-1', state: 'STARTED', userId: null, identifierLower: null });


beforeEach(() => {
  users = {
    findOauthLink: vi.fn().mockResolvedValue(null),
    findWithCredential: vi.fn().mockResolvedValue(null),
    touchOauthLogin: vi.fn(),
    touchLastSeen: vi.fn(),
    emailExists: vi.fn().mockResolvedValue(false),
    linkOauth: vi.fn().mockResolvedValue(undefined),
  };
  cache = {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    // A state entry naming X, so the provider check passes and the callback reaches
    // the adapter.
    take: vi.fn().mockResolvedValue(
      JSON.stringify({
        provider: 'X',
        redirectUri: 'https://app.example.test/auth/x/callback',
        ipClass: client.ipClass,
        codeVerifier: 'verifier',
      }),
    ),
    consume: vi.fn().mockResolvedValue(undefined),
  };
  blocklist = { assertNotBlocked: vi.fn().mockResolvedValue(undefined) };
  sessions = { issue: vi.fn().mockResolvedValue({ sessionId: 's1' }) };
  mfa = { challengeFor: vi.fn().mockResolvedValue(null) };
  attempts = {
    createFlow: vi.fn(),
    promoteAttempt: vi.fn().mockResolvedValue(true),
    completeAttempt: vi.fn().mockResolvedValue(true),
    markOtpSent: vi.fn().mockResolvedValue(true),
    findAttemptByTokenHash: vi.fn().mockResolvedValue(null),
    expireAttempt: vi.fn().mockResolvedValue(undefined),
  };


  service = new OauthService(
    users as unknown as UserDbOperation,
    { findResumableByOauth: vi.fn(), create: vi.fn(), setContinuationSecret: vi.fn() } as unknown as RegistrationDbOperation,
    sessions as unknown as SessionService,
    { sendOtp: vi.fn() } as unknown as MailService,
    cache as unknown as CacheService,
    { consumeAll: vi.fn().mockResolvedValue({ token: 'quota', keys: [] }) } as unknown as QuotaService,
    blocklist as unknown as BlocklistService,
    mfa as unknown as MfaService,
    attempts as unknown as TwoFactorDbOperation,
    new OauthProviderRegistry([new FakeEmaillessAdapter()]),
    { resolve: vi.fn().mockResolvedValue({ ip: client.ip, country: null }) } as unknown as GeoResolver,
  );
});

function callback(): Promise<unknown> {
  return service.callback(
      flow(),
      {
        step: 'oauth-callback',
        loginId: 'l'.repeat(43), provider: 'X', code: 'auth-code', state: 'state' },
    client,
  );
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

describe('an emailless provider identity that is not linked yet', () => {
  it('offers the choice with the create branch closed, rather than failing', async () => {
    // The behaviour change worth pinning. This used to throw
    // `oauth_exchange_failed` — a 502 blaming the provider for behaving exactly as
    // documented. Nothing failed: the sign-in succeeded and the identity is genuine.
    const outcome = (await callback()) as {
      kind: string;
      email: string | null;
      canCreateNew: boolean;
      provider: string;
      linkToken: string;
    };

    expect(outcome.kind).toBe('choice_required');
    expect(outcome.email).toBeNull();
    expect(outcome.canCreateNew).toBe(false);
    expect(outcome.provider).toBe('X');
    expect(outcome.linkToken).toBeTruthy();
  });

  it('parks the identity so the link branch has something to attach', async () => {
    // Without this the choice would be unactionable: `attachPending` reads the
    // identity back out of the cache, and it is the only route an X identity has to
    // an account.
    await callback();

    const parked = cache.set.mock.calls.find(([key]) => String(key).includes('pending'));
    expect(parked).toBeDefined();

    const [, value] = parked as [string, string];
    expect(JSON.parse(value)).toMatchObject({
      identity: { provider: 'X', subject: 'x-subject-1', email: null },
      ipClass: client.ipClass,
    });
  });

  it('does not consult the blocklist, having no address to consult it about', async () => {
    // Not an oversight worth flagging: the blocklist is keyed on an email, and there
    // is none. The check still runs on the linked-account path below, which is where
    // an address exists.
    await callback();
    expect(blocklist.assertNotBlocked).not.toHaveBeenCalled();
  });

  it('never mints a session, because nothing is linked yet', async () => {
    await callback();
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});

describe('an emailless provider identity that IS already linked', () => {
  beforeEach(() => {
    users.findOauthLink.mockResolvedValue({
      id: 'link-1',
      userId: 'user-1',
      user: { status: 'ACTIVE', emailLower: 'ada@example.test' },
    });
    users.findWithCredential.mockResolvedValue({
      user: { id: 'user-1', email: 'ada@example.test' },
      credential: null,
    });
  });

  it('signs in normally — a linked identity needs no email to find its account', async () => {
    // The other half of the design, and the reason link-only is a usable product
    // rather than a dead end: once attached, "Continue with X" works forever.
    const outcome = (await callback()) as { kind: string };

    expect(outcome.kind).toBe('session');
    expect(sessions.issue).toHaveBeenCalledTimes(1);
  });

  it('still applies the blocklist to the linked account', async () => {
    // A linked provider identity is the shortest path to a session in the service,
    // which is exactly why the blocklist has to be on it.
    await callback();
    expect(blocklist.assertNotBlocked).toHaveBeenCalledWith('ada@example.test');
  });

  it('still demands the second factor', async () => {
    // The bypass this must not reopen: a user who switched 2FA on must not find that
    // "Continue with X" turned it back off.
    mfa.challengeFor.mockResolvedValue({
      mfaToken: 'token',
      methods: ['totp'],
      expiresAt: new Date(),
    });

    const outcome = (await callback()) as { kind: string };

    expect(outcome.kind).toBe('mfa_required');
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});

describe('taking the create branch anyway', () => {
  it('refuses with a slug that names the actual problem', async () => {
    // A client that ignored `canCreateNew`. `oauth_email_unavailable` is a 409 whose
    // remedy is specific — sign up with an email, then link this — where
    // `oauth_exchange_failed` would be a 502 telling the user to try again at a
    // provider that is working perfectly.
    cache.take.mockResolvedValue(
      JSON.stringify({
        identity: EMAILLESS_IDENTITY,
        ipClass: client.ipClass,
        deviceKey: client.deviceKey,
        purpose: 'oauth-choice',
      }),
    );

    const err = await problem(service.chooseRegister('link-token', client));

    expect(err.type).toBe(ERR.OAUTH_EMAIL_UNAVAILABLE);
  });
});

describe('the provider a state was minted for is the provider that may redeem it', () => {
  it('refuses a callback naming a different provider than the authorization request', async () => {
    // Sharper than a failed exchange for the signed-payload providers: Telegram's
    // verification needs no round trip at all, so which adapter gets to check a
    // caller-supplied payload must not be the caller's choice.
    cache.take.mockResolvedValue(
      JSON.stringify({
        provider: 'GOOGLE',
        redirectUri: 'https://app.example.test/auth/x/callback',
        ipClass: client.ipClass,
      }),
    );

    const err = await problem(callback());
    expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
  });

  it('tolerates a state entry written before the provider was recorded', async () => {
    // The rolling-deploy tolerance, and safe for a specific reason: after this
    // deploy every entry `start` writes carries a provider, so an attacker cannot
    // manufacture one that lacks it. The only provider-less entries are legitimate
    // flows already in flight, and they drain within the state TTL.
    cache.take.mockResolvedValue(
      JSON.stringify({
        redirectUri: 'https://app.example.test/auth/x/callback',
        ipClass: client.ipClass,
      }),
    );

    const outcome = (await callback()) as { kind: string };
    expect(outcome.kind).toBe('choice_required');
  });
});
