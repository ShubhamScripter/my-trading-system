import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Registration } from '@prisma/client';
import { AuthController } from '../../auth/auth.controller';
import { CONTINUATION } from '../../auth/auth.constants';
import type { ClientContext } from '../../auth/auth.types';
import { pepperedHash } from '../../auth/auth.utility';
import { signupIdSchema } from '../../auth/dto/common.dto';
import type { RegistrationDbOperation } from '../../auth/persistence/registration.dboperation';
import type { RetainedEmailDbOperation } from '../../auth/persistence/retained-email.dboperation';
import { RegistrationService } from '../../auth/services/registration.service';
import type { BlocklistService } from '../../auth/services/blocklist.service';
import type { CredentialService } from '../../auth/services/credential.service';
import type { LoginService } from '../../auth/services/login.service';
import type { OauthService } from '../../auth/services/oauth.service';
import type { PasswordService } from '../../auth/services/password.service';
import type { SessionService } from '../../auth/services/session.service';
import type { UserService } from '../../auth/services/user.service';
import type { BffSessionService } from '../../auth/security/bff.session';
import { makePublicUser, makeQuota, makeRegistration } from '../harness';
import { ERR } from '../../src/contracts';
import type { ProblemException } from '../../src/http';
import type { CaptchaVerifier } from '../../src/captcha/captcha.types';
import type { GeoResolver } from '../../src/geo/geo.types';
import type { MailService } from '../../src/mail/mail.service';
import type { CacheService, QuotaService } from '../../redis';

/**
 * ═══ `signupId`: THE REGISTRATION FLOW'S ONLY CREDENTIAL ════════════════════
 *
 * The signup flow used to be identified by an httpOnly `orebit_reg` cookie, with
 * `x-registration-token` as a second transport for clients without a cookie jar.
 * Both are gone. `start` returns the same 32-byte secret in the response body as
 * `signupId`, and every later step sends it back in the request body.
 *
 * ─── What this file is actually testing ────────────────────────────────────
 *
 * Not the transport. Moving a value from a `Set-Cookie` header into a JSON field
 * is not interesting on its own, and a suite that asserted "the field is present"
 * would pass for a `signupId` that was the registration's primary key — which is
 * precisely the design this one replaced years ago and must not drift back into.
 *
 * What is worth pinning is the set of properties that make a bearer handle safe
 * to put in a body at all, and they are the same ones the cookie needed:
 *
 *   - it is unpredictable and opaque, and the row's id never leaves the server;
 *   - only a hash of it is stored, so a database dump drives no signups;
 *   - it resolves to exactly one registration and cannot select another;
 *   - it authorises no STEP by itself — the row's state does that;
 *   - it dies on expiry and on completion, and a replay after either is refused;
 *   - unknown, expired and completed are not distinguishable from one another
 *     beyond the one distinction a legitimate user needs.
 *
 * The service is driven with a mocked `RegistrationDbOperation`, so the state
 * machine, the expiry check and the hash lookup are the REAL ones. Only the rows
 * they read are fixtures.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

/** A well-formed handle. The value is arbitrary; the SHAPE is what the DTO checks. */
const SIGNUP_ID = 's'.repeat(43);
const OTHER_SIGNUP_ID = 'z'.repeat(43);

const CAPTCHA = { captchaProvider: 'TURNSTILE', captchaToken: 'tok' } as const;

let registrations: ReturnType<typeof makeRegistrations>;
let service: RegistrationService;
let controller: AuthController;
let registrationDouble: ReturnType<typeof makeRegistrationService>;
let sessionCookies: ReturnType<typeof makeSessionCookies>;

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
function dbDouble<K extends string>(
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

const makeRegistrations = () =>
  dbDouble('create', 'findById', 'findByContinuationHash', 'findResumableByEmail', 'markExpired');
const makeRegistrationService = () =>
  dbDouble(
    'start',
    'resendOtp',
    'verifyEmail',
    'setTrustDevice',
    'checkReferral',
    'setCredentials',
    'setCountry',
    'readState',
  );
const makeSessionCookies = () => dbDouble('read', 'issue', 'slide', 'ensureCsrf', 'clear');

beforeEach(() => {
  registrations = makeRegistrations();
  registrations.findResumableByEmail.mockResolvedValue(null);
  registrations.markExpired.mockResolvedValue(makeRegistration({ state: 'EXPIRED' }));

  service = new RegistrationService(
    registrations as unknown as RegistrationDbOperation,
    dbDouble<never>() as unknown as UserService,
    dbDouble<never>() as unknown as CredentialService,
    dbDouble<never>() as unknown as SessionService,
    { sendOtp: vi.fn() } as unknown as MailService,
    { consume: vi.fn().mockResolvedValue(undefined), clear: vi.fn() } as unknown as CacheService,
    makeQuota() as unknown as QuotaService,
    {
      isBlocked: vi.fn().mockResolvedValue(false),
      assertNotBlocked: vi.fn().mockResolvedValue(undefined),
    } as unknown as BlocklistService,
    { findLive: vi.fn().mockResolvedValue(null) } as unknown as RetainedEmailDbOperation,
    { resolve: vi.fn().mockResolvedValue({ country: 'GB' }) } as unknown as GeoResolver,
  );

  registrationDouble = makeRegistrationService();
  registrationDouble.start.mockResolvedValue({
    registration: makeRegistration(),
    continuationSecret: 'the-secret',
  });
  for (const method of [
    'resendOtp',
    'verifyEmail',
    'setTrustDevice',
    'setCredentials',
    'readState',
  ] as const) {
    registrationDouble[method].mockResolvedValue(makeRegistration());
  }
  registrationDouble.checkReferral.mockResolvedValue({
    registration: makeRegistration(),
    referrerUsername: null,
  });
  registrationDouble.setCountry.mockResolvedValue({
    registration: makeRegistration(),
    // A full IssuedSession: `toSessionPayload` reads the user off it, so a
    // sessionId-only stub would fail inside the mapper rather than in the code
    // this file is about.
    session: {
      sessionId: 's1',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessExpiresAt: new Date(Date.now() + 900_000),
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
      user: makePublicUser(),
    },
  });

  sessionCookies = makeSessionCookies();
  sessionCookies.read.mockReturnValue(null);
  sessionCookies.issue.mockReturnValue('csrf-1');
  sessionCookies.ensureCsrf.mockReturnValue('csrf-1');

  controller = new AuthController(
    registrationDouble as unknown as RegistrationService,
    dbDouble<never>() as unknown as LoginService,
    dbDouble<never>() as unknown as SessionService,
    dbDouble<never>() as unknown as PasswordService,
    dbDouble<never>() as unknown as OauthService,
    dbDouble<never>() as unknown as UserService,
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

/**
 * A registration that is still inside its window.
 *
 * `makeRegistration` pins `expiresAt` to `FIXED_NOW + 1h`, and `FIXED_NOW` is a
 * fixed date in the past — fine for specs that never reach the expiry check, and
 * uniformly "expired" for the ones here, which all do. The clock this is compared
 * against is the real one, so the fixture has to be too.
 */
function live(overrides: Partial<Registration> = {}): Registration {
  return makeRegistration({ expiresAt: new Date(Date.now() + 30 * 60 * 1000), ...overrides });
}

/** The registration `findByContinuationHash` will answer with, or null. */
function resolvesTo(registration: Registration | null): void {
  registrations.findByContinuationHash.mockResolvedValue(registration);
}

describe('signupId — start hands it over exactly once', () => {
  it('returns the secret in the start response', async () => {
    const result = await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies as never,
    );

    expect(result.data).toMatchObject({ signupId: 'the-secret' });
  });

  it('sets no cookie on start — the handle is the whole handover', async () => {
    await controller.register(
      { step: 'start', email: 'ada@example.test', ...CAPTCHA },
      client,
      sessionCookies as never,
    );

    // The session port is the only cookie writer the controller holds, and `start`
    // has no session to mint. Nothing else can write a Set-Cookie from here.
    expect(sessionCookies.issue).not.toHaveBeenCalled();
  });

  it('never repeats the secret on a later step', async () => {
    // `start` hands it over once. Repeating it would widen the exposure for
    // nothing — the client already has it.
    const later = await controller.register(
      { step: 'state', signupId: SIGNUP_ID },
      client,
      sessionCookies as never,
    );

    expect(JSON.stringify(later)).not.toContain('the-secret');
  });
});

describe('signupId — what it is made of', () => {
  it('is 32 bytes of base64url, so it is far past guessable', () => {
    // The DTO derives its length from `SECRET_BYTES` rather than hardcoding one,
    // so this asserts the two agree. 43 characters carry 256 bits.
    expect(CONTINUATION.SECRET_BYTES).toBe(32);
    expect(signupIdSchema.safeParse('s'.repeat(43)).success).toBe(true);
    expect(signupIdSchema.safeParse('s'.repeat(42)).success).toBe(false);
    expect(signupIdSchema.safeParse('s'.repeat(44)).success).toBe(false);
  });

  it('refuses a value outside the base64url alphabet before any lookup', () => {
    // A shape check, not a security check — the authority is the hash lookup.
    // What it buys is that junk never reaches sha256 and a database round trip.
    for (const bad of ['s'.repeat(42) + '+', 's'.repeat(42) + '/', 's'.repeat(42) + '=']) {
      expect(signupIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is resolved by its HASH, so a database dump drives no signups', async () => {
    resolvesTo(live({ state: 'OTP_VERIFIED' }));

    await service.setCredentials(SIGNUP_ID, { step: 'credentials', signupId: SIGNUP_ID, skip: true });

    // The plaintext is never the lookup key, and never appears in one.
    const [hash] = registrations.findByContinuationHash.mock.calls[0] as [string];
    expect(hash).toBe(pepperedHash(SIGNUP_ID, 'continuation'));
    expect(hash).not.toContain(SIGNUP_ID);
  });
});

describe('signupId — resolution and refusal', () => {
  it('refuses an unknown handle', async () => {
    resolvesTo(null);
    expect((await problem(service.readState(SIGNUP_ID))).type).toBe(ERR.REGISTRATION_NOT_FOUND);
  });

  it('refuses an expired registration, and retires it as it refuses', async () => {
    // Expiry is evaluated on READ rather than by a sweep, so a row that is never
    // read costs nothing and one that IS read can never be used.
    const expired = makeRegistration({ expiresAt: new Date(Date.now() - 1000) });
    resolvesTo(expired);

    expect((await problem(service.readState(SIGNUP_ID))).type).toBe(ERR.REGISTRATION_EXPIRED);
    expect(registrations.markExpired).toHaveBeenCalledWith(expired.id);
  });

  it('cannot resolve a completed registration at all', async () => {
    // `findByContinuationHash` filters `completedAt: null` in the WHERE, and
    // completion nulls the hash in the same statement that sets `completedAt`, so
    // a finished signup has nothing left to match on. This asserts the caller's
    // side of that: a spent handle is simply not found.
    resolvesTo(null);

    expect((await problem(service.readState(SIGNUP_ID))).type).toBe(ERR.REGISTRATION_NOT_FOUND);
  });

  it('gives an unknown and a superseded handle the SAME answer', async () => {
    // Distinguishing them would tell a caller whether a handle was ever valid,
    // which is the one thing a holder of a guess would like to learn. Both are
    // simply "no registration in progress".
    resolvesTo(null);
    const unknown = await problem(service.readState(SIGNUP_ID));
    resolvesTo(null);
    const superseded = await problem(service.readState(OTHER_SIGNUP_ID));

    expect(unknown.type).toBe(superseded.type);
    expect(unknown.detail).toBe(superseded.detail);
  });

  it('resolves ONE registration, and never one the caller names another way', async () => {
    // The row id is not a candidate key on this path: there is no code path from a
    // request body to `findById`. A second registration existing changes nothing
    // about which row a handle reaches.
    resolvesTo(live({ id: 'reg-mine', state: 'OTP_VERIFIED' }));

    await service.setCredentials(SIGNUP_ID, {
      step: 'credentials',
      signupId: SIGNUP_ID,
      skip: true,
    });

    // Exactly one lookup, and it went through the hash. `findById` exists on the
    // dboperation for internal callers; if a request path ever reached it, a
    // caller could select a registration by id and the whole handle would be
    // decoration.
    expect(registrations.findByContinuationHash).toHaveBeenCalledTimes(1);
    expect(registrations.findById).not.toHaveBeenCalled();
  });
});

describe('signupId — it authorises no step by itself', () => {
  /**
   * The property that separates "holding a handle" from "being allowed to do
   * this". Every case below presents a PERFECTLY VALID handle for a live
   * registration and is refused anyway, because the row is in the wrong state.
   *
   * Driven through `STEP_REQUIRES` for real — the service resolves the row and
   * consults the table, exactly as it does in production.
   */
  const ILLEGAL = [
    ['credentials before the email is verified', 'OTP_SENT', 'setCredentials'],
    ['country before credentials are set', 'OTP_VERIFIED', 'setCountry'],
    ['verify-email after the email is verified', 'CREDENTIALS_SET', 'verifyEmail'],
    ['resend-otp after the email is verified', 'OTP_VERIFIED', 'resendOtp'],
    ['trust-device before credentials are set', 'OTP_SENT', 'setTrustDevice'],
  ] as const;

  it.each(ILLEGAL)('refuses %s', async (_what, state, method) => {
    resolvesTo(live({ state }));

    const call: Record<(typeof ILLEGAL)[number][2], () => Promise<unknown>> = {
      setCredentials: () =>
        service.setCredentials(SIGNUP_ID, { step: 'credentials', signupId: SIGNUP_ID, skip: true }),
      setCountry: () =>
        service.setCountry(
          SIGNUP_ID,
          { step: 'country', signupId: SIGNUP_ID, country: 'GB' },
          client,
        ),
      verifyEmail: () =>
        service.verifyEmail(SIGNUP_ID, {
          step: 'verify-email',
          signupId: SIGNUP_ID,
          code: '123456',
        }),
      resendOtp: () => service.resendOtp(SIGNUP_ID),
      setTrustDevice: () =>
        service.setTrustDevice(SIGNUP_ID, {
          step: 'trust-device',
          signupId: SIGNUP_ID,
          trust: true,
        }),
    };

    const err = await problem(call[method]());
    expect(err.type).toBe(ERR.REGISTRATION_STEP_INVALID);
    // The state is disclosed on purpose — it is the caller's own progress, and it
    // is what lets a desynchronised client resume rather than start over.
    expect(err.extra).toMatchObject({ state });
  });

  it('discloses the state only to someone who already holds the handle', async () => {
    // The refusal above carries `state`. A caller WITHOUT a live handle gets
    // `registration_not_found` and learns nothing, so the disclosure is not a
    // probe: it costs a valid handle to obtain.
    resolvesTo(null);
    const err = await problem(
      service.setCredentials(SIGNUP_ID, { step: 'credentials', signupId: SIGNUP_ID, skip: true }),
    );

    expect(err.type).toBe(ERR.REGISTRATION_NOT_FOUND);
    expect(err.extra).toBeUndefined();
  });
});

describe('signupId — the DTO requires it on every step but start', () => {
  it('refuses a start body that carries one', async () => {
    // `.strict()`. A body arriving at `start` with a handle is a client that has
    // lost its place; silently dropping the field would open a SECOND registration
    // and return a second handle while the caller believed it was continuing.
    const err = await problem(
      controller.register(
        { step: 'start', email: 'ada@example.test', signupId: SIGNUP_ID, ...CAPTCHA },
        client,
        sessionCookies as never,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it.each([
    ['resend-otp', { step: 'resend-otp' }],
    ['verify-email', { step: 'verify-email', code: '123456' }],
    ['check-referral', { step: 'check-referral', code: 'ABCD1234' }],
    ['trust-device', { step: 'trust-device', trust: true }],
    ['credentials', { step: 'credentials', skip: true }],
    ['country', { step: 'country', country: 'GB' }],
    ['state', { step: 'state' }],
  ])('refuses %s with no signupId at all', async (_step, body) => {
    // The honest description once the value is a body field rather than a cookie
    // the browser attaches invisibly: nothing was sent, so the request is
    // malformed. `registration_not_found` would imply a lookup happened.
    const err = await problem(controller.register(body, client, sessionCookies as never));
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('passes the handle from the body straight through to the service', async () => {
    await controller.register(
      { step: 'state', signupId: SIGNUP_ID },
      client,
      sessionCookies as never,
    );

    expect(registrationDouble.readState).toHaveBeenCalledWith(SIGNUP_ID);
  });
});

describe('signupId — completion retires it and issues the real session', () => {
  it('issues the session cookies on country, and only there', async () => {
    await controller.register(
      { step: 'country', signupId: SIGNUP_ID, country: 'GB' },
      client,
      sessionCookies as never,
    );

    expect(sessionCookies.issue).toHaveBeenCalledTimes(1);
  });

  it('issues no session on any earlier step', async () => {
    for (const body of [
      { step: 'verify-email', signupId: SIGNUP_ID, code: '123456' },
      { step: 'credentials', signupId: SIGNUP_ID, skip: true },
      { step: 'trust-device', signupId: SIGNUP_ID, trust: true },
      { step: 'state', signupId: SIGNUP_ID },
    ]) {
      await controller.register(body, client, sessionCookies as never);
    }

    expect(sessionCookies.issue).not.toHaveBeenCalled();
  });

  it('has no cookie left to clear when the flow ends', async () => {
    // The old flow cleared `orebit_reg` here. There is nothing to clear now, and
    // the controller must not be reaching for a port that no longer exists.
    await controller.register(
      { step: 'country', signupId: SIGNUP_ID, country: 'GB' },
      client,
      sessionCookies as never,
    );

    expect(sessionCookies.clear).not.toHaveBeenCalled();
  });
});
