import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginAttempt, LoginState } from '@prisma/client';
import { AuthController } from '../../auth/auth.controller';
import { LOGIN_FLOW, STEP_UP } from '../../auth/auth.constants';
import { LOGIN_STEP_REQUIRES, type ClientContext } from '../../auth/auth.types';
import { pepperedHash } from '../../auth/auth.utility';
import { loginIdSchema } from '../../auth/dto/common.dto';
import { LoginService } from '../../auth/services/login.service';
import type { BlocklistService } from '../../auth/services/blocklist.service';
import type { CredentialService } from '../../auth/services/credential.service';
import type { OauthService } from '../../auth/services/oauth.service';
import type { PasswordService } from '../../auth/services/password.service';
import type { RegistrationService } from '../../auth/services/registration.service';
import type { SessionService } from '../../auth/services/session.service';
import type { UserService } from '../../auth/services/user.service';
import type { ChallengeDbOperation } from '../../auth/persistence/challenge.dboperation';
import type { UserDbOperation } from '../../auth/persistence/user.dboperation';
import type { BffSessionService } from '../../auth/security/bff.session';
import { MfaService } from '../../src/2fa/mfa.service';
import type { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { makeCredential, makeLoginAttempt, makePublicUser, makeQuota, makeUser } from '../harness';
import { ERR } from '../../src/contracts';
import type { ProblemException } from '../../src/http';
import type { CaptchaVerifier } from '../../src/captcha/captcha.types';
import type { MailService } from '../../src/mail/mail.service';
import { KEYS, type CacheService, type QuotaService } from '../../redis';
import { policy } from '../../auth/limits';

/**
 * ═══ `loginId`: ONE HANDLE FOR ONE SIGN-IN ═════════════════════════════════
 *
 * `POST /auth/login` used to be six independent modes, each identifying its own
 * subject from the request body. The only server-side state was the gap between a
 * proven first factor and a second, and it had a handle of its own — `mfaToken` —
 * minted half way through.
 *
 * It is now a state machine. `step:'start'` opens a `LoginAttempt` before any
 * credential is presented and returns an opaque `loginId`; every later step
 * carries it, and the SAME value continues to `POST /auth/2fa/verify`.
 *
 * ─── The four properties this file exists to hold ──────────────────────────
 *
 *  1. ONE handle. No second token is minted when a factor is owed — the row is
 *     promoted in place — so there is no seam where two credentials with two sets
 *     of rules briefly coexist.
 *  2. The SERVER owns the identity. `userId` is written once, by the step that
 *     first resolves an account, and no later step reads a user from a body. A
 *     flow therefore cannot be switched between users by editing a field.
 *  3. The handle authorises no STEP. `LOGIN_STEP_REQUIRES` and the
 *     FACTOR_REQUIRED check in `requireAttempt` decide that, which is what makes
 *     the second factor unskippable rather than merely conventional.
 *  4. It is single-use and short-lived, and no cookie carries it.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

const LOGIN_ID = 'l'.repeat(43);
const CAPTCHA = { captchaProvider: 'TURNSTILE', captchaToken: 'tok' } as const;

/** Deliberately different from LOGIN_ID: `oauth-start` mints its own, and a test
 *  that reused one value could not tell an echo from a coincidence. */
const OAUTH_LOGIN_ID = 'o'.repeat(43);

/** A flow whose recorded context matches `client`, live and in the given state. */
function flow(state: LoginState = 'STARTED', overrides: Partial<LoginAttempt> = {}): LoginAttempt {
  return makeLoginAttempt({
    state,
    userId: state === 'STARTED' ? null : '01940000-0000-7000-8000-000000000001',
    tokenHash: pepperedHash(LOGIN_ID, 'mfa'),
    ipClass: client.ipClass,
    deviceFingerprint: client.deviceKey,
    userAgent: client.userAgent,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    ...overrides,
  });
}

let attempts: ReturnType<typeof makeAttempts>;
let users: ReturnType<typeof makeUsers>;
let cache: ReturnType<typeof makeCache>;
let credentials: { checkPassword: ReturnType<typeof vi.fn> };
let mfa: MfaService;
let factors: ReturnType<typeof makeFactors>;
let service: LoginService;
let controller: AuthController;
let loginDouble: ReturnType<typeof makeLoginDouble>;
let sessionCookies: ReturnType<typeof makeSessionCookies>;
let oauth: ReturnType<typeof makeOauth>;

/**
 * A double that answers ANY method with a no-op `vi.fn()`, while typing the ones
 * a spec actually configures.
 *
 * The services under test reach a couple of dozen collaborator methods between
 * them and only a handful matter to any given assertion, so listing them all
 * would be noise to maintain every time an unrelated call is added. The Proxy
 * supplies the rest at runtime.
 *
 * The names passed in are typed as a literal union rather than an index
 * signature, and that is the point: under `noUncheckedIndexedAccess` an index
 * signature is `| undefined`, so every `double.method.mockResolvedValue(...)`
 * would need a non-null assertion. A `Record<'a' | 'b', Mock>` needs none, and
 * misspelling a name becomes a compile error instead of a silently-created spy.
 */
function anyDouble<K extends string>(
  ...methods: readonly K[]
): Record<K, ReturnType<typeof vi.fn>> {
  const target: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of methods) target[method] = vi.fn().mockResolvedValue(undefined);

  return new Proxy(target, {
    get(t, prop: string) {
      t[prop] ??= vi.fn().mockResolvedValue(undefined);
      return t[prop];
    },
  }) as Record<K, ReturnType<typeof vi.fn>>;
}

const makeAttempts = () =>
  anyDouble(
    'createFlow',
    'promoteAttempt',
    'completeAttempt',
    'markOtpSent',
    'findAttemptByTokenHash',
    'expireAttempt',
  );
const makeUsers = () =>
  anyDouble('findByEmail', 'findByUsername', 'findByPublicCode', 'findWithCredential');
const makeFactors = () =>
  anyDouble(
    'listConfirmedTotpFactors',
    'listPasskeys',
    'countUnusedRecoveryCodes',
    'findAttemptByTokenHash',
    'promoteAttempt',
  );
const makeLoginDouble = () =>
  anyDouble(
    'startFlow',
    'resolveFlow',
    'assertLoginStep',
    'abandonFlow',
    'withPassword',
    'requestOtp',
    'verifyOtp',
  );
const makeOauth = () => anyDouble('start', 'callback', 'chooseRegister');
/**
 * The cache, as a proxy double.
 *
 * `issueLoginOtp` reaches a good half-dozen `CacheService` methods — a lease, a
 * cooldown, a counter — and none of them is what these tests are about. Listing
 * only the two that get asserted on and letting the Proxy supply the rest keeps
 * the file about login flows rather than about Redis.
 */
const makeCache = () => {
  const d = anyDouble('consume', 'clear', 'setIfAbsent', 'cooldownRemaining');
  d.setIfAbsent.mockResolvedValue(true);
  d.cooldownRemaining.mockResolvedValue(0);
  return d;
};
/** `issueLoginOtp` reads `.id` off what `issue` returns, so a bare no-op double
 *  fails inside the mail path rather than in the code under test. */
const makeChallenges = () => {
  const d = anyDouble('issue', 'invalidateIfHash', 'findLive', 'consume');
  d.issue.mockResolvedValue({ id: 'challenge-1' });
  return d;
};
const makeSessionCookies = () => anyDouble('read', 'issue', 'slide', 'ensureCsrf', 'clear');

const issuedSession = () => ({
  sessionId: 's1',
  accessToken: 'access',
  refreshToken: 'refresh',
  accessExpiresAt: new Date(Date.now() + 900_000),
  refreshExpiresAt: new Date(Date.now() + 86_400_000),
  user: makePublicUser(),
});

beforeEach(() => {
  attempts = makeAttempts();
  attempts.createFlow.mockImplementation(async () => flow('STARTED'));
  attempts.promoteAttempt.mockResolvedValue(true);
  attempts.completeAttempt.mockResolvedValue(true);
  attempts.markOtpSent.mockResolvedValue(true);
  attempts.findAttemptByTokenHash.mockResolvedValue(null);
  attempts.expireAttempt.mockResolvedValue(undefined);

  users = makeUsers();
  users.findByEmail.mockResolvedValue(null);
  users.findByUsername.mockResolvedValue(null);
  users.findByPublicCode.mockResolvedValue(null);
  users.findWithCredential.mockResolvedValue(null);

  cache = makeCache();
  credentials = { checkPassword: vi.fn().mockResolvedValue(true) };

  factors = makeFactors();
  factors.listConfirmedTotpFactors.mockResolvedValue([]);
  factors.listPasskeys.mockResolvedValue([]);
  factors.countUnusedRecoveryCodes.mockResolvedValue(0);
  factors.findAttemptByTokenHash.mockResolvedValue(null);
  factors.promoteAttempt.mockResolvedValue(true);
  mfa = new MfaService(factors as unknown as TwoFactorDbOperation);

  service = new LoginService(
    users as unknown as UserDbOperation,
    makeChallenges() as unknown as ChallengeDbOperation,
    credentials as unknown as CredentialService,
    { issue: vi.fn().mockResolvedValue(issuedSession()) } as unknown as SessionService,
    { sendOtp: vi.fn() } as unknown as MailService,
    cache as unknown as CacheService,
    makeQuota() as unknown as QuotaService,
    {
      isBlocked: vi.fn().mockResolvedValue(false),
      assertNotBlocked: vi.fn().mockResolvedValue(undefined),
    } as unknown as BlocklistService,
    mfa,
    attempts as unknown as TwoFactorDbOperation,
  );

  loginDouble = makeLoginDouble();
  loginDouble.startFlow.mockResolvedValue({ loginId: LOGIN_ID, attempt: flow('STARTED') });
  loginDouble.resolveFlow.mockResolvedValue(flow('STARTED'));
  loginDouble.withPassword.mockResolvedValue({ kind: 'session', session: issuedSession() });
  loginDouble.requestOtp.mockResolvedValue({ kind: 'otp_sent', resendAvailableAt: null });
  loginDouble.verifyOtp.mockResolvedValue({ kind: 'session', session: issuedSession() });

  oauth = makeOauth();
  oauth.start.mockResolvedValue({
    loginId: OAUTH_LOGIN_ID,
    url: 'https://provider/authorize',
    state: 'st',
    flow: 'oidc-code',
  });

  sessionCookies = makeSessionCookies();
  sessionCookies.read.mockReturnValue(null);
  sessionCookies.issue.mockReturnValue('csrf-1');
  sessionCookies.ensureCsrf.mockReturnValue('csrf-1');

  controller = new AuthController(
    anyDouble<never>() as unknown as RegistrationService,
    loginDouble as unknown as LoginService,
    anyDouble<never>() as unknown as SessionService,
    anyDouble<never>() as unknown as PasswordService,
    oauth as unknown as OauthService,
    anyDouble<never>() as unknown as UserService,
    { create: vi.fn().mockResolvedValue('handle-1') } as unknown as BffSessionService,
    { verify: vi.fn().mockResolvedValue(undefined) } as unknown as CaptchaVerifier,
  );
});

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** An account that exists, is active, and has a password. */
function accountExists() {
  const user = makeUser();
  users.findByEmail.mockResolvedValue(user);
  users.findWithCredential.mockResolvedValue({ user, credential: makeCredential() });
  return user;
}

/** Give the account a confirmed second factor. */
function withTotp() {
  factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);
}

/**
 * ═══ THERE IS NO `start` STEP ══════════════════════════════════════════════
 *
 * This block used to assert that `POST /auth/login {step:'start'}` returned a
 * handle. That request is gone: it presented no credential and produced nothing
 * but an identifier for the next request, which is a round trip on the critical
 * path of every sign-in.
 *
 * What replaces those assertions is the inverse — that no such step exists — plus
 * the properties that moved onto the three steps which can now be first. The
 * handle's own qualities (entropy, hash-at-rest, recorded context, absolute
 * expiry) are unchanged and are asserted here against the step that mints one.
 */
describe('loginId — the artificial start step is gone', () => {
  it('refuses step:start as an unknown step', async () => {
    const err = await problem(
      controller.loginRequest({ step: 'start' }, client, sessionCookies as never),
    );

    // A validation failure from the discriminated union, not a 404 or a silent
    // no-op: `start` is not a step any more, and a client still sending one
    // should be told so loudly rather than left waiting for a handle.
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('creates no flow for a step:start body', async () => {
    await problem(controller.loginRequest({ step: 'start' }, client, sessionCookies as never));

    expect(attempts.createFlow).not.toHaveBeenCalled();
  });

  it.each([
    ['password', { step: 'password', identifier: 'ada@example.test', password: 'p', ...CAPTCHA }],
    ['otp-request', { step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA }],
    ['oauth-start', { step: 'oauth-start', provider: 'GOOGLE' }],
  ])('%s is accepted with no loginId — it is an entry point', async (_step, body) => {
    // The whole point of the change: the first real operation needs nothing from
    // a previous round trip.
    const err = await problem(
      controller.loginRequest(body, client, sessionCookies as never),
    ).catch(() => null);

    expect(err?.type).not.toBe(ERR.VALIDATION_FAILED);
  });

  it.each([
    ['password', { step: 'password', identifier: 'a@b.test', password: 'p', ...CAPTCHA }],
    ['oauth-start', { step: 'oauth-start', provider: 'GOOGLE' }],
  ])('%s REFUSES a loginId — there is no flow to continue', async (_step, body) => {
    // `.strict()`. Accepting one would give these steps two meanings depending on
    // a field's presence: open a flow, or continue somebody's.
    const err = await problem(
      controller.loginRequest({ ...body, loginId: LOGIN_ID }, client, sessionCookies as never),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });
});

describe('loginId — the first real operation mints it', () => {
  it('password opens the flow and returns the handle on mfa_required', async () => {
    accountExists();
    withTotp();

    const result = await service.withPassword(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(attempts.createFlow).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'mfa_required' });
    expect((result as { loginId: string }).loginId).toHaveLength(43);
  });

  it('password opens NO flow when the password is wrong', async () => {
    // The row is created only once the credential has actually verified, so a
    // wrong guess leaves nothing behind. Opening it on entry would make every
    // failed attempt a write.
    accountExists();
    credentials.checkPassword.mockResolvedValue(false);

    await problem(
      service.withPassword(
        { step: 'password', identifier: 'ada@example.test', password: 'wrong', ...CAPTCHA },
        client,
      ),
    );

    expect(attempts.createFlow).not.toHaveBeenCalled();
  });

  it('password opens NO flow for an identifier that matches nothing', async () => {
    users.findByEmail.mockResolvedValue(null);

    await problem(
      service.withPassword(
        { step: 'password', identifier: 'nobody@example.test', password: 'p', ...CAPTCHA },
        client,
      ),
    );

    expect(attempts.createFlow).not.toHaveBeenCalled();
  });

  it('otp-request opens the flow and returns the handle', async () => {
    accountExists();

    const result = await service.requestOtp(
      null,
      null,
      { step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    expect(attempts.createFlow).toHaveBeenCalledTimes(1);
    expect((result as { loginId: string }).loginId).toHaveLength(43);
  });

  it('otp-request returns a handle even for an unknown address', async () => {
    // The indistinguishability contract does not end with this response. If only
    // the eligible branch returned a handle, the absence of one would be the tell.
    users.findByEmail.mockResolvedValue(null);

    const result = await service.requestOtp(
      null,
      null,
      { step: 'otp-request', identifier: 'nobody@example.test', ...CAPTCHA },
      client,
    );

    expect(result).toMatchObject({ kind: 'otp_sent' });
    expect((result as { loginId: string }).loginId).toHaveLength(43);
  });

  it('otp-request REUSES the flow on a resend rather than opening a second', async () => {
    // This is why `loginId` is optional on this one step. A resend that minted a
    // new handle would strand the previous row at OTP_SENT with a live handle and
    // silently change the value the client is holding.
    accountExists();
    const existing = flow('OTP_SENT');

    const result = await service.requestOtp(
      existing,
      LOGIN_ID,
      { step: 'otp-request', loginId: LOGIN_ID, identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    expect(attempts.createFlow).not.toHaveBeenCalled();
    expect(result).toMatchObject({ loginId: LOGIN_ID });
    expect(attempts.markOtpSent).toHaveBeenCalledWith(existing.id, 'ada@example.test');
  });

  it('oauth-start opens the flow through the factory it is given', async () => {
    // The service does not mint the handle itself — it calls back into
    // `LoginService`, after its own quotas, so there is one definition of the
    // entropy and the hash domain and a refused request writes no row.
    const openFlow = vi.fn(async () => ({ loginId: LOGIN_ID, attempt: flow('STARTED') }));

    await controller.loginRequest(
      { step: 'oauth-start', provider: 'GOOGLE' },
      client,
      sessionCookies as never,
    );

    expect(oauth.start).toHaveBeenCalledTimes(1);
    expect(typeof oauth.start.mock.calls[0]?.[2]).toBe('function');
    expect(openFlow).not.toHaveBeenCalled();
  });

  it('a session-in-one-request returns no handle at all', async () => {
    // Nothing to continue, and the row was retired in the statement that
    // completed it. Returning a value that is already dead would be worse than
    // returning none.
    accountExists();

    const result = await service.withPassword(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(result.kind).toBe('session');
    expect(result).not.toHaveProperty('loginId');
  });
});

describe('loginId — what the minted handle is made of', () => {
  /** Drive one real mint and read back what was stored. */
  async function mintViaPassword() {
    accountExists();
    withTotp();
    const result = await service.withPassword(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );
    const [input] = attempts.createFlow.mock.calls[0] as [Record<string, unknown>];
    return { loginId: (result as { loginId: string }).loginId, input };
  }

  it('is 32 bytes of base64url', async () => {
    const { loginId } = await mintViaPassword();

    expect(STEP_UP.SECRET_BYTES).toBe(32);
    expect(loginIdSchema.safeParse(loginId).success).toBe(true);
  });

  it('stores only the hash of what it returns', async () => {
    const { loginId, input } = await mintViaPassword();

    expect(input.tokenHash).toBe(pepperedHash(loginId, 'mfa'));
    expect(input.tokenHash).not.toContain(loginId);
  });

  it('opens the row anonymously, with no account attached', async () => {
    // `userId` is written by `promoteAttempt` and by nothing else, even though
    // the account is already known by the time the row is created.
    const { input } = await mintViaPassword();

    expect(input).not.toHaveProperty('userId');
  });

  it('records the device and network that opened it', async () => {
    const { input } = await mintViaPassword();

    expect(input).toMatchObject({
      ipClass: client.ipClass,
      deviceFingerprint: client.deviceKey,
    });
  });

  it('stamps an absolute expiry from LOGIN_FLOW.TTL_SECONDS', async () => {
    const before = Date.now();
    const { input } = await mintViaPassword();
    const expiresAt = input.expiresAt as Date;

    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(
      before + LOGIN_FLOW.TTL_SECONDS * 1000 + 1000,
    );
  });

  it('mints a different handle every time', async () => {
    const a = await mintViaPassword();
    attempts.createFlow.mockClear();
    const b = await mintViaPassword();

    expect(a.loginId).not.toBe(b.loginId);
  });
});

describe('loginId — flow creation is not a second rate-limit charge', () => {
  it('password charges only the flood ceiling, as it did before', async () => {
    // The removed `LOGIN_FLOW.START_BY_*` buckets guarded an endpoint that no
    // longer exists. Charging them here as well would bill one request twice for
    // one write, and the tighter ceiling would start refusing sign-ins the
    // endpoint's own limiter was sized to allow.
    accountExists();

    await service.withPassword(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    const consumed = cache.consume.mock.calls.map((c) => c[0] as string);
    expect(consumed).toContain(KEYS.rate.loginFloodByIp(client.ip));
    // Nothing resembling a flow-creation bucket.
    expect(consumed.some((key) => key.includes('login-start'))).toBe(false);
  });

  it('otp-request charges its own three buckets and nothing extra', async () => {
    accountExists();
    const quota = makeQuota();
    const metered = new LoginService(
      users as unknown as UserDbOperation,
      makeChallenges() as unknown as ChallengeDbOperation,
      anyDouble<never>() as unknown as CredentialService,
      anyDouble<never>() as unknown as SessionService,
      { sendOtp: vi.fn() } as unknown as MailService,
      cache as unknown as CacheService,
      quota as unknown as QuotaService,
      {
        isBlocked: vi.fn().mockResolvedValue(false),
        assertNotBlocked: vi.fn().mockResolvedValue(undefined),
      } as unknown as BlocklistService,
      mfa,
      attempts as unknown as TwoFactorDbOperation,
    );

    await metered.requestOtp(
      null,
      null,
      { step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    const call = quota.consumeAll.mock.calls[0] as unknown as [
      readonly { key: string }[],
      string,
      string,
    ];
    const [entries, , onFailure] = call;
    const keys = entries.map((e) => e.key);

    expect(keys).toContain(KEYS.rate.loginOtpByIdentifier('ada@example.test'));
    expect(keys).toContain(KEYS.rate.loginOtpByIp(client.ip));
    expect(keys).toContain(KEYS.rate.loginOtpByDevice(client.deviceKey));
    expect(keys.some((key) => key.includes('login-start'))).toBe(false);
    // Still `deny` on cache failure: this path can send email.
    expect(onFailure).toBe('deny');
  });

  it('the quota is charged BEFORE the row is written', async () => {
    // A limiter charged after the insert bounds the response, not the write.
    accountExists();
    const order: string[] = [];
    const quota = makeQuota();
    quota.consumeAll.mockImplementation(async () => {
      order.push('quota');
      return { token: 'q', keys: [] };
    });
    attempts.createFlow.mockImplementation(async () => {
      order.push('createFlow');
      return flow('STARTED');
    });

    const metered = new LoginService(
      users as unknown as UserDbOperation,
      makeChallenges() as unknown as ChallengeDbOperation,
      anyDouble<never>() as unknown as CredentialService,
      anyDouble<never>() as unknown as SessionService,
      { sendOtp: vi.fn() } as unknown as MailService,
      cache as unknown as CacheService,
      quota as unknown as QuotaService,
      {
        isBlocked: vi.fn().mockResolvedValue(false),
        assertNotBlocked: vi.fn().mockResolvedValue(undefined),
      } as unknown as BlocklistService,
      mfa,
      attempts as unknown as TwoFactorDbOperation,
    );

    await metered.requestOtp(
      null,
      null,
      { step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
    );

    // The endpoint quotas come first and the row second. A third entry follows —
    // the per-recipient mail budget charged inside `issueLoginOtp` — which is
    // after the write on purpose: it bills a message, not a row.
    expect(order.slice(0, 2)).toEqual(['quota', 'createFlow']);
    expect(order.indexOf('quota')).toBeLessThan(order.indexOf('createFlow'));
  });
});

describe('loginId — resolution refuses everything but a live flow', () => {
  it('refuses an unknown handle', async () => {
    attempts.findAttemptByTokenHash.mockResolvedValue(null);

    expect((await problem(service.resolveFlow(LOGIN_ID, client))).type).toBe(
      ERR.MFA_TOKEN_INVALID,
    );
  });

  it('refuses an expired flow, and retires it as it refuses', async () => {
    const stale = flow('STARTED', { expiresAt: new Date(Date.now() - 1000) });
    attempts.findAttemptByTokenHash.mockResolvedValue(stale);

    expect((await problem(service.resolveFlow(LOGIN_ID, client))).type).toBe(ERR.MFA_EXPIRED);
    // Retired on the way out, so a stale row stops occupying the unique partial
    // index and a retry gets the same clean answer as the first try.
    expect(attempts.expireAttempt).toHaveBeenCalledWith(stale.id);
  });

  it('refuses a completed flow', async () => {
    attempts.findAttemptByTokenHash.mockResolvedValue(
      flow('COMPLETED', { completedAt: new Date() }),
    );

    expect((await problem(service.resolveFlow(LOGIN_ID, client))).type).toBe(
      ERR.MFA_TOKEN_INVALID,
    );
  });

  it('refuses a superseded flow with the same answer as an unknown one', async () => {
    // Distinguishing them would tell a caller whether a handle was ever valid.
    attempts.findAttemptByTokenHash.mockResolvedValue(flow('EXPIRED'));
    const superseded = await problem(service.resolveFlow(LOGIN_ID, client));

    attempts.findAttemptByTokenHash.mockResolvedValue(null);
    const unknown = await problem(service.resolveFlow(LOGIN_ID, client));

    // EXPIRED answers `mfa_expired`, which is the one deliberate distinction: a
    // legitimate user who took too long must be told to start again rather than
    // to retry. Neither reveals whether the handle was ever real.
    expect([ERR.MFA_EXPIRED, ERR.MFA_TOKEN_INVALID]).toContain(superseded.type);
    expect(unknown.type).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('refuses a handle presented from a different device', async () => {
    attempts.findAttemptByTokenHash.mockResolvedValue(flow('STARTED'));

    const err = await problem(
      service.resolveFlow(LOGIN_ID, { ...client, deviceKey: 'd'.repeat(64) }),
    );

    expect(err.type).toBe(ERR.MFA_CONTEXT_MISMATCH);
  });

  it('refuses a handle presented from a different network class', async () => {
    attempts.findAttemptByTokenHash.mockResolvedValue(flow('STARTED'));

    const err = await problem(
      service.resolveFlow(LOGIN_ID, { ...client, ipClass: '198.51.100.0/24' }),
    );

    expect(err.type).toBe(ERR.MFA_CONTEXT_MISMATCH);
  });

  it('does NOT retire the flow on a context mismatch', async () => {
    // Otherwise anyone holding a copied handle could kill a victim's live
    // sign-in. It expires on its own soon enough.
    attempts.findAttemptByTokenHash.mockResolvedValue(flow('STARTED'));

    await problem(service.resolveFlow(LOGIN_ID, { ...client, deviceKey: 'd'.repeat(64) }));

    expect(attempts.expireAttempt).not.toHaveBeenCalled();
  });

  it('meters resolution per IP, and allows on cache failure', async () => {
    // Guards a READ whose real defence is 256 bits of entropy. Failing closed
    // would break every in-flight sign-in during an outage to prevent an attack
    // that is not feasible anyway.
    attempts.findAttemptByTokenHash.mockResolvedValue(flow('STARTED'));
    await service.resolveFlow(LOGIN_ID, client);

    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.loginResolveByIp(client.ip),
      policy().LOGIN_FLOW.RESOLVE_BY_IP,
      'allow',
    );
  });
});

describe('loginId — the handle authorises no step by itself', () => {
  it.each([
    ['password from OTP_SENT', 'password', 'OTP_SENT'],
    ['otp-verify from STARTED', 'otp-verify', 'STARTED'],
    ['otp-verify from FACTOR_REQUIRED', 'otp-verify', 'FACTOR_REQUIRED'],
    ['password from FACTOR_REQUIRED', 'password', 'FACTOR_REQUIRED'],
    ['oauth-start from FACTOR_REQUIRED', 'oauth-start', 'FACTOR_REQUIRED'],
  ] as const)('refuses %s', (_what, step, state) => {
    const err = (() => {
      try {
        service.assertLoginStep(flow(state), step);
      } catch (e) {
        return e as ProblemException;
      }
      throw new Error('expected a refusal');
    })();

    expect(err.type).toBe(ERR.MFA_STEP_INVALID);
    // The state travels back so a desynchronised client can re-read rather than
    // throw the flow away. It is the caller's own progress.
    expect(err.extra).toMatchObject({ state });
  });

  /**
   * The regression this pair exists for.
   *
   * `state` was briefly left OUT of `LOGIN_STEP_REQUIRES`, on the reasoning that
   * a step legal from every live state needs no entry. That is exactly backwards
   * against a table that fails closed: an absent key means "always refused", so
   * the step was unreachable in every state and answered `mfa_step_invalid` to
   * every caller. It typechecked, and no unit test noticed — it took driving the
   * real endpoint to see it.
   */
  it.each(['STARTED', 'OTP_SENT', 'FACTOR_REQUIRED'] as const)(
    'allows step:state from %s',
    (state) => {
      expect(() => service.assertLoginStep(flow(state), 'state')).not.toThrow();
    },
  );

  it('every CONTINUATION step has a table entry', () => {
    // A step that exists on the wire but not in the table is dead on arrival,
    // because the table fails closed.
    for (const step of ['otp-request', 'otp-verify', 'oauth-callback', 'oauth-register', 'state']) {
      expect(LOGIN_STEP_REQUIRES[step], `${step} has no LOGIN_STEP_REQUIRES entry`).toBeDefined();
    }
  });

  it('the steps that OPEN a flow have no entry, and need none', () => {
    // They create the row this table asks about, so there is no prior state to
    // require and they never reach the gate. An entry would be a state check
    // against a row that does not exist yet.
    //
    // `otp-request` is deliberately absent from this list: it is in the table,
    // because with a `loginId` it is a resend and IS a continuation.
    expect(LOGIN_STEP_REQUIRES['password']).toBeUndefined();
    expect(LOGIN_STEP_REQUIRES['oauth-start']).toBeUndefined();
  });

  it('fails closed on a step it does not recognise', () => {
    // A step added to the DTO without a table entry is refused on its first
    // request rather than quietly running from any state at all.
    expect(() => service.assertLoginStep(flow('STARTED'), 'teleport')).toThrow();
  });

  it('the table admits exactly the steps that exist, and no terminal state', () => {
    for (const [step, states] of Object.entries(LOGIN_STEP_REQUIRES)) {
      expect(states.length, `${step} allows nothing`).toBeGreaterThan(0);
      expect(states).not.toContain('COMPLETED');
      expect(states).not.toContain('EXPIRED');
    }
  });
});

describe('loginId — MFA cannot be bypassed', () => {
  it('accepts the second factor only from FACTOR_REQUIRED', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(flow('FACTOR_REQUIRED'));

    await expect(mfa.requireAttempt(LOGIN_ID, client)).resolves.toMatchObject({
      state: 'FACTOR_REQUIRED',
    });
  });

  it.each(['STARTED', 'OTP_SENT'] as const)(
    'refuses a second factor from a flow still at %s',
    async (state) => {
      // The bypass this closes: `start` is anonymous, so a handle for a flow that
      // has proven nothing is the cheapest kind to obtain. Reaching a factor step
      // with one would make the FIRST factor optional.
      factors.findAttemptByTokenHash.mockResolvedValue(flow(state));

      expect((await problem(mfa.requireAttempt(LOGIN_ID, client))).type).toBe(
        ERR.MFA_TOKEN_INVALID,
      );
    },
  );

  it('mints NO second handle when a factor is owed', async () => {
    accountExists();
    withTotp();

    const result = await service.withPassword(
            {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(result.kind).toBe('mfa_required');
    // ONE row and ONE handle for the whole sign-in. The password step opened the
    // flow; the second factor promotes that same row rather than minting a
    // second one, which is what `factors.promoteAttempt` below asserts.
    // Exactly one row for the whole sign-in: the password step opened it, and
    // the second factor promoted that same row rather than opening another.
    expect(attempts.createFlow).toHaveBeenCalledTimes(1);
    expect(factors.promoteAttempt).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('mfaToken');
    // The handle it carries is the one THIS request minted — the only one that
    // has ever existed for this flow.
    expect((result as { loginId: string }).loginId).toHaveLength(43);
  });

  it('promotes the existing row instead, under a compare-and-swap', async () => {
    const user = accountExists();
    withTotp();

    await service.withPassword(
            {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(factors.promoteAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, from: 'STARTED', to: 'FACTOR_REQUIRED' }),
    );
  });

  it('issues no session on the mfa_required branch', async () => {
    accountExists();
    withTotp();
    const issue = vi.fn();
    const guarded = new LoginService(
      users as unknown as UserDbOperation,
      makeChallenges() as unknown as ChallengeDbOperation,
      { checkPassword: vi.fn().mockResolvedValue(true) } as unknown as CredentialService,
      { issue } as unknown as SessionService,
      anyDouble<never>() as unknown as MailService,
      cache as unknown as CacheService,
      makeQuota() as unknown as QuotaService,
      {
        isBlocked: vi.fn().mockResolvedValue(false),
        assertNotBlocked: vi.fn().mockResolvedValue(undefined),
      } as unknown as BlocklistService,
      mfa,
      attempts as unknown as TwoFactorDbOperation,
    );

    await guarded.withPassword(
            {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(issue).not.toHaveBeenCalled();
  });
});

describe('loginId — step:state describes the flow honestly', () => {
  it('reports the real methods, not an empty list', async () => {
    // A client that lost its place asks for `state` precisely because it does not
    // know what to prompt for. An earlier version answered `methods: []` from the
    // row alone, which told it there was nothing it could prove.
    factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);

    await expect(service.describeFlow(flow('FACTOR_REQUIRED'), LOGIN_ID)).resolves.toMatchObject({
      kind: 'mfa_required',
      methods: ['totp'],
    });
  });

  it('resolves the methods fresh, so a factor removed mid-flow stops being offered', async () => {
    factors.listConfirmedTotpFactors.mockResolvedValue([]);

    await expect(service.describeFlow(flow('FACTOR_REQUIRED'), LOGIN_ID)).resolves.toMatchObject({
      methods: [],
    });
  });

  it('describes a flow that has proven nothing as started', async () => {
    await expect(service.describeFlow(flow('STARTED'), LOGIN_ID)).resolves.toEqual({
      kind: 'started',
      loginId: LOGIN_ID,
    });
  });

  it('describes a passwordless flow awaiting its code', async () => {
    await expect(service.describeFlow(flow('OTP_SENT'), LOGIN_ID)).resolves.toMatchObject({
      kind: 'otp_sent',
    });
  });
});

describe('loginId — the server owns the identity', () => {
  it('otp-verify takes the address from the flow, never from the body', async () => {
    // The DTO has no `identifier` field at all, so this is structural rather than
    // a check. What it means concretely: a caller who legitimately requested a
    // code for their own address cannot present it against somebody else's.
    accountExists();
    users.findByEmail.mockResolvedValue(makeUser());

    await problem(
      service.verifyOtp(
        flow('OTP_SENT', { identifierLower: 'victim@example.test' }),
      LOGIN_ID,
        { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
        client,
      ),
    );

    expect(users.findByEmail).toHaveBeenCalledWith('victim@example.test');
  });

  it('writes userId once, and only against a flow that has none or already has it', async () => {
    accountExists();
    withTotp();

    await service.withPassword(
            {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    // `promoteAttempt` is the only writer, and its WHERE clause is what makes
    // attaching a SECOND, different account impossible rather than unlikely.
    expect(factors.promoteAttempt).toHaveBeenCalledTimes(1);
  });

  it('records the attempted address even when it matches nothing', async () => {
    // Otherwise the NEXT step would answer differently for a real address than
    // for an unknown one, handing back the distinction `otp-request` was careful
    // not to make.
    users.findByEmail.mockResolvedValue(null);

    await service.requestOtp(
      null,
      null,
      { step: 'otp-request', loginId: LOGIN_ID, identifier: 'nobody@example.test', ...CAPTCHA },
      client,
    );

    expect(attempts.markOtpSent).toHaveBeenCalledWith(expect.any(String), 'nobody@example.test');
  });
});

describe('loginId — completion retires it', () => {
  it('completes the flow when a session is issued with no factor owed', async () => {
    accountExists();

    const result = await service.withPassword(
            {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
    );

    expect(result.kind).toBe('session');
    expect(attempts.completeAttempt).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than issuing a session when it loses the completion swap', async () => {
    // The alternative is two sessions from one first factor.
    accountExists();
    attempts.completeAttempt.mockResolvedValue(false);

    const err = await problem(
      service.withPassword(
                {
          step: 'password',
          identifier: 'ada@example.test',
          password: 'C0rrect!Passw0rd',
          ...CAPTCHA,
        },
        client,
      ),
    );

    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('retires the flow when it turns into a registration instead', async () => {
    await service.abandonFlow(flow('STARTED'));
    expect(attempts.expireAttempt).toHaveBeenCalledTimes(1);
  });
});

describe('loginId — the session outcome, and no flow cookie', () => {
  it('issues orebit_session and orebit_csrf on a completed sign-in', async () => {
    await controller.loginRequest(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
      sessionCookies as never,
    );

    // `SessionCookie.issue` writes both cookies and returns the CSRF token — the
    // single place either is set.
    expect(sessionCookies.issue).toHaveBeenCalledTimes(1);
  });

  it('carries no handle on the terminal session outcome', async () => {
    const result = await controller.loginRequest(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
      sessionCookies as never,
    );

    // The flow is over and its handle is retired. Returning one would hand back a
    // value that is already dead.
    expect(result.data).not.toHaveProperty('loginId');
  });

  it('returns no token of any kind in the body', async () => {
    const result = await controller.loginRequest(
      {
        step: 'password',
        identifier: 'ada@example.test',
        password: 'C0rrect!Passw0rd',
        ...CAPTCHA,
      },
      client,
      sessionCookies as never,
    );

    const body = JSON.stringify(result);
    expect(body).not.toContain('access');
    expect(body).not.toContain('refresh');
  });

  it('sets NO cookie on any step that does not end in a session', async () => {
    loginDouble.requestOtp.mockResolvedValue({
      kind: 'otp_sent',
      loginId: LOGIN_ID,
      resendAvailableAt: null,
    });

    // Opening a flow is a database write, not a cookie. There is no temporary
    // login cookie of any kind, and the session port is the controller's only
    // cookie writer — so this is the whole of "no flow cookie exists".
    await controller.loginRequest(
      { step: 'otp-request', identifier: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies as never,
    );
    await controller.loginRequest(
      { step: 'oauth-start', provider: 'GOOGLE' },
      client,
      sessionCookies as never,
    );

    expect(sessionCookies.issue).not.toHaveBeenCalled();
  });

  it('echoes the handle back on every in-progress outcome', async () => {
    loginDouble.requestOtp.mockResolvedValue({
      kind: 'otp_sent',
      loginId: LOGIN_ID,
      resendAvailableAt: null,
    });
    const otp = await controller.loginRequest(
      { step: 'otp-request', loginId: LOGIN_ID, identifier: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies as never,
    );
    expect(otp.data).toMatchObject({ loginId: LOGIN_ID });

    const redirect = await controller.loginRequest(
      { step: 'oauth-start', provider: 'GOOGLE' },
      client,
      sessionCookies as never,
    );
    // The OAuth service returns the handle its factory minted, so the controller
    // echoes that rather than one it was given.
    expect(redirect.data).toMatchObject({ loginId: OAUTH_LOGIN_ID });
  });
});

describe('loginId — the gate runs before any branch', () => {
  it('resolves and state-checks a CONTINUATION before the service is reached', async () => {
    await controller.loginRequest(
      { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
      client,
      sessionCookies as never,
    );

    expect(loginDouble.resolveFlow).toHaveBeenCalledWith(LOGIN_ID, client);
    expect(loginDouble.assertLoginStep).toHaveBeenCalledWith(expect.anything(), 'otp-verify');
  });

  it.each([
    ['password', { step: 'password', identifier: 'a@b.test', password: 'p', ...CAPTCHA }],
    ['otp-request', { step: 'otp-request', identifier: 'a@b.test', ...CAPTCHA }],
    ['oauth-start', { step: 'oauth-start', provider: 'GOOGLE' }],
  ])('does not resolve anything on %s — there is no handle yet', async (_step, body) => {
    await controller.loginRequest(body, client, sessionCookies as never);

    expect(loginDouble.resolveFlow).not.toHaveBeenCalled();
  });

  it('refuses a start body carrying a handle', async () => {
    // `.strict()`. Silently dropping the field would open a SECOND flow and return
    // a second handle while the caller believed it was continuing the first.
    const err = await problem(
      controller.loginRequest(
        { step: 'start', loginId: LOGIN_ID },
        client,
        sessionCookies as never,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it.each([
    ['otp-verify', { step: 'otp-verify', code: '123456' }],
    ['oauth-callback', { step: 'oauth-callback', provider: 'GOOGLE', code: 'c', state: 's' }],
    ['oauth-register', { step: 'oauth-register', linkToken: 'tok' }],
    ['state', { step: 'state' }],
  ])('refuses CONTINUATION step %s with no loginId at all', async (_step, body) => {
    // A missing handle never reaches the gate: the DTO requires it, so `parseDto`
    // answers first. That is the honest description once the value is a body
    // field rather than a cookie the browser attaches invisibly.
    const err = await problem(controller.loginRequest(body, client, sessionCookies as never));
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });
});
