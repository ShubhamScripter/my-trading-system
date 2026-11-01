import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MFA } from '../../auth/auth.constants';
import { MfaService } from '../../auth/services/mfa.service';
import {
  base32Decode,
  generate,
  generateSecret,
  sealSecret,
  stepFor,
} from '../../auth/security/totp';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { FIXED_NOW, makeAdmin, makeAttempt, makePasskey, makeTotpFactor } from '../harness';

/**
 * MfaService, against doubled persistence.
 *
 * The three properties worth asserting here are the ones a reviewer would want
 * proof of: the downgrade guard, the replay defence, and that a session is only
 * ever minted AFTER the attempt is successfully closed.
 */

/**
 * ═══ THE CLOCK IS FROZEN, AND IT HAS TO BE ═════════════════════════════════
 *
 * `liveTotp` generates a code for `stepFor()` and the service verifies it against
 * `new Date()` a few statements later. Those are two separate reads of the clock,
 * and `TOTP.WINDOW` is 0 — so a step boundary falling between them makes the code
 * expired by the time it is checked, and the spec fails for a reason that has
 * nothing to do with what it is testing.
 *
 * That was survivable under the old ±1-step window, which absorbed exactly this.
 * With no window the flake is real, roughly one run in a few hundred, and it would
 * land on whichever spec happened to be unlucky. Freezing removes it entirely.
 *
 * `FIXED_NOW` rather than an arbitrary instant, for two reasons: it is what the
 * harness stamps into `createdAt`/`confirmedAt`, so fixtures and "now" agree; and
 * it is midnight-aligned UTC, so its epoch second divides by `STEP_SECONDS` exactly
 * and every code here sits at the START of its step with a full 30 seconds of
 * headroom.
 *
 * `toFake: ['Date']` and not the whole timer suite — the doubles resolve real
 * promises, and hijacking `setTimeout` here would buy nothing and risk a hang.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

/** A real sealed secret plus a matching live code, so TOTP verification runs for
 *  real rather than through a stubbed comparison. */
function liveTotp() {
  const secret = generateSecret();
  const sealed = sealSecret(secret);
  return {
    secret,
    code: generate(secret, stepFor()),
    factorFields: {
      secretCiphertext: new Uint8Array(sealed.ciphertext),
      secretIv: new Uint8Array(sealed.iv),
      secretTag: new Uint8Array(sealed.tag),
    },
  };
}

interface Doubles {
  admins: Record<string, ReturnType<typeof vi.fn>>;
  attempts: Record<string, ReturnType<typeof vi.fn>>;
  mfa: Record<string, ReturnType<typeof vi.fn>>;
  sessions: Record<string, ReturnType<typeof vi.fn>>;
  cache: Record<string, ReturnType<typeof vi.fn>>;
  mail: Record<string, ReturnType<typeof vi.fn>>;
}

function build(overrides: Partial<Doubles> = {}) {
  const admin = makeAdmin();

  const doubles: Doubles = {
    admins: {
      findById: vi.fn().mockResolvedValue(admin),
      markMfaEnrolled: vi.fn().mockResolvedValue(undefined),
      ...overrides.admins,
    },
    attempts: {
      incrementMfaAttempts: vi.fn().mockResolvedValue(1),
      complete: vi.fn().mockResolvedValue(true),
      ...overrides.attempts,
    },
    mfa: {
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findPendingTotp: vi.fn().mockResolvedValue(null),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      startTotpEnrollment: vi.fn().mockResolvedValue(makeTotpFactor({ confirmedAt: null })),
      confirmTotp: vi.fn().mockResolvedValue(true),
      claimTotpStep: vi.fn().mockResolvedValue(true),
      listPasskeys: vi.fn().mockResolvedValue([]),
      findPasskeyByCredentialId: vi.fn().mockResolvedValue(null),
      createPasskey: vi.fn().mockResolvedValue(makePasskey()),
      recordPasskeyUse: vi.fn().mockResolvedValue(undefined),
      ...overrides.mfa,
    },
    sessions: {
      issue: vi.fn().mockResolvedValue({ sessionId: 's1', accessToken: 'a', refreshToken: 'r' }),
      ...overrides.sessions,
    },
    cache: {
      set: vi.fn().mockResolvedValue(undefined),
      take: vi.fn().mockResolvedValue(null),
      ...overrides.cache,
    },
    mail: {
      sendSecurityChanged: vi.fn().mockResolvedValue(undefined),
      ...overrides.mail,
    },
  };

  const service = new MfaService(
    doubles.admins as never,
    doubles.attempts as never,
    doubles.mfa as never,
    doubles.sessions as never,
    doubles.cache as never,
    doubles.mail as never,
  );

  return { service, doubles, admin };
}

async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

describe('enrollment status', () => {
  it('needs enrollment only when there are no confirmed factors at all', async () => {
    const none = build({ mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }) } });
    expect((await none.service.enrollmentState('a')).needsEnrollment).toBe(true);

    const totp = build({ mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }) } });
    expect((await totp.service.enrollmentState('a')).needsEnrollment).toBe(false);

    const passkey = build({ mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 1 }) } });
    expect((await passkey.service.enrollmentState('a')).needsEnrollment).toBe(false);
  });

  it('reports only the methods actually enrolled', async () => {
    const both = build({ mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 2, passkey: 3 }) } });
    expect((await both.service.enrollmentState('a')).methods).toEqual(['TOTP', 'PASSKEY']);

    const only = build({ mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 1 }) } });
    expect((await only.service.enrollmentState('a')).methods).toEqual(['PASSKEY']);
  });

  /**
   * The point of folding the two questions into one method: `verify-email` and
   * `state` asked both in a row, and each used to run its own pair of COUNT
   * queries. Four reads to answer one question about one admin.
   */
  it('reads the factor counts ONCE to answer both questions', async () => {
    const counts = vi.fn().mockResolvedValue({ totp: 1, passkey: 1 });
    const { service } = build({ mfa: { confirmedFactorCounts: counts } });

    const state = await service.enrollmentState('a');

    expect(counts).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ needsEnrollment: false, methods: ['TOTP', 'PASSKEY'] });
  });
});

describe('═══ THE DOWNGRADE GUARD ═══', () => {
  /**
   * Without this, anyone holding a step-up token — which is to say anyone who
   * stole a password and could read the email — could enroll an authenticator they
   * control and walk straight past the factor the real admin owns. The second
   * factor would become a formality.
   */
  it('refuses totp-enroll when a TOTP factor is already confirmed', async () => {
    const { service, admin } = build({
      mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }) },
    });
    expect(await slugOf(() => service.totpEnroll(admin))).toBe(ERR.MFA_ALREADY_ENROLLED);
  });

  /** Cross-factor: a confirmed PASSKEY also blocks TOTP enrollment. Guarding only
   *  the same factor type would leave the obvious way around it open. */
  it('refuses totp-enroll when a PASSKEY is already registered', async () => {
    const { service, admin } = build({
      mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 1 }) },
    });
    expect(await slugOf(() => service.totpEnroll(admin))).toBe(ERR.MFA_ALREADY_ENROLLED);
  });

  /** And the mirror image: a confirmed TOTP blocks passkey REGISTRATION. */
  it('refuses passkey registration when a TOTP factor is already confirmed', async () => {
    const { service, admin } = build({
      mfa: {
        listPasskeys: vi.fn().mockResolvedValue([]),
        confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }),
      },
    });
    expect(
      await slugOf(() => service.passkeyChallenge(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }))),
    ).toBe(ERR.MFA_ALREADY_ENROLLED);
  });

  /**
   * The guard counts CONFIRMED factors from the factor tables, never
   * `Admin.mfaEnrolledAt`. That column is a denormalised convenience, and letting
   * a security decision depend on it would mean a stale value could widen what
   * enrollment is allowed to do.
   */
  it('ignores a stale mfaEnrolledAt and trusts the factor count', async () => {
    const { service } = build({
      mfa: { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }) },
    });
    // The column claims enrolled; the tables say otherwise. Enrollment proceeds.
    const enrolled = makeAdmin({ mfaEnrolledAt: new Date() });
    await expect(service.totpEnroll(enrolled)).resolves.toMatchObject({
      secret: expect.any(String),
      uri: expect.stringContaining('otpauth://'),
    });
  });

  it('allows enrollment when there is genuinely nothing enrolled', async () => {
    const { service, admin, doubles } = build();
    const result = await service.totpEnroll(admin);
    expect(result.uri).toContain('otpauth://totp/');
    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(doubles.mfa['startTotpEnrollment']).toHaveBeenCalledOnce();
  });

  /** The stored secret must be the SEALED one — never plaintext at rest. */
  it('stores the secret encrypted, not in the clear', async () => {
    const { service, admin, doubles } = build();
    const { secret } = await service.totpEnroll(admin);

    const stored = doubles.mfa['startTotpEnrollment']?.mock.calls[0]?.[0] as {
      sealed: { ciphertext: Buffer };
    };
    // The ciphertext must not equal the raw secret bytes.
    expect(Buffer.from(stored.sealed.ciphertext).equals(base32Decode(secret))).toBe(false);
  });
});

describe('totpVerify — authentication', () => {
  function withConfirmedFactor(overrides: Partial<Doubles> = {}) {
    const live = liveTotp();
    const factor = makeTotpFactor({ ...live.factorFields, confirmedAt: new Date() });
    const built = build({
      ...overrides,
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(null),
        findConfirmedTotp: vi.fn().mockResolvedValue(factor),
        confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }),
        claimTotpStep: vi.fn().mockResolvedValue(true),
        ...overrides.mfa,
      },
    });
    return { ...built, code: live.code, factor };
  }

  it('issues a session for a correct code', async () => {
    const { service, admin, code, doubles } = withConfirmedFactor();
    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx());
    expect(doubles.sessions['issue']).toHaveBeenCalledOnce();
    expect(doubles.sessions['issue']?.mock.calls[0]?.[1]).toBe('TOTP');
  });

  it('rejects a wrong code and reports the guesses remaining', async () => {
    const { service, admin } = withConfirmedFactor();
    try {
      await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), '000000', ctx());
      expect.unreachable('should have thrown');
    } catch (err) {
      const problem = err as ProblemException;
      expect(problem.type).toBe(ERR.TOTP_INVALID);
      expect(problem.extra).toEqual({ attemptsRemaining: MFA.MAX_ATTEMPTS - 1 });
    }
  });

  /**
   * ═══ THE REPLAY DEFENCE ════════════════════════════════════════════════════
   *
   * `claimTotpStep` puts the comparison in the WHERE clause, so a losing caller
   * gets `count === 0`. This asserts that losing it produces a REFUSAL rather than
   * a session — a correct code that something else already spent must not mint a
   * second one.
   */
  it('refuses a code whose time step was already claimed', async () => {
    const { service, admin, code, doubles } = withConfirmedFactor({
      mfa: { claimTotpStep: vi.fn().mockResolvedValue(false) },
    });
    expect(
      await slugOf(() =>
        service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx()),
      ),
    ).toBe(ERR.TOTP_REPLAYED);
    expect(doubles.sessions['issue']).not.toHaveBeenCalled();
  });

  /** The attempt counter is charged BEFORE the code is compared, so an abandoned
   *  request still costs a guess and a caller cannot race for unlimited tries. */
  it('charges an attempt before comparing the code', async () => {
    const { service, admin, doubles } = withConfirmedFactor();
    await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), '000000', ctx()),
    );
    expect(doubles.attempts['incrementMfaAttempts']).toHaveBeenCalledOnce();
  });

  it('refuses once the attempt cap is exhausted', async () => {
    const { service, admin, code } = withConfirmedFactor({
      attempts: {
        incrementMfaAttempts: vi.fn().mockResolvedValue(MFA.MAX_ATTEMPTS + 1),
        complete: vi.fn().mockResolvedValue(true),
      },
    });
    expect(
      await slugOf(() =>
        service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx()),
      ),
    ).toBe(ERR.MFA_ATTEMPTS_EXHAUSTED);
  });

  it('refuses when no factor is enrolled at all', async () => {
    const { service, admin } = build({
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(null),
        findConfirmedTotp: vi.fn().mockResolvedValue(null),
      },
    });
    expect(
      await slugOf(() =>
        service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), '123456', ctx()),
      ),
    ).toBe(ERR.MFA_NOT_ENROLLED);
  });
});

describe('totpVerify — enrollment confirmation', () => {
  function withPendingFactor(overrides: Partial<Doubles> = {}) {
    const live = liveTotp();
    const pending = makeTotpFactor({ ...live.factorFields, confirmedAt: null });
    const built = build({
      ...overrides,
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(pending),
        confirmTotp: vi.fn().mockResolvedValue(true),
        ...overrides.mfa,
      },
    });
    return { ...built, code: live.code };
  }

  /** A pending factor means this call is enrollment confirmation, resolved from
   *  SERVER state — the request body is identical either way. */
  it('confirms the pending factor and issues a session', async () => {
    const { service, admin, code, doubles } = withPendingFactor();
    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx());

    expect(doubles.mfa['confirmTotp']).toHaveBeenCalledOnce();
    expect(doubles.admins['markMfaEnrolled']).toHaveBeenCalledOnce();
    expect(doubles.sessions['issue']).toHaveBeenCalledOnce();
  });

  /** The confirmation records the matched step, which is what ARMS the replay
   *  defence for every subsequent sign-in. */
  it('records the matched time step as it confirms', async () => {
    const { service, admin, code, doubles } = withPendingFactor();
    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx());
    const [, step] = doubles.mfa['confirmTotp']?.mock.calls[0] as [string, bigint];
    expect(typeof step).toBe('bigint');
    expect(step).toBe(stepFor());
  });

  /** An attacker who reaches enrollment must not do it silently. */
  it('emails a security notification', async () => {
    const { service, admin, code, doubles } = withPendingFactor();
    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx());
    expect(doubles.mail['sendSecurityChanged']).toHaveBeenCalledOnce();
  });

  /** Losing the confirm CAS means something else enrolled first — the unique
   *  partial index would refuse a second confirmed factor anyway. */
  it('refuses when the confirmation swap is lost', async () => {
    const { service, admin, code } = withPendingFactor({
      mfa: { confirmTotp: vi.fn().mockResolvedValue(false) },
    });
    expect(
      await slugOf(() =>
        service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), code, ctx()),
      ),
    ).toBe(ERR.MFA_ALREADY_ENROLLED);
  });

  it('rejects a wrong code without confirming anything', async () => {
    const { service, admin, doubles } = withPendingFactor();
    await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), '000000', ctx()),
    );
    expect(doubles.mfa['confirmTotp']).not.toHaveBeenCalled();
    expect(doubles.sessions['issue']).not.toHaveBeenCalled();
  });
});

describe('completing the attempt', () => {
  /**
   * The session is minted only AFTER the attempt is successfully closed. Reversing
   * those two would let a lost race still hand out tokens — two requests could each
   * complete the ceremony from one attempt.
   */
  it('issues no session when the attempt cannot be closed', async () => {
    const live = liveTotp();
    const { service, admin, doubles } = build({
      attempts: {
        incrementMfaAttempts: vi.fn().mockResolvedValue(1),
        complete: vi.fn().mockResolvedValue(false),
      },
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(null),
        findConfirmedTotp: vi
          .fn()
          .mockResolvedValue(makeTotpFactor({ ...live.factorFields, confirmedAt: new Date() })),
        claimTotpStep: vi.fn().mockResolvedValue(true),
      },
    });

    expect(
      await slugOf(() =>
        service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), live.code, ctx()),
      ),
    ).toBe(ERR.STEP_UP_INVALID);
    expect(doubles.sessions['issue']).not.toHaveBeenCalled();
  });

  /**
   * The admin row is re-read before minting. The copy passed in was loaded before
   * `markMfaEnrolled` ran, so minting from it would report `mfaEnrolled: false` to
   * the very admin who just enrolled.
   */
  it('re-reads the admin so a fresh enrollment is reflected in the session', async () => {
    const live = liveTotp();
    const stale = makeAdmin({ mfaEnrolledAt: null });
    const fresh = makeAdmin({ mfaEnrolledAt: new Date() });

    const { service, doubles } = build({
      admins: {
        findById: vi.fn().mockResolvedValue(fresh),
        markMfaEnrolled: vi.fn().mockResolvedValue(undefined),
      },
      mfa: {
        findPendingTotp: vi
          .fn()
          .mockResolvedValue(makeTotpFactor({ ...live.factorFields, confirmedAt: null })),
        confirmTotp: vi.fn().mockResolvedValue(true),
      },
    });

    await service.totpVerify(stale, makeAttempt({ state: 'EMAIL_VERIFIED' }), live.code, ctx());
    expect(doubles.sessions['issue']?.mock.calls[0]?.[0]).toBe(fresh);
  });
});

describe('passkey challenge — the server decides the mode', () => {
  it('chooses "register" when there are no passkeys', async () => {
    const { service, admin, doubles } = build({ mfa: { listPasskeys: vi.fn().mockResolvedValue([]) } });
    const result = await service.passkeyChallenge(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }));
    expect(result.mode).toBe('register');
    // And the mode is STORED, so verification reads it back rather than trusting
    // the request.
    const stored = doubles.cache['set']?.mock.calls[0]?.[1] as string;
    expect(JSON.parse(stored)).toMatchObject({ mode: 'register' });
  });

  it('chooses "authenticate" when passkeys exist', async () => {
    const { service, admin, doubles } = build({
      mfa: {
        listPasskeys: vi.fn().mockResolvedValue([makePasskey()]),
        confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 1 }),
      },
    });
    const result = await service.passkeyChallenge(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }));
    expect(result.mode).toBe('authenticate');
    const stored = doubles.cache['set']?.mock.calls[0]?.[1] as string;
    expect(JSON.parse(stored)).toMatchObject({ mode: 'authenticate' });
  });

  it('returns options carrying a challenge', async () => {
    const { service, admin } = build();
    const result = await service.passkeyChallenge(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }));
    expect(typeof result.options['challenge']).toBe('string');
  });
});

describe('passkey verify — the stored mode governs', () => {
  /** No challenge in the cache: expired, already spent, or never issued. All the
   *  same answer. */
  it('refuses when no challenge was stored', async () => {
    const { service, admin } = build({ cache: { take: vi.fn().mockResolvedValue(null) } });
    expect(
      await slugOf(() =>
        service.passkeyVerify(
          admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          { id: 'x' } as never,
          ctx(),
        ),
      ),
    ).toBe(ERR.PASSKEY_CHALLENGE_INVALID);
  });

  it('refuses a malformed challenge record', async () => {
    const { service, admin } = build({ cache: { take: vi.fn().mockResolvedValue('not json') } });
    expect(
      await slugOf(() =>
        service.passkeyVerify(
          admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          { id: 'x' } as never,
          ctx(),
        ),
      ),
    ).toBe(ERR.PASSKEY_CHALLENGE_INVALID);
  });

  /**
   * ═══ CROSS-ACCOUNT ASSERTION ═══════════════════════════════════════════════
   *
   * A passkey belonging to a DIFFERENT admin must not satisfy this admin's
   * step-up token. Without the ownership comparison, one admin could complete
   * another's half-finished sign-in with their own key.
   */
  it("refuses a passkey that belongs to another admin", async () => {
    const { service, admin } = build({
      cache: {
        take: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ mode: 'authenticate', challenge: 'abc' })),
      },
      mfa: {
        findPasskeyByCredentialId: vi
          .fn()
          .mockResolvedValue(makePasskey({ adminId: 'someone-else' })),
      },
    });
    expect(
      await slugOf(() =>
        service.passkeyVerify(
          admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          { id: 'dGVzdC1jcmVkZW50aWFsLWlk' } as never,
          ctx(),
        ),
      ),
    ).toBe(ERR.PASSKEY_VERIFICATION_FAILED);
  });

  it('refuses an unknown credential id', async () => {
    const { service, admin } = build({
      cache: {
        take: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ mode: 'authenticate', challenge: 'abc' })),
      },
      mfa: { findPasskeyByCredentialId: vi.fn().mockResolvedValue(null) },
    });
    expect(
      await slugOf(() =>
        service.passkeyVerify(
          admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          { id: 'unknown' } as never,
          ctx(),
        ),
      ),
    ).toBe(ERR.PASSKEY_VERIFICATION_FAILED);
  });
});
