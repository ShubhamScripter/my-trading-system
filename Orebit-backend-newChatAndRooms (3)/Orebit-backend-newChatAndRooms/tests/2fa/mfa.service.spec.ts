import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginAttempt } from '@prisma/client';
import type { IdentifiedAttempt } from '../../src/2fa/2fa.types';

/**
 * The TOTP primitives are mocked, deliberately.
 *
 * RFC 6238 correctness, the step window, base32 and the AES envelope are covered
 * exhaustively by `tests/2fa/totp.spec.ts` against the spec's own vectors. What THIS
 * file is about is the accounting around a comparison — how many guesses exist, when
 * an attempt is retired, what is charged — and driving that through real crypto would
 * mean the outcome of each case depended on whether a randomly generated secret
 * happened to accept a hardcoded six digits. `verifyCode` returning `null` is exactly
 * "the code was wrong", stated directly.
 */
vi.mock('../../src/2fa/totp', () => ({
  openFactorSecret: vi.fn(() => Buffer.from('secret')),
  verifyCode: vi.fn(() => null),
}));

// Imported after the `vi.mock` call for readability only — Vitest hoists mock
// factories above every import regardless of where they appear in the file.
import { verifyCode } from '../../src/2fa/totp';
import { policy } from '../../auth/limits';
import type { ClientContext } from '../../auth/auth.types';
import { pepperedHash } from '../../auth/auth.utility';
import type { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { MfaService } from '../../src/2fa/mfa.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * MfaService — the gate between a proven first factor and a session.
 *
 * This file did not exist, and its absence is why three separate defects survived a
 * green suite: the attempt cap was off by one, the exhaustion branch was unreachable
 * dead code, and nothing compared the device finishing a ceremony against the device
 * that started it. `tests/2fa/attempt.spec.ts` tested the pure guards in isolation
 * and agreed with the implementation's own wrong threshold, so it could never have
 * noticed.
 *
 * The assertions here are therefore phrased as OBSERVABLE OUTCOMES — how many codes
 * actually get compared, whether a session may be minted — rather than as calls to
 * the helpers, which is the mistake the old suite made.
 */

// 43 base64url characters, because that is what a real handle is. The value is
// only ever hashed here, so the shape is not load-bearing for these tests — but a
// fixture that could not pass `loginIdSchema` is a fixture that quietly stops
// describing the system.
const LOGIN_ID = 'l'.repeat(43);

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

/**
 * A flow whose recorded context matches `client` above.
 *
 * Typed as `IdentifiedAttempt` — a `LoginAttempt` with a non-null `userId` —
 * because every method here takes one. `LoginAttempt.userId` became nullable when
 * the row started being created at `step:'start'`, before anyone has identified
 * themselves; `MfaService.requireAttempt` is the gate that narrows it, and
 * everything downstream of that gate is entitled to assume it has been narrowed.
 */
function attempt(overrides: Partial<LoginAttempt> = {}): IdentifiedAttempt {
  return {
    id: 'attempt-1',
    userId: 'user-1',
    tokenHash: pepperedHash(LOGIN_ID, 'mfa'),
    identifierLower: null,
    state: 'FACTOR_REQUIRED',
    attempts: 0,
    ipClass: client.ipClass,
    deviceFingerprint: client.deviceKey,
    userAgent: client.userAgent,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    completedAt: null,
    ...overrides,
  } as IdentifiedAttempt;
}

function createFactors() {
  return {
    listConfirmedTotpFactors: vi.fn().mockResolvedValue([]),
    listPasskeys: vi.fn().mockResolvedValue([]),
    countUnusedRecoveryCodes: vi.fn().mockResolvedValue(0),
    createFlow: vi.fn(),
    promoteAttempt: vi.fn().mockResolvedValue(true),
    markOtpSent: vi.fn().mockResolvedValue(true),
    findAttemptByTokenHash: vi.fn().mockResolvedValue(null),
    chargeAttempt: vi.fn(),
    expireAttempt: vi.fn().mockResolvedValue(undefined),
    completeAttempt: vi.fn().mockResolvedValue(true),
    claimTotpStep: vi.fn().mockResolvedValue(true),
    spendRecoveryCode: vi.fn().mockResolvedValue(false),
  };
}

let factors: ReturnType<typeof createFactors>;
let service: MfaService;

beforeEach(() => {
  factors = createFactors();
  service = new MfaService(factors as unknown as TwoFactorDbOperation);
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

/**
 * An account with one confirmed TOTP factor.
 *
 * The same list feeds `availableMethods` and the verify loop, which is the trap the
 * first draft of this file fell into: emptying it to model a wrong code also removed
 * `totp` from the available methods, so `proveFactor` refused with
 * `MFA_METHOD_UNAVAILABLE` before charging anything. A wrong code is modelled by
 * `verifyCode` returning null instead.
 */
function withTotp(): void {
  factors.listConfirmedTotpFactors.mockResolvedValue([
    {
      id: 'totp-1',
      userId: 'user-1',
      secretCiphertext: new Uint8Array([1]),
      secretIv: new Uint8Array([2]),
      secretTag: new Uint8Array([3]),
    },
  ]);
}

/** The next comparison misses. */
function codeIsWrong(): void {
  vi.mocked(verifyCode).mockReturnValue(null);
}

describe('MfaService.requireAttempt — the ceremony must finish where it started', () => {
  it('resolves an attempt presented from the same device and network', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    await expect(service.requireAttempt(LOGIN_ID, client)).resolves.toMatchObject({
      id: 'attempt-1',
    });
  });

  it('looks the attempt up by a PEPPERED HASH, never the raw token', async () => {
    // A database dump must not be usable to finish somebody else's sign-in.
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());
    await service.requireAttempt(LOGIN_ID, client);

    const [arg] = factors.findAttemptByTokenHash.mock.calls[0] as [string];
    expect(arg).not.toContain(LOGIN_ID);
    expect(arg).toBe(pepperedHash(LOGIN_ID, 'mfa'));
  });

  it('refuses a different device cookie', async () => {
    // The attack: a leaked `mfaToken` plus a phished code, redeemed from another
    // browser. Before this check the session was minted with the VICTIM's device
    // identity, inheriting their trusted-device window and suppressing their
    // new-device email.
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    const err = await problem(
      service.requireAttempt(LOGIN_ID, { ...client, deviceKey: 'b'.repeat(64) }),
    );
    expect(err.type).toBe(ERR.MFA_CONTEXT_MISMATCH);
  });

  it('refuses a different network class', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    const err = await problem(
      service.requireAttempt(LOGIN_ID, { ...client, ipClass: '198.51.100.0/24' }),
    );
    expect(err.type).toBe(ERR.MFA_CONTEXT_MISMATCH);
  });

  it('accepts address movement WITHIN the same class', async () => {
    // The false positive this design exists to avoid: a mobile client's exact address
    // changes constantly inside one carrier block, so only the prefix is compared.
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    await expect(
      service.requireAttempt(LOGIN_ID, { ...client, ip: '203.0.113.199' }),
    ).resolves.toBeTruthy();
  });

  it('does NOT retire the attempt on a context mismatch', async () => {
    // Deliberate, matching `OauthService.assertSameNetwork`: retiring would let
    // anyone holding a token kill a victim's in-flight ceremony. It expires on its
    // own in ten minutes.
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    await problem(service.requireAttempt(LOGIN_ID, { ...client, deviceKey: 'c'.repeat(64) }));
    expect(factors.expireAttempt).not.toHaveBeenCalled();
  });

  it('refuses an unknown token before looking at any context', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(null);

    const err = await problem(service.requireAttempt(LOGIN_ID, client));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('refuses a spent attempt as invalid rather than as a context mismatch', async () => {
    // Ordering: liveness is checked before context, so a replayed token reports the
    // replay rather than blaming the network.
    factors.findAttemptByTokenHash.mockResolvedValue(
      attempt({ state: 'COMPLETED', deviceFingerprint: 'z'.repeat(64) }),
    );

    const err = await problem(service.requireAttempt(LOGIN_ID, client));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });
});

describe('MfaService.proveFactor — how many guesses actually exist', () => {
  /**
   * The regression this describe block exists for. `chargeAttempt` returns the
   * POST-increment count, and the guard used to refuse at `>= MAX` — so request MAX
   * was refused before its code was ever compared, giving four usable guesses out of
   * a configured five, and a correct fifth code failed.
   */

  function proving(code = '000000') {
    return service.proveFactor({ loginId: LOGIN_ID, method: 'totp', code, client });
  }

  beforeEach(() => {
    withTotp();
    codeIsWrong();
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());
    factors.countUnusedRecoveryCodes.mockResolvedValue(0);
  });

  it('compares the code on every attempt from 1 through policy().MFA.PROOF_ATTEMPTS', async () => {
    // Drive the counter the way the database would, and count which requests actually
    // reached a comparison. `verifyCode` being called IS "the code was compared", so
    // this measures the thing the old suite never asked about.
    const compared: number[] = [];

    for (let n = 1; n <= policy().MFA.PROOF_ATTEMPTS + 1; n += 1) {
      factors.chargeAttempt.mockResolvedValue(n);
      vi.mocked(verifyCode).mockClear();

      await problem(proving());
      if (vi.mocked(verifyCode).mock.calls.length > 0) compared.push(n);
    }

    expect(compared).toEqual(Array.from({ length: policy().MFA.PROOF_ATTEMPTS }, (_, i) => i + 1));
  });

  it('refuses the attempt AFTER the cap without comparing anything', async () => {
    factors.chargeAttempt.mockResolvedValue(policy().MFA.PROOF_ATTEMPTS + 1);

    const err = await problem(proving());
    expect(err.type).toBe(ERR.MFA_ATTEMPTS_EXHAUSTED);
    // Never reached the comparison: the availability lookup ran, but no step claim.
    expect(factors.claimTotpStep).not.toHaveBeenCalled();
  });

  it('retires the attempt on the last wrong guess — the branch that was dead', async () => {
    // `expireAttempt` was previously unreachable: its condition could only hold when
    // the guard had already thrown. So an exhausted attempt lingered as
    // FACTOR_REQUIRED for its full ten minutes, which is the dead row the code's own
    // comment claimed to prevent.
    factors.chargeAttempt.mockResolvedValue(policy().MFA.PROOF_ATTEMPTS);

    const err = await problem(proving());

    expect(err.type).toBe(ERR.MFA_ATTEMPTS_EXHAUSTED);
    expect(factors.expireAttempt).toHaveBeenCalledWith('attempt-1');
  });

  it('does not retire while guesses remain, and reports how many', async () => {
    factors.chargeAttempt.mockResolvedValue(2);

    const err = await problem(proving());

    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
    expect(err.extra).toMatchObject({ attemptsRemaining: policy().MFA.PROOF_ATTEMPTS - 2 });
    expect(factors.expireAttempt).not.toHaveBeenCalled();
  });

  it('charges the guess BEFORE comparing, so an abandoned request still spends one', async () => {
    factors.chargeAttempt.mockResolvedValue(1);

    await problem(proving());
    expect(factors.chargeAttempt).toHaveBeenCalledWith('attempt-1');
  });

  it('does not charge a guess for naming a method the account does not have', async () => {
    // A client mistake, not an attempt at a credential.
    factors.listConfirmedTotpFactors.mockResolvedValue([]);
    factors.listPasskeys.mockResolvedValue([]);
    factors.countUnusedRecoveryCodes.mockResolvedValue(0);
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    const err = await problem(proving());

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(factors.chargeAttempt).not.toHaveBeenCalled();
  });

  it('checks the context before charging anything', async () => {
    // A mismatched device must not cost the legitimate user a guess.
    withTotp();
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    const err = await problem(
      service.proveFactor({
        loginId: LOGIN_ID,
        method: 'totp',
        code: '000000',
        client: { ...client, deviceKey: 'd'.repeat(64) },
      }),
    );

    expect(err.type).toBe(ERR.MFA_CONTEXT_MISMATCH);
    expect(factors.chargeAttempt).not.toHaveBeenCalled();
  });
});

describe('MfaService.completeProven — one proof, one session', () => {
  it('returns the attempt when it wins the swap', async () => {
    factors.completeAttempt.mockResolvedValue(true);

    await expect(service.completeProven(attempt(), 'totp')).resolves.toMatchObject({
      method: 'totp',
    });
  });

  it('treats a lost swap as a failed verification', async () => {
    // The alternative is two sessions from one proof.
    factors.completeAttempt.mockResolvedValue(false);

    const err = await problem(service.completeProven(attempt(), 'totp'));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });
});

describe('MfaService.availableMethods and hasFactor', () => {
  it('never offers recovery codes as the only method', async () => {
    // An account holding nothing but codes has no second factor to recover, so
    // offering them would be a way in that cannot legitimately exist.
    factors.countUnusedRecoveryCodes.mockResolvedValue(10);

    await expect(service.availableMethods('user-1')).resolves.toEqual([]);
    await expect(service.hasFactor('user-1')).resolves.toBe(false);
  });

  it('offers recovery codes alongside a real factor', async () => {
    withTotp();
    factors.countUnusedRecoveryCodes.mockResolvedValue(3);

    await expect(service.availableMethods('user-1')).resolves.toEqual([
      'totp',
      'recovery_code',
    ]);
  });

  it('omits recovery codes once every one is spent', async () => {
    withTotp();
    factors.countUnusedRecoveryCodes.mockResolvedValue(0);

    await expect(service.availableMethods('user-1')).resolves.toEqual(['totp']);
  });

  it('reports no factor for an account with nothing enrolled', async () => {
    await expect(service.hasFactor('user-1')).resolves.toBe(false);
  });
});

/**
 * ─── What this block asserts now, and why it inverted ──────────────────────
 *
 * It used to check that `challengeFor` MINTED a handle: that it stored only the
 * hash, and that two calls produced two different tokens. Both were the right
 * tests for a method that created its own row.
 *
 * It no longer creates one. The caller arrives holding a flow opened at
 * `step:'start'`, and the client already has the handle naming it — so the
 * property worth pinning down is the opposite one: that NO second handle appears,
 * and that the existing row is promoted in place. A test asserting "mints a
 * different token every time" would now be asserting a seam back into existence.
 */
describe('MfaService.challengeFor', () => {
  const flow = () => attempt({ state: 'STARTED', userId: null });

  it('answers null for an account with nothing enrolled, so 2FA stays opt-in', async () => {
    await expect(service.challengeFor(flow(), 'user-1', 'STARTED')).resolves.toBeNull();
    expect(factors.promoteAttempt).not.toHaveBeenCalled();
  });

  it('mints no second handle — it promotes the flow the caller already has', async () => {
    withTotp();

    const challenge = await service.challengeFor(flow(), 'user-1', 'STARTED');

    expect(factors.createFlow).not.toHaveBeenCalled();
    // The returned challenge describes what to prove and by when, and carries no
    // credential of its own. The client continues with the `loginId` it holds.
    expect(challenge).not.toHaveProperty('mfaToken');
    expect(challenge).not.toHaveProperty('loginId');
    expect(Object.keys(challenge ?? {}).sort()).toEqual(['expiresAt', 'methods']);
  });

  it('attaches the account and advances the state under a compare-and-swap', async () => {
    withTotp();

    await service.challengeFor(flow(), 'user-1', 'STARTED');

    expect(factors.promoteAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'attempt-1',
        userId: 'user-1',
        from: 'STARTED',
        to: 'FACTOR_REQUIRED',
      }),
    );
  });

  it('re-stamps the expiry once, so the ceremony gets its own budget', async () => {
    // The flow's clock started at `step:'start'`, possibly most of
    // LOGIN_FLOW.TTL_SECONDS ago while the user typed a password. Without this the
    // second factor would inherit whatever was left.
    withTotp();

    const before = Date.now();
    const challenge = await service.challengeFor(flow(), 'user-1', 'STARTED');
    const [input] = factors.promoteAttempt.mock.calls[0] as [{ expiresAt: Date }];

    expect(input.expiresAt.getTime()).toBeGreaterThan(before);
    expect(challenge?.expiresAt).toEqual(input.expiresAt);
  });

  it('refuses when it loses the swap, rather than proceeding', async () => {
    // Something else advanced this flow between the caller resolving it and here.
    // Proceeding would mean two ceremonies against one row.
    withTotp();
    factors.promoteAttempt.mockResolvedValue(false);

    const err = await problem(service.challengeFor(flow(), 'user-1', 'STARTED'));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });
});

/**
 * The state gate on the second factor.
 *
 * `requireAttempt` is the single door into `POST /auth/2fa/verify`, so this is
 * where "MFA cannot be bypassed" is actually enforced — a handle from a flow that
 * has not proven a first factor must not reach a factor step.
 */
describe('MfaService.requireAttempt — FACTOR_REQUIRED and nothing else', () => {
  it.each(['STARTED', 'OTP_SENT'] as const)(
    'refuses a live flow still at %s',
    async (state) => {
      factors.findAttemptByTokenHash.mockResolvedValue(attempt({ state, userId: null }));

      const err = await problem(service.requireAttempt(LOGIN_ID, client));
      expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
    },
  );

  it('accepts a flow that has proven a first factor', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(attempt());

    await expect(service.requireAttempt(LOGIN_ID, client)).resolves.toMatchObject({
      id: 'attempt-1',
      userId: 'user-1',
    });
  });

  it('refuses a FACTOR_REQUIRED row with no account attached', async () => {
    // Unreachable through `promoteAttempt`, which writes the state and the id in
    // one statement. Refused anyway: the alternative is a downstream null that
    // nothing checked.
    factors.findAttemptByTokenHash.mockResolvedValue(attempt({ userId: null }));

    const err = await problem(service.requireAttempt(LOGIN_ID, client));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('refuses an unknown handle', async () => {
    factors.findAttemptByTokenHash.mockResolvedValue(null);

    const err = await problem(service.requireAttempt(LOGIN_ID, client));
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
  });
});
