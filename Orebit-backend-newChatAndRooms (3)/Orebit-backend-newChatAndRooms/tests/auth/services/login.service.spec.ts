import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTP } from '../../../auth/auth.constants';
import { policy } from '../../../auth/limits';

/** The short window of the login-code mail budget. */
const MAIL_BUDGET = policy().LOGIN_OTP.MAIL_BY_ACCOUNT[0] as {
  limit: number;
  windowSeconds: number;
};
import type { ClientContext } from '../../../auth/auth.types';
import { pepperedHash } from '../../../auth/auth.utility';
import type { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import type { CredentialService } from '../../../auth/services/credential.service';
import { LoginService } from '../../../auth/services/login.service';
import type { MfaService } from '../../../src/2fa/mfa.service';
import type { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import type { SessionService } from '../../../auth/services/session.service';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { MailService } from '../../../src/mail/mail.service';
import { MailUndoRegistry } from '../../../src/mail/mail.undo';
import type { MailUndo } from '../../../src/mail/mail.types';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import {
  makeChallenge,
  makeCredential,
  makeLoginAttempt,
  makeQuota,
  makeUser,
} from '../../harness';

/**
 * LoginService against hand-written doubles of its seven dependencies.
 *
 * The bulk of this file is `verifyOtp`, and deliberately so: it is the OTP
 * challenge protocol — expiry, attempt counting, constant-time compare,
 * compare-and-swap consume — and every one of those steps is a security control
 * whose failure mode is silent. A wrong attempt-counter branch does not throw or
 * corrupt anything; it just quietly hands an attacker more guesses.
 *
 * These tests are also the safety net for extracting that protocol into a shared
 * ChallengeService. They assert observable behaviour only — which error type,
 * which dboperation calls, in which order — so the extraction must not need to
 * edit a single one of them.
 */

const CODE = '123456';
const CORRECT_HASH = pepperedHash(CODE, 'otp');

/** The captcha fields the DTO requires. Verification happens in the controller,
 *  so at this layer they are inert payload the service never reads. */
const CAPTCHA = { captchaProvider: 'TURNSTILE', captchaToken: 'tok' } as const;

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

function createUsers() {
  return {
    findByEmail: vi.fn().mockResolvedValue(null),
    findByUsername: vi.fn().mockResolvedValue(null),
    findByPublicCode: vi.fn().mockResolvedValue(null),
    findWithCredential: vi.fn(),
    touchLastSeen: vi.fn().mockResolvedValue(undefined),
  };
}

function createChallenges() {
  return {
    issue: vi.fn().mockResolvedValue(makeChallenge()),
    findLive: vi.fn().mockResolvedValue(null),
    incrementAttempts: vi.fn().mockResolvedValue(1),
    consume: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A cache double that models the one property of Redis these paths depend on:
 * `consume` and `cooldownRemaining` read and write the SAME keyspace.
 *
 * The previous double gave the two independent mocks, and that is precisely what
 * let a real bug live here fully green. The rate counter and the resend cooldown
 * shared a key, so `consume` set an hour-long TTL on the first otp-request and
 * `cooldownRemaining` immediately read it back as a live cooldown — the endpoint
 * never sent a code at all, on any request. Independent mocks cannot express that,
 * because the collision IS the coupling they abstracted away.
 *
 * One `ttls` map is therefore not incidental fidelity. It is the assertion: merge
 * those two namespaces again and `sends a code for a passwordless active account`
 * fails instead of shipping.
 */
function createCache() {
  const ttls = new Map<string, number>();
  const counts = new Map<string, number>();

  return {
    ttls,
    counts,
    consume: vi.fn(async (key: string, rule: { limit: number; windowSeconds: number }) => {
      const hits = (counts.get(key) ?? 0) + 1;
      counts.set(key, hits);
      // `EXPIRE … NX` — the window is stamped once, by the request that opens it.
      if (!ttls.has(key)) ttls.set(key, rule.windowSeconds);
      if (hits > rule.limit) {
        throw new ProblemException({ type: ERR.RATE_LIMITED, retryAfterSeconds: 30 });
      }
    }),
    cooldownRemaining: vi.fn(async (key: string) => ttls.get(key) ?? 0),
    startCooldown: vi.fn(async (key: string, seconds: number) => {
      if (ttls.has(key)) return false;
      ttls.set(key, seconds);
      return true;
    }),
    /** DEL — drops the key outright, counter and TTL together. */
    clear: vi.fn(async (key: string) => {
      ttls.delete(key);
      counts.delete(key);
    }),
    /** DECR, but only on a key that still exists — see `CacheService.refund`. */
    refund: vi.fn(async (key: string) => {
      const hits = counts.get(key);
      if (hits === undefined) return;
      counts.set(key, hits - 1);
    }),
    // The strict variants, over the SAME keyspace. `MailUndoRegistry` uses these so a
    // failed compensation is reported rather than swallowed; the observable effect on
    // the counters is identical, which is what these tests assert on.
    clearOrThrow: vi.fn(async (key: string) => {
      ttls.delete(key);
      counts.delete(key);
    }),
    refundOrThrow: vi.fn(async (key: string) => {
      const hits = counts.get(key);
      if (hits === undefined) return;
      counts.set(key, hits - 1);
    }),
    setIfAbsent: vi.fn(async (key: string, value: string, seconds: number) => {
      if (ttls.has(key)) return false;
      ttls.set(key, seconds);
      counts.set(key, value.length);
      return true;
    }),
    clearIfValue: vi.fn(async (key: string) => {
      ttls.delete(key);
      counts.delete(key);
    }),
  };
}

let users: ReturnType<typeof createUsers>;
let challenges: ReturnType<typeof createChallenges>;
let cache: ReturnType<typeof createCache>;
let credentials: { checkPassword: ReturnType<typeof vi.fn> };
let sessions: { issue: ReturnType<typeof vi.fn> };
let mail: { sendOtp: ReturnType<typeof vi.fn> };

/**
 * Make every send fail, the way a dead relay does.
 *
 * The undo runs in the background after the caller has returned, so the double
 * invokes it inline and the assertions see the settled state. That is a fair model:
 * both orderings are possible in production, and the one worth pinning is that the
 * refund happens at all.
 */
function undeliverable(): void {
  mail.sendOtp.mockImplementation(
    async (_to: string, _code: string, _mins: number, undo: readonly MailUndo[]) => {
      // Run the DECLARED compensations through the real registry, against the same
      // cache double the service charged. This is why these tests still assert the
      // budget coming back rather than merely that a descriptor was passed: the
      // service no longer performs the refund — it declares it, and the worker
      // applies it — so the assertion worth keeping spans both halves.
      await new MailUndoRegistry(
        cache as unknown as CacheService,
        quota as unknown as QuotaService,
      ).runAll(undo, {
        jobId: 'test-job',
        kind: 'otp',
      });
    },
  );
}
let mfa: { challengeFor: ReturnType<typeof vi.fn>; assertSameContext: ReturnType<typeof vi.fn> };
let attempts: {
  createFlow: ReturnType<typeof vi.fn>;
  promoteAttempt: ReturnType<typeof vi.fn>;
  completeAttempt: ReturnType<typeof vi.fn>;
  markOtpSent: ReturnType<typeof vi.fn>;
  findAttemptByTokenHash: ReturnType<typeof vi.fn>;
  expireAttempt: ReturnType<typeof vi.fn>;
};
let quota: ReturnType<typeof makeQuota>;
let blocklist: { assertNotBlocked: ReturnType<typeof vi.fn>; isBlocked: ReturnType<typeof vi.fn> };
let service: LoginService;

/** Point the identifier resolution at a user with (or without) a credential. */
function resolvesTo(user = makeUser(), credential = makeCredential()) {
  users.findByEmail.mockResolvedValue(user);
  users.findWithCredential.mockResolvedValue({ user, credential });
  return user;
}

beforeEach(() => {
  users = createUsers();
  challenges = createChallenges();
  cache = createCache();
  credentials = { checkPassword: vi.fn().mockResolvedValue(true) };
  sessions = { issue: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }) };
  // `true` = SMTP took it. A falsy value now means the send failed, which makes
  // the service refund the budget and the cooldown.
  // Dispatch is non-blocking now, so the double models the CONTRACT rather than a
  // return value: `sendOtp` takes an `onUndelivered` callback and, by default,
  // never calls it — the message went out. `undeliverable()` below flips that.
  mail = { sendOtp: vi.fn() };
  // Null = this account has no second factor, which is the state every test in
  // this file describes. The ceremony has its own suite; here it must be inert, so
  // that a change breaking ordinary sign-in cannot hide behind an MFA branch.
  mfa = { challengeFor: vi.fn().mockResolvedValue(null), assertSameContext: vi.fn() };
  // The flow row. `promoteAttempt` and `completeAttempt` answer true by default —
  // they are compare-and-swaps, and a lost swap is the interesting case, so the
  // tests that care set them to false explicitly.
  attempts = {
    createFlow: vi.fn().mockResolvedValue(makeLoginAttempt({ state: 'STARTED' })),
    promoteAttempt: vi.fn().mockResolvedValue(true),
    completeAttempt: vi.fn().mockResolvedValue(true),
    markOtpSent: vi.fn().mockResolvedValue(true),
    findAttemptByTokenHash: vi.fn().mockResolvedValue(null),
    expireAttempt: vi.fn().mockResolvedValue(undefined),
  };
  quota = makeQuota();
  // Nothing blocked by default, so every existing test describes the same flow it
  // did before the blocklist existed.
  blocklist = {
    assertNotBlocked: vi.fn().mockResolvedValue(undefined),
    isBlocked: vi.fn().mockResolvedValue(false),
  };

  service = new LoginService(
    users as unknown as UserDbOperation,
    challenges as unknown as ChallengeDbOperation,
    credentials as unknown as CredentialService,
    sessions as unknown as SessionService,
    mail as unknown as MailService,
    cache as unknown as CacheService,
    quota as unknown as QuotaService,
    blocklist as unknown as BlocklistService,
    mfa as unknown as MfaService,
    attempts as unknown as TwoFactorDbOperation,
  );
});

/**
 * The flow row every step past `start` now resolves before it runs.
 *
 * A helper rather than an inline literal at ~30 call sites, and it takes the state
 * because that is the one field the state machine actually reads: `withPassword`
 * runs from STARTED, `verifyOtp` from OTP_SENT.
 */
const flowAt = (state: 'STARTED' | 'OTP_SENT' = 'STARTED', overrides = {}) =>
  makeLoginAttempt({ state, tokenHash: 'b'.repeat(64), userId: null, ...overrides });

/** The ProblemException a call rejected with. Fails the test if it resolved. */
async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

async function problemType(call: Promise<unknown>): Promise<string> {
  return (await problem(call)).type;
}

/**
 * `otp-verify` no longer takes an identifier — the address comes from the flow the
 * code was sent for. So the fixture carries it on the row instead, which is also
 * what makes the "cannot be switched between users" property testable: point
 * `identifierLower` somewhere else and the account that gets resolved changes with
 * it, whatever any request body says.
 */
const LOGIN_ID = 'l'.repeat(43);

const verify = (code = CODE, identifierLower = 'ada@example.test') =>
  service.verifyOtp(
    flowAt('OTP_SENT', { identifierLower }),
      LOGIN_ID,
    { step: 'otp-verify', loginId: 'l'.repeat(43), code },
    client,
  );

describe('LoginService.verifyOtp — resolution', () => {
  it('reports otp_invalid for an identifier that matches no account', async () => {
    // NOT account_not_found: this endpoint is unauthenticated, and a distinct
    // error here would make it an account-existence oracle.
    expect(await problemType(verify())).toBe(ERR.OTP_INVALID);
    expect(challenges.findLive).not.toHaveBeenCalled();
  });

  it('reports account_disabled for a disabled account', async () => {
    resolvesTo(makeUser({ status: 'DISABLED' }));
    expect(await problemType(verify())).toBe(ERR.ACCOUNT_DISABLED);
    expect(challenges.findLive).not.toHaveBeenCalled();
  });

  it('charges the flood ceiling before touching the database', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: CORRECT_HASH }));
    await verify();

    // One bucket on the happy path: the endpoint flood ceiling, charged on entry.
    // There is deliberately no per-identifier request bucket any more — it metered
    // one target at a time, so a caller walking a list of identifiers paid nothing.
    // What bounds that caller is `loginUnknownByIp`, charged only when the
    // identifier resolves to nothing.
    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.loginFloodByIp(client.ip),
      policy().PASSWORD_LOGIN.FLOOD_BY_IP,
      'allow',
    );
    expect(cache.consume).toHaveBeenCalledTimes(1);
  });

  /**
   * ─── The enumeration charge moved off this step, deliberately ────────────
   *
   * It used to be charged here, because `otp-verify` took an identifier from the
   * body and could therefore be pointed at a different address on every request —
   * which is the definition of an enumeration surface.
   *
   * It cannot be any more. The address is fixed on the flow row when
   * `otp-request` runs and this step reads it from there, so a caller varying
   * anything in the body is still asking about the same account. Charging a
   * caller for an address they cannot choose would meter honest retries and
   * nothing else. The bucket still exists and is still charged, one step earlier,
   * where the address IS chosen — asserted in the `requestOtp` suite below.
   */
  it('does not charge the enumeration bucket — the address is fixed on the flow', async () => {
    users.findByEmail.mockResolvedValue(null);

    await expect(verify(CODE, 'nobody@example.test')).rejects.toThrow();

    expect(cache.consume).not.toHaveBeenCalledWith(
      KEYS.rate.loginUnknownByIp(client.ip),
      policy().PASSWORD_LOGIN.UNKNOWN_BY_IP,
      'allow',
    );
  });

  it('resolves the account from the FLOW, not from anything the caller sends', async () => {
    // The property the whole migration turns on: a login flow cannot be pointed
    // at a different account by editing a request body, because the body has no
    // field that names one.
    const user = makeUser({ email: 'ada@example.test', emailLower: 'ada@example.test' });
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: makeCredential() });
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: CORRECT_HASH }));

    await service.verifyOtp(
      flowAt('OTP_SENT', { identifierLower: 'victim@example.test' }),
      LOGIN_ID,
      { step: 'otp-verify', loginId: LOGIN_ID, code: CODE },
      client,
    );

    expect(users.findByEmail).toHaveBeenCalledWith('victim@example.test');
  });
});

describe('LoginService.verifyOtp — the challenge protocol', () => {
  it('reports otp_expired when there is no live challenge at all', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(null);

    expect(await problemType(verify())).toBe(ERR.OTP_EXPIRED);
    // Nothing to invalidate — the absence is not a challenge.
    expect(challenges.invalidate).not.toHaveBeenCalled();
    expect(challenges.incrementAttempts).not.toHaveBeenCalled();
  });

  it('invalidates and reports otp_expired for a challenge past its expiry', async () => {
    resolvesTo();
    const challenge = makeChallenge({
      codeHash: CORRECT_HASH,
      expiresAt: new Date(Date.now() - 1000),
    });
    challenges.findLive.mockResolvedValue(challenge);

    expect(await problemType(verify())).toBe(ERR.OTP_EXPIRED);
    expect(challenges.invalidate).toHaveBeenCalledWith(challenge.id);
    // Expiry is checked BEFORE the counter: an expired code must not burn an
    // attempt, or a slow user loses their remaining guesses to the clock.
    expect(challenges.incrementAttempts).not.toHaveBeenCalled();
  });

  it('invalidates and reports otp_attempts_exhausted when the counter is already spent', async () => {
    resolvesTo();
    const challenge = makeChallenge({
      codeHash: CORRECT_HASH,
      attempts: OTP.MAX_ATTEMPTS,
    });
    challenges.findLive.mockResolvedValue(challenge);

    expect(await problemType(verify())).toBe(ERR.OTP_ATTEMPTS_EXHAUSTED);
    expect(challenges.invalidate).toHaveBeenCalledWith(challenge.id);
    // A dead code is not re-tested, even with the correct value.
    expect(challenges.consume).not.toHaveBeenCalled();
  });

  it('increments the attempt counter BEFORE comparing, so an abandoned request still costs a guess', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: 'wrong' }));
    challenges.incrementAttempts.mockResolvedValue(1);

    await problemType(verify());
    expect(challenges.incrementAttempts).toHaveBeenCalledTimes(1);
  });

  it('reports otp_invalid with the remaining attempts for a wrong code below the limit', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: 'wrong' }));
    challenges.incrementAttempts.mockResolvedValue(2);

    const err = await problem(verify());
    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(err.extra).toEqual({ attemptsRemaining: OTP.MAX_ATTEMPTS - 2 });
    // Still usable, so it must NOT be invalidated.
    expect(challenges.invalidate).not.toHaveBeenCalled();
  });

  it('escalates to otp_attempts_exhausted when the wrong guess is the last one', async () => {
    resolvesTo();
    const challenge = makeChallenge({ codeHash: 'wrong' });
    challenges.findLive.mockResolvedValue(challenge);
    challenges.incrementAttempts.mockResolvedValue(OTP.MAX_ATTEMPTS);

    expect(await problemType(verify())).toBe(ERR.OTP_ATTEMPTS_EXHAUSTED);
    expect(challenges.invalidate).toHaveBeenCalledWith(challenge.id);
  });

  it('never reports negative attemptsRemaining', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: 'wrong' }));
    // Beyond the limit — the escalation branch owns this, and it must not leak a
    // negative count on the way out.
    challenges.incrementAttempts.mockResolvedValue(OTP.MAX_ATTEMPTS + 3);

    expect(await problemType(verify())).toBe(ERR.OTP_ATTEMPTS_EXHAUSTED);
  });

  it('reports otp_invalid when the compare-and-swap consume loses the race', async () => {
    resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: CORRECT_HASH }));
    challenges.consume.mockResolvedValue(false);

    // A correct code that something else already spent must not also succeed —
    // one code, one session.
    expect(await problemType(verify())).toBe(ERR.OTP_INVALID);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('consumes the challenge and issues a session for the correct code', async () => {
    const user = resolvesTo();
    const challenge = makeChallenge({ codeHash: CORRECT_HASH });
    challenges.findLive.mockResolvedValue(challenge);

    const result = await verify();

    expect(challenges.consume).toHaveBeenCalledWith(challenge.id);
    expect(sessions.issue).toHaveBeenCalledTimes(1);
    expect(users.touchLastSeen).toHaveBeenCalledWith(user.id);
    // A discriminated result rather than a bare session, because this path can now
    // also stop at `mfa_required` — see the second-factor gate suite below.
    expect(result).toEqual({ kind: 'session', session: { sessionId: 'sess-1' } });
  });

  it('looks the challenge up under the LOGIN_OTP purpose, not PASSWORD_RESET', async () => {
    const user = resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: CORRECT_HASH }));

    await verify();
    // The purpose is the only thing separating a login code from a reset code.
    // Accepting either here would let a reset code mint a session.
    expect(challenges.findLive).toHaveBeenCalledWith(user.id, 'LOGIN_OTP');
  });
});

describe('LoginService.withPassword', () => {
  it('reports invalid_credentials for an unknown account', async () => {
    const call = service.withPassword(
            {
        step: 'password', identifier: 'nobody@example.test', password: 'x'.repeat(12), ...CAPTCHA },
      client,
    );
    expect(await problemType(call)).toBe(ERR.INVALID_CREDENTIALS);
  });

  it('reports invalid_credentials — not a distinct error — for a wrong password', async () => {
    resolvesTo();
    credentials.checkPassword.mockResolvedValue(false);

    const call = service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'Wr0ng!Passw0rd', ...CAPTCHA },
      client,
    );
    // Identical to the unknown-account case above. That pairing is the whole
    // point, so both assertions belong next to each other.
    expect(await problemType(call)).toBe(ERR.INVALID_CREDENTIALS);
  });

  it('emails a code and returns otp_required for a passwordless account', async () => {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });

    const result = await service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'Any!Passw0rd1', ...CAPTCHA },
      client,
    );

    expect(result.kind).toBe('otp_required');
    expect(challenges.issue).toHaveBeenCalledTimes(1);
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('issues a session for a correct password', async () => {
    resolvesTo();
    const result = await service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'R1ght!Passw0rd', ...CAPTCHA },
      client,
    );

    expect(result).toEqual({ kind: 'session', session: { sessionId: 'sess-1' } });
  });
});

describe('LoginService.requestOtp', () => {
  it('returns otp_sent and sends nothing for an unknown account', async () => {
    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'nobody@example.test', ...CAPTCHA },
      client,
    );

    expect(result.kind).toBe('otp_sent');
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });

  it('DOES send to an account that has a password — this is now the recovery path', async () => {
    resolvesTo();
    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    // The gate that used to be here (`credential === null`) was lifted when the
    // public forgot-password route was removed. Restoring it would leave a user
    // who forgets their password with no way back into their account, ever.
    expect(result.kind).toBe('otp_sent');
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('sends a code for a passwordless active account', async () => {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });

    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    expect(result.kind).toBe('otp_sent');
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('does not re-send while the cooldown is still running', async () => {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    cache.cooldownRemaining.mockResolvedValue(45);

    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    expect(result.kind).toBe('otp_sent');
    expect(challenges.issue).not.toHaveBeenCalled();
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });
});

/**
 * The budget for codes that are actually emailed.
 *
 * It is keyed on the account and enforced inside `issueLoginOtp`, which is the one
 * place both senders pass through. It used to sit at the `requestOtp` call site
 * only, and the consequences were two: the password path — which reaches the same
 * sender whenever an account turns out to have no password — was bounded by nothing
 * but the sixty-second cooldown, and the counter shared a Redis key with that
 * cooldown, which broke `requestOtp` outright.
 */
describe('LoginService — the blocklist at the login doors', () => {
  it('refuses a password login for a blocked account', async () => {
    resolvesTo();
    blocklist.assertNotBlocked.mockRejectedValue(
      new ProblemException({ type: ERR.EMAIL_DOMAIN_BLOCKED }),
    );

    const call = service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'C0rrect!Passw0rd', ...CAPTCHA },
      client,
    );
    expect(await problemType(call)).toBe(ERR.EMAIL_DOMAIN_BLOCKED);
  });

  it('refuses BEFORE the password is checked, so a block cannot be probed with guesses', async () => {
    resolvesTo();
    blocklist.assertNotBlocked.mockRejectedValue(
      new ProblemException({ type: ERR.EMAIL_DOMAIN_BLOCKED }),
    );

    await problem(
      service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'C0rrect!Passw0rd', ...CAPTCHA },
        client,
      ),
    );
    // Also means a blocked account cannot be walked into its lockout by someone
    // else's failed attempts.
    expect(credentials.checkPassword).not.toHaveBeenCalled();
  });

  it('refuses an OTP login for a blocked account', async () => {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    blocklist.assertNotBlocked.mockRejectedValue(
      new ProblemException({ type: ERR.EMAIL_DOMAIN_BLOCKED }),
    );

    const call = service.verifyOtp(
      flowAt('OTP_SENT', { identifierLower: 'ada@example.test' }),
      LOGIN_ID,
      {
        step: 'otp-verify',
        loginId: LOGIN_ID, code: CODE },
      client,
    );
    expect(await problemType(call)).toBe(ERR.EMAIL_DOMAIN_BLOCKED);
    // The code must not be spent by a request that was never going to succeed.
    expect(challenges.consume).not.toHaveBeenCalled();
  });

  it('checks the RESOLVED account, so a username cannot route around the block', async () => {
    const user = makeUser();
    users.findByUsername.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: makeCredential() });

    await service
      .withPassword(
                {
          step: 'password',
          identifier: 'ada_lovelace',
          password: 'C0rrect!Passw0rd',
          ...CAPTCHA,
        },
        client,
      )
      .catch(() => undefined);

    // The identifier typed was a username; the value checked must be the
    // account's email, or logging in by username would bypass the blocklist
    // entirely.
    expect(blocklist.assertNotBlocked).toHaveBeenCalledWith(user.emailLower);
  });

  it('requestOtp stays silent for a blocked account — no code, no distinct error', async () => {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    blocklist.isBlocked.mockResolvedValue(true);

    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    // Byte-identical to the unknown-account response above. If this ever threw
    // `email_domain_blocked`, this endpoint would start disclosing which
    // addresses have accounts.
    expect(result).toMatchObject({ kind: 'otp_sent', resendAvailableAt: null });
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });
});

describe('LoginService — the login-code send budget', () => {
  /** A passwordless account: the only kind that is ever emailed a login code. */
  function passwordless() {
    const user = makeUser();
    users.findByEmail.mockResolvedValue(user);
    users.findByUsername.mockResolvedValue(user);
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    return user;
  }

  const password = () =>
    service.withPassword(
            {
        step: 'password',
        identifier: 'Ada.Lovelace@example.test',
        password: 'Wr0ng!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

  /** Sixty seconds passing — the only thing standing between two sends. */
  function elapseCooldown(emailLower: string) {
    cache.ttls.delete(KEYS.rate.loginOtpCooldown(emailLower));
  }

  it('refunds the budget and the cooldown when SMTP would not take the message', async () => {
    const user = passwordless();
    undeliverable();

    const result = await password();

    // Charged before the send — it has to be, to gate it — then given back.
    expect(quota.countFor(KEYS.rate.loginOtpSendByAccount(user.emailLower))).toBe(0);
    expect(cache.ttls.has(KEYS.rate.loginOtpCooldown(user.emailLower))).toBe(false);
    // `resendAvailableAt` is now the optimistic cooldown rather than null: at the
    // moment this returned, the send had not been attempted. The user is told to
    // wait longer than they must — never shorter — and the cooldown asserted above
    // is already cleared, so the retry they are discouraged from making would in
    // fact succeed. See the note on `issueLoginOtp`.
    expect(result.kind).toBe('otp_required');
  });

  it('does not lock a passwordless account out across a full SMTP outage', async () => {
    // The failure this guards: five retries against a dead mail server exhaust the
    // hourly budget, the user never receives a code, never sees an error, and is
    // shut out of their own account for an hour.
    const user = passwordless();
    undeliverable();

    for (let attempt = 0; attempt < MAIL_BUDGET.limit + 2; attempt += 1) {
      await password();
    }

    expect(mail.sendOtp).toHaveBeenCalledTimes(MAIL_BUDGET.limit + 2);

    // SMTP recovers; the very next attempt must still be able to send.
    mail.sendOtp.mockImplementation(async () => undefined);
    await expect(password()).resolves.toMatchObject({ kind: 'otp_required' });
    expect(quota.countFor(KEYS.rate.loginOtpSendByAccount(user.emailLower))).toBe(1);
  });

  it('charges the password path for the code it sends', async () => {
    const user = passwordless();
    await password();

    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
    // The short window and the rolling day, charged together on the DURABLE store —
    // a cost quota a cache restart must not hand back.
    expect(quota.consumeAll).toHaveBeenCalledWith(
      [
        { key: KEYS.rate.loginOtpSendByAccount(user.emailLower), rule: MAIL_BUDGET },
        {
          key: KEYS.rate.loginOtpSendByAccountDaily(user.emailLower),
          rule: policy().LOGIN_OTP.MAIL_BY_ACCOUNT[1],
        },
      ],
      'durable',
      'deny',
    );
  });

  it('refuses once the account budget is spent, rather than emailing one a minute forever', async () => {
    const user = passwordless();
    const { limit } = MAIL_BUDGET;

    for (let i = 0; i < limit; i += 1) {
      await password();
      elapseCooldown(user.emailLower);
    }
    expect(mail.sendOtp).toHaveBeenCalledTimes(limit);

    expect(await problemType(password())).toBe(ERR.RATE_LIMITED);
    expect(mail.sendOtp).toHaveBeenCalledTimes(limit);
  });

  it('draws both senders from ONE bucket, keyed on the account and not the identifier typed', async () => {
    const user = passwordless();

    await password();
    elapseCooldown(user.emailLower);
    // A different endpoint AND a different identifier form for the same account.
    await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: 'ada_lovelace', ...CAPTCHA },
      client,
    );

    expect(mail.sendOtp).toHaveBeenCalledTimes(2);
    expect(quota.countFor(KEYS.rate.loginOtpSendByAccount(user.emailLower))).toBe(2);
  });

  it('sends on the FIRST otp-request for the account\'s own address', async () => {
    // The exact production shape of the collision, and the one the older tests
    // dodged by resolving `ada@example.test` to a user whose email is actually
    // `Ada.Lovelace@example.test` — two different strings, so two different keys,
    // so no collision to trip over. Ask for a code at the address the account
    // really has and the endpoint guard's key matched the cooldown's: `consume`
    // stamped an hour, `cooldownRemaining` read it back, and nothing was ever sent.
    const user = passwordless();

    const result = await service.requestOtp(
      null,
      null,
      {
        step: 'otp-request', identifier: user.email, ...CAPTCHA },
      client,
    );

    expect(result.kind).toBe('otp_sent');
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('keeps the cooldown and the hourly counter in separate keys', async () => {
    const user = passwordless();
    await password();

    // The regression this pins: when these shared a key, `consume` stamped the
    // counter's hour-long window and `cooldownRemaining` read it straight back as a
    // live cooldown — so the sender declined every request, including the first.
    //
    // They are now separated structurally as well as by name: the cooldown is a
    // cache key whose TTL *is* the remaining wait, and the budget is a rolling
    // quota on the durable store. Different mechanism, different service, different
    // instance — so the collision is no longer expressible.
    expect(cache.ttls.get(KEYS.rate.loginOtpCooldown(user.emailLower))).toBe(
      OTP.RESEND_COOLDOWN_SECONDS,
    );
    expect(quota.countFor(KEYS.rate.loginOtpSendByAccount(user.emailLower))).toBe(1);
    expect(cache.ttls.has(KEYS.rate.loginOtpSendByAccount(user.emailLower))).toBe(false);
    expect(KEYS.rate.loginOtpCooldown(user.emailLower)).not.toBe(
      KEYS.rate.loginOtpSendByAccount(user.emailLower),
    );
  });
});

/**
 * ═══ THE SECOND-FACTOR GATE ════════════════════════════════════════════════
 *
 * `completeLogin` is the one place both login paths turn a proven first factor
 * into a session, which makes it the one place a second factor can be enforced for
 * both. These tests pin the two halves of that:
 *
 *   an account with nothing enrolled is completely unaffected — same branch, same
 *   round trip, same response shape as before 2FA existed; and
 *
 *   an account with a factor gets NO session, from either door.
 *
 * The second is the one worth having. A gate that only covers the password path is
 * not a gate, and the email-OTP path is the easier one to forget precisely because
 * it already felt like a second step.
 *
 * ─── What used to be tested here ───────────────────────────────────────────
 *
 * Attaching a pending OAuth identity via a `linkToken` on the login body. That is
 * gone deliberately, not by oversight: a link writes a credential that outlives a
 * password change, a session sweep and an email change, so it must not be a side
 * effect of presenting one factor. Linking is now `POST /auth/link` behind an
 * elevation ticket, and its tests live with it.
 */
describe('LoginService — the second factor gate', () => {
  const CHALLENGE = {
    mfaToken: 'mfa-token-1',
    methods: ['totp', 'recovery_code'] as const,
    expiresAt: new Date(Date.now() + 600_000),
  };

  const passwordLogin = () =>
    service.withPassword(
            {
        step: 'password', identifier: 'ada@example.test', password: 'pw', ...CAPTCHA },
      client,
    );

  it('issues a session directly when nothing is enrolled', async () => {
    // The opt-in property, asserted rather than assumed. Every other test in this
    // file relies on it, so if it broke they would all fail confusingly instead of
    // this one failing clearly.
    resolvesTo();

    const result = await passwordLogin();

    expect(result.kind).toBe('session');
    expect(sessions.issue).toHaveBeenCalled();
  });

  it('withholds the session when a factor is enrolled', async () => {
    const user = resolvesTo();
    mfa.challengeFor.mockResolvedValue(CHALLENGE);

    const result = await passwordLogin();

    // `loginId` too: the password step opened the flow, so the handle it minted
    // travels back with the challenge. It is the flow's only handle — the second
    // factor promotes this same row rather than issuing another.
    expect(result).toEqual({
      kind: 'mfa_required',
      loginId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown as string,
      ...CHALLENGE,
    });
    // THE assertion. A correct password plus an issued session is the bypass this
    // whole feature exists to prevent.
    expect(sessions.issue).not.toHaveBeenCalled();
    // The flow the password step just opened, the resolved account, and the
    // state it was opened in — a compare-and-swap against what the caller
    // actually saw, not a re-read.
    expect(mfa.challengeFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'STARTED' }),
      user.id,
      'STARTED',
    );
  });

  it('withholds it on the email-OTP path too, not just the password one', async () => {
    // Same gate, other door. A user who signs in with an emailed code has proven
    // their mailbox — which is the FIRST factor, and the reason 2FA was wanted.
    const user = resolvesTo();
    challenges.findLive.mockResolvedValue(makeChallenge({ codeHash: CORRECT_HASH }));
    challenges.consume.mockResolvedValue(true);
    mfa.challengeFor.mockResolvedValue(CHALLENGE);

    const result = await service.verifyOtp(
      flowAt('OTP_SENT', { identifierLower: 'ada@example.test' }),
      LOGIN_ID,
      {
        step: 'otp-verify',
        loginId: LOGIN_ID,
        code: CODE,
      },
      client,
    );

    expect(result.kind).toBe('mfa_required');
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('does not mark the account as seen until the sign-in actually finishes', async () => {
    // `lastSeenAt` drives the "new device" and account-activity surfaces. Stamping
    // it on a half-finished sign-in would report an intrusion attempt as a visit.
    resolvesTo();
    mfa.challengeFor.mockResolvedValue(CHALLENGE);

    await passwordLogin();

    expect(users.touchLastSeen).not.toHaveBeenCalled();
  });

  it('still refuses a wrong password before the gate is ever consulted', async () => {
    // Ordering: the factor check must not become a way to learn that an account has
    // 2FA on without knowing the password.
    resolvesTo();
    credentials.checkPassword.mockResolvedValue(false);

    await problem(passwordLogin());

    expect(mfa.challengeFor).not.toHaveBeenCalled();
  });
});
