import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import type { ClientContext } from '../../auth/auth.types';
import type { CaptchaVerifier } from '../../src/captcha/captcha.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import type { LoginService } from '../../auth/services/login.service';
import type { OauthService } from '../../auth/services/oauth.service';
import type { PasswordService } from '../../auth/services/password.service';
import type { RegistrationService } from '../../auth/services/registration.service';
import type { SessionService } from '../../auth/services/session.service';
import type { BffSessionService } from '../../auth/security/bff.session';
import type { UserService } from '../../auth/services/user.service';
import {
  makeLoginAttempt,
  makePrincipal,
  makePublicUser,
  makeRegistration,
} from '../harness';

/**
 * The controller's whole job is parse, delegate, serialise — so these assert the
 * three, plus the two things it owns that no service can:
 *
 *  - captcha is verified BEFORE the service is called, on the steps that need it.
 *    A captcha checked afterwards protects nothing.
 *  - `start` returns the `signupId`, and every later step resolves the
 *    registration from the one in its own body — the only place that handover is
 *    expressed.
 *  - `POST /auth/login` resolves and state-checks its flow BEFORE any branch
 *    runs, so no step can reach a service without passing the gate.
 *
 * `SessionCookie` is a hand-rolled port precisely so this file can hand the
 * controller a few vi.fn()s instead of standing up Fastify. The registration
 * cookie port that used to sit beside it is gone with the cookie itself.
 */

const principal = makePrincipal();

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

const CAPTCHA = { captchaProvider: 'TURNSTILE', captchaToken: 'tok' } as const;

/**
 * Well-formed flow handles.
 *
 * 43 characters of base64url, because `signupIdSchema` and `loginIdSchema` derive
 * that length from `SECRET_BYTES` and reject anything else before the controller
 * runs. A placeholder like `'secret-1'` would fail validation, so these are not
 * cosmetic — they are the difference between exercising the controller and
 * exercising the DTO.
 */
const SIGNUP_ID = 's'.repeat(43);
const LOGIN_ID = 'l'.repeat(43);

const session = {
  sessionId: 'sess-1',
  accessToken: 'access',
  // Distinctive on purpose: `'refresh'` is a substring of `refreshExpiresAt`, so a
  // test asserting the token is absent from a response body would pass or fail on
  // the wrong thing.
  refreshToken: 'rt-must-not-be-in-any-body',
  accessExpiresAt: new Date('2026-01-15T10:15:00.000Z'),
  refreshExpiresAt: new Date('2026-02-14T10:00:00.000Z'),
  user: makePublicUser(),
};

function createRegistration() {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ registration: makeRegistration(), continuationSecret: 'secret-1' }),
    resendOtp: vi.fn().mockResolvedValue(makeRegistration()),
    verifyEmail: vi.fn().mockResolvedValue(makeRegistration()),
    checkReferral: vi
      .fn()
      .mockResolvedValue({ registration: makeRegistration(), referrerUsername: null }),
    setTrustDevice: vi.fn().mockResolvedValue(makeRegistration()),
    setCredentials: vi.fn().mockResolvedValue(makeRegistration()),
    setCountry: vi.fn().mockResolvedValue({ registration: makeRegistration(), session }),
    readState: vi.fn().mockResolvedValue(makeRegistration()),
  };
}

function createLogin() {
  return {
    // The flow half. `resolveFlow` answers a live STARTED row by default, which is
    // what every first-factor step needs; a spec exercising a later step overrides
    // it with the state it cares about.
    startFlow: vi
      .fn()
      .mockResolvedValue({ loginId: LOGIN_ID, attempt: makeLoginAttempt({ state: 'STARTED' }) }),
    resolveFlow: vi.fn().mockResolvedValue(makeLoginAttempt({ state: 'STARTED' })),
    assertLoginStep: vi.fn(),
    abandonFlow: vi.fn().mockResolvedValue(undefined),

    withPassword: vi.fn().mockResolvedValue({ kind: 'session', session }),
    requestOtp: vi.fn().mockResolvedValue({ kind: 'otp_sent', resendAvailableAt: null }),
    // A discriminated result, like `withPassword` above: this path can now stop
    // at `mfa_required` instead of minting a session.
    verifyOtp: vi.fn().mockResolvedValue({ kind: 'session', session }),
  };
}

/** `SessionCookie` is a hand-rolled port so the cookie lifecycle can be asserted
 *  with four vi.fn()s instead of a live Fastify reply and a cookie jar.
 *
 *  `issue` returns a CSRF token now, because the real one does — that return value is
 *  what reaches the response body, so a mock returning `undefined` would let a payload
 *  ship without one and nothing would notice. */
function createSessionCookies() {
  return {
    read: vi.fn().mockReturnValue('handle-in-cookie'),
    issue: vi.fn().mockReturnValue('csrf-token-1'),
    slide: vi.fn(),
    ensureCsrf: vi.fn().mockReturnValue('csrf-token-1'),
    clear: vi.fn(),
  };
}

let registration: ReturnType<typeof createRegistration>;
let login: ReturnType<typeof createLogin>;
let sessions: {
  rotate: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  logoutAll: ReturnType<typeof vi.fn>;
  revokeSession: ReturnType<typeof vi.fn>;
};
let passwords: {
  requestCode: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  change: ReturnType<typeof vi.fn>;
};
let oauth: {
  start: ReturnType<typeof vi.fn>;
  callback: ReturnType<typeof vi.fn>;
  chooseRegister: ReturnType<typeof vi.fn>;
};
let users: {
  getCurrentUser: ReturnType<typeof vi.fn>;
  updateMyProfile: ReturnType<typeof vi.fn>;
};
let captcha: { verify: ReturnType<typeof vi.fn> };
let sessionCookies: ReturnType<typeof createSessionCookies>;
let bff: {
  create: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  recordState: ReturnType<typeof vi.fn>;
};
let controller: AuthController;

beforeEach(() => {
  registration = createRegistration();
  login = createLogin();
  sessions = {
    rotate: vi.fn().mockResolvedValue(session),
    logout: vi.fn().mockResolvedValue(undefined),
    logoutAll: vi.fn().mockResolvedValue(undefined),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  };
  passwords = {
    requestCode: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    change: vi.fn().mockResolvedValue(undefined),
  };
  oauth = { start: vi.fn(), callback: vi.fn(), chooseRegister: vi.fn() };
  users = {
    getCurrentUser: vi.fn().mockResolvedValue(makePublicUser()),
    updateMyProfile: vi.fn().mockResolvedValue({ ...makePublicUser(), country: 'FR' }),
  };
  captcha = { verify: vi.fn().mockResolvedValue(undefined) };
  sessionCookies = createSessionCookies();
  bff = {
    create: vi.fn().mockResolvedValue('handle-1'),
    destroy: vi.fn().mockResolvedValue(undefined),
    // 'absent' is the honest default for a logout whose session has already gone.
    // 'unknown' is the interesting one and is set per-test — see the 503 case.
    recordState: vi.fn().mockResolvedValue('absent'),
  };

  controller = new AuthController(
    registration as unknown as RegistrationService,
    login as unknown as LoginService,
    sessions as unknown as SessionService,
    passwords as unknown as PasswordService,
    oauth as unknown as OauthService,
    users as unknown as UserService,
    bff as unknown as BffSessionService,
    captcha as unknown as CaptchaVerifier,
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

describe('AuthController.me', () => {
  it('returns the profile and the calling session family', async () => {
    const principal = makePrincipal();
    const result = await controller.me(principal, sessionCookies);

    expect(users.getCurrentUser).toHaveBeenCalledWith(principal.userId);
    // The FAMILY, not the generation. A generation id changes on every background
    // rotation, so a client marking "this device" in the session list would be
    // holding a value that matches no row moments later.
    expect(result.data.session).toEqual({ familyId: principal.familyId });
    expect(result.data.user.publicCode).toBe('OREBiT7Q9K2M4X');
  });

  it('reports the CSRF token so a cross-origin client can recover it', async () => {
    // The app is served from another origin and cannot read `orebit_csrf`, so after a
    // reload this route is how it learns the token to echo. `ensureCsrf` returns the
    // existing one untouched — see its note on read-don't-rotate.
    const result = await controller.me(makePrincipal(), sessionCookies);

    expect(sessionCookies.ensureCsrf).toHaveBeenCalled();
    expect(result.data.csrfToken).toBe('csrf-token-1');
  });

  it('serialises registeredAt as an ISO string, not a Date', async () => {
    const result = await controller.me(makePrincipal(), sessionCookies);
    // The wire boundary. A Date here would serialise differently depending on who
    // called JSON.stringify.
    expect(typeof result.data.user.registeredAt).toBe('string');
  });

  it('propagates unauthenticated when the account is gone from under a live token', async () => {
    // The soft-delete race. This used to be `throw new Error(...)`, which the
    // problem filter turned into a 500 — telling a client with a dead credential
    // to retry. UserService owns the decision that it is a 401; the controller's
    // only job is not to swallow or re-map it.
    users.getCurrentUser.mockRejectedValue(
      new ProblemException({ type: ERR.UNAUTHENTICATED }),
    );

    const err = await problem(controller.me(makePrincipal(), sessionCookies));
    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(err.status).toBe(401);
  });
});

describe('AuthController.register — captcha ordering', () => {
  it('verifies the captcha BEFORE starting the registration', async () => {
    const order: string[] = [];
    captcha.verify.mockImplementation(async () => void order.push('captcha'));
    registration.start.mockImplementation(async () => {
      order.push('start');
      return { registration: makeRegistration(), continuationSecret: 'secret-1' };
    });

    await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(order).toEqual(['captcha', 'start']);
  });

  it('does not start the registration when the captcha fails', async () => {
    captcha.verify.mockRejectedValue(new ProblemException({ type: ERR.CAPTCHA_FAILED }));

    const err = await problem(
      controller.register(
        { step: 'start', email: 'ada@example.test', ...CAPTCHA },
        client,
        sessionCookies,
      ),
    );

    expect(err.type).toBe(ERR.CAPTCHA_FAILED);
    expect(registration.start).not.toHaveBeenCalled();
  });

  it('requires no captcha on the steps that carry a signupId', async () => {
    // Possession of the handle plus an emailed code is already a barrier; a second
    // challenge on every step would add friction without adding security.
    await controller.register({ step: 'verify-email', signupId: SIGNUP_ID, code: '123456' }, client, sessionCookies);
    expect(captcha.verify).not.toHaveBeenCalled();
  });
});

/**
 * Where the signup handle comes from and where it goes.
 *
 * This block used to assert a cookie lifecycle — issued on `start`, cleared on
 * `country`, never in a body. The mechanism is gone, and so is the shape of those
 * assertions: the value is now returned in the `start` body ON PURPOSE, which is
 * the exact inversion of what the old suite pinned down. What survives unchanged
 * is the property underneath both: exactly one response ever carries the secret,
 * and every later step names its registration with what the caller sends.
 */
describe('AuthController.register — the signupId handover', () => {
  it('returns the secret as signupId on start, and only on start', async () => {
    const result = await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(result.data).toMatchObject({ signupId: 'secret-1' });
  });

  it('never returns the secret again on any later step', async () => {
    // `start` hands it over once. A later response repeating it would widen the
    // exposure for no gain — the client already has it, and anything that can read
    // one of these responses can read the first.
    for (const body of [
      { step: 'state', signupId: SIGNUP_ID },
      { step: 'credentials', signupId: SIGNUP_ID, skip: true },
      { step: 'country', signupId: SIGNUP_ID, country: 'GB' },
    ]) {
      const result = await controller.register(body, client, sessionCookies);
      expect(JSON.stringify(result)).not.toContain('secret-1');
    }
  });

  it('sets no cookie of its own on start', async () => {
    await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies,
    );

    // The session port is the ONLY cookie writer the controller holds now, and
    // `start` has no session to mint.
    expect(sessionCookies.issue).not.toHaveBeenCalled();
  });

  it('takes the registration from the body on later steps', async () => {
    await controller.register({ step: 'state', signupId: SIGNUP_ID }, client, sessionCookies);
    expect(registration.readState).toHaveBeenCalledWith(SIGNUP_ID);
  });

  it('issues the session cookies on country, and only there', async () => {
    await controller.register({ step: 'country', signupId: SIGNUP_ID, country: 'GB' }, client, sessionCookies);
    expect(sessionCookies.issue).toHaveBeenCalledTimes(1);
  });
});

describe('AuthController.register — dispatch', () => {
  const DISPATCH = [
    { step: 'resend-otp', method: 'resendOtp', body: { step: 'resend-otp', signupId: SIGNUP_ID } },
    { step: 'verify-email', method: 'verifyEmail', body: { step: 'verify-email', signupId: SIGNUP_ID, code: '123456' } },
    {
      step: 'check-referral',
      method: 'checkReferral',
      body: { step: 'check-referral', signupId: SIGNUP_ID, code: 'ABCD1234' },
    },
    // `trust-device` was missing from this table, so the one step whose dispatch
    // nothing verified was also the one most recently added.
    {
      step: 'trust-device',
      method: 'setTrustDevice',
      body: { step: 'trust-device', signupId: SIGNUP_ID, trust: true },
    },
    { step: 'credentials', method: 'setCredentials', body: { step: 'credentials', signupId: SIGNUP_ID, skip: true } },
    { step: 'country', method: 'setCountry', body: { step: 'country', signupId: SIGNUP_ID, country: 'GB' } },
    { step: 'state', method: 'readState', body: { step: 'state', signupId: SIGNUP_ID } },
  ] as const;

  it.each(DISPATCH)('routes step $step to RegistrationService.$method', async ({ method, body }) => {
    await controller.register(body, client, sessionCookies);
    expect(registration[method]).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown step at the DTO rather than falling through', async () => {
    const err = await problem(controller.register({ step: 'teleport', signupId: SIGNUP_ID }, client, sessionCookies));
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('reports valid:false and omits referrerUsername when the code matches nobody', async () => {
    registration.checkReferral.mockResolvedValue({
      registration: makeRegistration(),
      referrerUsername: null,
    });

    const result = await controller.register(
      { step: 'check-referral', signupId: SIGNUP_ID, code: 'NOTACODE' },
      client,
      sessionCookies,
    );
    const payload = result.data as { valid: boolean; referrerUsername?: string };

    expect(payload.valid).toBe(false);
    // Absent, not null — the client renders on presence.
    expect('referrerUsername' in payload).toBe(false);
  });

  it('reports valid:true with the username when the code resolves', async () => {
    registration.checkReferral.mockResolvedValue({
      registration: makeRegistration(),
      referrerUsername: 'ada_lovelace',
    });

    const result = await controller.register(
      { step: 'check-referral', signupId: SIGNUP_ID, code: 'K7M2P9QR' },
      client,
      sessionCookies,
    );

    expect(result.data).toMatchObject({ valid: true, referrerUsername: 'ada_lovelace' });
  });
});

describe('AuthController.register — the start payload withholds what start cannot know', () => {
  it('omits country and referral fields a fresh registration has not answered', async () => {
    const result = await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies,
    );

    // The hand-listed field set in toStartPayload. Adding a field to
    // RegistrationStatePayload must not silently leak into `start`.
    //
    // `signupId` is the one addition, and it belongs to `start` alone: this is
    // the response that hands the handle over, and no later one repeats it.
    expect(Object.keys(result.data).sort()).toEqual(
      [
        'email',
        'emailVerified',
        'otpExpiresAt',
        'otpSendsRemaining',
        'passwordSet',
        'resendAvailableAt',
        'signupId',
        'state',
      ].sort(),
    );
  });
});

describe('AuthController.loginRequest', () => {
  it('verifies the captcha before a password login', async () => {
    const order: string[] = [];
    captcha.verify.mockImplementation(async () => void order.push('captcha'));
    login.withPassword.mockImplementation(async () => {
      order.push('login');
      return { kind: 'session', session };
    });

    await controller.loginRequest(
      { step: 'password', identifier: 'ada@example.test', password: 'R1ght!Passw0rd', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(order).toEqual(['captcha', 'login']);
  });

  it('requires no captcha on otp-verify — the emailed code is the challenge', async () => {
    await controller.loginRequest(
      { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
      client,
      sessionCookies,
    );

    expect(captcha.verify).not.toHaveBeenCalled();
    expect(login.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it('maps a passwordless account to outcome otp_required, not an error', async () => {
    login.withPassword.mockResolvedValue({
      kind: 'otp_required',
      loginId: LOGIN_ID,
      resendAvailableAt: null,
    });

    const result = await controller.loginRequest(
      { step: 'password', identifier: 'ada@example.test', password: 'Any!Passw0rd1', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(result.data).toEqual({ outcome: 'otp_required', loginId: LOGIN_ID, resendAvailableAt: null });
  });

  it('serialises resendAvailableAt as an ISO string when there is one', async () => {
    const at = new Date('2026-01-15T10:01:00.000Z');
    login.withPassword.mockResolvedValue({ kind: 'otp_required', resendAvailableAt: at });

    const result = await controller.loginRequest(
      { step: 'password', identifier: 'ada@example.test', password: 'Any!Passw0rd1', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(result.data).toMatchObject({ resendAvailableAt: at.toISOString() });
  });
});

describe('AuthController.password', () => {
  it('dispatches request-code to PasswordService', async () => {
    const result = await controller.password({ action: 'request-code' }, principal, client);

    expect(passwords.requestCode).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ ok: true });
  });

  it('requires no captcha — the route is authenticated now, not public', async () => {
    await controller.password(
      { action: 'set', code: '123456', password: 'Br4nd!NewPassw0rd', confirmPassword: 'Br4nd!NewPassw0rd' },
      principal,
      client,
    );

    expect(captcha.verify).not.toHaveBeenCalled();
    expect(passwords.set).toHaveBeenCalledTimes(1);
  });

  it('dispatches change with the current password', async () => {
    await controller.password(
      {
        action: 'change',
        currentPassword: 'Old!Passw0rd',
        password: 'Br4nd!NewPassw0rd',
        confirmPassword: 'Br4nd!NewPassw0rd',
      },
      principal,
      client,
    );

    expect(passwords.change).toHaveBeenCalledTimes(1);
  });

  it('rejects a change whose confirmation does not match', async () => {
    const err = await problem(
      controller.password(
        {
          action: 'change',
          currentPassword: 'Old!Passw0rd',
          password: 'Br4nd!NewPassw0rd',
          confirmPassword: 'Something!Else1',
        },
        principal,
        client,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(passwords.change).not.toHaveBeenCalled();
  });
});

/**
 * The social sign-in fork.
 *
 * The controller's whole job on these two steps is deciding what travels back as
 * a success body and which of them hands over a SIGNUP handle. Both used to be
 * wrong in a way no test caught: the callback registered people automatically and
 * refused the collision case with advice — "sign in and link the provider" — that
 * no endpoint could carry out.
 */
describe('AuthController.loginRequest — the oauth choice', () => {
  const callback = () =>
    controller.loginRequest(
      { step: 'oauth-callback', loginId: LOGIN_ID, provider: 'GOOGLE', code: 'c', state: 'st' },
      client,
      sessionCookies,
    );

  it('returns the choice as a success body, not as an error', () => {
    // `choice_required` is a happy path that needs a different screen. Modelling it
    // as a problem document would make a client parse an error to continue.
    oauth.callback.mockResolvedValue({
      kind: 'choice_required',
      linkToken: 'tok',
      email: 'person@example.test',
      canCreateNew: true,
    });

    return expect(callback()).resolves.toEqual({
      data: {
        outcome: 'choice_required',
        loginId: LOGIN_ID,
        linkToken: 'tok',
        email: 'person@example.test',
        canCreateNew: true,
      },
    });
  });

  it('passes canCreateNew:false through when the email is already taken', async () => {
    oauth.callback.mockResolvedValue({
      kind: 'choice_required',
      linkToken: 'tok',
      email: 'taken@example.test',
      canCreateNew: false,
    });

    const res = await callback();

    expect(res.data).toMatchObject({ canCreateNew: false });
  });

  it('hands over no signup handle on the callback itself', async () => {
    // The handle belongs to the branch that actually starts a registration.
    // Returning one here would give it to a user who is about to sign in to an
    // account instead.
    oauth.callback.mockResolvedValue({
      kind: 'choice_required',
      linkToken: 'tok',
      email: 'person@example.test',
      canCreateNew: true,
    });

    const res = await callback();

    expect(res.data).not.toHaveProperty('signupId');
  });

  it('still returns a session when the provider is already linked', async () => {
    oauth.callback.mockResolvedValue({ kind: 'session', session });

    const res = await callback();

    expect(res.data).toMatchObject({ outcome: 'session' });
    // The flow is over, so the terminal outcome carries no handle to continue with.
    expect(res.data).not.toHaveProperty('loginId');
  });

  it('returns the continuation secret as signupId on oauth-register, and only there', async () => {
    oauth.chooseRegister.mockResolvedValue({
      kind: 'registration_required',
      continuationSecret: 'secret-1',
      email: 'person@example.test',
      emailVerified: true,
    });

    const res = await controller.loginRequest(
      { step: 'oauth-register', loginId: LOGIN_ID, linkToken: 'tok' },
      client,
      sessionCookies,
    );

    expect(oauth.chooseRegister).toHaveBeenCalledWith('tok', client);
    expect(res.data).toEqual({
      outcome: 'registration_required',
      signupId: 'secret-1',
      email: 'person@example.test',
      emailVerified: true,
    });
  });

  it('retires the login flow when it turns into a registration', async () => {
    // The sign-in is over — there is no account to sign in to — so its handle must
    // stop working rather than sitting live until the TTL runs out.
    oauth.chooseRegister.mockResolvedValue({
      kind: 'registration_required',
      continuationSecret: 'secret-1',
      email: 'person@example.test',
      emailVerified: true,
    });

    await controller.loginRequest(
      { step: 'oauth-register', loginId: LOGIN_ID, linkToken: 'tok' },
      client,
      sessionCookies,
    );

    expect(login.abandonFlow).toHaveBeenCalledTimes(1);
  });
});

/**
 * The credential's transport.
 *
 * Both tokens used to reach the client: the access token as a body field and the
 * refresh token as a cookie. The access token had to be readable, because it went into
 * an `Authorization` header — so an XSS stole a working credential.
 *
 * Neither leaves now. These assert the three halves of that: no token appears in any
 * body, every minting path stores a record and hands back a handle, and logout tears
 * all of it down in the right order.
 */
describe('AuthController — the session cookie', () => {
  const sessionPayloadOf = (data: unknown) =>
    (data as { session?: Record<string, unknown> }).session ?? (data as Record<string, unknown>);

  it('never returns EITHER token in any body that carries a session', async () => {
    const paths = [
      () =>
        controller.loginRequest(
          { step: 'password', identifier: 'ada@example.test', password: 'R1ght!Passw0rd', ...CAPTCHA },
          client,
          sessionCookies,
        ),
      () =>
        controller.loginRequest(
          { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
          client,
          sessionCookies,
        ),
      () => controller.register({ step: 'country', signupId: SIGNUP_ID, country: 'GB' }, client, sessionCookies),
    ];

    for (const path of paths) {
      const result = await path();
      // The whole envelope, not just the session block: a token anywhere in the
      // response defeats the cookie.
      const body = JSON.stringify(result);
      expect(body).not.toContain(session.refreshToken);
      expect(body).not.toContain(session.accessToken);
      expect(sessionPayloadOf(result.data)).not.toHaveProperty('refreshToken');
      expect(sessionPayloadOf(result.data)).not.toHaveProperty('accessToken');
    }
  });

  it('stores the record BEFORE handing out the cookie, on every minting path', async () => {
    // The order is the point. `create` is fail-closed, so doing it first is what stops
    // a browser leaving with a handle that names nothing — which would look like a
    // successful sign-in and 401 on the very next request.
    const order: string[] = [];
    bff.create.mockImplementation(async () => {
      order.push('create');
      return 'handle-1';
    });
    sessionCookies.issue.mockImplementation(() => {
      order.push('issue');
      return 'csrf-token-1';
    });

    await controller.loginRequest(
      { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
      client,
      sessionCookies,
    );
    expect(order).toEqual(['create', 'issue']);
    expect(bff.create).toHaveBeenCalledWith(session);
    expect(sessionCookies.issue).toHaveBeenCalledWith('handle-1');

    order.length = 0;
    await controller.register({ step: 'country', signupId: SIGNUP_ID, country: 'GB' }, client, sessionCookies);
    expect(order).toEqual(['create', 'issue']);

    order.length = 0;
    oauth.callback.mockResolvedValue({ kind: 'session', session });
    await controller.loginRequest(
      { step: 'oauth-callback', loginId: LOGIN_ID, provider: 'GOOGLE', code: 'c', state: 'st' },
      client,
      sessionCookies,
    );
    expect(order).toEqual(['create', 'issue']);
  });

  it('returns the CSRF token that `issue` actually minted', async () => {
    // Not a second one derived here: the token in the body must be the one whose
    // cookie was written, or every mutation the client attempts fails the
    // double-submit check.
    sessionCookies.issue.mockReturnValue('the-real-token');

    const result = await controller.loginRequest(
      { step: 'otp-verify', loginId: LOGIN_ID, code: '123456' },
      client,
      sessionCookies,
    );

    expect(sessionPayloadOf(result.data).csrfToken).toBe('the-real-token');
  });

  it('issues nothing on a login that did not produce a session', async () => {
    login.withPassword.mockResolvedValue({ kind: 'otp_required', resendAvailableAt: null });

    await controller.loginRequest(
      { step: 'password', identifier: 'ada@example.test', password: 'Any!Passw0rd1', ...CAPTCHA },
      client,
      sessionCookies,
    );

    expect(bff.create).not.toHaveBeenCalled();
    expect(sessionCookies.issue).not.toHaveBeenCalled();
  });

  it('revokes, then destroys the record, then clears the cookies', async () => {
    // Backwards, a failure after the cookie was cleared would leave the user
    // apparently signed out while the session stayed live AND unreachable — the
    // handle we deleted was the only value naming it.
    const order: string[] = [];
    sessions.logout.mockImplementation(async () => void order.push('revoke'));
    bff.destroy.mockImplementation(async () => void order.push('destroy'));
    sessionCookies.clear.mockImplementation(() => void order.push('clear'));

    await controller.session({ action: 'logout' }, principal, sessionCookies);

    expect(order).toEqual(['revoke', 'destroy', 'clear']);
    expect(sessions.logout).toHaveBeenCalledWith(principal);
    expect(bff.destroy).toHaveBeenCalledWith('handle-in-cookie');
  });

  it('clears the cookies on logout-all too', async () => {
    await controller.session({ action: 'logout-all' }, principal, sessionCookies);

    expect(sessions.logoutAll).toHaveBeenCalledWith(principal);
    expect(sessionCookies.clear).toHaveBeenCalledTimes(1);
  });

  it('logs out idempotently when the session is already gone', async () => {
    // The guard tolerated a dead session, so there is no principal. Redis says the
    // record is genuinely absent, which means there is nothing left to revoke and the
    // honest answer is success — a second click must not become an error.
    bff.recordState.mockResolvedValue('absent');

    await controller.session({ action: 'logout' }, null, sessionCookies);

    expect(sessions.logout).not.toHaveBeenCalled();
    expect(sessionCookies.clear).toHaveBeenCalledTimes(1);
  });

  it('refuses a logout it cannot verify, and KEEPS the cookies', async () => {
    // 'absent' and 'unknown' are opposites here. Reporting success while the store
    // holding the mapping was unreachable would be a lie about a security operation —
    // and clearing the cookie would strand a live session nobody could ever revoke,
    // because the handle is the only value naming it.
    bff.recordState.mockResolvedValue('unknown');

    const err = await problem(controller.session({ action: 'logout' }, null, sessionCookies));

    expect(err.type).toBe(ERR.SESSION_STORE_UNAVAILABLE);
    expect(err.status).toBe(503);
    expect(bff.destroy).not.toHaveBeenCalled();
    expect(sessionCookies.clear).not.toHaveBeenCalled();
  });

  it('leaves the caller’s own cookies alone when revoking someone else’s session', async () => {
    // `revoke-session` ends a DIFFERENT browser's session. The caller's credential is
    // untouched and has to keep working.
    await controller.session(
      { action: 'revoke-session', sessionId: '00000000-0000-4000-8000-000000000000' },
      principal,
      sessionCookies,
    );

    expect(sessionCookies.clear).not.toHaveBeenCalled();
    expect(bff.destroy).not.toHaveBeenCalled();
  });

  it('no longer accepts a refresh action', async () => {
    // There is nothing for a client to ask for: rotation happens inside AuthGuard.
    // A stale client polling a 200 it never gets would look healthy while doing
    // nothing, so the discriminated union refuses the discriminant outright.
    const err = await problem(
      controller.session({ action: 'refresh' }, principal, sessionCookies),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('refuses a body carrying a token, rather than silently stripping it', async () => {
    // `.strict()`. A client sending `refreshToken` believes it holds a credential it
    // cannot hold, and telling it so at the edge beats accepting the request and
    // ignoring the field.
    const err = await problem(
      controller.session(
        { action: 'logout', refreshToken: 'from-the-body' },
        principal,
        sessionCookies,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(sessions.logout).not.toHaveBeenCalled();
  });
});

describe('AuthController.updateMe', () => {
  /**
   * The profile update, which moved here from `UserController` when accounts
   * folded into `auth/`. Its whole job is validate → delegate → envelope, and the
   * order matters: an unvalidated body reaching the service would defeat the
   * parse-don't-validate arrangement the services are typed against.
   */

  it('passes the parsed body to the service and envelopes the result', async () => {
    const result = await controller.updateMe({ country: 'fr' }, makePrincipal({ userId: 'u1' }));

    // Parsed, not raw: the service receives the uppercased code.
    expect(users.updateMyProfile).toHaveBeenCalledWith('u1', { country: 'FR' });
    expect(result.data.country).toBe('FR');
  });

  it('reads the subject from the principal, never from the request body', async () => {
    // The only thing that decides whose profile is written is the token the guard
    // verified. A `userId` in the body must be ignored — and `.strict()` means it
    // is refused outright rather than silently dropped.
    await expect(
      controller.updateMe(
        { country: 'GB', userId: 'someone-else' },
        makePrincipal({ userId: 'user-from-token' }),
      ),
    ).rejects.toBeInstanceOf(ProblemException);
    expect(users.updateMyProfile).not.toHaveBeenCalled();
  });

  it('rejects an invalid country before touching the service', async () => {
    const err = await problem(controller.updateMe({ country: 'ZZ' }, makePrincipal()));
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(err.status).toBe(400);
    expect(users.updateMyProfile).not.toHaveBeenCalled();
  });

  it('rejects unknown fields rather than silently dropping them', async () => {
    await expect(
      controller.updateMe({ country: 'GB', username: 'someone_else' }, makePrincipal()),
    ).rejects.toBeInstanceOf(ProblemException);
    expect(users.updateMyProfile).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], ['not-an-object'], [42], [[]]])(
    'rejects a body that is not an object (%s)',
    async (body) => {
      const err = await problem(controller.updateMe(body, makePrincipal()));
      expect(err.type).toBe(ERR.VALIDATION_FAILED);
    },
  );

  it('serialises registeredAt as an ISO string, like the read does', async () => {
    const result = await controller.updateMe({ country: 'GB' }, makePrincipal());
    expect(typeof result.data.registeredAt).toBe('string');
  });

  it('returns the bare user payload, not the session block that me() adds', async () => {
    // A write echoes what it wrote. "Who am I and on what session" is `me`'s
    // question, and a PATCH touched neither.
    const result = await controller.updateMe({ country: 'GB' }, makePrincipal());
    expect(result.data).not.toHaveProperty('session');
    expect(result.data).toHaveProperty('publicCode');
  });

  it('propagates a service failure unchanged', async () => {
    // The controller adds no error handling of its own — the global filter is the
    // one place a problem becomes a response.
    const failure = new ProblemException({ type: ERR.UNAUTHENTICATED });
    users.updateMyProfile.mockRejectedValue(failure);

    await expect(
      controller.updateMe({ country: 'GB' }, makePrincipal()),
    ).rejects.toBe(failure);
  });
});
