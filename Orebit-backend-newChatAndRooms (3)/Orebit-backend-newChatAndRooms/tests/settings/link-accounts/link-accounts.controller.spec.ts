import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { LinkAccountsController } from '../../../src/settings/link-accounts/link-accounts.controller';
import { makePrincipal } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * A controller here parses, delegates and serialises, so the questions are narrow:
 * does each action reach the method it names, does the envelope carry the right
 * `outcome`, and is a malformed body refused BEFORE any service call runs?
 *
 * The last one is the one worth having. `verify` spends an emailed code and a
 * factor; a body that reached the service and only then failed would have charged a
 * limiter for a request that was never valid.
 *
 * The acting account is taken from the `Principal` on every path and never from the
 * body, which is why no test here passes a user id — there is nowhere to put one.
 */

const PRINCIPAL = makePrincipal();
const CLIENT = { ip: '203.0.113.7', ipClass: '203.0.113.0/24' } as never;

describe('LinkAccountsController', () => {
  let service: {
    status: ReturnType<typeof vi.fn>;
    challenge: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    requestUnlink: ReturnType<typeof vi.fn>;
  };

  const build = () => new LinkAccountsController(service as never);

  beforeEach(() => {
    service = {
      status: vi.fn(async () => ({ accounts: [], availableProviders: ['GOOGLE'] })),
      challenge: vi.fn(async () => ({ methods: ['totp'], options: null })),
      verify: vi.fn(async () => ({
        ticket: 'ticket-1',
        expiresInSeconds: 60,
        action: 'account.social.link',
      })),
      start: vi.fn(async () => ({
        provider: 'GOOGLE',
        url: 'https://provider.example.com/authorize',
        state: 'abc',
        flow: 'oidc-code',
      })),
      complete: vi.fn(async () => ({
        provider: 'GOOGLE',
        displayName: 'Ada',
        email: 'ada@example.com',
        emailVerifiedByProvider: true,
        imageUrl: null,
        linkedAt: '2026-01-15T10:00:00.000Z',
        lastLoginAt: null,
        unlinkAt: null,
      })),
      requestUnlink: vi.fn(async () => ({
        provider: 'GOOGLE',
        unlinkAt: '2026-09-18T12:00:00.000Z',
      })),
    };
  });

  // ─── status ───────────────────────────────────────────────────────────────

  describe('status', () => {
    it('wraps the service answer with its outcome', async () => {
      const result = await build().status(PRINCIPAL);
      expect(result).toEqual({
        data: {
          outcome: 'social_accounts_status',
          accounts: [],
          availableProviders: ['GOOGLE'],
        },
      });
    });

    it("asks about the principal's own account", async () => {
      await build().status(PRINCIPAL);
      expect(service.status).toHaveBeenCalledWith(PRINCIPAL.userId);
    });
  });

  // ─── verify ───────────────────────────────────────────────────────────────

  describe('verify — dispatch', () => {
    it('routes challenge to the challenge method and reports the email-code rule', async () => {
      const result = await build().verify({ action: 'challenge' }, PRINCIPAL);
      expect(service.challenge).toHaveBeenCalledWith(PRINCIPAL.userId);
      expect(result.data).toEqual({
        outcome: 'social_link_challenge',
        methods: ['totp'],
        options: null,
        // Stated rather than inferred: a client should not have to read an empty
        // `methods` array to learn whether a code is owed.
        emailCodeRequired: true,
      });
    });

    it('routes verify to the verify method, carrying both proof fields', async () => {
      const passkey = { id: 'credential-1' };
      await build().verify(
        { action: 'verify', emailCode: '123456', passkey },
        PRINCIPAL,
      );

      expect(service.verify).toHaveBeenCalledWith(PRINCIPAL, {
        emailCode: '123456',
        totpCode: undefined,
        passkey,
        // Defaulted by the schema, so a body written before unlink existed still asks
        // for the ticket it has always asked for.
        intent: 'link',
      });
    });

    it('returns the ticket under its own outcome', async () => {
      const result = await build().verify(
        { action: 'verify', emailCode: '123456', totpCode: '654321' },
        PRINCIPAL,
      );
      expect(result.data).toEqual({
        outcome: 'social_link_elevated',
        ticket: 'ticket-1',
        expiresInSeconds: 60,
        action: 'account.social.link',
      });
    });
  });

  describe('verify — validation', () => {
    it('rejects an unknown action before touching the service', async () => {
      await expect(
        build().verify({ action: 'link-start' }, PRINCIPAL),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.challenge).not.toHaveBeenCalled();
      expect(service.verify).not.toHaveBeenCalled();
    });

    it('rejects a verify with no emailed code, without charging a limiter', async () => {
      // The code is required on every path here, so a client that forgets it should
      // get a field-named validation error rather than a refusal it has paid for.
      await expect(
        build().verify({ action: 'verify', totpCode: '654321' }, PRINCIPAL),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.verify).not.toHaveBeenCalled();
    });

    it('rejects an unknown key rather than dropping it', async () => {
      await expect(
        build().verify(
          { action: 'verify', emailCode: '123456', password: 'hunter2' },
          PRINCIPAL,
        ),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
    });
  });

  // ─── start and callback ───────────────────────────────────────────────────

  describe('start', () => {
    it('delegates with the principal and the client context', async () => {
      await build().start({ provider: 'GOOGLE' }, PRINCIPAL, CLIENT);
      expect(service.start).toHaveBeenCalledWith(PRINCIPAL, { provider: 'GOOGLE' }, CLIENT);
    });

    it('wraps the answer with its outcome', async () => {
      const result = await build().start({ provider: 'GOOGLE' }, PRINCIPAL, CLIENT);
      expect(result.data).toMatchObject({
        outcome: 'social_account_link_started',
        provider: 'GOOGLE',
        state: 'abc',
      });
    });

    it('rejects an unknown provider before starting anything', async () => {
      await expect(
        build().start({ provider: 'MYSPACE' }, PRINCIPAL, CLIENT),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.start).not.toHaveBeenCalled();
    });
  });

  describe('callback', () => {
    it('delegates and returns the linked account', async () => {
      const input = { provider: 'GOOGLE', code: 'auth-code', state: 'abc' };
      const result = await build().callback(input, PRINCIPAL, CLIENT);

      expect(service.complete).toHaveBeenCalledWith(PRINCIPAL, input, CLIENT);
      expect(result.data).toMatchObject({
        outcome: 'social_account_linked',
        provider: 'GOOGLE',
        displayName: 'Ada',
      });
    });

    it('returns no session payload of any kind', async () => {
      // The settings callback must never sign anyone in. There is no cookie port on
      // this method, and nothing session-shaped in what it answers.
      const result = await build().callback(
        { provider: 'GOOGLE', code: 'auth-code', state: 'abc' },
        PRINCIPAL,
        CLIENT,
      );

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('accessToken');
      expect(serialised).not.toContain('csrfToken');
      expect(result.data).not.toHaveProperty('session');
    });

    it('rejects a body missing the state', async () => {
      await expect(
        build().callback({ provider: 'GOOGLE', code: 'auth-code' }, PRINCIPAL, CLIENT),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.complete).not.toHaveBeenCalled();
    });
  });

  describe('unlink', () => {
    const IP_CLASS = '203.0.113.0/24';

    it('says SCHEDULED, not unlinked', async () => {
      // The distinction the whole feature turns on. The account is still linked when
      // this returns, so an outcome of `social_account_unlinked` would have a client
      // remove the row from its list and show the user something untrue for a week.
      const result = await build().unlink({ provider: 'GOOGLE' }, PRINCIPAL, IP_CLASS);

      expect(result.data).toEqual({
        outcome: 'social_account_unlink_scheduled',
        provider: 'GOOGLE',
        unlinkAt: '2026-09-18T12:00:00.000Z',
      });
      expect(JSON.stringify(result)).not.toContain('social_account_unlinked');
    });

    it('takes the account from the principal and the network from the argument', async () => {
      await build().unlink({ provider: 'GOOGLE' }, PRINCIPAL, IP_CLASS);

      expect(service.requestUnlink).toHaveBeenCalledWith(PRINCIPAL, 'GOOGLE', IP_CLASS);
    });

    it('issues nothing session-shaped', async () => {
      // There is no reply object on this method or on the route above it, so a cookie
      // is unreachable rather than merely unset. This asserts the payload carries no
      // token either.
      const result = await build().unlink({ provider: 'GOOGLE' }, PRINCIPAL, IP_CLASS);

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('accessToken');
      expect(serialised).not.toContain('csrfToken');
      expect(result.data).not.toHaveProperty('session');
    });

    it('refuses an unknown provider before the service is reached', async () => {
      await expect(
        build().unlink({ provider: 'MYSPACE' }, PRINCIPAL, IP_CLASS),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.requestUnlink).not.toHaveBeenCalled();
    });

    it('refuses a body that names somebody else link', async () => {
      // The elevation ticket has already been spent by the guard by the time this
      // runs, so a body carrying a field this route does not accept must fail rather
      // than have that field quietly dropped.
      await expect(
        build().unlink({ provider: 'GOOGLE', userId: 'user-2' }, PRINCIPAL, IP_CLASS),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(service.requestUnlink).not.toHaveBeenCalled();
    });
  });
});
