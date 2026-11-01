import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OauthProvider } from '@prisma/client';
import { KEYS } from '../../../redis';
import { OauthProviderRegistry } from '../../../auth/oauth/registry';
import type { OauthProviderAdapter } from '../../../auth/oauth/provider.port';
import { OauthService } from '../../../auth/services/oauth.service';
import type { OauthIdentity } from '../../../auth/auth.types';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { rawUniqueViolation } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `startLink` / `completeLink` are the Settings half of OAuth, and they exist for
 * one reason: the LOGIN callback resolves an already-linked identity into a session
 * and sets the caller's session cookie from it. Run from a settings screen that
 * would silently sign a user in as whoever owns the provider account they were
 * trying to attach.
 *
 * So the questions here are:
 *
 *   1. Is a link state reachable from the login callback, or the reverse? (No —
 *      they are separate Redis namespaces, and that is asserted rather than assumed.)
 *   2. Can user B redeem a state minted for user A?
 *   3. Is a state that does not carry a user tolerated, the way `callback` tolerates
 *      a missing `loginAttemptId`? (It must not be.)
 *   4. Does anything on any path mint a session?
 *   5. Does an identity that belongs elsewhere refuse, without writing a row?
 *
 * ─── On the doubles ─────────────────────────────────────────────────────────
 *
 * `cache` is a real `Map`, not a stub, because most of this file is about what is
 * under WHICH KEY and whether a read removed it. A stub returning fixed values could
 * not express "the login callback looks somewhere else" or "single-use".
 *
 * The adapter is a double here, unlike tests/auth/services/oauth.service.spec.ts,
 * which uses a real `GoogleAdapter` because it is asserting PKCE and nonce
 * construction. Nothing in this file is about what Google is told; it is about what
 * happens to the answer.
 */

const USER_A = 'user-a';
const USER_B = 'user-b';

const PRINCIPAL_A = { userId: USER_A, sessionId: 'session-a', familyId: 'family-a' };
const PRINCIPAL_B = { userId: USER_B, sessionId: 'session-b', familyId: 'family-b' };

const client = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest',
};

const IDENTITY: OauthIdentity = {
  provider: 'GOOGLE',
  subject: 'google-subject-1',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada',
  avatarUrl: 'https://cdn.example.com/ada.png',
};

/** A stand-in adapter. Its `verify` answers whatever the spec set. */
function createAdapter(provider: OauthProvider = 'GOOGLE'): OauthProviderAdapter & {
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    provider,
    capabilities: {
      flow: 'oidc-code',
      providesEmail: 'always',
      supportsPkce: true,
      supportsNonce: true,
      assertsEmailVerified: true,
    },
    isConfigured: () => true,
    configuredRedirectUri: 'https://app.example.com/oauth/callback',
    authorizationUrl: () => 'https://provider.example.com/authorize',
    verify: vi.fn(async () => IDENTITY),
  } as never;
}

/** A real store, so "which key" and "single use" are observable. */
function createCache() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    take: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    consume: vi.fn(async () => undefined),
    setIfAbsent: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    }),
    clearIfValue: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

describe('OauthService — the Settings link ceremony', () => {
  let cache: ReturnType<typeof createCache>;
  let users: {
    findOauthLink: ReturnType<typeof vi.fn>;
    listOauthLinks: ReturnType<typeof vi.fn>;
    linkOauth: ReturnType<typeof vi.fn>;
    cancelOauthUnlink: ReturnType<typeof vi.fn>;
  };
  let sessions: { issue: ReturnType<typeof vi.fn> };
  let adapter: ReturnType<typeof createAdapter>;
  let service: OauthService;

  function build(...adapters: OauthProviderAdapter[]): OauthService {
    return new OauthService(
      users as never,
      { create: vi.fn(), findResumableByOauth: vi.fn() } as never,
      sessions as never,
      { sendOtp: vi.fn() } as never,
      cache as never,
      { consumeAll: vi.fn().mockResolvedValue({ token: 'q', keys: [] }) } as never,
      { assertNotBlocked: vi.fn() } as never,
      { challengeFor: vi.fn() } as never,
      { promoteAttempt: vi.fn(), completeAttempt: vi.fn() } as never,
      new OauthProviderRegistry(adapters.length > 0 ? adapters : [adapter]),
      { resolve: vi.fn() } as never,
    );
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

  /** Start a ceremony for A and hand back the state it minted. */
  async function startFor(
    principal = PRINCIPAL_A,
    provider: OauthProvider = 'GOOGLE',
  ): Promise<string> {
    const started = await service.startLink(principal, { provider }, client);
    return started.state;
  }

  const callbackInput = (state: string, provider: OauthProvider = 'GOOGLE') => ({
    provider,
    code: 'authorization-code',
    state,
  });

  beforeEach(() => {
    cache = createCache();
    users = {
      findOauthLink: vi.fn().mockResolvedValue(null),
      listOauthLinks: vi.fn().mockResolvedValue([]),
      linkOauth: vi.fn().mockResolvedValue(undefined),
      cancelOauthUnlink: vi.fn().mockResolvedValue(true),
    };
    sessions = { issue: vi.fn() };
    adapter = createAdapter();
    service = build();
  });

  // ─── the keyspace, which is the isolation ─────────────────────────────────

  describe('a link state lives in its own namespace', () => {
    it('writes under oauth.linkState, never under oauth.state', async () => {
      const state = await startFor();

      expect(cache.store.has(KEYS.oauth.linkState(state))).toBe(true);
      // THE property this whole design rests on. If a link state were readable
      // here, `POST /auth/login {step:'oauth-callback'}` could redeem it — and that
      // path mints a session and sets the caller's session cookie.
      expect(cache.store.has(KEYS.oauth.state(state))).toBe(false);
    });

    it('refuses a state parked by the LOGIN flow', async () => {
      // The mirror of the case above: a login state must not finish as a link.
      cache.store.set(
        KEYS.oauth.state('login-state'),
        JSON.stringify({ provider: 'GOOGLE', redirectUri: '', ipClass: client.ipClass }),
      );

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput('login-state'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
      expect(adapter.verify).not.toHaveBeenCalled();
    });

    it('opens no login flow — a link is not a sign-in', async () => {
      await startFor();
      // `start` takes an `openFlow` callback and writes a LoginAttempt row.
      // `startLink` has no such parameter, and nothing here should create one.
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });

  // ─── binding to the account ───────────────────────────────────────────────

  describe('the state belongs to the account that started it', () => {
    it('lets the account that started it finish', async () => {
      const state = await startFor();
      await expect(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      ).resolves.toMatchObject({ subject: 'google-subject-1' });
      expect(users.linkOauth).toHaveBeenCalledOnce();
    });

    it('refuses a state minted for user A when user B presents it', async () => {
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_B, callbackInput(state), client),
      );
      // `oauth_state_invalid` rather than something that says "this is someone
      // else's": a caller holding a state they were not given learns nothing.
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
      expect(adapter.verify).not.toHaveBeenCalled();
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('refuses when the login family differs, even for the right account', async () => {
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(
          { ...PRINCIPAL_A, familyId: 'family-elsewhere' },
          callbackInput(state),
          client,
        ),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
    });

    it('binds to the family rather than the session generation', async () => {
      // Under the BFF the backend rotates the access token on its own schedule, so
      // `sessionId` changes silently mid-flow. Binding to it would refuse a
      // legitimate user whose token happened to rotate while they were at Google.
      const state = await startFor(PRINCIPAL_A);

      await expect(
        service.completeLink(
          { ...PRINCIPAL_A, sessionId: 'rotated-generation' },
          callbackInput(state),
          client,
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('a state that carries no account is refused, not tolerated', () => {
    it.each([
      ['no linkUserId', { linkFamilyId: 'family-a' }],
      ['no linkFamilyId', { linkUserId: USER_A }],
      ['an empty linkUserId', { linkUserId: '', linkFamilyId: 'family-a' }],
      ['neither', {}],
    ])('refuses a stash with %s', async (_label, extra) => {
      // `callback` deliberately TOLERATES a missing `loginAttemptId`, because an
      // entry written by the previous deploy genuinely has none. That argument does
      // not transfer: `linkUserId` is the authorisation check itself, and no link
      // state has ever been written without one.
      cache.store.set(
        KEYS.oauth.linkState('forged'),
        JSON.stringify({
          provider: 'GOOGLE',
          redirectUri: adapter.configuredRedirectUri,
          ipClass: client.ipClass,
          ...extra,
        }),
      );

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput('forged'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('refuses an unparseable stash rather than throwing a SyntaxError', async () => {
      cache.store.set(KEYS.oauth.linkState('junk'), 'not json');

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput('junk'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
    });
  });

  // ─── the ordinary state controls, kept ────────────────────────────────────

  describe('the state controls the login flow has', () => {
    it('is single-use — the second attempt finds nothing', async () => {
      const state = await startFor();
      await service.completeLink(PRINCIPAL_A, callbackInput(state), client);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
      expect(users.linkOauth).toHaveBeenCalledOnce();
    });

    it('refuses an unknown state', async () => {
      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput('never-minted'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
    });

    it('refuses a callback naming a different provider than the request', async () => {
      const apple = createAdapter('APPLE');
      service = build(adapter, apple);
      const state = await startFor(PRINCIPAL_A, 'GOOGLE');

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state, 'APPLE'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_STATE_INVALID);
      expect(apple.verify).not.toHaveBeenCalled();
    });

    it('records no device key, because this prefix never receives one', async () => {
      // `DEVICE.COOKIE_PATH` is `/auth`, so the browser never sends the device
      // cookie to `/settings/*` and `deviceCookie()` would MINT a fresh one on every
      // call. A state bound to that would record one device at `start` and see a
      // different one at `callback`, so no link could ever complete — which is
      // exactly what happened the first time this was driven with curl.
      const state = await startFor();
      const stash = JSON.parse(
        cache.store.get(KEYS.oauth.linkState(state)) as string,
      ) as Record<string, unknown>;

      expect(stash).not.toHaveProperty('deviceKey');
      // The family binding replaces it and is the stronger claim: a device cookie
      // says "the same browser", a family says "the same login in that browser".
      expect(stash.linkFamilyId).toBe(PRINCIPAL_A.familyId);
      expect(stash.ipClass).toBe(client.ipClass);
    });

    it('completes from a request carrying no device identity at all', async () => {
      // The regression guard for the bug above: the ceremony must finish when the
      // only thing the two legs share is the account, the login and the network.
      const state = await startFor();

      await expect(
        service.completeLink(PRINCIPAL_A, callbackInput(state), {
          ip: client.ip,
          ipClass: client.ipClass,
        }),
      ).resolves.toBeTruthy();
      expect(users.linkOauth).toHaveBeenCalledOnce();
    });

    it('refuses a callback from a different network', async () => {
      const state = await startFor();

      const err = await problem(
        service.completeLink(
          PRINCIPAL_A,
          callbackInput(state),
          { ...client, ip: '198.51.100.7', ipClass: '198.51.100.0/24' },
        ),
      );
      expect(err.type).toBe(ERR.OAUTH_CONTEXT_MISMATCH);
    });

    it('refuses an unconfigured provider before anything else', async () => {
      const unconfigured = { ...createAdapter('APPLE'), isConfigured: () => false };
      service = build(adapter, unconfigured as never);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput('any', 'APPLE'), client),
      );
      expect(err.type).toBe(ERR.OAUTH_PROVIDER_UNSUPPORTED);
    });

    it('checks the binding BEFORE spending a provider token exchange', async () => {
      const state = await startFor(PRINCIPAL_A);
      await problem(service.completeLink(PRINCIPAL_B, callbackInput(state), client));
      // A callback that does not belong to this ceremony must never turn an
      // authorization code into a verified identity we then have to decide about.
      expect(adapter.verify).not.toHaveBeenCalled();
    });
  });

  // ─── never a session ──────────────────────────────────────────────────────

  describe('no path mints a session', () => {
    it('issues none on a successful link', async () => {
      const state = await startFor();
      await service.completeLink(PRINCIPAL_A, callbackInput(state), client);
      expect(sessions.issue).not.toHaveBeenCalled();
    });

    it('issues none when the identity already belongs to another account', async () => {
      // THE case this whole module exists for. The LOGIN callback would resolve
      // this identity to a session and replace the caller's cookie.
      users.findOauthLink.mockResolvedValue({ id: 'link-x', userId: USER_B });
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(err.status).toBe(409);
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(users.linkOauth).not.toHaveBeenCalled();
    });
  });

  // ─── the uniqueness rule ──────────────────────────────────────────────────

  describe('one external account, one Orebit account', () => {
    it('refuses an identity already linked to somebody else', async () => {
      users.findOauthLink.mockResolvedValue({ id: 'link-x', userId: USER_B });
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(err.detail).toContain('a different Orebit account');
    });

    it('refuses an identity already linked to the CALLER, rather than duplicating it', async () => {
      users.findOauthLink.mockResolvedValue({ id: 'link-a', userId: USER_A, unlinkAt: null });
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(err.detail).toContain('already linked to this Orebit account');
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('refuses a SECOND account of a provider this user already holds', async () => {
      users.listOauthLinks.mockResolvedValue([
        { provider: 'GOOGLE', subject: 'other', unlinkAt: null },
      ]);
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(users.linkOauth).not.toHaveBeenCalled();
    });
  });

  // ─── re-linking takes a pending unlink back ───────────────────────────────

  /**
   * The only way to cancel a scheduled unlink, and the reason there is no cancel
   * endpoint. See `attachToAccount`.
   *
   * The asymmetry these assertions pin down is the whole design: re-linking the SAME
   * provider identity restores the status quo and is allowed, while a DIFFERENT
   * identity for that provider would be a swap and must wait out the deadline —
   * otherwise anyone holding a session and the mailbox could replace the social login
   * in a single ceremony, which is exactly what the seven days exist to prevent.
   */
  describe('a pending unlink and a re-link', () => {
    const PENDING = new Date('2026-09-18T12:00:00.000Z');

    it('cancels the unlink when the SAME identity is re-linked', async () => {
      users.findOauthLink.mockResolvedValue({
        id: 'link-a',
        userId: USER_A,
        unlinkAt: PENDING,
      });
      const state = await startFor(PRINCIPAL_A);

      await expect(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      ).resolves.toBeDefined();

      expect(users.cancelOauthUnlink).toHaveBeenCalledWith('link-a');
      // Nothing new is written: the row that was counting down is the row that stays.
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('still refuses the same identity when NO unlink is pending', async () => {
      // The pre-existing rule, unchanged. Only a pending row opens the cancel path.
      users.findOauthLink.mockResolvedValue({ id: 'link-a', userId: USER_A, unlinkAt: null });
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(users.cancelOauthUnlink).not.toHaveBeenCalled();
    });

    it('never cancels a pending unlink belonging to ANOTHER account', async () => {
      users.findOauthLink.mockResolvedValue({ id: 'link-x', userId: USER_B, unlinkAt: PENDING });
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(err.detail).toContain('a different Orebit account');
      expect(users.cancelOauthUnlink).not.toHaveBeenCalled();
    });

    it('refuses a DIFFERENT account of that provider, naming the deadline', async () => {
      users.listOauthLinks.mockResolvedValue([
        { provider: 'GOOGLE', subject: 'other', unlinkAt: PENDING },
      ]);
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      // The date is the point: "already linked" alone reads as a contradiction to
      // somebody who asked to unlink it an hour ago.
      expect(err.detail).toContain(PENDING.toISOString());
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('falls through to the refusal when the sweep wins the race', async () => {
      // The row was retired between the read and the cancel, so the conditional
      // update matched nothing. Refusing is honest — the caller retries and links
      // fresh against a now-absent row — and nothing is left half-written.
      users.findOauthLink.mockResolvedValue({
        id: 'link-a',
        userId: USER_A,
        unlinkAt: PENDING,
      });
      users.cancelOauthUnlink.mockResolvedValue(false);
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(users.linkOauth).not.toHaveBeenCalled();
    });

    it('lets the unique index have the last word on a race', async () => {
      // Both reads above are races — a second tab can commit in between — so the
      // partial unique indexes are the authority and the insert catches 23505.
      users.linkOauth.mockRejectedValue(rawUniqueViolation());
      const state = await startFor(PRINCIPAL_A);

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
    });
  });

  // ─── what gets written ────────────────────────────────────────────────────

  describe('the stored link', () => {
    it('records the provider metadata the settings screen renders', async () => {
      const state = await startFor();
      await service.completeLink(PRINCIPAL_A, callbackInput(state), client);

      expect(users.linkOauth).toHaveBeenCalledWith(USER_A, {
        provider: 'GOOGLE',
        subject: 'google-subject-1',
        emailAtLink: 'ada@example.com',
        emailVerifiedByProvider: true,
        avatarUrl: 'https://cdn.example.com/ada.png',
        nameAtLink: 'Ada',
      });
    });

    it('attaches to the principal, never to the account named in the stash', async () => {
      const state = await startFor(PRINCIPAL_A);
      await service.completeLink(PRINCIPAL_A, callbackInput(state), client);

      const [userId] = users.linkOauth.mock.calls[0] as [string];
      expect(userId).toBe(PRINCIPAL_A.userId);
    });

    it('stores nulls rather than inventing values for a provider that supplies none', async () => {
      // Apple publishes no name and no avatar; X and Telegram supply no address.
      adapter.verify.mockResolvedValue({
        provider: 'GOOGLE',
        subject: 'sparse-subject',
        email: null,
        emailVerified: false,
        name: null,
        avatarUrl: null,
      });
      const state = await startFor();
      await service.completeLink(PRINCIPAL_A, callbackInput(state), client);

      expect(users.linkOauth).toHaveBeenCalledWith(
        USER_A,
        expect.objectContaining({ emailAtLink: '', nameAtLink: null, avatarUrl: null }),
      );
    });

    it('refuses an adapter that answers with a different provider', async () => {
      adapter.verify.mockResolvedValue({ ...IDENTITY, provider: 'FACEBOOK' });
      const state = await startFor();

      const err = await problem(
        service.completeLink(PRINCIPAL_A, callbackInput(state), client),
      );
      // Subjects are unique only WITHIN a provider, so this would be a genuine
      // cross-provider collision rather than a tidiness check.
      expect(err.type).toBe(ERR.OAUTH_EXCHANGE_FAILED);
      expect(users.linkOauth).not.toHaveBeenCalled();
    });
  });

  // ─── provider shapes ──────────────────────────────────────────────────────

  describe('providers that do not redirect', () => {
    it('carries a null authorization URL through, with the flow that explains it', async () => {
      const telegram = {
        ...createAdapter('TELEGRAM'),
        capabilities: {
          flow: 'signed-payload',
          providesEmail: 'never',
          supportsPkce: false,
          supportsNonce: false,
          assertsEmailVerified: false,
        },
        configuredRedirectUri: '',
        authorizationUrl: () => null,
      };
      service = build(telegram as never);

      const started = await service.startLink(PRINCIPAL_A, { provider: 'TELEGRAM' }, client);
      expect(started.url).toBeNull();
      expect(started.flow).toBe('signed-payload');
      // The state is still minted, which is the point of routing Telegram through
      // here at all — it buys the single-use state and every binding on it.
      expect(cache.store.has(KEYS.oauth.linkState(started.state))).toBe(true);
    });

    it('parks no PKCE verifier or nonce for a provider that ignores them', async () => {
      const telegram = {
        ...createAdapter('TELEGRAM'),
        capabilities: {
          flow: 'signed-payload',
          providesEmail: 'never',
          supportsPkce: false,
          supportsNonce: false,
          assertsEmailVerified: false,
        },
        configuredRedirectUri: '',
        authorizationUrl: () => null,
      };
      service = build(telegram as never);

      const started = await service.startLink(PRINCIPAL_A, { provider: 'TELEGRAM' }, client);
      const stash = JSON.parse(
        cache.store.get(KEYS.oauth.linkState(started.state)) as string,
      ) as Record<string, unknown>;
      // Reading back a verifier that proves nothing would look like a control that
      // is not there.
      expect(stash.codeVerifier).toBeUndefined();
      expect(stash.nonce).toBeUndefined();
    });
  });

  describe('startLink', () => {
    it('refuses an unconfigured provider without parking a state', async () => {
      const unconfigured = { ...createAdapter('APPLE'), isConfigured: () => false };
      service = build(adapter, unconfigured as never);

      const err = await problem(
        service.startLink(PRINCIPAL_A, { provider: 'APPLE' }, client),
      );
      expect(err.type).toBe(ERR.OAUTH_PROVIDER_UNSUPPORTED);
      expect(cache.store.size).toBe(0);
    });

    it('refuses a redirect URI that is not the configured one', async () => {
      const err = await problem(
        service.startLink(
          PRINCIPAL_A,
          { provider: 'GOOGLE', redirectUri: 'https://evil.example.com/steal' },
          client,
        ),
      );
      // Accepting an arbitrary value is an open redirect: the authorization code
      // arrives at whatever address is named.
      expect(err.type).toBe(ERR.VALIDATION_FAILED);
      expect(cache.store.size).toBe(0);
    });

    it('mints a different state every time', async () => {
      const first = await startFor();
      const second = await startFor();
      expect(first).not.toBe(second);
    });

    it('never returns the verifier or the nonce to the caller', async () => {
      const started = await service.startLink(PRINCIPAL_A, { provider: 'GOOGLE' }, client);
      const stash = JSON.parse(
        cache.store.get(KEYS.oauth.linkState(started.state)) as string,
      ) as { codeVerifier: string; nonce: string };

      const serialised = JSON.stringify(started);
      expect(serialised).not.toContain(stash.codeVerifier);
      expect(serialised).not.toContain(stash.nonce);
    });
  });

  describe('availableProviders', () => {
    it('reports only what this deployment has credentials for', () => {
      const unconfigured = { ...createAdapter('APPLE'), isConfigured: () => false };
      service = build(adapter, unconfigured as never);

      expect(service.availableProviders()).toEqual(['GOOGLE']);
    });
  });
});
