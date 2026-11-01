import { describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { pepperedHash } from '../../../auth/auth.utility';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { DeleteAccountService } from '../../../src/settings/delete-account/delete-account.service';
import type { PendingWithdrawalsState } from '../../../src/settings/delete-account/delete-account.types';
import { makePrincipal, makeUser } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Three properties, and they are the reasons this feature is shaped the way it is.
 *
 *   1. A deletion takes effect AT ONCE. The status moves and every session is revoked
 *      in the same request, unlike the delayed social unlink which changes nothing for
 *      seven days. Anything that would let a deleted account keep working is the bug
 *      this feature exists to not have.
 *
 *   2. The data waits. `deletedAt` stays NULL for the window, which is what keeps the
 *      email and username reserved and therefore what makes reactivation promisable.
 *      The spec asserts the request does NOT write it.
 *
 *   3. The public reactivation route cannot reveal whether an account exists. Not in
 *      the body, not in the status, and not in which rate-limit buckets it charges.
 *
 * ─── On the doubles ─────────────────────────────────────────────────────────
 *
 * `users` is STATEFUL and implements the real compare-and-swap predicates rather than
 * returning constants. A stub that answered `true` unconditionally would let the
 * idempotency and race assertions below pass against an implementation that has
 * neither — the same reasoning `link-accounts.service.spec.ts` states for its own.
 *
 * `mfa` is derived from the enrolment fixture rather than stubbed independently, so a
 * spec cannot describe an account that cannot exist.
 */

const USER = makeUser();
const PRINCIPAL = makePrincipal({ userId: USER.id });
const EMAIL_CODE = '123456';
const TOTP_CODE = '654321';
const IP = '203.0.113.7';
const IP_CLASS = '203.0.113.0/24';
const REACTIVATION_CODE = '112233';

/**
 * Written out rather than imported from `ACCOUNT_DELETION.RECOVERY_DAYS`, deliberately.
 *
 * Importing the constant would make these assertions agree with the service by
 * construction — change it to one day and the spec would happily follow. Thirty days is
 * the product promise, so the spec states it independently and fails if the code stops
 * honouring it.
 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** An account inside its recovery window: status moved, data still intact. */
function deletedUser(purgeAt: Date): User {
  return makeUser({
    status: 'DELETED',
    deletedAt: null,
    deletionRequestedAt: new Date(Date.now() - 1000),
    purgeAt,
  });
}

/**
 * A stateful `UserDbOperation` double.
 *
 * `requestAccountDeletion` and `reactivateAccount` model their real predicates,
 * including the window check, because that is precisely what the concurrency and
 * boundary tests are about.
 */
function createUsers(initial: User = USER) {
  const state = { user: initial as User | null };

  return {
    state,
    findById: vi.fn(async () => state.user),
    findByEmail: vi.fn(async (emailLower: string) =>
      state.user !== null && state.user.emailLower === emailLower && state.user.deletedAt === null
        ? state.user
        : null,
    ),
    requestAccountDeletion: vi.fn(async (_id: string, requestedAt: Date, purgeAt: Date) => {
      const row = state.user;
      if (row === null) return false;
      // The real predicate: ACTIVE, not already purged, not already counting down.
      if (row.status !== 'ACTIVE' || row.deletedAt !== null || row.purgeAt !== null) return false;
      state.user = { ...row, status: 'DELETED', deletionRequestedAt: requestedAt, purgeAt };
      return true;
    }),
    reactivateAccount: vi.fn(async (_id: string, now: Date) => {
      const row = state.user;
      if (row === null) return false;
      // The real predicate, window included. `purgeAt > now` is the whole boundary.
      if (row.status !== 'DELETED' || row.deletedAt !== null || row.purgeAt === null) return false;
      if (row.purgeAt.getTime() <= now.getTime()) return false;
      state.user = { ...row, status: 'ACTIVE', deletionRequestedAt: null, purgeAt: null };
      return true;
    }),
  };
}

function createTwoFactor() {
  return {
    reauthChallenge: vi.fn(async () => ({ methods: ['totp'], options: null })),
    consumeCredentialOtp: vi.fn(async () => undefined),
    proveTotpCode: vi.fn(async () => true),
    provePasskeyAssertion: vi.fn(async () => true),
  };
}

function createDeps(users = createUsers(), withdrawal: PendingWithdrawalsState = { state: 'unavailable' }) {
  const twoFactor = createTwoFactor();
  const mfa = { availableMethods: vi.fn(async () => ['totp']) };
  const elevation = {
    issue: vi.fn(async () => ({
      ticket: 'ticket-1',
      expiresInSeconds: 60,
      action: 'account.delete',
    })),
  };
  const sessions = { revokeAllForUser: vi.fn(async () => undefined) };
  const challenges = {
    issue: vi.fn(async (_input: { userId: string; purpose: string }) => ({ id: 'challenge-1' })),
    findLive: vi.fn(async () => null),
    consume: vi.fn(async () => true),
    incrementAttempts: vi.fn(async () => 1),
    invalidate: vi.fn(async () => undefined),
  };
  const securityChange = { assertNoRecentEmailChange: vi.fn(async () => undefined) };
  // Parameters declared so the specs that read `mock.calls` see typed arguments — the
  // rate-limit assertions are ABOUT which key was charged, so an untyped `vi.fn()`
  // would make them unwritable.
  const cache = {
    consume: vi.fn(async (_key: string, _rule?: unknown, _onFailure?: string) => undefined),
  };
  const mail = {
    sendAccountDeleted: vi.fn(),
    sendAccountReactivationCode: vi.fn(async () => undefined),
    sendAccountReactivated: vi.fn(),
  };
  const withdrawals = { check: vi.fn(async () => withdrawal) };

  const service = new DeleteAccountService(
    twoFactor as never,
    mfa as never,
    elevation as never,
    sessions as never,
    users as never,
    challenges as never,
    securityChange as never,
    cache as never,
    mail as never,
    withdrawals as never,
  );

  return { service, users, twoFactor, mfa, elevation, sessions, challenges, securityChange, cache, mail, withdrawals };
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

// ─── the ceremony ───────────────────────────────────────────────────────────

describe('DeleteAccountService.verify — earning the ticket', () => {
  it('issues a ticket bound to account.delete and nothing else', async () => {
    const { service, elevation } = createDeps();

    const result = await service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE });

    expect(elevation.issue).toHaveBeenCalledWith(PRINCIPAL.sessionId, 'account.delete');
    expect(result.action).toBe('account.delete');
  });

  it('spends the emailed code before comparing the factor', async () => {
    const { service, twoFactor } = createDeps();
    const order: string[] = [];
    twoFactor.consumeCredentialOtp.mockImplementation(async () => {
      order.push('otp');
    });
    twoFactor.proveTotpCode.mockImplementation(async () => {
      order.push('totp');
      return true;
    });

    await service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE });

    // A wrong code must not be usable to probe whether the factor beside it was right.
    expect(order).toEqual(['otp', 'totp']);
  });

  it('refuses an unavailable factor WITHOUT spending the emailed code', async () => {
    const { service, twoFactor, mfa } = createDeps();
    mfa.availableMethods.mockResolvedValue(['passkey']);

    const err = await problem(
      service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE }),
    );

    // The ordering rule: a refusal the server could issue for free must not first cost
    // the user their emailed code.
    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('spends the emailed code even when the factor is wrong', async () => {
    const { service, twoFactor } = createDeps();
    twoFactor.proveTotpCode.mockResolvedValue(false);

    const err = await problem(
      service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE }),
    );

    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
    expect(twoFactor.consumeCredentialOtp).toHaveBeenCalled();
  });

  it('never consults the account password, even with nothing enrolled', async () => {
    const { service, twoFactor, mfa, elevation } = createDeps();
    mfa.availableMethods.mockResolvedValue([]);

    await service.verify(PRINCIPAL, { emailCode: EMAIL_CODE });

    // The emailed code alone is the whole ceremony for an account with no factor. A
    // password is the credential most likely to be already compromised in the case this
    // ceremony exists to stop, and `TwoFactorService` is not asked for one.
    expect(elevation.issue).toHaveBeenCalled();
    expect(twoFactor).not.toHaveProperty('checkPassword');
    expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
    expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
  });

  it('charges the reauth bucket and honours the email-change freeze', async () => {
    const { service, cache, securityChange } = createDeps();

    await service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE });

    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.reauthBySession(PRINCIPAL.sessionId),
      expect.anything(),
      'deny',
    );
    expect(securityChange.assertNoRecentEmailChange).toHaveBeenCalledWith(PRINCIPAL.userId);
  });

  it('refuses while the account is frozen after an email change', async () => {
    const { service, securityChange, twoFactor } = createDeps();
    securityChange.assertNoRecentEmailChange.mockRejectedValue(
      new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
    );

    const err = await problem(
      service.verify(PRINCIPAL, { emailCode: EMAIL_CODE, totpCode: TOTP_CODE }),
    );

    expect(err.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('asks for the challenge under this feature`s own action', async () => {
    const { service, twoFactor } = createDeps();

    await service.challenge(USER.id);

    // So the advertised method list matches what will actually be accepted — and so
    // `reauthMethods` withholds `recovery_code`: a printed sheet must not delete an
    // account.
    expect(twoFactor.reauthChallenge).toHaveBeenCalledWith(USER.id, 'account.delete');
  });
});

// ─── the deletion ───────────────────────────────────────────────────────────

describe('DeleteAccountService.remove — deleting the account', () => {
  it('moves the status and sets a deadline thirty days out', async () => {
    const { service, users } = createDeps();
    const before = Date.now();

    const { purgeAt } = await service.remove(PRINCIPAL, false, IP_CLASS);

    expect(users.state.user?.status).toBe('DELETED');
    expect(purgeAt.getTime()).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
    expect(purgeAt.getTime()).toBeLessThanOrEqual(Date.now() + THIRTY_DAYS_MS);
  });

  it('does NOT write deletedAt — the identifiers stay reserved', async () => {
    const { service, users } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // The load-bearing half of the design. Every partial unique index is scoped
    // `WHERE deleted_at IS NULL`, so leaving it unset is what keeps the email and
    // username reserved — and therefore what makes reactivation promisable. Writing it
    // here would release the address the moment the request landed.
    expect(users.state.user?.deletedAt).toBeNull();
  });

  it('revokes EVERY session, including the caller`s, as ACCOUNT_DELETED', async () => {
    const { service, sessions } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // `revokeAllForUser`, not `revokeAllForUserExcept`. There is no account left to
    // stay signed in to, and a surviving session would be a live credential for a state
    // that is supposed to grant nothing.
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      PRINCIPAL.userId,
      REVOKE_REASON.ACCOUNT_DELETED,
    );
  });

  it('moves the state BEFORE revoking the sessions', async () => {
    const { service, users, sessions } = createDeps();
    const order: string[] = [];
    users.requestAccountDeletion.mockImplementation(async () => {
      order.push('state');
      return true;
    });
    sessions.revokeAllForUser.mockImplementation(async () => {
      order.push('revoke');
    });

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // Of the two orderings only one has a failure mode that grants access. Revoking
    // first would leave a window in which every session was dead and the account still
    // ACTIVE — a user locked out of an account that was never deleted.
    expect(order).toEqual(['state', 'revoke']);
  });

  it('is idempotent: a second request returns the ORIGINAL deadline', async () => {
    const { service, users } = createDeps();

    const first = await service.remove(PRINCIPAL, false, IP_CLASS);
    users.requestAccountDeletion.mockClear();
    const second = await service.remove(PRINCIPAL, false, IP_CLASS);

    // Resetting the countdown on every call would let anyone holding a session hold the
    // purge thirty days away indefinitely.
    expect(second.purgeAt.getTime()).toBe(first.purgeAt.getTime());
    expect(users.requestAccountDeletion).not.toHaveBeenCalled();
  });

  it('sends exactly one notification across two requests', async () => {
    const { service, mail } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);
    await service.remove(PRINCIPAL, false, IP_CLASS);

    expect(mail.sendAccountDeleted).toHaveBeenCalledTimes(1);
    expect(mail.sendAccountDeleted).toHaveBeenCalledWith(
      USER.email,
      expect.any(Date),
      IP_CLASS,
      null,
    );
  });

  it('reports the winner`s deadline when it loses the compare-and-swap', async () => {
    const { service, users } = createDeps();
    const winner = new Date(Date.now() + THIRTY_DAYS_MS);
    // A second tab deleted between this request's read and its write.
    users.requestAccountDeletion.mockImplementation(async () => {
      users.state.user = deletedUser(winner);
      return false;
    });

    const result = await service.remove(PRINCIPAL, false, IP_CLASS);

    // Re-read and answer with what is actually true, rather than reporting a deadline
    // we did not set.
    expect(result.purgeAt.getTime()).toBe(winner.getTime());
  });

  it('charges an account-keyed bucket, not a session-keyed one', async () => {
    const { service, cache } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // A caller metered per session could reset their own budget by signing in again —
    // and this action ends every session, so that is not hypothetical.
    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.deleteAccountByAccount(PRINCIPAL.userId),
      expect.anything(),
      'deny',
    );
  });

  it('honours the email-change freeze before changing anything', async () => {
    const { service, securityChange, users, sessions } = createDeps();
    securityChange.assertNoRecentEmailChange.mockRejectedValue(
      new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
    );

    const err = await problem(service.remove(PRINCIPAL, false, IP_CLASS));

    expect(err.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    expect(users.requestAccountDeletion).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
});

// ─── the withdrawal boundary ────────────────────────────────────────────────

describe('DeleteAccountService — the withdrawal boundary', () => {
  it('consults the port on every deletion', async () => {
    const { service, withdrawals } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);

    expect(withdrawals.check).toHaveBeenCalledWith(PRINCIPAL.userId);
  });

  it('deletes normally when no subsystem is bound, without acknowledgement', async () => {
    const { service, users } = createDeps(createUsers(), { state: 'unavailable' });

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // `unavailable` must not block a deletion. An unbuilt subsystem cannot be allowed to
    // make the feature unusable, and there is demonstrably nothing in this repository to
    // withdraw.
    expect(users.state.user?.status).toBe('DELETED');
  });

  it('refuses pending funds without acknowledgement, and proceeds with it', async () => {
    const pending: PendingWithdrawalsState = { state: 'pending' };

    const refused = createDeps(createUsers(), pending);
    const err = await problem(refused.service.remove(PRINCIPAL, false, IP_CLASS));
    expect(err.type).toBe(ERR.ACCOUNT_DELETE_FUNDS_PENDING);
    expect(refused.users.state.user?.status).toBe('ACTIVE');

    const allowed = createDeps(createUsers(), pending);
    await allowed.service.remove(PRINCIPAL, true, IP_CLASS);
    expect(allowed.users.state.user?.status).toBe('DELETED');
  });

  it('checks the funds BEFORE moving any state', async () => {
    const { service, users } = createDeps(createUsers(), { state: 'pending' });

    await problem(service.remove(PRINCIPAL, false, IP_CLASS));

    // A refusal that had already deleted the account would be the worst of both.
    expect(users.requestAccountDeletion).not.toHaveBeenCalled();
  });

  it('performs no withdrawal of any kind', async () => {
    const { service, withdrawals } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);

    // The port has exactly one method, and it is a question. There is nothing on it to
    // move money with, which is the point of the boundary: the Withdraw Funds API is a
    // future task and this feature must not grow half of one.
    expect(Object.keys(withdrawals)).toEqual(['check']);
  });
});

// ─── reactivation ───────────────────────────────────────────────────────────

describe('DeleteAccountService.requestReactivation — and what it must not reveal', () => {
  function windowOpen() {
    return createUsers(deletedUser(new Date(Date.now() + THIRTY_DAYS_MS)));
  }

  it('mails a code for a deleted account inside its window', async () => {
    const { service, mail, challenges } = createDeps(windowOpen());

    await service.requestReactivation(USER.email, IP);

    expect(challenges.issue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id, purpose: 'ACCOUNT_REACTIVATION' }),
    );
    expect(mail.sendAccountReactivationCode).toHaveBeenCalled();
  });

  it('uses its OWN challenge purpose, never LOGIN_OTP', async () => {
    const { service, challenges } = createDeps(windowOpen());

    await service.requestReactivation(USER.email, IP);

    // Sharing LOGIN_OTP would let a code obtained from the ordinary login flow
    // reactivate an account, and would silently kill an in-flight login code —
    // `ux_challenges_live` is unique on (user, purpose) and `issue` supersedes.
    const [{ purpose }] = challenges.issue.mock.calls[0] as [{ purpose: string }];
    expect(purpose).toBe('ACCOUNT_REACTIVATION');
  });

  it('returns the same nothing for every address', async () => {
    const cases = [
      ['a deleted account', windowOpen()],
      ['a live account', createUsers(USER)],
      ['an unknown address', createUsers(null as unknown as User)],
      ['an expired account', createUsers(deletedUser(new Date(Date.now() - 1000)))],
    ] as const;

    for (const [, users] of cases) {
      const { service } = createDeps(users);
      await expect(service.requestReactivation(USER.email, IP)).resolves.toBeUndefined();
    }
  });

  it('sends no mail for a live account, an unknown address, or an expired one', async () => {
    for (const users of [
      createUsers(USER),
      createUsers(null as unknown as User),
      createUsers(deletedUser(new Date(Date.now() - 1000))),
    ]) {
      const { service, mail, challenges } = createDeps(users);
      await service.requestReactivation(USER.email, IP);
      expect(mail.sendAccountReactivationCode).not.toHaveBeenCalled();
      expect(challenges.issue).not.toHaveBeenCalled();
    }
  });

  it('charges IDENTICAL rate-limit buckets whether or not an account exists', async () => {
    const withAccount = createDeps(windowOpen());
    await withAccount.service.requestReactivation(USER.email, IP);

    const without = createDeps(createUsers(null as unknown as User));
    await without.service.requestReactivation(USER.email, IP);

    // The leak this prevents is subtle and total: a bucket charged only when an account
    // resolved would be readable by sending two requests and watching for the throttle.
    const keysOf = (deps: ReturnType<typeof createDeps>) =>
      deps.cache.consume.mock.calls.map((call) => call[0]);
    expect(keysOf(without)).toEqual(keysOf(withAccount));
    expect(keysOf(withAccount)).toEqual([
      KEYS.rate.accountReactivationByIp(IP),
      KEYS.rate.accountReactivationByEmail(USER.emailLower),
    ]);
  });

  it('charges both buckets BEFORE resolving the account', async () => {
    const users = windowOpen();
    const { service, cache } = createDeps(users);
    const order: string[] = [];
    cache.consume.mockImplementation(async () => {
      order.push('meter');
    });
    users.findByEmail.mockImplementation(async () => {
      order.push('lookup');
      return null;
    });

    await service.requestReactivation(USER.email, IP);

    expect(order).toEqual(['meter', 'meter', 'lookup']);
  });

  it('keys the buckets on caller-supplied values, never on a resolved userId', async () => {
    const { service, cache } = createDeps(windowOpen());

    await service.requestReactivation(USER.email, IP);

    for (const [key] of cache.consume.mock.calls) {
      expect(key).not.toContain(USER.id);
    }
  });
});

describe('DeleteAccountService.reactivate — the window', () => {
  /**
   * A service whose live reactivation challenge accepts `REACTIVATION_CODE`.
   *
   * The hash is produced by the SAME helper `verifyChallengeCode` compares with, so the
   * code path under test is the real one — only the row it reads is a fixture. Comparing
   * the digits is that helper's job and is covered by its own spec; what these tests are
   * about is the WINDOW.
   */
  function serviceFor(purgeAt: Date) {
    const deps = createDeps(createUsers(deletedUser(purgeAt)));
    deps.challenges.findLive.mockResolvedValue({
      id: 'challenge-1',
      userId: USER.id,
      purpose: 'ACCOUNT_REACTIVATION',
      codeHash: pepperedHash(REACTIVATION_CODE, 'otp'),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      consumedAt: null,
      targetEmailLower: null,
      ipAddress: IP,
      createdAt: new Date(),
    } as never);
    return deps;
  }

  it('restores an account inside the window', async () => {
    const deps = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));
    // The code comparison is `verifyChallengeCode`'s job and is covered by its own spec;
    // here the hash is made to match so the WINDOW is what is under test.

    await deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS);

    expect(deps.users.state.user?.status).toBe('ACTIVE');
    expect(deps.users.state.user?.purgeAt).toBeNull();
    expect(deps.users.state.user?.deletionRequestedAt).toBeNull();
  });

  it('refuses once the window has closed', async () => {
    const deps = serviceFor(new Date(Date.now() - 1000));

    const err = await problem(deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS));

    // `otp_invalid` rather than a window-expired slug, deliberately: this route is
    // public, and naming the state would confirm both that the account exists and that
    // it was deleted. The account staying DELETED is the half that matters here.
    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(deps.users.state.user?.status).toBe('DELETED');
  });

  it('enforces the boundary at exactly purgeAt — an instant either side decides it', async () => {
    // Time is FROZEN for this one, and it has to be: the offsets below are single
    // milliseconds, so against a real clock the few microseconds between building the
    // fixture and the service reading `Date.now()` would decide the result instead of
    // the predicate. Freezing is what makes this a test of the boundary rather than of
    // how fast the machine is.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-15T10:00:00.000Z'));
      const now = Date.now();

      // `purgeAt > now` is the predicate, so the deadline itself is NOT inside the
      // window — the last restorable instant is one millisecond before it.
      for (const [offset, expected] of [
        [1, 'ACTIVE'],
        [0, 'DELETED'],
        [-1, 'DELETED'],
      ] as const) {
        const deps = serviceFor(new Date(now + offset));

        await deps.service
          .reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS)
          .catch(() => undefined);

        expect(deps.users.state.user?.status, `offset ${offset}ms`).toBe(expected);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends the code even when the reactivation is refused', async () => {
    const deps = serviceFor(new Date(Date.now() - 1000));

    await problem(deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS));

    // A code that survived a refused reactivation could be replayed the moment the
    // account's state changed, and a caller could hold one waiting for that.
    expect(deps.challenges.consume).toHaveBeenCalledWith('challenge-1');
  });

  it('treats a lost race on the code as a failed verification', async () => {
    const deps = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));
    deps.challenges.consume.mockResolvedValue(false);

    const err = await problem(deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS));

    // Two requests must not both succeed on one code.
    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(deps.users.reactivateAccount).not.toHaveBeenCalled();
  });

  it('answers otp_invalid for an unknown address, exactly as for a wrong code', async () => {
    const unknown = createDeps(createUsers(null as unknown as User));
    const wrong = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));

    const a = await problem(unknown.service.reactivate('nobody@example.test', '000000', IP, IP_CLASS));
    const b = await problem(wrong.service.reactivate(USER.email, '000000', IP, IP_CLASS));

    // The two must remain indistinguishable on the public route.
    expect(a.type).toBe(ERR.OTP_INVALID);
    expect(b.type).toBe(ERR.OTP_INVALID);
  });

  it('answers IDENTICALLY whether or not the address has a deleted account', async () => {
    // ═══ THE ENUMERATION ORACLE THIS ROUTE MUST NOT BE ══════════════════════
    //
    // One unauthenticated request per address, no code requested first. Before this was
    // fixed the two answers differed: an unknown address got 400 `otp_invalid`, while a
    // real account inside its window reached `verifyChallengeCode`, found no live
    // challenge, and got 410 `otp_expired` — which told a stranger exactly which
    // addresses were mid-deletion, i.e. whose owners were locked out with only a
    // mailbox to get back in.
    const deleted = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));
    deleted.challenges.findLive.mockResolvedValue(null);
    const unknown = createDeps(createUsers(null as unknown as User));

    const a = await problem(deleted.service.reactivate(USER.email, '000000', IP, IP_CLASS));
    const b = await problem(unknown.service.reactivate(USER.email, '000000', IP, IP_CLASS));

    expect(a.type).toBe(b.type);
    expect(a.status).toBe(b.status);
    expect(a.detail).toBe(b.detail);
    expect(a.extra).toBe(b.extra);
    expect(a.type).toBe(ERR.OTP_INVALID);
  });

  it('leaks nothing through attemptsRemaining on a wrong code', async () => {
    // The second oracle, which survives equalising the status codes: a wrong guess
    // against a REAL account carries `extra.attemptsRemaining`, and an unknown address
    // never does.
    const deps = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));

    const err = await problem(deps.service.reactivate(USER.email, '000000', IP, IP_CLASS));

    expect(err.extra).toBeUndefined();
    expect(err.type).toBe(ERR.OTP_INVALID);
  });

  it('does not reveal an expired window on the public route', async () => {
    // The third oracle. Reachable only in the lag between `purgeAt` passing and the
    // sweep running, and it confirms both that the account exists and that it was
    // deleted — so it answers the same as everything else.
    const deps = serviceFor(new Date(Date.now() - 1000));

    const err = await problem(deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS));

    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(err.status).toBe(400);
  });

  it('charges both rate-limit buckets on the verify branch too', async () => {
    // The branch that leaked was also the branch that charged nothing, so the feature's
    // own anti-enumeration budgets did not apply to it.
    const deps = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));

    await deps.service
      .reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS)
      .catch(() => undefined);

    expect(deps.cache.consume.mock.calls.map((call) => call[0])).toEqual([
      KEYS.rate.accountReactivationByIp(IP),
      KEYS.rate.accountReactivationByEmail(USER.emailLower),
    ]);
  });

  it('charges those buckets identically for an unknown address', async () => {
    const known = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));
    const unknown = createDeps(createUsers(null as unknown as User));

    await known.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS).catch(() => undefined);
    await unknown.service.reactivate(USER.email, '000000', IP, IP_CLASS).catch(() => undefined);

    expect(unknown.cache.consume.mock.calls.map((c) => c[0])).toEqual(
      known.cache.consume.mock.calls.map((c) => c[0]),
    );
  });

  it('refuses to reactivate a live account', async () => {
    const deps = createDeps(createUsers(USER));

    const err = await problem(deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS));

    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(deps.users.reactivateAccount).not.toHaveBeenCalled();
  });

  it('mints no session — the owner must sign in again', async () => {
    const deps = serviceFor(new Date(Date.now() + THIRTY_DAYS_MS));

    await deps.service.reactivate(USER.email, REACTIVATION_CODE, IP, IP_CLASS);

    // `SessionService` is injected for `revokeAllForUser` alone. Reactivation does not
    // resurrect the sessions the deletion revoked, and nothing here mints one.
    expect(deps.sessions).not.toHaveProperty('issue');
    expect(deps.mail.sendAccountReactivated).toHaveBeenCalled();
  });
});

// ─── concurrency ────────────────────────────────────────────────────────────

describe('DeleteAccountService — concurrent state transitions', () => {
  it('leaves one valid state when two deletions race', async () => {
    const { service, users } = createDeps();

    const [a, b] = await Promise.all([
      service.remove(PRINCIPAL, false, IP_CLASS),
      service.remove(PRINCIPAL, false, IP_CLASS),
    ]);

    expect(users.state.user?.status).toBe('DELETED');
    // Both callers are told the truth, and only one deadline exists.
    expect(a.purgeAt.getTime()).toBe(b.purgeAt.getTime());
  });

  it('leaves a self-consistent state when a delete and a reactivate race', async () => {
    // Both interleavings are legitimate outcomes and which one wins is a property of the
    // database, not of this service — so the assertion is the INVARIANT rather than a
    // winner. What must never happen is the impossible middle: a status and a deadline
    // that disagree.
    for (const order of [
      ['reactivate', 'delete'],
      ['delete', 'reactivate'],
    ] as const) {
      const users = createUsers(deletedUser(new Date(Date.now() + THIRTY_DAYS_MS)));
      const deadline = new Date(Date.now() + THIRTY_DAYS_MS);

      const run = (what: string) =>
        what === 'reactivate'
          ? users.reactivateAccount(USER.id, new Date())
          : users.requestAccountDeletion(USER.id, new Date(), deadline);

      await Promise.all(order.map(run));

      const user = users.state.user;
      if (user?.status === 'ACTIVE') {
        expect(user.purgeAt).toBeNull();
        expect(user.deletionRequestedAt).toBeNull();
      } else {
        expect(user?.status).toBe('DELETED');
        expect(user?.purgeAt).not.toBeNull();
        // Still recoverable: a race must never skip the window straight to a purge.
        expect(user?.deletedAt).toBeNull();
      }
    }
  });

  it('never produces ACTIVE with a purge deadline, or DELETED without one', async () => {
    const { service, users } = createDeps();

    await service.remove(PRINCIPAL, false, IP_CLASS);
    const deleted = users.state.user;
    expect(deleted?.status).toBe('DELETED');
    expect(deleted?.purgeAt).not.toBeNull();

    await users.reactivateAccount(USER.id, new Date());
    const restored = users.state.user;
    expect(restored?.status).toBe('ACTIVE');
    expect(restored?.purgeAt).toBeNull();
  });
});
