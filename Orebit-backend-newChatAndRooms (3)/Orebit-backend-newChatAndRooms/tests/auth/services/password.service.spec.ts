import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTP } from '../../../auth/auth.constants';
import { policy } from '../../../auth/limits';
import type { ClientContext, Principal } from '../../../auth/auth.types';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { pepperedHash } from '../../../auth/auth.utility';
import type { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';
import type { CredentialService } from '../../../auth/services/credential.service';
import { PasswordService } from '../../../auth/services/password.service';
import type { SessionService } from '../../../auth/services/session.service';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { MailService } from '../../../src/mail/mail.service';
import { MailUndoRegistry } from '../../../src/mail/mail.undo';
import type { MailUndo } from '../../../src/mail/mail.types';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { makeChallenge, makeCredential, makeQuota, makeSecurityChangePolicy, makeUser } from '../../harness';
import { FACTS, makeRestrictions } from '../../restrictions/double';

/**
 * PasswordService, now that it is an authenticated set/change service rather than
 * public recovery.
 *
 * Two properties carry the security weight and both are asserted below:
 *
 *  1. `change` accepts the current password and NOTHING else. Offering a second
 *     proof would make the weaker one the only one that matters.
 *  2. Both paths revoke every OTHER session and keep the caller's. Revoking all of
 *     them signs the user out of the tab they are standing in; revoking none
 *     leaves an attacker signed in through the change that was meant to evict them.
 */

const CODE = '123456';
const CORRECT_HASH = pepperedHash(CODE, 'otp');
const NEW_PASSWORD = 'Br4nd!NewPassw0rd';

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

const principal: Principal = {
  userId: 'user-1',
  sessionId: 'session-current',
  publicCode: 'OREBIT123',
  familyId: 'family-1',
};

function createUsers() {
  const user = makeUser({ id: principal.userId });
  return {
    user,
    findById: vi.fn().mockResolvedValue(user),
    findWithCredential: vi.fn().mockResolvedValue({ user, credential: makeCredential() }),
    upsertPassword: vi.fn().mockResolvedValue(undefined),
  };
}

function createChallenges() {
  return {
    issue: vi.fn().mockResolvedValue(makeChallenge({ purpose: 'PASSWORD_RESET' })),
    findLive: vi.fn().mockResolvedValue(null),
    incrementAttempts: vi.fn().mockResolvedValue(1),
    consume: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };
}

let users: ReturnType<typeof createUsers>;
let challenges: ReturnType<typeof createChallenges>;
let credentials: {
  hash: ReturnType<typeof vi.fn>;
  assertPolicy: ReturnType<typeof vi.fn>;
  checkPassword: ReturnType<typeof vi.fn>;
};
let sessions: { revokeAllForUserExcept: ReturnType<typeof vi.fn> };
let mail: {
  sendPasswordReset: ReturnType<typeof vi.fn>;
  sendSecurityChanged: ReturnType<typeof vi.fn>;
};
let cache: {
  consume: ReturnType<typeof vi.fn>;
  refund: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  clearOrThrow: ReturnType<typeof vi.fn>;
  refundOrThrow: ReturnType<typeof vi.fn>;
  setIfAbsent: ReturnType<typeof vi.fn>;
};
/**
 * The factor double for `assertNotAFactorDowngrade`.
 *
 * `[]` — no confirmed factor — is the default because every pre-existing spec in this
 * file is about something else, and on a no-factor account the gate is a no-op. The
 * specs that ARE about the gate override it; see 'the factor downgrade gate' below.
 */
let mfa: {
  availableMethods: ReturnType<typeof vi.fn>;
  expireLiveAttemptsFor: ReturnType<typeof vi.fn>;
};
let service: PasswordService;

beforeEach(() => {
  users = createUsers();
  mfa = {
    availableMethods: vi.fn().mockResolvedValue([]),
    // `commit` retires the account's in-flight sign-ins beside the session sweep. The
    // real behaviour is driven end-to-end in
    // password-invalidates-login-attempts.spec.ts; here it only has to exist.
    expireLiveAttemptsFor: vi.fn().mockResolvedValue(0),
  };
  challenges = createChallenges();
  credentials = {
    hash: vi.fn().mockResolvedValue('$argon2id$fresh'),
    assertPolicy: vi.fn(),
    checkPassword: vi.fn().mockResolvedValue(true),
  };
  sessions = { revokeAllForUserExcept: vi.fn().mockResolvedValue(undefined) };
  mail = {
    // Non-blocking dispatch: the double models the contract, which is an
    // `onUndelivered` callback it may or may not run. Not calling it means the
    // message went out.
    sendPasswordReset: vi.fn(),
    sendSecurityChanged: vi.fn().mockResolvedValue(true),
  };
  cache = {
    consume: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    // `MailUndoRegistry` reaches for the strict variants, so a failed compensation is
    // reported rather than swallowed. Same effect, different error contract.
    clear: vi.fn().mockResolvedValue(undefined),
    clearOrThrow: vi.fn().mockResolvedValue(undefined),
    refundOrThrow: vi.fn().mockResolvedValue(undefined),
    // The once-only claim for non-idempotent compensations; `true` = this delivery
    // won it. `cache.refund` is a DECR, so repeating it would over-refund.
    setIfAbsent: vi.fn().mockResolvedValue(true),
  };

  service = new PasswordService(
    users as unknown as UserDbOperation,
    challenges as unknown as ChallengeDbOperation,
    credentials as unknown as CredentialService,
    sessions as unknown as SessionService,
    mail as unknown as MailService,
    makeRestrictions() as never,
    cache as unknown as CacheService,
    makeSecurityChangePolicy() as never,
    mfa as never,
  );
});

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** A live PASSWORD_RESET challenge matching CODE. */
function liveChallenge() {
  challenges.findLive.mockResolvedValue(
    makeChallenge({ purpose: 'PASSWORD_RESET', codeHash: CORRECT_HASH }),
  );
}

const setPassword = () =>
  service.set(
    principal,
    { action: 'set', code: CODE, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
    client,
  );

const changePassword = (currentPassword = 'Old!Passw0rd') =>
  service.change(
    principal,
    {
      action: 'change',
      currentPassword,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    },
    client,
  );

describe('PasswordService.requestCode', () => {
  it('meters the account and emails a reset code', async () => {
    await service.requestCode(principal, client);

    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.passwordForgotByEmail(users.user.emailLower),
      policy().CREDENTIAL.SET_CODE_BY_ACCOUNT,
      'deny',
    );
    expect(challenges.issue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: principal.userId, purpose: 'PASSWORD_RESET' }),
    );
    expect(mail.sendPasswordReset).toHaveBeenCalledTimes(1);
  });

  it('refunds the budget when SMTP would not take the message', async () => {
    // The undo runs in the background after `requestCode` has returned; the double
    // invokes it inline so the assertion sees the settled state. What is being
    // pinned is that a relay outage does not cost the user a reset attempt.
    // Runs the DECLARED compensation through the real registry, against the same
    // cache double the service charged. The service no longer performs the refund —
    // it declares it and the worker applies it — so what is pinned here spans both
    // halves rather than merely asserting a descriptor was handed over.
    mail.sendPasswordReset.mockImplementation(
      async (_to: string, _code: string, _mins: number, undo: readonly MailUndo[]) => {
        await new MailUndoRegistry(cache as unknown as CacheService, makeQuota() as unknown as QuotaService).runAll(undo, {
          jobId: 'test-job',
          kind: 'password-reset',
        });
      },
    );

    await service.requestCode(principal, client);

    // `refundOrThrow`, not `refund`: the registry uses the variant that reports a
    // failure, because the fail-open one returned normally on a Redis outage and had
    // the compensation logged as applied when nothing had been given back.
    expect(cache.refundOrThrow).toHaveBeenCalledWith(
      KEYS.rate.passwordForgotByEmail(users.user.emailLower),
    );
  });

  it('refuses a token that outlived its account', async () => {
    users.findById.mockResolvedValue(null);

    const err = await problem(service.requestCode(principal, client));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
  });
});

describe('PasswordService.set — proving the mailbox', () => {
  it('checks the policy AFTER the code is proven but BEFORE it is spent', async () => {
    // The ordering that matters: a weak new password must not burn the code and
    // force another email. Reversing verify and consume silently destroys this.
    liveChallenge();
    credentials.assertPolicy.mockImplementation(() => {
      throw new ProblemException({ type: ERR.PASSWORD_WEAK });
    });

    const err = await problem(setPassword());

    expect(err.type).toBe(ERR.PASSWORD_WEAK);
    expect(challenges.consume).not.toHaveBeenCalled();
    expect(users.upsertPassword).not.toHaveBeenCalled();
  });

  it('sets the password and keeps the caller signed in', async () => {
    liveChallenge();

    await setPassword();

    expect(users.upsertPassword).toHaveBeenCalledWith(
      principal.userId,
      '$argon2id$fresh',
      expect.anything(),
    );
    expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
      principal.userId,
      principal.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );
  });

  it('revokes before it writes', async () => {
    // Two independent commits, so the order decides which way a partial failure
    // fails. Writing first and then failing to revoke leaves the new password live
    // alongside every session it was meant to evict.
    liveChallenge();
    const order: string[] = [];
    sessions.revokeAllForUserExcept.mockImplementation(async () => void order.push('revoke'));
    users.upsertPassword.mockImplementation(async () => void order.push('write'));

    await setPassword();

    expect(order).toEqual(['revoke', 'write']);
  });

  it('notifies the account (gap M3)', async () => {
    liveChallenge();

    await setPassword();

    expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
      users.user.email,
      expect.any(String),
      client.ipClass,
      // No anti-phishing code configured on the fixture account.
      null,
    );
  });

  it('refuses a wrong code without touching the password', async () => {
    liveChallenge();

    const err = await problem(
      service.set(
        principal,
        { action: 'set', code: '000000', password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
        client,
      ),
    );

    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(users.upsertPassword).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE FACTOR DOWNGRADE GATE ══════════════════════════════════════════════
 *
 * `set` serves two populations that are identical to this route and are not identical
 * at all: an account with NO password, where it CREATES a credential and the mailbox
 * is a safe authorisation, and one whose owner has forgotten theirs, where it
 * REPLACES a live password.
 *
 * On the second, if the account has a passkey or an authenticator, a mailbox-only
 * replacement is a downgrade of exactly the protection the owner opted into — and it
 * would be a one-call bypass of `PASSWORD_FACTOR_REQUIRED` on
 * `POST /settings/security/password`. This route has no field for the proof that case
 * needs, so it refuses the case rather than serving it weakly.
 *
 * Two of the three cases are deliberately UNTOUCHED, and that is the point of gating
 * rather than retiring the action. Each is asserted below.
 */
describe('PasswordService.set — the factor downgrade gate', () => {
  it('still serves an account with no password at all', async () => {
    // `set`'s real job. The provider-created and password-skipped accounts that
    // depend on it must keep working, and they are the reason the gate reads the
    // credential before it asks about factors.
    liveChallenge();
    users.findWithCredential.mockResolvedValue({ user: users.user, credential: null });
    mfa.availableMethods.mockResolvedValue(['passkey', 'totp']);

    await expect(setPassword()).resolves.toBeUndefined();
    expect(users.upsertPassword).toHaveBeenCalled();
  });

  it('does not even ask about factors when there is no password', async () => {
    // The common case, and one fewer pair of counting queries on it.
    liveChallenge();
    users.findWithCredential.mockResolvedValue({ user: users.user, credential: null });

    await setPassword();

    expect(mfa.availableMethods).not.toHaveBeenCalled();
  });

  it('still serves an account that has a password but no factor', async () => {
    // Equivalent to `forgot` on a no-factor account, where the emailed code IS the
    // documented sufficient authorisation. No behaviour change here.
    liveChallenge();
    mfa.availableMethods.mockResolvedValue([]);

    await expect(setPassword()).resolves.toBeUndefined();
    expect(users.upsertPassword).toHaveBeenCalled();
  });

  it.each([
    ['a passkey', ['passkey'], ['passkey']],
    ['an authenticator', ['totp'], ['authenticator']],
    ['both', ['passkey', 'totp'], ['passkey', 'authenticator']],
  ] as const)(
    'refuses an account that has a password AND %s',
    async (_label, enrolled, expected) => {
      liveChallenge();
      mfa.availableMethods.mockResolvedValue([...enrolled]);

      const err = await problem(setPassword());

      expect(err.type).toBe(ERR.PASSWORD_FACTOR_REQUIRED);
      // Named so a client can render the right prompt on the route that can ask.
      expect(err.extra).toEqual({ methods: expected });
      expect(err.detail).toContain('/settings/security/password');
    },
  );

  it('refuses BEFORE the emailed code is spent', async () => {
    // A refusal the server could issue for free must not cost the user their code —
    // they will need it on the route this points them at.
    liveChallenge();
    mfa.availableMethods.mockResolvedValue(['passkey']);

    await problem(setPassword());

    expect(challenges.consume).not.toHaveBeenCalled();
    expect(users.upsertPassword).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUserExcept).not.toHaveBeenCalled();
  });

  it('ignores an unconfirmed enrollment, like every other factor question', async () => {
    // `availableMethods` lists CONFIRMED credentials only, so an abandoned
    // enrollment must not close this route on an account that has no usable factor.
    liveChallenge();
    mfa.availableMethods.mockResolvedValue(['recovery_code']);

    await expect(setPassword()).resolves.toBeUndefined();
  });

  it('does not gate `change`, which proves the current password', async () => {
    // The gate is about a mailbox-only REPLACEMENT. `change` demands the current
    // password, which is the one thing a mailbox cannot supply, so a factor adds
    // nothing there and requiring one would break a working flow.
    mfa.availableMethods.mockResolvedValue(['passkey', 'totp']);

    await expect(
      service.change(
        principal,
        {
          action: 'change',
          currentPassword: 'old-password',
          password: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        },
        client,
      ),
    ).resolves.toBeUndefined();

    expect(users.upsertPassword).toHaveBeenCalled();
  });
});

describe('PasswordService.change — proving the current password', () => {
  it('refuses a wrong current password', async () => {
    credentials.checkPassword.mockResolvedValue(false);

    const err = await problem(changePassword('not-the-password'));

    expect(err.type).toBe(ERR.INVALID_CREDENTIALS);
    expect(users.upsertPassword).not.toHaveBeenCalled();
  });

  it('never accepts an emailed code as an alternative proof', async () => {
    // Two proofs for one action means the weaker one is the only one that matters.
    // `change` must not consult the challenge table at all.
    liveChallenge();

    await changePassword();

    expect(challenges.findLive).not.toHaveBeenCalled();
    expect(challenges.consume).not.toHaveBeenCalled();
  });

  it('routes an account with no password to the set flow instead', async () => {
    users.findWithCredential.mockResolvedValue({ user: users.user, credential: null });

    const err = await problem(changePassword());

    expect(err.type).toBe(ERR.OTP_REQUIRED);
  });

  it('changes the password, evicts other sessions, and notifies', async () => {
    await changePassword();

    expect(users.upsertPassword).toHaveBeenCalledWith(
      principal.userId,
      '$argon2id$fresh',
      expect.anything(),
    );
    expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
      principal.userId,
      principal.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );
    expect(mail.sendSecurityChanged).toHaveBeenCalledTimes(1);
  });

  it('counts a wrong guess toward the lockout like any other', async () => {
    // A session is not a reason to exempt a password guess from the counter that
    // bounds guessing — `checkPassword` owns that, so it must be the thing called.
    credentials.checkPassword.mockResolvedValue(false);

    await problem(changePassword('wrong'));

    expect(credentials.checkPassword).toHaveBeenCalledWith(expect.anything(), 'wrong');
  });
});

describe('the OTP lifetime is unchanged by the move', () => {
  it('issues a code with the standard TTL', async () => {
    await service.requestCode(principal, client);

    const issued = challenges.issue.mock.calls[0]?.[0] as { expiresAt: Date };
    const seconds = (issued.expiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(OTP.TTL_SECONDS - 10);
    expect(seconds).toBeLessThanOrEqual(OTP.TTL_SECONDS);
  });
});
