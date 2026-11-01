import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OauthLink, OauthProvider } from '@prisma/client';
import { policy } from '../../../auth/limits';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { LinkAccountsService } from '../../../src/settings/link-accounts/link-accounts.service';
import { makePrincipal, makeUser } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * The product rule this service exists to enforce is a four-case table, and three of
 * the four are ways a user could be locked out rather than ways an attacker could
 * get in. So most of this file is about what is NOT demanded:
 *
 *   1. authenticator only → the emailed code and a TOTP code, and no passkey prompt
 *   2. passkey only       → the emailed code and an assertion, and no TOTP prompt
 *   3. both enrolled      → the emailed code and EITHER, the caller's choice
 *   4. neither enrolled   → the emailed code ALONE — in particular, no password
 *
 * Case 4 is the one worth the most scrutiny. `TwoFactorService.reauthVerify` answers
 * the same question by falling back to the account password, which would be wrong
 * twice over here: it is not what the product asks for, and an account created
 * through a provider has no credential row at all, so it would make linking a second
 * provider impossible for exactly the people most likely to want one. This file
 * asserts the password is never consulted.
 *
 * The other half is ordering. A refusal the server could issue for free must not
 * first cost the user their emailed code — the same discipline `SettingsService`
 * keeps for `assertPathAvailable` — while a request that gets as far as comparing a
 * factor must have spent the code whatever the answer.
 *
 * ─── On the doubles ─────────────────────────────────────────────────────────
 *
 * `mfa` is DERIVED from the enrolment fixture rather than stubbed independently, for
 * the reason `settings.service.spec.ts` gives: two free-standing stubs can describe
 * an account that cannot exist — `availableMethods: ['passkey']` on an account with
 * no passkeys. Here one helper sets both.
 *
 * `oauth` is a stub of the boundary, not of OAuth. Everything this service does with
 * a provider is one call to `startLink` or `completeLink`; the state binding, the
 * PKCE verifier and the link write are asserted in tests/auth/oauth/link-state.spec.ts.
 */

const USER = makeUser();
const PRINCIPAL = makePrincipal({ userId: USER.id });
const EMAIL_CODE = '123456';
const TOTP_CODE = '654321';
const PASSKEY = { id: 'credential-1' };
const IP_CLASS = '203.0.113.0/24';

/**
 * Written out rather than imported from `SOCIAL_UNLINK.DELAY_DAYS`, deliberately.
 *
 * Importing the constant would make this assertion agree with the service by
 * construction — change the constant to one day and the spec would happily follow.
 * Seven days is the product promise, so the spec states it independently and fails
 * if the code stops honouring it.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** One stored link, with the columns the settings screen reads. */
function makeLink(overrides: Partial<OauthLink> = {}): OauthLink {
  return {
    id: 'link-1',
    userId: USER.id,
    provider: 'GOOGLE',
    subject: 'google-subject-1',
    emailAtLink: 'ada@example.com',
    emailVerifiedByProvider: true,
    avatarUrlAtLink: 'https://cdn.example.com/ada.png',
    nameAtLink: 'Ada',
    linkedAt: new Date('2026-01-15T10:00:00.000Z'),
    lastLoginAt: null,
    unlinkRequestedAt: null,
    unlinkAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A stateful double rather than one-shot resolved values, because the unlink path
 * reads, writes, and in the contended case reads again — a stub returning a fixed
 * array could not express "the row changed underneath us".
 *
 * `scheduleOauthUnlink` models the real compare-and-swap rather than returning a
 * constant: it writes only when the row is live and not already counting down, and
 * reports whether it wrote. A stub that always answered `true` would let the
 * idempotency assertions below pass against an implementation that has none.
 */
function createUsers(links: OauthLink[] = []) {
  const state = { links, user: USER as typeof USER | null };
  return {
    state,
    listOauthLinks: vi.fn(async () => state.links),
    findById: vi.fn(async () => state.user),
    scheduleOauthUnlink: vi.fn(async (id: string, unlinkAt: Date) => {
      const row = state.links.find((link) => link.id === id);
      if (row === undefined || row.deletedAt !== null || row.unlinkAt !== null) return false;
      state.links = state.links.map((link) =>
        link.id === id ? { ...link, unlinkRequestedAt: new Date(), unlinkAt } : link,
      );
      return true;
    }),
  };
}

function createOauth(available: OauthProvider[] = ['GOOGLE', 'APPLE', 'FACEBOOK']) {
  return {
    availableProviders: vi.fn(() => available),
    // Widened deliberately: Telegram answers `url: null` with a different `flow`, and
    // a return type inferred from the Google fixture would make that case
    // unexpressible in a spec rather than merely unusual.
    startLink: vi.fn(
      async (): Promise<{ url: string | null; state: string; flow: string }> => ({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
        state: 'abc',
        flow: 'oidc-code',
      }),
    ),
    completeLink: vi.fn(async () => ({
      provider: 'GOOGLE' as OauthProvider,
      subject: 'google-subject-1',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada',
      avatarUrl: 'https://cdn.example.com/ada.png',
    })),
  };
}

function createTwoFactor() {
  return {
    reauthChallenge: vi.fn(async () => ({ methods: [], options: null })),
    consumeCredentialOtp: vi.fn(async () => undefined),
    proveTotpCode: vi.fn(async () => true),
    provePasskeyAssertion: vi.fn(async () => true),
  };
}

/** A real `Map`, so a charge that was consumed is observably consumed. */
function createCache() {
  const counts = new Map<string, number>();
  return {
    counts,
    consume: vi.fn(async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }),
  };
}

describe('LinkAccountsService', () => {
  let users: ReturnType<typeof createUsers>;
  let oauth: ReturnType<typeof createOauth>;
  let twoFactor: ReturnType<typeof createTwoFactor>;
  let cache: ReturnType<typeof createCache>;
  let elevation: { issue: ReturnType<typeof vi.fn> };
  let mail: { sendSocialUnlinkScheduled: ReturnType<typeof vi.fn> };
  let methods: string[];

  const mfa = { availableMethods: vi.fn(async () => methods) };

  function build(): LinkAccountsService {
    return new LinkAccountsService(
      twoFactor as never,
      mfa as never,
      elevation as never,
      oauth as never,
      users as never,
      cache as never,
      mail as never,
    );
  }

  /**
   * Set what the account has enrolled. One helper rather than two stubs, so the
   * fixture cannot describe an account that could not exist.
   */
  const enrol = (...enrolled: string[]) => {
    methods = enrolled;
  };

  const verify = (input: Record<string, unknown> = {}) =>
    build().verify(PRINCIPAL, { emailCode: EMAIL_CODE, ...input } as never);

  async function problem(call: Promise<unknown>): Promise<ProblemException> {
    try {
      await call;
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      return err as ProblemException;
    }
    throw new Error('expected the call to reject, but it resolved');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    users = createUsers();
    oauth = createOauth();
    twoFactor = createTwoFactor();
    cache = createCache();
    elevation = {
      issue: vi.fn(async (_sessionId: string, action: string) => ({
        ticket: 'ticket-1',
        expiresInSeconds: 60,
        action,
      })),
    };
    mail = { sendSocialUnlinkScheduled: vi.fn(() => undefined) };
    enrol();
  });

  // ─── the four verification cases ──────────────────────────────────────────

  describe('verify — authenticator enrolled, no passkey', () => {
    beforeEach(() => enrol('totp'));

    it('accepts the emailed code plus a TOTP code', async () => {
      await expect(verify({ totpCode: TOTP_CODE })).resolves.toMatchObject({
        ticket: 'ticket-1',
      });
      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
      expect(twoFactor.proveTotpCode).toHaveBeenCalledWith(USER.id, TOTP_CODE);
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });

    it('refuses the emailed code alone — a factor exists and is owed', async () => {
      const err = await problem(verify());
      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(elevation.issue).not.toHaveBeenCalled();
    });

    it('refuses a passkey assertion, naming the factor that is missing', async () => {
      const err = await problem(verify({ passkey: PASSKEY }));
      expect(err.detail).toContain('Biometric sign-in is not enabled');
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });
  });

  describe('verify — passkey enrolled, no authenticator', () => {
    beforeEach(() => enrol('passkey'));

    it('accepts the emailed code plus an assertion', async () => {
      await expect(verify({ passkey: PASSKEY })).resolves.toMatchObject({
        ticket: 'ticket-1',
      });
      expect(twoFactor.provePasskeyAssertion).toHaveBeenCalledWith(USER.id, PASSKEY);
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
    });

    it('refuses a TOTP code, naming the factor that is missing', async () => {
      const err = await problem(verify({ totpCode: TOTP_CODE }));
      expect(err.detail).toContain('No authenticator app');
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
    });
  });

  describe('verify — both enrolled', () => {
    beforeEach(() => enrol('totp', 'passkey'));

    it('accepts a TOTP code', async () => {
      await expect(verify({ totpCode: TOTP_CODE })).resolves.toMatchObject({
        ticket: 'ticket-1',
      });
      expect(twoFactor.proveTotpCode).toHaveBeenCalled();
    });

    it('accepts a passkey assertion just as readily — the caller chooses', async () => {
      await expect(verify({ passkey: PASSKEY })).resolves.toMatchObject({
        ticket: 'ticket-1',
      });
      expect(twoFactor.provePasskeyAssertion).toHaveBeenCalled();
    });

    it('does NOT demand both', async () => {
      await expect(verify({ totpCode: TOTP_CODE })).resolves.toBeTruthy();
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });

    it('refuses BOTH at once rather than silently picking one', async () => {
      // `proveEnrolledFactor` next door prefers the passkey and is right to; here the
      // caller could not tell which credential was spent, so the combination is the
      // mistake worth reporting.
      const err = await problem(verify({ totpCode: TOTP_CODE, passkey: PASSKEY }));
      expect(err.detail).toContain('exactly one factor');
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });
  });

  describe('verify — nothing enrolled', () => {
    beforeEach(() => enrol());

    it('accepts the emailed code ALONE', async () => {
      await expect(verify()).resolves.toMatchObject({ ticket: 'ticket-1' });
      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
    });

    it('never asks for a password — which is the whole reason this is not reauthVerify', async () => {
      // `TwoFactorService.reauthVerify` would call `proveWithPassword` here. An
      // account created through a provider has no credential row at all, so that
      // path would make linking a second provider impossible for exactly the users
      // most likely to want one.
      await expect(verify()).resolves.toBeTruthy();
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });

    it('still refuses a factor the account does not hold', async () => {
      // Ignoring the field would answer 201 while checking nothing, which tells a
      // client its proof was verified when nothing verified it.
      const err = await problem(verify({ totpCode: TOTP_CODE }));
      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    });
  });

  // ─── ordering and consumption ─────────────────────────────────────────────

  describe('verify — what is spent, and when', () => {
    it('charges the per-session limiter before anything else', async () => {
      enrol('totp');
      await verify({ totpCode: TOTP_CODE });
      expect(cache.counts.get(KEYS.rate.reauthBySession(PRINCIPAL.sessionId))).toBe(1);
      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.reauthBySession(PRINCIPAL.sessionId),
        policy().MFA.REAUTH_FAIL_BY_SESSION,
        'deny',
      );
    });

    it('leaves the emailed code UNSPENT when the proof shape is wrong', async () => {
      // A refusal the server could issue for free must not first cost the user a
      // mailbox round trip. Same rule `SettingsService.assertPathAvailable` follows.
      enrol('totp');
      await problem(verify({ passkey: PASSKEY }));
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('spends the emailed code BEFORE comparing the factor', async () => {
      enrol('totp');
      const order: string[] = [];
      twoFactor.consumeCredentialOtp.mockImplementation(async () => {
        order.push('otp');
      });
      twoFactor.proveTotpCode.mockImplementation(async () => {
        order.push('totp');
        return true;
      });

      await verify({ totpCode: TOTP_CODE });
      expect(order).toEqual(['otp', 'totp']);
    });

    it('has still spent the emailed code when the factor turns out wrong', async () => {
      // Otherwise a wrong emailed code could be used to probe whether a TOTP guess
      // was right, one attempt at a time, for free.
      enrol('totp');
      twoFactor.proveTotpCode.mockResolvedValue(false);

      const err = await problem(verify({ totpCode: TOTP_CODE }));
      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledOnce();
      expect(elevation.issue).not.toHaveBeenCalled();
    });

    it('mints the ticket for account.social.link and nothing else', async () => {
      enrol('totp');
      await verify({ totpCode: TOTP_CODE });
      expect(elevation.issue).toHaveBeenCalledWith(PRINCIPAL.sessionId, 'account.social.link');
    });

    it('refuses a rejected assertion without minting a ticket', async () => {
      enrol('passkey');
      twoFactor.provePasskeyAssertion.mockResolvedValue(false);

      const err = await problem(verify({ passkey: PASSKEY }));
      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(elevation.issue).not.toHaveBeenCalled();
    });
  });

  describe('challenge', () => {
    it('asks for the methods this feature will actually accept', async () => {
      await build().challenge(USER.id);
      // The action is forwarded so `reauthMethods` withholds `recovery_code`: a
      // printed backup sheet must never attach a provider.
      expect(twoFactor.reauthChallenge).toHaveBeenCalledWith(USER.id, 'account.social.link');
    });
  });

  // ─── the status read ──────────────────────────────────────────────────────

  describe('status', () => {
    it('reports a linked provider with the metadata the screen renders', async () => {
      users.state.links = [makeLink()];

      const status = await build().status(USER.id);
      expect(status.accounts).toEqual([
        {
          provider: 'GOOGLE',
          displayName: 'Ada',
          email: 'ada@example.com',
          emailVerifiedByProvider: true,
          imageUrl: 'https://cdn.example.com/ada.png',
          linkedAt: '2026-01-15T10:00:00.000Z',
          lastLoginAt: null,
          // Null is the ordinary case: no removal has been requested.
          unlinkAt: null,
        },
      ]);
    });

    it('NEVER exposes the provider subject', async () => {
      // It identifies the account at the provider, the screen has no use for it, and
      // a client that echoed it into the DOM would be the first place it leaked.
      users.state.links = [makeLink()];

      const status = await build().status(USER.id);
      expect(JSON.stringify(status)).not.toContain('google-subject-1');
      expect(status.accounts[0]).not.toHaveProperty('subject');
    });

    it('normalises the empty email both writers store to null', async () => {
      // X and Telegram supply no address and `linkOauth` records `''`. A blank line
      // on a settings screen is not the same thing as "no address".
      users.state.links = [makeLink({ provider: 'X', emailAtLink: '' })];

      const status = await build().status(USER.id);
      expect(status.accounts[0]?.email).toBeNull();
    });

    it('reports a null display name rather than inventing one', async () => {
      // Apple publishes no name in its ID token and has no endpoint to fetch one.
      users.state.links = [makeLink({ provider: 'APPLE', nameAtLink: null })];

      const status = await build().status(USER.id);
      expect(status.accounts[0]?.displayName).toBeNull();
    });

    it('offers only providers this deployment has credentials for', async () => {
      oauth.availableProviders.mockReturnValue(['GOOGLE']);

      const status = await build().status(USER.id);
      // X and TELEGRAM have adapters but no configuration here, so a button for
      // them could only ever fail.
      expect(status.availableProviders).toEqual(['GOOGLE']);
    });

    it('drops a provider that is already linked — one live link per provider', async () => {
      users.state.links = [makeLink({ provider: 'GOOGLE' })];

      const status = await build().status(USER.id);
      expect(status.availableProviders).toEqual(['APPLE', 'FACEBOOK']);
    });

    it('answers empty for an account that has linked nothing', async () => {
      const status = await build().status(USER.id);
      expect(status.accounts).toEqual([]);
      expect(status.availableProviders).toEqual(['GOOGLE', 'APPLE', 'FACEBOOK']);
    });
  });

  // ─── the provider round trip ──────────────────────────────────────────────

  describe('start', () => {
    it('hands the principal to the OAuth layer so the state can be bound to it', async () => {
      const client = { ip: '203.0.113.7' } as never;
      await build().start(PRINCIPAL, { provider: 'GOOGLE' }, client);

      expect(oauth.startLink).toHaveBeenCalledWith(PRINCIPAL, { provider: 'GOOGLE' }, client);
    });

    it('passes the authorization URL and the flow back verbatim', async () => {
      const started = await build().start(PRINCIPAL, { provider: 'GOOGLE' }, {} as never);
      expect(started).toEqual({
        provider: 'GOOGLE',
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
        state: 'abc',
        flow: 'oidc-code',
      });
    });

    it('carries a null URL through for a provider with no authorization endpoint', async () => {
      // Telegram. The client renders the Login Widget instead of navigating, and
      // `flow` is what tells it to.
      oauth.startLink.mockResolvedValue({ url: null, state: 'abc', flow: 'signed-payload' });

      const started = await build().start(PRINCIPAL, { provider: 'TELEGRAM' }, {} as never);
      expect(started.url).toBeNull();
      expect(started.flow).toBe('signed-payload');
    });
  });

  describe('complete', () => {
    const input = { provider: 'GOOGLE' as OauthProvider, code: 'auth-code', state: 'abc' };

    it('returns the stored row, so the screen renders database timestamps', async () => {
      users.state.links = [makeLink()];

      const account = await build().complete(PRINCIPAL, input, {} as never);
      expect(account).toMatchObject({
        provider: 'GOOGLE',
        displayName: 'Ada',
        email: 'ada@example.com',
        linkedAt: '2026-01-15T10:00:00.000Z',
      });
      expect(account).not.toHaveProperty('subject');
    });

    it('lets the OAuth layer refuse before anything is read back', async () => {
      oauth.completeLink.mockRejectedValue(
        new ProblemException({ type: ERR.OAUTH_ALREADY_LINKED }),
      );

      const err = await problem(build().complete(PRINCIPAL, input, {} as never));
      expect(err.type).toBe(ERR.OAUTH_ALREADY_LINKED);
      expect(users.listOauthLinks).not.toHaveBeenCalled();
    });
  });

  // ─── the delayed unlink ───────────────────────────────────────────────────

  /**
   * ═══ THE ONE THING THAT MUST NOT REGRESS ════════════════════════════════════
   *
   * Requesting an unlink removes NOTHING. It writes a deadline, and the link stays
   * live and usable for sign-in until a background sweep retires it seven days later.
   *
   * A regression here is invisible from the response — it still says "scheduled" —
   * and shows up as a user losing their social login the moment they click, with the
   * notice email arriving after the fact. So `deletedAt` is asserted untouched on
   * every path below, not only on the happy one.
   */
  describe('requestUnlink', () => {
    const unlink = (provider: OauthProvider = 'GOOGLE') =>
      build().requestUnlink(PRINCIPAL, provider, IP_CLASS);

    /** The row as it stands in the double now, rather than the fixture we passed in. */
    const stored = () => users.state.links[0] as OauthLink;

    beforeEach(() => {
      users.state.links = [makeLink()];
    });

    it('schedules the removal exactly SOCIAL_UNLINK.DELAY_DAYS out', async () => {
      const before = Date.now();
      const result = await unlink();
      const after = Date.now();

      const scheduled = new Date(result.unlinkAt).getTime();
      // A window rather than an equality, because the service reads the clock itself
      // — which is the point: the deadline is computed server-side and no part of it
      // comes from the caller.
      expect(scheduled).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
      expect(scheduled).toBeLessThanOrEqual(after + SEVEN_DAYS_MS);
      expect(result.provider).toBe('GOOGLE');
    });

    it('leaves the link LIVE — nothing is removed yet', async () => {
      await unlink();

      expect(stored().deletedAt).toBeNull();
      expect(stored().unlinkAt).toBeInstanceOf(Date);
      expect(stored().unlinkRequestedAt).toBeInstanceOf(Date);
    });

    it('keeps reporting the provider as linked, now carrying unlinkAt', async () => {
      const { unlinkAt } = await unlink();

      const status = await build().status(USER.id);
      expect(status.accounts).toHaveLength(1);
      expect(status.accounts[0]).toMatchObject({ provider: 'GOOGLE', unlinkAt });
      // Still held, so still not offered as something to link.
      expect(status.availableProviders).not.toContain('GOOGLE');
    });

    it('emails the account, naming the provider and the deadline', async () => {
      const { unlinkAt } = await unlink();

      expect(mail.sendSocialUnlinkScheduled).toHaveBeenCalledWith(
        USER.email,
        'GOOGLE',
        new Date(unlinkAt),
        IP_CLASS,
        // The anti-phishing code off the row this path already read — null on a
        // fixture that has none.
        null,
      );
    });

    // ─── idempotence ────────────────────────────────────────────────────────

    it('a second request returns the ORIGINAL deadline and does not extend it', async () => {
      const first = await unlink();
      const firstWrite = stored().unlinkRequestedAt;

      const second = await unlink();

      expect(second.unlinkAt).toBe(first.unlinkAt);
      // Not merely the same answer — the row was not touched at all, so nothing
      // could have silently bought another seven days.
      expect(stored().unlinkRequestedAt).toBe(firstWrite);
      expect(users.scheduleOauthUnlink).toHaveBeenCalledTimes(1);
    });

    it('sends exactly ONE email however many times it is asked', async () => {
      await unlink();
      await unlink();
      await unlink();

      expect(mail.sendSocialUnlinkScheduled).toHaveBeenCalledTimes(1);
    });

    it('reports the winner deadline when another tab wins the swap', async () => {
      // The compare-and-swap lost: something scheduled between our read and our
      // write. The caller must be told what is actually true, not what we tried.
      const theirs = new Date('2026-10-01T09:00:00.000Z');
      users.scheduleOauthUnlink.mockImplementation(async () => {
        users.state.links = [makeLink({ unlinkAt: theirs })];
        return false;
      });

      await expect(unlink()).resolves.toMatchObject({ unlinkAt: theirs.toISOString() });
      expect(mail.sendSocialUnlinkScheduled).not.toHaveBeenCalled();
    });

    it('refuses when the sweep retired the row mid-request', async () => {
      users.scheduleOauthUnlink.mockImplementation(async () => {
        users.state.links = [];
        return false;
      });

      const err = await problem(unlink());
      expect(err.type).toBe(ERR.NOT_FOUND);
    });

    // ─── scoping and refusals ───────────────────────────────────────────────

    it('refuses a provider this account has not linked', async () => {
      const err = await problem(unlink('APPLE'));

      expect(err.type).toBe(ERR.NOT_FOUND);
      expect(users.scheduleOauthUnlink).not.toHaveBeenCalled();
      expect(mail.sendSocialUnlinkScheduled).not.toHaveBeenCalled();
    });

    it('touches no other provider', async () => {
      users.state.links = [makeLink(), makeLink({ id: 'link-2', provider: 'FACEBOOK' })];

      await unlink('GOOGLE');

      const facebook = users.state.links.find((link) => link.provider === 'FACEBOOK');
      expect(facebook?.unlinkAt).toBeNull();
      expect(facebook?.deletedAt).toBeNull();
    });

    it('resolves the row from the principal, never from the argument', async () => {
      // The only user id that reaches persistence is the caller's own. There is no
      // parameter through which another account could be named.
      await unlink();

      expect(users.listOauthLinks).toHaveBeenCalledWith(PRINCIPAL.userId);
      expect(users.findById).toHaveBeenCalledWith(PRINCIPAL.userId);
    });

    it('still schedules when the account row cannot be read for the email', async () => {
      // The deadline is already committed by then. A missing user costs the
      // notification, never the write.
      users.state.user = null;

      await expect(unlink()).resolves.toMatchObject({ provider: 'GOOGLE' });
      expect(stored().unlinkAt).toBeInstanceOf(Date);
      expect(mail.sendSocialUnlinkScheduled).not.toHaveBeenCalled();
    });
  });

  // ─── the ticket the unlink is spent against ───────────────────────────────

  /**
   * The four-case proof policy is `resolveLinkProof`'s and is exercised in full
   * above; these assert only that asking for an unlink ticket runs the SAME policy
   * and yields a DIFFERENT permit. Re-testing the four cases per intent would be
   * duplicating coverage of one shared function.
   */
  describe('verify — which permit it issues', () => {
    it('issues a link ticket when no intent is named', async () => {
      await verify({ totpCode: undefined });

      expect(elevation.issue).toHaveBeenCalledWith(PRINCIPAL.sessionId, 'account.social.link');
    });

    it('issues an unlink ticket for intent: unlink', async () => {
      await verify({ intent: 'unlink' });

      expect(elevation.issue).toHaveBeenCalledWith(PRINCIPAL.sessionId, 'account.social.unlink');
    });

    it('charges the same proof for the unlink as for the link', async () => {
      enrol('totp');

      await verify({ intent: 'unlink', totpCode: TOTP_CODE });

      // The emailed code AND the factor, exactly as the link path spends them. If
      // the unlink ever became the cheaper ceremony, this is what would notice.
      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
      expect(twoFactor.proveTotpCode).toHaveBeenCalledWith(USER.id, TOTP_CODE);
    });

    it('refuses the emailed code alone for an unlink when a factor is enrolled', async () => {
      enrol('totp');

      const err = await problem(verify({ intent: 'unlink' }));
      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(elevation.issue).not.toHaveBeenCalled();
    });

    it('never falls back to a password for an unlink on a bare account', async () => {
      enrol();

      await verify({ intent: 'unlink' });

      // No factor is enrolled, so the emailed code alone is the whole proof — and
      // the emailed code is still spent.
      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
      expect(elevation.issue).toHaveBeenCalledWith(PRINCIPAL.sessionId, 'account.social.unlink');
    });
  });
});
