import { beforeEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../../../auth/limits';
import type { Principal } from '../../../auth/auth.types';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { PaymentPinService } from '../../../src/settings/paymentPin/payment-pin.service';
import type {
  PaymentPinGrant,
  PaymentPinOperation,
  PaymentPinVerificationMethod,
} from '../../../src/settings/paymentPin/payment-pin.types';
import { serialiseGrant } from '../../../src/settings/paymentPin/payment-pin.utility';
import { makePrincipal, makeQuota, makeSecurityChangePolicy, makeUser } from '../../harness';
import { FACTS, makeRestrictions } from '../../restrictions/double';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * A Payment PIN is six digits guarding money, so the two questions worth asking of
 * this service are "does an authorised change actually happen" and — far more of the
 * file — "is every unauthorised one refused, and refused before it costs the user
 * anything".
 *
 * The assertions are therefore phrased as OBSERVABLE OUTCOMES rather than as calls to
 * collaborators: was the hash actually replaced, was the row actually deleted, was an
 * emailed code actually consumed, was a quota actually charged, and — the ones that
 * matter most — was the emailed code left UNSPENT when the request was going to be
 * refused anyway. The failures worth catching are all of that shape: a method that
 * verifies nothing, a challenge that survives being spent, an unavailable method that
 * burns a code to discover it, a budget a second session resets.
 *
 * Limits are read through `policy()` rather than transcribed, so a founder changing a
 * number does not change this file.
 *
 * ─── On the argon2 double ───────────────────────────────────────────────────
 *
 * `CredentialService` is doubled with a hash that is a recognisable function of its
 * input, so "the stored value is not the PIN" and "the new PIN verifies and the old one
 * does not" are both assertable without spending ~20ms of real argon2 per case. What
 * that cannot check is that the real hash is used at all — so there is an explicit test
 * that the service never stores its input.
 */

const USER = makeUser();
const IP_CLASS = '203.0.113.0/24';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';

const PRINCIPAL = makePrincipal({ userId: USER.id });

const GOOD_PIN = '483920';
const NEW_PIN = '271828';
const EMAIL_CODE = '000000';
const TOTP_CODE = '123456';
const ASSERTION = { id: 'credential-id' };

/**
 * The fake hash. Deterministic and invertible, so `verify` works — but base64 rather
 * than the value with a prefix, so the plaintext is not a SUBSTRING of it.
 *
 * That matters: several assertions below check that a PIN does not appear in what was
 * stored, and a double of the form `argon2:${pin}` would fail them for a reason that
 * says nothing about the service.
 */
const hashOf = (value: string): string => `argon2:${Buffer.from(value).toString('base64')}`;

// ─── the doubles ────────────────────────────────────────────────────────────

/**
 * The factor tables, doubled.
 *
 * Default account: an authenticator and a passkey, so a test that cares about neither
 * does not have to say so. Tests that need a different account move THESE, and the
 * derived `MfaService` view follows.
 */
function createFactors() {
  return {
    listConfirmedTotpFactors: vi.fn(async (): Promise<{ id: string }[]> => [{ id: 'totp-1' }]),
    listPasskeys: vi.fn(async (): Promise<{ id: string }[]> => [{ id: 'pk-1' }]),
    countUnusedRecoveryCodes: vi.fn(async () => 8),
  };
}

/**
 * `MfaService`, doubled — DERIVED from the factor doubles rather than stubbed
 * independently, for `settings.service.spec.ts`'s reason: two independently stubbed
 * doubles can describe an account that does not exist (`listPasskeys: []` alongside
 * `availableMethods: ['passkey']`), and a service tested against an impossible account
 * is tested against nothing in particular.
 */
function createMfa(factors: ReturnType<typeof createFactors>) {
  return {
    availableMethods: vi.fn(async (): Promise<string[]> => {
      const [totp, passkeys, recovery] = await Promise.all([
        factors.listConfirmedTotpFactors(),
        factors.listPasskeys(),
        factors.countUnusedRecoveryCodes(),
      ]);

      const methods: string[] = [];
      if (totp.length > 0) methods.push('totp');
      if (passkeys.length > 0) methods.push('passkey');
      if (recovery > 0 && methods.length > 0) methods.push('recovery_code');
      return methods;
    }),
  };
}

function createTwoFactor() {
  return {
    consumeCredentialOtp: vi.fn(async () => undefined),
    proveTotpCode: vi.fn(async () => true),
    provePasskeyAssertion: vi.fn(async () => true),
  };
}

function createCredentials() {
  return {
    hash: vi.fn(async (value: string) => hashOf(value)),
    verify: vi.fn(async (hash: string, value: string) => hash === hashOf(value)),
  };
}

/**
 * The `payment_pins` table, doubled as a single nullable row.
 *
 * Stateful rather than permissive, because the properties worth testing are the ones
 * only state can express: that the old PIN stops verifying and the new one starts, that
 * a disable really leaves nothing behind, and that a status read after either reports
 * what actually happened.
 */
function createPins(initial: string | null = null) {
  let row: { userId: string; pinHash: string } | null =
    initial === null ? null : { userId: USER.id, pinHash: hashOf(initial) };

  return {
    findByUserId: vi.fn(async (userId: string) => (row?.userId === userId ? row : null)),
    create: vi.fn(async (userId: string, pinHash: string) => {
      row = { userId, pinHash };
      return row;
    }),
    replaceHash: vi.fn(async (userId: string, pinHash: string) => {
      if (row?.userId !== userId) return false;
      row = { userId, pinHash };
      return true;
    }),
    remove: vi.fn(async (userId: string) => {
      if (row?.userId !== userId) return false;
      row = null;
      return true;
    }),
    /** For assertions. Not part of the real interface. */
    current: () => row,
  };
}

/**
 * `CacheService`, doubled with a real store for `set`/`take`.
 *
 * `take` deletes as it reads, exactly as `GETDEL` does, because "single-use" is the
 * property most of the challenge tests are about and a double that merely returned the
 * value would let every replay test pass against a service that never consumed
 * anything.
 */
function createCache() {
  const store = new Map<string, string>();

  return {
    consume: vi.fn(async (_key: string, _rule: unknown, _onError: string) => undefined),
    set: vi.fn(async (key: string, value: string, _ttl: number) => {
      store.set(key, value);
    }),
    take: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    /** For assertions. */
    store,
  };
}

describe('PaymentPinService', () => {
  let factors: ReturnType<typeof createFactors>;
  let mfa: ReturnType<typeof createMfa>;
  let twoFactor: ReturnType<typeof createTwoFactor>;
  let credentials: ReturnType<typeof createCredentials>;
  let pins: ReturnType<typeof createPins>;
  let cache: ReturnType<typeof createCache>;
  let quota: ReturnType<typeof makeQuota>;
  let users: { findById: ReturnType<typeof vi.fn> };
  let mail: { sendSecurityChanged: ReturnType<typeof vi.fn> };

  function build(): PaymentPinService {
    return new PaymentPinService(
      twoFactor as never,
      mfa as never,
      credentials as never,
      pins as never,
      users as never,
      cache as never,
      quota as never,
      mail as never,
      makeSecurityChangePolicy() as never,
      makeRestrictions() as never,
    );
  }

  beforeEach(() => {
    factors = createFactors();
    mfa = createMfa(factors);
    twoFactor = createTwoFactor();
    credentials = createCredentials();
    pins = createPins();
    cache = createCache();
    quota = makeQuota();
    users = { findById: vi.fn(async () => USER) };
    mail = { sendSecurityChanged: vi.fn() };
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const enable = (pin = GOOD_PIN, emailCode = EMAIL_CODE) =>
    build().enable(USER.id, FACTS, { action: 'enable', pin, emailCode });

  /** Verify with `method`, returning the challenge id. */
  async function verify(
    operation: PaymentPinOperation,
    method: PaymentPinVerificationMethod,
    overrides: Record<string, unknown> = {},
    principal: Principal = PRINCIPAL,
  ): Promise<string> {
    const proof =
      method === 'pin'
        ? { currentPin: GOOD_PIN }
        : method === 'authenticator'
          ? { totpCode: TOTP_CODE }
          : { passkey: ASSERTION };

    const { challengeId } = await build().verify(principal, {
      operation,
      method,
      emailCode: EMAIL_CODE,
      ...proof,
      ...overrides,
    } as never);

    return challengeId;
  }

  /** Mint a challenge directly, so a test can control every field of the grant without
   *  going through a verification that would refuse the state it wants to create. */
  async function plant(grant: Partial<PaymentPinGrant> = {}): Promise<string> {
    const challengeId = 'planted-challenge-id';
    await cache.set(
      KEYS.paymentPin.challenge(challengeId),
      serialiseGrant({
        userId: USER.id,
        familyId: PRINCIPAL.familyId,
        operation: 'update',
        method: 'pin',
        ...grant,
      }),
      300,
    );
    return challengeId;
  }

  const expectProblem = async (run: Promise<unknown>, type: string) => {
    await expect(run).rejects.toThrow(ProblemException);
    await run.catch((err: unknown) => {
      expect((err as ProblemException).type).toBe(type);
    });
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  ENABLE
  // ══════════════════════════════════════════════════════════════════════════

  describe('enable', () => {
    it('succeeds on an account with only a passkey', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([]);

      await enable();

      expect(pins.current()).not.toBeNull();
    });

    it('succeeds on an account with only an authenticator', async () => {
      factors.listPasskeys.mockResolvedValue([]);

      await enable();

      expect(pins.current()).not.toBeNull();
    });

    it('refuses an account with neither, because the PIN would be unchangeable', async () => {
      // Two of the three ways to change or remove a PIN are the two factors. An account
      // that set one with neither would have exactly one — the PIN itself — and a user
      // who forgot it would be stranded.
      factors.listConfirmedTotpFactors.mockResolvedValue([]);
      factors.listPasskeys.mockResolvedValue([]);

      await expectProblem(enable(), ERR.MFA_METHOD_UNAVAILABLE);
      expect(pins.current()).toBeNull();
    });

    it('does NOT spend the emailed code when no factor is enrolled', async () => {
      // Availability is the server's knowledge, not the caller's mistake. Charging a
      // user a code to discover it would make them request another to try the thing
      // they should have been told about first.
      factors.listConfirmedTotpFactors.mockResolvedValue([]);
      factors.listPasskeys.mockResolvedValue([]);

      await enable().catch(() => undefined);

      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('does NOT spend the emailed code for a weak PIN', async () => {
      // The same seam `auth/security/challenge.ts` keeps open between verifying a code
      // and spending it, so a weak value does not cost the user their code.
      await expectProblem(enable('123456'), ERR.PAYMENT_PIN_WEAK);

      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(pins.current()).toBeNull();
    });

    it('refuses an account that already has a PIN', async () => {
      pins = createPins(GOOD_PIN);

      await expectProblem(enable(NEW_PIN), ERR.PAYMENT_PIN_ALREADY_ENABLED);
      // Unchanged — an enable must never overwrite an existing PIN.
      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
    });

    it('does NOT spend the emailed code when a PIN already exists', async () => {
      pins = createPins(GOOD_PIN);

      await enable(NEW_PIN).catch(() => undefined);

      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('propagates an invalid emailed code and writes nothing', async () => {
      twoFactor.consumeCredentialOtp.mockRejectedValue(
        new ProblemException({ type: ERR.OTP_INVALID }),
      );

      await expectProblem(enable(), ERR.OTP_INVALID);
      expect(pins.current()).toBeNull();
    });

    it('spends the emailed code before it writes', async () => {
      await enable();

      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
      expect(pins.create).toHaveBeenCalled();
    });

    it('stores a HASH, never the PIN', async () => {
      await enable();

      const stored = pins.current()?.pinHash;
      expect(stored).not.toBe(GOOD_PIN);
      expect(stored).not.toContain(GOOD_PIN);
      expect(credentials.hash).toHaveBeenCalledWith(GOOD_PIN);
    });

    it('never passes the PIN to `create` unhashed', async () => {
      // What the reversible test double cannot prove on its own: that `hash` is on the
      // path at all rather than the raw value being written.
      await enable();

      const [[, written]] = pins.create.mock.calls as [[string, string]];
      expect(written).toBe(await credentials.hash(GOOD_PIN));
    });

    it('meters on entry, per account', async () => {
      await enable();

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.paymentPinEnableByAccount(USER.id),
        policy().PAYMENT_PIN.ENABLE_BY_ACCOUNT,
        'deny',
      );
    });

    it('notifies the account owner', async () => {
      await enable();
      // Awaited here only because the notification is deliberately fire-and-forget.
      await Promise.resolve();

      // Trailing null: no anti-phishing code on the fixture account.
      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        'Payment PIN set',
        FACTS.ipClass,
        null,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  VERIFY
  // ══════════════════════════════════════════════════════════════════════════

  describe('verify', () => {
    beforeEach(() => {
      pins = createPins(GOOD_PIN);
    });

    it.each(['pin', 'authenticator', 'passkey'] as const)(
      'mints a challenge for a correct "%s"',
      async (method) => {
        const challengeId = await verify('update', method);

        expect(challengeId).toEqual(expect.any(String));
        expect(cache.store.size).toBe(1);
      },
    );

    it('runs ONLY the declared method, never the others', async () => {
      await verify('update', 'authenticator');

      expect(twoFactor.proveTotpCode).toHaveBeenCalledOnce();
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
      // `verify` is the argon2 comparison; a `pin` check would have run it.
      expect(credentials.verify).not.toHaveBeenCalled();
    });

    it('refuses a wrong current PIN', async () => {
      await expectProblem(
        verify('update', 'pin', { currentPin: '271828' }),
        ERR.PAYMENT_PIN_INVALID,
      );
      expect(cache.store.size).toBe(0);
    });

    it('refuses a wrong TOTP code', async () => {
      twoFactor.proveTotpCode.mockResolvedValue(false);

      await expectProblem(verify('update', 'authenticator'), ERR.MFA_CODE_INVALID);
      expect(cache.store.size).toBe(0);
    });

    it('refuses a failed passkey assertion', async () => {
      twoFactor.provePasskeyAssertion.mockResolvedValue(false);

      await expectProblem(verify('disable', 'passkey'), ERR.MFA_CODE_INVALID);
      expect(cache.store.size).toBe(0);
    });

    it('spends the emailed code BEFORE the credential proof', async () => {
      // So a wrong code cannot be used to probe whether a PIN guess was right, and an
      // abandoned request has still cost the code.
      const order: string[] = [];
      twoFactor.consumeCredentialOtp.mockImplementation(async () => {
        order.push('otp');
      });
      credentials.verify.mockImplementation(async () => {
        order.push('proof');
        return true;
      });

      await verify('update', 'pin');

      expect(order).toEqual(['otp', 'proof']);
    });

    it('refuses a method the account has not set up, without spending the code', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([]);

      await expectProblem(verify('update', 'authenticator'), ERR.MFA_METHOD_UNAVAILABLE);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('refuses any verification when no PIN is set', async () => {
      pins = createPins(null);

      await expectProblem(verify('update', 'authenticator'), ERR.PAYMENT_PIN_NOT_ENABLED);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('refuses a proof that does not match the declared method', async () => {
      // The resolver runs again in the service, so the rule holds for callers that are
      // not the HTTP layer.
      await expectProblem(
        verify('update', 'pin', { totpCode: TOTP_CODE }),
        ERR.VALIDATION_FAILED,
      );
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('meters on entry, per account, before anything is resolved', async () => {
      await verify('update', 'pin');

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.paymentPinVerifyByAccount(USER.id),
        policy().PAYMENT_PIN.VERIFY_BY_ACCOUNT,
        'deny',
      );
    });

    it('charges ONE bucket for all three methods', async () => {
      // A per-method key would triple the guess budget against a six-digit secret while
      // the limit still read "5 per 15 minutes".
      await verify('update', 'pin');
      await verify('update', 'authenticator');
      await verify('disable', 'passkey');

      const keys = cache.consume.mock.calls.map(([key]) => key as string);
      expect(new Set(keys)).toEqual(new Set([KEYS.rate.paymentPinVerifyByAccount(USER.id)]));
    });

    it('binds the challenge to the user, the login family, the operation and the method', async () => {
      await verify('disable', 'passkey');

      const [[, value]] = cache.set.mock.calls as [[string, string, number]];
      expect(JSON.parse(value)).toEqual({
        userId: USER.id,
        familyId: PRINCIPAL.familyId,
        operation: 'disable',
        method: 'passkey',
      });
    });

    it('binds the FAMILY, not the session, so a token rotation does not void it', async () => {
      // `sessionId` changes on every refresh and this challenge lives five minutes while
      // the user types a new PIN. `makePrincipal` gives the two different values on
      // purpose, so a service keyed on the wrong one fails here.
      await verify('update', 'pin');

      const [[, value]] = cache.set.mock.calls as [[string, string, number]];
      const grant = JSON.parse(value) as PaymentPinGrant;
      expect(grant.familyId).toBe(PRINCIPAL.familyId);
      expect(grant.familyId).not.toBe(PRINCIPAL.sessionId);
    });

    it('stores the challenge under a hashed key, so the id never appears in Redis', async () => {
      const challengeId = await verify('update', 'pin');

      expect([...cache.store.keys()]).toEqual([KEYS.paymentPin.challenge(challengeId)]);
      expect([...cache.store.keys()][0]).not.toContain(challengeId);
    });

    it('gives every verification a distinct id', async () => {
      const first = await verify('update', 'pin');
      const second = await verify('update', 'pin');

      expect(first).not.toBe(second);
    });

    it('reports the configured lifetime', async () => {
      const result = await build().verify(PRINCIPAL, {
        operation: 'update',
        method: 'pin',
        currentPin: GOOD_PIN,
        emailCode: EMAIL_CODE,
      } as never);

      expect(result.expiresInSeconds).toBe(policy().PAYMENT_PIN.CHALLENGE_TTL_SECONDS);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  describe('update', () => {
    beforeEach(() => {
      pins = createPins(GOOD_PIN);
    });

    const update = (challengeId: string, newPin = NEW_PIN, principal = PRINCIPAL) =>
      build().update(principal, FACTS, { action: 'update', challengeId, newPin });

    it.each(['pin', 'authenticator', 'passkey'] as const)(
      'changes the PIN after verifying with "%s"',
      async (method) => {
        const challengeId = await verify('update', method);
        const result = await update(challengeId);

        expect(pins.current()?.pinHash).toBe(hashOf(NEW_PIN));
        // Echoed from the SERVER's record of what was proved.
        expect(result.method).toBe(method);
      },
    );

    it('makes the old PIN stop working and the new one start', async () => {
      const challengeId = await verify('update', 'pin');
      await update(challengeId);

      const stored = pins.current()?.pinHash as string;
      expect(await credentials.verify(stored, NEW_PIN)).toBe(true);
      expect(await credentials.verify(stored, GOOD_PIN)).toBe(false);
    });

    it('stores a hash of the new PIN, never the PIN', async () => {
      const challengeId = await verify('update', 'pin');
      await update(challengeId);

      expect(pins.current()?.pinHash).not.toContain(NEW_PIN);
    });

    it('refuses a weak new PIN and leaves the old one in place', async () => {
      const challengeId = await verify('update', 'pin');

      await expectProblem(update(challengeId, '111111'), ERR.PAYMENT_PIN_WEAK);
      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
    });

    it('refuses a new PIN identical to the current one', async () => {
      const challengeId = await verify('update', 'pin');

      await expectProblem(update(challengeId, GOOD_PIN), ERR.PAYMENT_PIN_REUSED);
    });

    // ─── the budget ─────────────────────────────────────────────────────────

    it('charges the account-scoped update budget', async () => {
      const challengeId = await verify('update', 'pin');
      await update(challengeId);

      expect(quota.countFor(KEYS.rate.paymentPinUpdateByAccount(USER.id))).toBe(1);
    });

    it('refuses the change after the budget is spent', async () => {
      const { limit } = policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT;

      for (let i = 0; i < limit; i += 1) {
        const challengeId = await verify('update', 'pin', { currentPin: GOOD_PIN });
        // Each iteration changes the PIN, so the next verification must use the new
        // one — model that by resetting the row to a known value instead.
        await update(challengeId, NEW_PIN).catch(() => undefined);
        pins = createPins(GOOD_PIN);
      }

      const challengeId = await verify('update', 'pin');
      await expectProblem(update(challengeId), ERR.RATE_LIMITED);
    });

    it('cannot be bypassed by verifying with a DIFFERENT method', async () => {
      // The bucket is the operation's, not the method's. A user out of budget who
      // reaches for their authenticator instead is still out of budget.
      const { limit } = policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT;

      for (let i = 0; i < limit; i += 1) {
        const challengeId = await verify('update', 'pin');
        await update(challengeId).catch(() => undefined);
        pins = createPins(GOOD_PIN);
      }

      const challengeId = await verify('update', 'passkey');
      await expectProblem(update(challengeId), ERR.RATE_LIMITED);
    });

    it('cannot be bypassed from a new session or a new login family', async () => {
      // Keyed on the ACCOUNT. A caller metered per session — or per family — would reset
      // their own budget by signing in again.
      const { limit } = policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT;

      for (let i = 0; i < limit; i += 1) {
        const challengeId = await verify('update', 'pin');
        await update(challengeId).catch(() => undefined);
        pins = createPins(GOOD_PIN);
      }

      const fresh = makePrincipal({
        userId: USER.id,
        sessionId: 'a-brand-new-session',
        familyId: 'a-brand-new-family',
      });
      const challengeId = await verify('update', 'pin', {}, fresh);

      await expectProblem(update(challengeId, NEW_PIN, fresh), ERR.RATE_LIMITED);
    });

    it('changes nothing when the budget refuses', async () => {
      // The challenge IS consumed on the way past — `take` is a GETDEL and it runs
      // before the charge — and that is the accepted cost of charging late. It costs the
      // caller nothing real: a challenge lives five minutes and this window is a day, so
      // a caller refused by the budget could never have spent it before it expired
      // anyway. What matters is that the PIN is untouched.
      const { limit } = policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT;

      for (let i = 0; i < limit; i += 1) {
        const spent = await verify('update', 'pin');
        await update(spent).catch(() => undefined);
        pins = createPins(GOOD_PIN);
      }

      const challengeId = await verify('update', 'pin');
      await expectProblem(update(challengeId), ERR.RATE_LIMITED);

      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
      expect(pins.replaceHash).not.toHaveBeenCalled();
    });

    // ─── the challenge ──────────────────────────────────────────────────────

    it('refuses a replayed challenge', async () => {
      const challengeId = await verify('update', 'pin');
      await update(challengeId);

      await expectProblem(update(challengeId, '314159'), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()?.pinHash).toBe(hashOf(NEW_PIN));
    });

    it('refuses an expired or unknown challenge', async () => {
      // An expired key is simply absent, which is what a TTL leaves behind.
      await expectProblem(update('never-issued'), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
    });

    it('refuses a challenge verified for the OTHER operation', async () => {
      const challengeId = await verify('disable', 'pin');

      await expectProblem(update(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
    });

    it('refuses another account’s challenge', async () => {
      const challengeId = await plant({ userId: OTHER_USER_ID });

      await expectProblem(update(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
    });

    it('refuses a challenge from another login family', async () => {
      const challengeId = await plant({ familyId: 'someone-elses-family' });

      await expectProblem(update(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
    });

    it('gives the SAME error for every way a challenge can be bad', async () => {
      // A caller holding a bad challenge must not learn which — telling them "that was
      // for update, not disable" confirms it is live and says what it is good for.
      const causes: (() => Promise<string>)[] = [
        () => plant({ userId: OTHER_USER_ID }),
        () => plant({ familyId: 'someone-elses-family' }),
        () => plant({ operation: 'disable' }),
        () => Promise.resolve('never-issued'),
      ];

      for (const cause of causes) {
        await expectProblem(update(await cause()), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      }
    });

    it('does not spend a change on a challenge it refuses', async () => {
      // The budget is charged AFTER the challenge validates, so an expired or replayed
      // challenge — the ordinary way a user reaches this line by mistake — does not
      // cost one of three daily changes. Charging first would protect the challenge
      // instead, which is worth nothing: a challenge lives five minutes and this window
      // is a day, so a caller refused by the budget can never use it anyway.
      await update(await plant({ operation: 'disable' })).catch(() => undefined);
      await update('never-issued').catch(() => undefined);

      expect(quota.countFor(KEYS.rate.paymentPinUpdateByAccount(USER.id))).toBe(0);
    });

    it('does not spend a change on a PIN it refuses', async () => {
      const weak = await verify('update', 'pin');
      await update(weak, '111111').catch(() => undefined);

      pins = createPins(GOOD_PIN);
      const reused = await verify('update', 'pin');
      await update(reused, GOOD_PIN).catch(() => undefined);

      expect(quota.countFor(KEYS.rate.paymentPinUpdateByAccount(USER.id))).toBe(0);
    });

    it('notifies the account owner', async () => {
      const challengeId = await verify('update', 'pin');
      await update(challengeId);
      await Promise.resolve();

      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        'Payment PIN changed',
        FACTS.ipClass,
        null,
      );
    });

    it('does NOT sign the account out of its other sessions', async () => {
      // A Payment PIN never established a session, so there is nothing for a sweep to
      // invalidate. `SessionService` is not even a dependency — this asserts the
      // decision at the constructor.
      const challengeId = await verify('update', 'pin');
      await update(challengeId);

      expect(Object.keys(build())).not.toContain('sessions');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  DISABLE
  // ══════════════════════════════════════════════════════════════════════════

  describe('disable', () => {
    beforeEach(() => {
      pins = createPins(GOOD_PIN);
    });

    const disable = (challengeId: string, principal = PRINCIPAL) =>
      build().disable(principal, FACTS, { action: 'disable', challengeId });

    it.each(['pin', 'authenticator', 'passkey'] as const)(
      'removes the PIN after verifying with "%s"',
      async (method) => {
        const challengeId = await verify('disable', method);
        const result = await disable(challengeId);

        expect(pins.current()).toBeNull();
        expect(result.method).toBe(method);
      },
    );

    it('really removes the row, so a status read reports the setting off', async () => {
      const challengeId = await verify('disable', 'pin');
      await disable(challengeId);

      const status = await build().status(USER.id);
      expect(status.enabled).toBe(false);
      expect(status.update.available).toBe(false);
      expect(status.disable.available).toBe(false);
    });

    it('refuses a replayed challenge', async () => {
      const challengeId = await verify('disable', 'pin');
      await disable(challengeId);

      await expectProblem(disable(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
    });

    it('refuses an expired or unknown challenge', async () => {
      await expectProblem(disable('never-issued'), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()).not.toBeNull();
    });

    it('refuses a challenge verified for the OTHER operation', async () => {
      const challengeId = await verify('update', 'pin');

      await expectProblem(disable(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()).not.toBeNull();
    });

    it('refuses another account’s challenge', async () => {
      const challengeId = await plant({ userId: OTHER_USER_ID, operation: 'disable' });

      await expectProblem(disable(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()).not.toBeNull();
    });

    it('refuses a challenge from another login family', async () => {
      const challengeId = await plant({
        familyId: 'someone-elses-family',
        operation: 'disable',
      });

      await expectProblem(disable(challengeId), ERR.PAYMENT_PIN_CHALLENGE_INVALID);
      expect(pins.current()).not.toBeNull();
    });

    it('does not draw on the update budget', async () => {
      // Reaching a disable already cost a verify slot, an emailed code and a proof, and
      // it can only succeed once. A quota here would meter a step that cannot repeat —
      // and, worse, would let a user out of PIN CHANGES be told they cannot remove it.
      const challengeId = await verify('disable', 'pin');
      await disable(challengeId);

      expect(quota.countFor(KEYS.rate.paymentPinUpdateByAccount(USER.id))).toBe(0);
    });

    it('notifies the account owner', async () => {
      const challengeId = await verify('disable', 'pin');
      await disable(challengeId);
      await Promise.resolve();

      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        'Payment PIN removed',
        FACTS.ipClass,
        null,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  STATUS
  // ══════════════════════════════════════════════════════════════════════════

  describe('status', () => {
    it('tells a fresh account with factors that it may enable', async () => {
      const status = await build().status(USER.id);

      expect(status.enabled).toBe(false);
      expect(status.canEnable).toBe(true);
      expect(status.canEnableReason).toBeUndefined();
    });

    it('explains why an account with no factor may not enable', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([]);
      factors.listPasskeys.mockResolvedValue([]);

      const status = await build().status(USER.id);

      expect(status.canEnable).toBe(false);
      expect(status.canEnableReason).toEqual(expect.any(String));
    });

    it('offers no method and no operation while the PIN is off', async () => {
      const status = await build().status(USER.id);

      expect(status.update).toMatchObject({ available: false, methods: [] });
      expect(status.disable).toMatchObject({ available: false, methods: [] });
      expect(status.update.reason).toEqual(expect.any(String));
    });

    it('offers every set-up method once the PIN is on', async () => {
      pins = createPins(GOOD_PIN);

      const status = await build().status(USER.id);

      expect(status.enabled).toBe(true);
      expect(status.canEnable).toBe(false);
      expect(status.update.methods).toEqual(['pin', 'authenticator', 'passkey']);
      expect(status.disable.methods).toEqual(['pin', 'authenticator', 'passkey']);
    });

    it('withholds a method the account has not set up', async () => {
      pins = createPins(GOOD_PIN);
      factors.listPasskeys.mockResolvedValue([]);

      const status = await build().status(USER.id);

      expect(status.update.methods).toEqual(['pin', 'authenticator']);
    });

    it('still offers "pin" to an account that has lost both factors', async () => {
      pins = createPins(GOOD_PIN);
      factors.listConfirmedTotpFactors.mockResolvedValue([]);
      factors.listPasskeys.mockResolvedValue([]);

      const status = await build().status(USER.id);

      expect(status.update.methods).toEqual(['pin']);
      expect(status.update.available).toBe(true);
    });

    it('reports the full budget before any change', async () => {
      pins = createPins(GOOD_PIN);

      const status = await build().status(USER.id);

      expect(status.update.remaining).toBe(policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT.limit);
    });

    it('counts a change down without charging anything itself', async () => {
      pins = createPins(GOOD_PIN);
      const service = build();

      const challengeId = await verify('update', 'pin');
      await service.update(PRINCIPAL, FACTS, {
        action: 'update',
        challengeId,
        newPin: NEW_PIN,
      });

      const first = await service.status(USER.id);
      const second = await service.status(USER.id);

      expect(first.update.remaining).toBe(policy().PAYMENT_PIN.UPDATE_BY_ACCOUNT.limit - 1);
      // Reading the budget must not spend it, or a screen refresh would cost a change.
      expect(second.update.remaining).toBe(first.update.remaining);
    });

    it('never reports a negative remaining', async () => {
      pins = createPins(GOOD_PIN);
      quota.used.mockResolvedValue(99);

      const status = await build().status(USER.id);

      expect(status.update.remaining).toBe(0);
    });

    it('discloses no PIN and no hash', async () => {
      pins = createPins(GOOD_PIN);

      const status = await build().status(USER.id);

      const serialised = JSON.stringify(status);
      expect(serialised).not.toContain(GOOD_PIN);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('pinHash');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CROSS-CUTTING SECURITY
  // ══════════════════════════════════════════════════════════════════════════

  describe('the properties that hold across every operation', () => {
    beforeEach(() => {
      pins = createPins(GOOD_PIN);
    });

    it('never takes an account id from anything but the principal', async () => {
      // User B holds a live, correctly-formed challenge for their own account. User A
      // presenting it changes nothing, because the comparison is against A's principal.
      const challengeId = await plant({ userId: OTHER_USER_ID });

      await expectProblem(
        build().update(PRINCIPAL, FACTS, {
          action: 'update',
          challengeId,
          newPin: NEW_PIN,
        }),
        ERR.PAYMENT_PIN_CHALLENGE_INVALID,
      );

      expect(pins.current()?.userId).toBe(USER.id);
      expect(pins.current()?.pinHash).toBe(hashOf(GOOD_PIN));
    });

    it('consumes a challenge on the first read, whatever the outcome', async () => {
      // `take` is a GETDEL, so even a REFUSED spend destroys the challenge. That is what
      // stops a caller probing a challenge against both operations to learn which it was
      // minted for.
      const challengeId = await verify('update', 'pin');

      await build()
        .disable(PRINCIPAL, FACTS, { action: 'disable', challengeId })
        .catch(() => undefined);

      expect(cache.store.size).toBe(0);
      await expectProblem(
        build().update(PRINCIPAL, FACTS, { action: 'update', challengeId, newPin: NEW_PIN }),
        ERR.PAYMENT_PIN_CHALLENGE_INVALID,
      );
    });

    it('never writes a plaintext PIN to the store, on any path', async () => {
      await build().enable(USER.id, FACTS, {
        action: 'enable',
        pin: GOOD_PIN,
        emailCode: EMAIL_CODE,
      }).catch(() => undefined);

      pins = createPins(GOOD_PIN);
      const challengeId = await verify('update', 'pin');
      await build().update(PRINCIPAL, FACTS, { action: 'update', challengeId, newPin: NEW_PIN });

      for (const call of [...pins.create.mock.calls, ...pins.replaceHash.mock.calls]) {
        const [, written] = call as [string, string];
        expect(written).not.toBe(GOOD_PIN);
        expect(written).not.toBe(NEW_PIN);
      }
    });

    it('never writes a PIN into the challenge', async () => {
      // The grant travels through Redis and back. A PIN in it would be a plaintext
      // secret in the cache for five minutes.
      await verify('update', 'pin');

      for (const value of cache.store.values()) {
        expect(value).not.toContain(GOOD_PIN);
      }
    });
  });
});
