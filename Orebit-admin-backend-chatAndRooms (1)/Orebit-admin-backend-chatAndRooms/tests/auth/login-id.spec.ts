import { describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../auth/auth.controller';
import { STEP_UP } from '../../auth/auth.constants';
import type { ClientContext } from '../../auth/auth.types';
import { TwoFactorController } from '../../src/2fa/2fa.controller';
import { twoFactorRequestSchema } from '../../src/2fa/2fa.dto';
import { TWO_FACTOR_REQUIRES } from '../../src/2fa/2fa.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin, makeAttempt } from '../harness';

/**
 * ═══ ONE CREDENTIAL, IN THE BODY, ACROSS TWO ROUTES ══════════════════════════
 *
 * The sign-in credential used to travel in the httpOnly `orebit_admin_step`
 * cookie. It is now `loginId`, returned by `step: 'password'` and echoed back by
 * every later step of `POST /auth/login` and by the four sign-in actions of
 * `POST /2fa`.
 *
 * ─── What this file is for, and what it deliberately leaves alone ───────────
 *
 * TRANSPORT, and only transport. Whether a `loginId` is minted, required, parsed,
 * and handed to the resolver unchanged.
 *
 * It does NOT re-test what the credential resolves to. `step_up_invalid`,
 * `step_up_expired`, the account-status gates and the compare-and-swap that stops
 * two requests completing one attempt are all properties of `LoginService` and the
 * dboperations, and they are covered against real code in login.spec.ts and
 * exhaustively table-driven in stepup.spec.ts. Re-asserting them here, through a
 * stubbed `logins.resolve`, would test the double.
 *
 * ─── Why these two controllers, and why together ────────────────────────────
 *
 * They are the layer the migration actually changed, and they had no coverage at
 * all before it — the `cookies.issue` / `require` / `clear` calls this replaced
 * were never asserted anywhere. And the property being protected is that ONE value
 * crosses TWO routes, which no single-route file can state.
 */

const LOGIN_ID = 'a'.repeat(Math.ceil((STEP_UP.SECRET_BYTES * 4) / 3));

function ctx(): ClientContext {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

/** The slug a refusal carried, so a spec asserts the contract rather than a message. */
async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    throw err;
  }
  throw new Error('expected a refusal, got a result');
}

// ─── AuthController ─────────────────────────────────────────────────────────

function authDoubles() {
  const resolved = { attempt: makeAttempt({ state: 'PASSWORD_VERIFIED' }), admin: makeAdmin() };

  const logins = {
    withPassword: vi.fn().mockResolvedValue({
      outcome: {
        kind: 'email_otp_required',
        otpExpiresAt: null,
        resendAvailableAt: null,
        otpSendsRemaining: 4,
      },
      stepUpSecret: LOGIN_ID,
    }),
    resolve: vi.fn().mockResolvedValue(resolved),
    resendOtp: vi.fn().mockResolvedValue({
      kind: 'email_otp_required',
      otpExpiresAt: null,
      resendAvailableAt: null,
      otpSendsRemaining: 3,
    }),
    verifyEmail: vi.fn().mockResolvedValue({ kind: 'mfa_required', methods: ['TOTP'] }),
    readState: vi.fn().mockResolvedValue({ kind: 'mfa_required', methods: ['TOTP'] }),
  };

  const captcha = {
    verify: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnValue({ enabled: false, providers: [] }),
  };

  const controller = new AuthController(
    logins as never,
    {} as never,
    {} as never,
    // BffSessionService. Unreached: this file only drives `POST /auth/login`, which
    // never mints a session — that happens on `POST /2fa`.
    {} as never,
    captcha as never,
  );

  return { controller, logins, captcha, resolved };
}

const PASSWORD_BODY = {
  step: 'password',
  email: 'admin@orebit.io',
  password: 'Orebit@123',
} as const;

describe('POST /auth/login — minting the loginId', () => {
  it('returns it in the body on the password step', async () => {
    const { controller } = authDoubles();

    const result = await controller.login(PASSWORD_BODY, ctx(), 'device-id');

    expect(result.data).toMatchObject({ outcome: 'email_otp_required', loginId: LOGIN_ID });
  });

  /**
   * The value the client is handed is the one the service minted, byte for byte.
   * A controller that derived, truncated or re-encoded it would hand back something
   * that hashes to nothing.
   */
  it('returns exactly what the service minted', async () => {
    const { controller, logins } = authDoubles();
    logins.withPassword.mockResolvedValue({
      outcome: {
        kind: 'email_otp_required',
        otpExpiresAt: null,
        resendAvailableAt: null,
        otpSendsRemaining: 4,
      },
      stepUpSecret: 'Zm9vYmFy_-0123456789abcdefghijklmnopqrstuv',
    });

    const result = await controller.login(PASSWORD_BODY, ctx(), 'device-id');

    expect((result.data as { loginId: string }).loginId).toBe(
      'Zm9vYmFy_-0123456789abcdefghijklmnopqrstuv',
    );
  });

  it('mints one that matches the shape the DTO will later demand', async () => {
    const { controller } = authDoubles();

    const result = await controller.login(PASSWORD_BODY, ctx(), 'device-id');
    const { loginId } = result.data as { loginId: string };

    expect(loginId).toHaveLength(Math.ceil((STEP_UP.SECRET_BYTES * 4) / 3));
    expect(loginId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /**
   * `start` runs before any password is proven, so there is no attempt for a
   * `loginId` to name. Returning one would mean the value existed before the
   * credential that earns it.
   */
  it('does not mint one on the start step', async () => {
    const { controller } = authDoubles();

    const result = await controller.login({ step: 'start' }, ctx(), 'device-id');

    expect(result.data).toMatchObject({ outcome: 'captcha' });
    expect(result.data).not.toHaveProperty('loginId');
  });

  /** A refused password must leave the caller holding nothing to continue with. */
  it('returns nothing when the password step throws', async () => {
    const { controller, logins } = authDoubles();
    logins.withPassword.mockRejectedValue(
      new ProblemException({ type: ERR.INVALID_CREDENTIALS }),
    );

    expect(await slugOf(() => controller.login(PASSWORD_BODY, ctx(), 'device-id'))).toBe(
      ERR.INVALID_CREDENTIALS,
    );
  });
});

describe('POST /auth/login — presenting the loginId', () => {
  const STEPS = [
    { step: 'verify-email', extra: { code: '123456' } },
    { step: 'resend-otp', extra: {} },
    { step: 'state', extra: {} },
  ] as const;

  /**
   * ═══ THE PARSE GATE FIRES BEFORE THE CREDENTIAL GATE ══════════════════════
   *
   * An absent `loginId` is `validation_failed`, not `step_up_required`. That is the
   * honest answer once the value is a body field rather than a cookie the browser
   * attaches invisibly — nothing was sent, so the request is malformed.
   *
   * The second assertion is the load-bearing one: `resolve` must never run. A
   * controller that reached the resolver with `undefined` would charge the resolve
   * rate limiter and hit the database on every malformed request.
   */
  for (const { step, extra } of STEPS) {
    it(`refuses "${step}" with no loginId, without reaching the resolver`, async () => {
      const { controller, logins } = authDoubles();

      expect(await slugOf(() => controller.login({ step, ...extra }, ctx(), 'd'))).toBe(
        ERR.VALIDATION_FAILED,
      );
      expect(logins.resolve).not.toHaveBeenCalled();
    });

    it(`hands "${step}" its loginId to the resolver verbatim`, async () => {
      const { controller, logins } = authDoubles();
      const client = ctx();

      await controller.login({ step, loginId: LOGIN_ID, ...extra }, client, 'd');

      expect(logins.resolve).toHaveBeenCalledWith(LOGIN_ID, client);
    });

    it(`echoes the loginId back on "${step}", so the client can continue`, async () => {
      const { controller } = authDoubles();

      const result = await controller.login(
        { step, loginId: LOGIN_ID, ...extra },
        ctx(),
        'd',
      );

      expect((result.data as { loginId: string }).loginId).toBe(LOGIN_ID);
    });
  }

  /**
   * A shape check, so junk never reaches sha256 and a database round trip. The
   * boundary cases are the ones a hand-written length check gets wrong.
   */
  const MALFORMED: readonly [string, string][] = [
    ['one character short', 'a'.repeat(42)],
    ['one character long', 'a'.repeat(44)],
    ['empty', ''],
    ['standard base64 padding', `${'a'.repeat(42)}=`],
    ['standard base64 plus', `${'a'.repeat(42)}+`],
    ['standard base64 slash', `${'a'.repeat(42)}/`],
  ];

  for (const [label, value] of MALFORMED) {
    it(`refuses a loginId that is ${label}`, async () => {
      const { controller, logins } = authDoubles();

      expect(
        await slugOf(() =>
          controller.login({ step: 'state', loginId: value }, ctx(), 'd'),
        ),
      ).toBe(ERR.VALIDATION_FAILED);
      expect(logins.resolve).not.toHaveBeenCalled();
    });
  }

  /**
   * `.strict()` cutting the other way. The two anonymous steps must not accept a
   * credential — a client attaching one everywhere is told, rather than having it
   * silently dropped on the steps that are meant to be reachable without one.
   */
  it('refuses a loginId on the anonymous steps', async () => {
    const { controller } = authDoubles();

    expect(
      await slugOf(() => controller.login({ step: 'start', loginId: LOGIN_ID }, ctx(), 'd')),
    ).toBe(ERR.VALIDATION_FAILED);
    expect(
      await slugOf(() =>
        controller.login({ ...PASSWORD_BODY, loginId: LOGIN_ID }, ctx(), 'd'),
      ),
    ).toBe(ERR.VALIDATION_FAILED);
  });
});

// ─── TwoFactorController ────────────────────────────────────────────────────

function twoFactorDoubles() {
  const resolved = { attempt: makeAttempt({ state: 'EMAIL_VERIFIED' }), admin: makeAdmin() };

  const logins = { resolve: vi.fn().mockResolvedValue(resolved) };

  const issued = {
    sessionId: 's',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: new Date(),
    refreshExpiresAt: new Date(),
    reauthenticateAt: new Date(),
    admin: {
      id: 'a',
      email: 'admin@orebit.io',
      name: 'Admin',
      role: 'SUPER_ADMIN',
      emailVerified: true,
      mfaEnrolled: true,
      createdAt: new Date(),
    },
  };

  const mfa = {
    totpEnroll: vi.fn().mockResolvedValue({ secret: 's', uri: 'otpauth://x' }),
    totpVerify: vi.fn().mockResolvedValue(issued),
    passkeyChallenge: vi.fn().mockResolvedValue({ mode: 'authenticate', options: {} }),
    passkeyVerify: vi.fn().mockResolvedValue(issued),
  };

  const session = { issue: vi.fn().mockReturnValue('csrf-token'), clear: vi.fn() };

  // The browser's session record. `create` is what stores both tokens server-side
  // and returns the opaque handle that goes in the cookie.
  const bff = { create: vi.fn().mockResolvedValue('session-handle'), destroy: vi.fn() };

  const controller = new TwoFactorController(
    {} as never,
    mfa as never,
    logins as never,
    {} as never,
    bff as never,
  );

  return { controller, logins, mfa, session, bff };
}

/** The body each sign-in action needs, minus the `loginId` itself. */
const SIGN_IN_ACTIONS = [
  { action: 'totp-enroll', extra: {} },
  { action: 'totp-verify', extra: { code: '123456' } },
  { action: 'passkey-challenge', extra: {} },
  { action: 'passkey-verify', extra: { response: { id: 'webauthn-credential-id' } } },
] as const;

describe('POST /2fa — the same loginId, one route later', () => {
  for (const { action, extra } of SIGN_IN_ACTIONS) {
    it(`refuses "${action}" with no loginId, without reaching the resolver`, async () => {
      const { controller, logins, session } = twoFactorDoubles();

      expect(
        await slugOf(() =>
          controller.mutate({ action, ...extra }, null, session as never, null, ctx()),
        ),
      ).toBe(ERR.VALIDATION_FAILED);
      expect(logins.resolve).not.toHaveBeenCalled();
    });

    it(`hands "${action}" its loginId to the resolver verbatim`, async () => {
      const { controller, logins, session } = twoFactorDoubles();
      const client = ctx();

      await controller.mutate(
        { action, loginId: LOGIN_ID, ...extra },
        null,
        session as never,
        null,
        client,
      );

      expect(logins.resolve).toHaveBeenCalledWith(LOGIN_ID, client);
    });
  }

  /**
   * ═══ THE DTO AND THE CREDENTIAL TABLE, ASSERTED AGAINST EACH OTHER ════════
   *
   * `TWO_FACTOR_REQUIRES` says which actions are reachable half-authenticated, and
   * the DTO says which accept a `loginId`. Those are two independent declarations
   * of one fact, so they can drift — an action added to the union with a `loginId`
   * but marked `bearer` would be a sign-in credential accepted on a route that
   * never resolves it.
   *
   * Driving the assertion FROM the table is what makes that unrepresentable: a new
   * `'step-up'` action fails here until its DTO variant exists.
   */
  it('accepts a loginId on exactly the actions the credential table calls step-up', () => {
    const declared = Object.entries(TWO_FACTOR_REQUIRES)
      .filter(([, credential]) => credential === 'step-up')
      .map(([action]) => action)
      .sort();

    expect(declared).toEqual(SIGN_IN_ACTIONS.map((a) => a.action).sort());
  });

  /**
   * ─── A DIFFERENTIAL assertion, and it has to be ────────────────────────────
   *
   * Simply posting `{ action, loginId }` at each bearer action and expecting a 400
   * proves nothing: `rename` and `remove` are refused for missing `kind` and
   * `factorId` whether or not a `loginId` is present, so that test would pass just
   * as happily against a DTO that accepted one.
   *
   * So each body is asserted VALID first, then invalid with `loginId` added. The
   * only difference between the two parses is the field under test, which is what
   * makes the failure attributable to it.
   *
   * Parsed against the schema directly rather than through the controller, because
   * the controller would resolve principals and tickets for the valid half and
   * refuse for reasons that have nothing to do with this file.
   */
  const VALID_BEARER_BODIES: readonly Record<string, unknown>[] = [
    { action: 'reauth-challenge' },
    { action: 'reauth-verify', code: '123456' },
    { action: 'totp-add' },
    { action: 'totp-confirm', code: '123456' },
    { action: 'passkey-add-challenge' },
    { action: 'passkey-add-verify', response: { id: 'webauthn-credential-id' } },
    { action: 'remove', kind: 'TOTP', factorId: '01920000-0000-7000-8000-000000000004' },
    {
      action: 'rename',
      kind: 'TOTP',
      factorId: '01920000-0000-7000-8000-000000000004',
      label: 'Phone',
    },
  ];

  it('covers every bearer action the credential table declares', () => {
    const declared = Object.entries(TWO_FACTOR_REQUIRES)
      .filter(([, credential]) => credential !== 'step-up')
      .map(([action]) => action)
      .sort();

    expect(VALID_BEARER_BODIES.map((b) => b.action as string).sort()).toEqual(declared);
  });

  for (const body of VALID_BEARER_BODIES) {
    it(`refuses a loginId on "${String(body.action)}", which is otherwise valid`, () => {
      expect(
        twoFactorRequestSchema.safeParse(body).success,
        `the control body for "${String(body.action)}" must itself parse`,
      ).toBe(true);

      expect(twoFactorRequestSchema.safeParse({ ...body, loginId: LOGIN_ID }).success).toBe(
        false,
      );
    });
  }
});

describe('completing the ceremony', () => {
  /**
   * The regression guard for having removed `cookies.clear()`. Nothing on the
   * client needs retiring — `AttemptDbOperation.complete` nulls the secret hash in
   * the same statement that sets `completedAt` — but the session must still be
   * minted, and its refresh token must still reach the cookie.
   */
  for (const { action, extra } of [
    { action: 'totp-verify', extra: { code: '123456' } },
    { action: 'passkey-verify', extra: { response: { id: 'webauthn-credential-id' } } },
  ] as const) {
    it(`"${action}" still mints a session and issues the refresh cookie`, async () => {
      const { controller, session } = twoFactorDoubles();

      const result = await controller.mutate(
        { action, loginId: LOGIN_ID, ...extra },
        null,
        session as never,
        null,
        ctx(),
      );

      expect(result.data).toMatchObject({ outcome: 'session' });
      expect(session.issue).toHaveBeenCalledTimes(1);
    });

    /** The final response must not hand back a value the client could try again. */
    it(`"${action}" does not return a loginId once authenticated`, async () => {
      const { controller, session } = twoFactorDoubles();

      const result = await controller.mutate(
        { action, loginId: LOGIN_ID, ...extra },
        null,
        session as never,
        null,
        ctx(),
      );

      expect(result.data).not.toHaveProperty('loginId');
      expect(
        (result.data as unknown as { session: Record<string, unknown> }).session,
      ).not.toHaveProperty('loginId');
    });
  }
});

/**
 * ═══ COOKIE INDEPENDENCE, AS A STRUCTURAL FACT ══════════════════════════════
 *
 * Every test above ran without a cookie jar, a FastifyRequest or a step-up port —
 * which is the practical demonstration. These two assertions are the mechanical
 * one: neither controller can be handed a cookie port, because neither has a
 * parameter for one.
 *
 * `Function.length` counts declared parameters, so re-introducing the port would
 * fail here rather than quietly restoring a second credential path.
 */
describe('no sign-in credential travels in a cookie', () => {
  it('AuthController.login takes body, client and deviceId — and nothing else', () => {
    expect(AuthController.prototype.login).toHaveLength(3);
  });

  it('TwoFactorController.mutate takes no step-up port', () => {
    // body, principal, session cookie, elevation ticket, client.
    expect(TwoFactorController.prototype.mutate).toHaveLength(5);
  });
});
