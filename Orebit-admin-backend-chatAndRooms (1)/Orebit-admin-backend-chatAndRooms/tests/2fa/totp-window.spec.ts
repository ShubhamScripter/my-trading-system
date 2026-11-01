import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOTP } from '../../auth/auth.constants';
import { generate, sealSecret, stepFor } from '../../auth/security/totp';
import { MfaService } from '../../auth/services/mfa.service';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { FIXED_NOW, makeAdmin, makeAttempt, makeTotpFactor } from '../harness';

/**
 * ═══ ONE WINDOW POLICY, ENFORCED ON EVERY PATH THAT VERIFIES A CODE ═════════
 *
 * `TOTP.WINDOW` is 0: a code is accepted only while the authenticator is still
 * showing it, and is refused the instant the app rolls over. `tests/auth/totp.spec.ts`
 * pins that in the verifier itself, to the millisecond.
 *
 * This file answers the different question a reviewer actually has to ask, which
 * no unit test of `verifyCode` can: do all the CALLERS get the same policy?
 *
 * There are four call sites across three flows, and every one of them reaches
 * `verifyCode(secret, code)` with no third argument — so all four read the server
 * clock through the same default and the same constant. That is the claim, and
 * asserting it is what stops a future path from acquiring its own tolerance:
 *
 *   sign-in, authenticate    MfaService.totpVerify, confirmed-factor branch
 *   sign-in, enroll          MfaService.totpVerify, pending-factor branch
 *   management, confirm      TwoFactorService.totpConfirm
 *   re-authentication        TwoFactorService.reauthVerify, `kind: 'totp'`
 *
 * Each is exercised with three codes — the current step, the previous step, and the
 * next step — against real sealing, real HMAC and real base32. Nothing about the
 * comparison is stubbed; only persistence is doubled.
 *
 * ─── Deterministic by construction, in both dimensions ─────────────────────
 *
 * The CLOCK is frozen at `FIXED_NOW`, whose epoch second divides by
 * `STEP_SECONDS` exactly, so every code below sits at the start of its own step
 * with a full 30 seconds of headroom. Without this the services — which read
 * `new Date()` themselves — could cross a boundary between fixture and assertion,
 * and at a zero window that expires the code mid-spec.
 *
 * The SECRET is fixed, so the three codes are fixed values rather than a fresh
 * roll each run. Two six-digit codes collide about once in a million; with a
 * random secret every "rejects the previous step" case here would be a
 * one-in-a-million false pass. The guard case below asserts they are distinct.
 */

const ADMIN_ID = '01920000-0000-7000-8000-000000000001';
const FACTOR_ID = '01920000-0000-7000-8000-0000000000a1';

/** Fixed 20 bytes — see the header on why this is not `generateSecret()`. */
const SECRET = Buffer.from('00112233445566778899aabbccddeeff01234567', 'hex');

const STEP = stepFor(FIXED_NOW);
const CURRENT = generate(SECRET, STEP);
const PREVIOUS = generate(SECRET, STEP - 1n);
const NEXT = generate(SECRET, STEP + 1n);

const PRINCIPAL = {
  adminId: ADMIN_ID,
  sessionId: '01920000-0000-7000-8000-000000000006',
  familyId: '01920000-0000-7000-8000-00000000000f',
  role: 'ADMIN' as const,
};

/** A real AES-256-GCM envelope around `SECRET`, so `openSecret` runs for real. */
function sealedFields() {
  const sealed = sealSecret(SECRET);
  return {
    secretCiphertext: new Uint8Array(sealed.ciphertext),
    secretIv: new Uint8Array(sealed.iv),
    secretTag: new Uint8Array(sealed.tag),
  };
}

function confirmedFactor() {
  return makeTotpFactor({ id: FACTOR_ID, confirmedAt: FIXED_NOW, ...sealedFields() });
}

function pendingFactor() {
  return makeTotpFactor({ id: FACTOR_ID, confirmedAt: null, ...sealedFields() });
}

beforeEach(() => {
  // `toFake: ['Date']` only — the doubles resolve real promises, and hijacking
  // `setTimeout` here would buy nothing and risk a hang.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

// ─── the sign-in paths (MfaService) ──────────────────────────────────────────

function buildSignIn(mfaOverrides: Record<string, unknown> = {}) {
  const admin = makeAdmin({ id: ADMIN_ID });

  const doubles = {
    admins: {
      findById: vi.fn().mockResolvedValue(admin),
      markMfaEnrolled: vi.fn().mockResolvedValue(undefined),
    },
    attempts: {
      incrementMfaAttempts: vi.fn().mockResolvedValue(1),
      complete: vi.fn().mockResolvedValue(true),
    },
    mfa: {
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(confirmedFactor()),
      findPendingTotp: vi.fn().mockResolvedValue(null),
      confirmTotp: vi.fn().mockResolvedValue(true),
      claimTotpStep: vi.fn().mockResolvedValue(true),
      listPasskeys: vi.fn().mockResolvedValue([]),
      ...mfaOverrides,
    },
    sessions: {
      issue: vi.fn().mockResolvedValue({ sessionId: 's1', accessToken: 'a', refreshToken: 'r' }),
    },
    cache: { set: vi.fn(), take: vi.fn().mockResolvedValue(null) },
    mail: { sendSecurityChanged: vi.fn().mockResolvedValue(undefined) },
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

// ─── the management and re-auth paths (TwoFactorService) ─────────────────────

function buildTwoFactor(mfaOverrides: Record<string, unknown> = {}) {
  const admin = makeAdmin({ id: ADMIN_ID });

  const doubles = {
    factors: {
      listFactors: vi.fn().mockResolvedValue([]),
      confirmTotpReplacing: vi.fn().mockResolvedValue(true),
      findFactor: vi.fn().mockResolvedValue({
        id: FACTOR_ID,
        kind: 'TOTP',
        label: 'Authenticator',
        createdAt: FIXED_NOW,
        lastUsedAt: null,
      }),
    },
    mfa: {
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(confirmedFactor()),
      findPendingTotp: vi.fn().mockResolvedValue(pendingFactor()),
      claimTotpStep: vi.fn().mockResolvedValue(true),
      discardStaleTotpEnrollments: vi.fn().mockResolvedValue(0),
      listPasskeys: vi.fn().mockResolvedValue([]),
      ...mfaOverrides,
    },
    admins: {
      findById: vi.fn().mockResolvedValue(admin),
      markMfaEnrolled: vi.fn().mockResolvedValue(undefined),
    },
    cache: {
      consume: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      take: vi.fn().mockResolvedValue(null),
    },
    mail: { sendSecurityChanged: vi.fn().mockResolvedValue(undefined) },
    elevation: {
      issue: vi.fn().mockResolvedValue({ ticket: 't', expiresInSeconds: 60, action: 'a' }),
    },
  };

  const service = new TwoFactorService(
    doubles.factors as never,
    doubles.mfa as never,
    doubles.admins as never,
    doubles.cache as never,
    doubles.mail as never,
    doubles.elevation as never,
  );

  return { service, doubles };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the window policy itself', () => {
  it('accepts the current step only', () => {
    expect(TOTP.WINDOW).toBe(0);
    expect(TOTP.STEP_SECONDS).toBe(30);
    expect(TOTP.DIGITS).toBe(6);
  });

  /** The precondition every rejection case below rests on. Asserted rather than
   *  assumed, so a collision reports itself instead of producing a false pass. */
  it('has three distinct codes to work with', () => {
    expect(new Set([PREVIOUS, CURRENT, NEXT]).size).toBe(3);
  });

  /** The clock is frozen at the START of a step, so nothing here is sitting on a
   *  boundary where a one-millisecond error would change the answer. */
  it('is frozen at a step boundary with a full step of headroom', () => {
    expect(Math.floor(FIXED_NOW.getTime() / 1000) % TOTP.STEP_SECONDS).toBe(0);
    expect(stepFor(new Date())).toBe(STEP);
    expect(stepFor(new Date(Date.now() + 29_999))).toBe(STEP);
    expect(stepFor(new Date(Date.now() + 30_000))).toBe(STEP + 1n);
  });
});

describe('sign-in — authenticating against a confirmed factor', () => {
  it('accepts the current step and issues a session', async () => {
    const { service, doubles, admin } = buildSignIn();

    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), CURRENT, ctx());

    expect(doubles.mfa.claimTotpStep).toHaveBeenCalledWith(FACTOR_ID, STEP);
    expect(doubles.sessions.issue).toHaveBeenCalledOnce();
  });

  /**
   * ═══ THE CASE THIS CHANGE EXISTS FOR ═══════════════════════════════════════
   *
   * The authenticator has rolled over and the admin submits the code it was
   * showing a moment ago. Under the old ±1-step window this MINTED A SESSION.
   * It must now be indistinguishable from a wrong code.
   */
  it('REJECTS the previous step — no grace after the rollover', async () => {
    const { service, doubles, admin } = buildSignIn();

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), PREVIOUS, ctx()),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    // Not merely refused at the end: it never became a step to claim, so it cannot
    // be mistaken for a replay and cannot advance `last_used_step`.
    expect(doubles.mfa.claimTotpStep).not.toHaveBeenCalled();
    expect(doubles.sessions.issue).not.toHaveBeenCalled();
  });

  it('REJECTS the next step — a code not yet displayed buys nothing', async () => {
    const { service, doubles, admin } = buildSignIn();

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), NEXT, ctx()),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.mfa.claimTotpStep).not.toHaveBeenCalled();
    expect(doubles.sessions.issue).not.toHaveBeenCalled();
  });

  /**
   * ═══ REPLAY PROTECTION IS UNTOUCHED BY THE NARROWING ═══════════════════════
   *
   * Narrowing the window shortened the race; it did not remove it. A step is still
   * 30 seconds wide, so the same code can be presented twice inside it — and
   * `claimTotpStep` is still the only thing that refuses the second one.
   */
  it('still refuses a current-step code whose step was already claimed', async () => {
    const { service, doubles, admin } = buildSignIn({
      claimTotpStep: vi.fn().mockResolvedValue(false),
    });

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), CURRENT, ctx()),
    );

    expect(slug).toBe(ERR.TOTP_REPLAYED);
    expect(doubles.sessions.issue).not.toHaveBeenCalled();
  });

  /** The matched step is what gets claimed, so it must be the CURRENT step and
   *  never a neighbour — otherwise a claim could advance the column past codes the
   *  admin has not used yet. */
  it('claims exactly the current step, never a neighbouring one', async () => {
    const { service, doubles, admin } = buildSignIn();

    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), CURRENT, ctx());

    const [, claimed] = doubles.mfa.claimTotpStep.mock.calls[0] as [string, bigint];
    expect(claimed).toBe(STEP);
    expect(claimed).not.toBe(STEP - 1n);
    expect(claimed).not.toBe(STEP + 1n);
  });
});

describe('sign-in — confirming a first enrollment', () => {
  function enrolling(mfaOverrides: Record<string, unknown> = {}) {
    return buildSignIn({
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(pendingFactor()),
      ...mfaOverrides,
    });
  }

  it('accepts the current step and confirms the factor', async () => {
    const { service, doubles, admin } = enrolling();

    await service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), CURRENT, ctx());

    expect(doubles.mfa.confirmTotp).toHaveBeenCalledWith(FACTOR_ID, STEP);
  });

  /** The enrollment branch has no `claimTotpStep` — the confirm write arms the
   *  defence instead — so the window is the ONLY thing standing between a stale
   *  code and a confirmed second factor here. */
  it('REJECTS the previous step without confirming anything', async () => {
    const { service, doubles, admin } = enrolling();

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), PREVIOUS, ctx()),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.mfa.confirmTotp).not.toHaveBeenCalled();
    expect(doubles.admins.markMfaEnrolled).not.toHaveBeenCalled();
  });

  it('REJECTS the next step without confirming anything', async () => {
    const { service, doubles, admin } = enrolling();

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt({ state: 'EMAIL_VERIFIED' }), NEXT, ctx()),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.mfa.confirmTotp).not.toHaveBeenCalled();
  });
});

describe('management — totp-confirm', () => {
  it('accepts the current step and confirms the replacement', async () => {
    const { service, doubles } = buildTwoFactor();

    await service.totpConfirm(PRINCIPAL, CURRENT);

    expect(doubles.factors.confirmTotpReplacing).toHaveBeenCalledWith({
      adminId: ADMIN_ID,
      factorId: FACTOR_ID,
      step: STEP,
    });
  });

  it('REJECTS the previous step without retiring the live factor', async () => {
    const { service, doubles } = buildTwoFactor();

    expect(await slugOf(() => service.totpConfirm(PRINCIPAL, PREVIOUS))).toBe(ERR.TOTP_INVALID);
    expect(doubles.factors.confirmTotpReplacing).not.toHaveBeenCalled();
  });

  it('REJECTS the next step without retiring the live factor', async () => {
    const { service, doubles } = buildTwoFactor();

    expect(await slugOf(() => service.totpConfirm(PRINCIPAL, NEXT))).toBe(ERR.TOTP_INVALID);
    expect(doubles.factors.confirmTotpReplacing).not.toHaveBeenCalled();
  });
});

describe('re-authentication — reauth-verify', () => {
  it('accepts the current step and issues an elevation ticket', async () => {
    const { service, doubles } = buildTwoFactor();

    await service.reauthVerify(PRINCIPAL, { kind: 'totp', code: CURRENT }, 'admins:create');

    expect(doubles.mfa.claimTotpStep).toHaveBeenCalledWith(FACTOR_ID, STEP);
    expect(doubles.elevation.issue).toHaveBeenCalledOnce();
  });

  /** An expired code must not buy a write permit either. This is the path that
   *  authorises mutations, so it is the one where a stale proof costs the most. */
  it('REJECTS the previous step and issues no ticket', async () => {
    const { service, doubles } = buildTwoFactor();

    const slug = await slugOf(() =>
      service.reauthVerify(PRINCIPAL, { kind: 'totp', code: PREVIOUS }, 'admins:create'),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.mfa.claimTotpStep).not.toHaveBeenCalled();
    expect(doubles.elevation.issue).not.toHaveBeenCalled();
  });

  it('REJECTS the next step and issues no ticket', async () => {
    const { service, doubles } = buildTwoFactor();

    const slug = await slugOf(() =>
      service.reauthVerify(PRINCIPAL, { kind: 'totp', code: NEXT }, 'admins:create'),
    );

    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.elevation.issue).not.toHaveBeenCalled();
  });

  it('still refuses a current-step code whose step was already claimed', async () => {
    const { service, doubles } = buildTwoFactor({
      claimTotpStep: vi.fn().mockResolvedValue(false),
    });

    const slug = await slugOf(() =>
      service.reauthVerify(PRINCIPAL, { kind: 'totp', code: CURRENT }, 'admins:create'),
    );

    expect(slug).toBe(ERR.TOTP_REPLAYED);
    expect(doubles.elevation.issue).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE CONSISTENCY CLAIM, AS ONE CASE ════════════════════════════════════
 *
 * Every path above rejects the previous step. This states that as a single fact
 * rather than leaving it implied across four describes, so a reviewer can read one
 * assertion and a future contributor adding a fifth verification path has an
 * obvious place to be caught out.
 */
describe('all paths agree', () => {
  it('rejects a previous-step code on every path that verifies one', async () => {
    const signIn = buildSignIn();
    const enroll = buildSignIn({
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(pendingFactor()),
    });
    const management = buildTwoFactor();
    const reauth = buildTwoFactor();

    const outcomes = await Promise.all([
      slugOf(() =>
        signIn.service.totpVerify(
          signIn.admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          PREVIOUS,
          ctx(),
        ),
      ),
      slugOf(() =>
        enroll.service.totpVerify(
          enroll.admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          PREVIOUS,
          ctx(),
        ),
      ),
      slugOf(() => management.service.totpConfirm(PRINCIPAL, PREVIOUS)),
      slugOf(() =>
        reauth.service.reauthVerify(PRINCIPAL, { kind: 'totp', code: PREVIOUS }, 'admins:create'),
      ),
    ]);

    expect(outcomes).toEqual([
      ERR.TOTP_INVALID,
      ERR.TOTP_INVALID,
      ERR.TOTP_INVALID,
      ERR.TOTP_INVALID,
    ]);
  });

  it('accepts a current-step code on every path that verifies one', async () => {
    const signIn = buildSignIn();
    const enroll = buildSignIn({
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(pendingFactor()),
    });
    const management = buildTwoFactor();
    const reauth = buildTwoFactor();

    const outcomes = await Promise.all([
      slugOf(() =>
        signIn.service.totpVerify(
          signIn.admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          CURRENT,
          ctx(),
        ),
      ),
      slugOf(() =>
        enroll.service.totpVerify(
          enroll.admin,
          makeAttempt({ state: 'EMAIL_VERIFIED' }),
          CURRENT,
          ctx(),
        ),
      ),
      slugOf(() => management.service.totpConfirm(PRINCIPAL, CURRENT)),
      slugOf(() =>
        reauth.service.reauthVerify(PRINCIPAL, { kind: 'totp', code: CURRENT }, 'admins:create'),
      ),
    ]);

    // `slugOf` returns 'did not throw' on success — every path completed.
    expect(outcomes).toEqual([
      'did not throw',
      'did not throw',
      'did not throw',
      'did not throw',
    ]);
  });
});
