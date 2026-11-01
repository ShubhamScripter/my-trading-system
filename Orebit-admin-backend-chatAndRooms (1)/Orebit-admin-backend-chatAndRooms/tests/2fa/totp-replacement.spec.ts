import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminTotpFactor, Prisma } from '@prisma/client';
import { MFA } from '../../auth/auth.constants';
import { MfaDbOperation } from '../../auth/persistence/mfa.dboperation';
import { MfaService } from '../../auth/services/mfa.service';
import { generate, generateSecret, sealSecret, stepFor } from '../../auth/security/totp';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { FIXED_NOW, makeAdmin, makeAttempt, makeTotpFactor } from '../harness';

/**
 * ═══ F06 — AN ABANDONED TOTP REPLACEMENT MUST NOT BLOCK THE NEXT SIGN-IN ═══════
 *
 * Two ceremonies write `admin_totp_factors`, and until this file existed only one of
 * them was accounted for by the reader.
 *
 *   sign-in enrollment   `MfaService.totpEnroll` refuses when a confirmed factor
 *                        exists, so it can only ever create a pending row for an
 *                        admin who has none.
 *   management rotation  `TwoFactorService.totpAdd` creates a pending row ALONGSIDE
 *                        a live confirmed one — that is the whole point of it, and
 *                        `confirmTotpReplacing` retires the old one atomically at
 *                        the end.
 *
 * `MfaService.totpVerify` branched on "is a pending row present", which was a sound
 * proxy for "this admin is enrolling" only under the first ceremony's precondition.
 * The second ceremony broke that precondition, so an abandoned `totp-add` left a
 * pending row that SHADOWED the confirmed factor at every subsequent login — and the
 * pending row had no expiry, no cancel action and no cleanup job, so it shadowed it
 * forever.
 *
 * The first two cases below are that lockout, and they are written to fail against
 * the pre-fix code. Everything after them is the lifecycle the fix adds.
 *
 * ─── Why the whole ceremony is exercised, not just the branch ────────────────
 *
 * `totpAdd`, `totpConfirm` and `confirmTotpReplacing` had NO test coverage at all
 * before this file. The retire-then-confirm ordering inside `confirmTotpReplacing`
 * is what keeps an admin from being locked out by a failed confirmation, and it was
 * resting entirely on review.
 */

const ADMIN_ID = '01920000-0000-7000-8000-000000000001';
const OLD_FACTOR_ID = '01920000-0000-7000-8000-0000000000a1';
const NEW_FACTOR_ID = '01920000-0000-7000-8000-0000000000a2';

/**
 * The clock is frozen for the same reason as in tests/auth/mfa.spec.ts, which
 * carries the full argument: `liveTotp` reads the clock to MAKE a code and the
 * service reads it again to CHECK one, and at `TOTP.WINDOW: 0` a step boundary
 * between the two reads expires the code mid-spec. `FIXED_NOW` is step-aligned, so
 * every code below sits at the start of its own step.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A real sealed secret plus a matching live code, so verification runs for real
 *  rather than through a stubbed comparison. Same helper as tests/auth/mfa.spec.ts;
 *  duplicated rather than shared because the two files double different layers. */
function liveTotp() {
  const secret = generateSecret();
  const sealed = sealSecret(secret);
  return {
    secret,
    code: generate(secret, stepFor()),
    fields: {
      secretCiphertext: new Uint8Array(sealed.ciphertext),
      secretIv: new Uint8Array(sealed.iv),
      secretTag: new Uint8Array(sealed.tag),
    },
  };
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

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

// ─── the login path (MfaService) ──────────────────────────────────────────────

function buildLogin(mfaOverrides: Record<string, unknown> = {}) {
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
      findPendingTotp: vi.fn().mockResolvedValue(null),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      confirmTotp: vi.fn().mockResolvedValue(true),
      claimTotpStep: vi.fn().mockResolvedValue(true),
      discardStaleTotpEnrollments: vi.fn().mockResolvedValue(0),
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

describe('F06 — an abandoned replacement must not shadow the confirmed factor', () => {
  it('signs in with the OLD authenticator while a pending replacement exists', async () => {
    // The lockout, stated as the thing that must work. Confirmed factor A is the
    // admin's real authenticator; B is a `totp-add` they started and abandoned.
    const old = liveTotp();
    const abandoned = liveTotp();

    const { service, doubles, admin } = buildLogin({
      findConfirmedTotp: vi.fn().mockResolvedValue(
        makeTotpFactor({ id: OLD_FACTOR_ID, confirmedAt: new Date(), ...old.fields }),
      ),
      findPendingTotp: vi.fn().mockResolvedValue(
        makeTotpFactor({ id: NEW_FACTOR_ID, confirmedAt: null, ...abandoned.fields }),
      ),
    });

    const issued = await service.totpVerify(admin, makeAttempt(), old.code, ctx());

    expect(issued).toMatchObject({ sessionId: 's1' });
    // The authenticate branch ran: the step was claimed against the CONFIRMED
    // factor, and nothing was confirmed.
    expect(doubles.mfa.claimTotpStep).toHaveBeenCalledWith(OLD_FACTOR_ID, expect.any(BigInt));
    expect(doubles.mfa.confirmTotp).not.toHaveBeenCalled();
  });

  it('refuses a code from the abandoned enrollment, without confirming it', async () => {
    // The security half. A code for B must NOT complete the replacement at login —
    // that is "an abandoned ceremony becoming a valid replacement", which the
    // invariant forbids. Pre-fix this reached `confirmTotp`, which does not retire
    // A, so the partial unique index raised a violation and the caller got a 500.
    const old = liveTotp();
    const abandoned = liveTotp();
    const confirmedRow = makeTotpFactor({
      id: OLD_FACTOR_ID,
      confirmedAt: new Date(),
      ...old.fields,
    });

    const { service, doubles, admin } = buildLogin({
      findConfirmedTotp: vi.fn().mockResolvedValue(confirmedRow),
      findPendingTotp: vi.fn().mockResolvedValue(
        makeTotpFactor({ id: NEW_FACTOR_ID, confirmedAt: null, ...abandoned.fields }),
      ),
    });

    const slug = await slugOf(() =>
      service.totpVerify(admin, makeAttempt(), abandoned.code, ctx()),
    );

    // A wrong code for the factor that governs sign-in — nothing more.
    expect(slug).toBe(ERR.TOTP_INVALID);
    expect(doubles.mfa.confirmTotp).not.toHaveBeenCalled();
    // The confirmed factor is untouched: still confirmed, still not deleted.
    expect(confirmedRow.confirmedAt).not.toBeNull();
    expect(confirmedRow.deletedAt).toBeNull();
  });

  it('still runs the enrollment branch for an admin with no confirmed factor', async () => {
    // The narrowing must not break first-time enrollment, which is the ONLY thing
    // the pending branch was ever meant to serve.
    const enrolling = liveTotp();

    const { service, doubles, admin } = buildLogin({
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(
        makeTotpFactor({ id: NEW_FACTOR_ID, confirmedAt: null, ...enrolling.fields }),
      ),
    });

    const issued = await service.totpVerify(admin, makeAttempt(), enrolling.code, ctx());

    expect(issued).toMatchObject({ sessionId: 's1' });
    expect(doubles.mfa.confirmTotp).toHaveBeenCalledWith(NEW_FACTOR_ID, expect.any(BigInt));
    expect(doubles.mfa.claimTotpStep).not.toHaveBeenCalled();
  });

  it('asks for the confirmed factor BEFORE the pending one', async () => {
    // Ordering, not just outcome. The defect was a branch taken on the wrong
    // question; asserting the question is asked in the right order is what stops it
    // being reintroduced by a refactor that happens to pass the cases above.
    const old = liveTotp();
    const seen: string[] = [];

    const { service, admin } = buildLogin({
      findConfirmedTotp: vi.fn(async () => {
        seen.push('confirmed');
        return makeTotpFactor({ id: OLD_FACTOR_ID, confirmedAt: new Date(), ...old.fields });
      }),
      findPendingTotp: vi.fn(async () => {
        seen.push('pending');
        return null;
      }),
    });

    await service.totpVerify(admin, makeAttempt(), old.code, ctx());

    // And the pending lookup is not made at all on the authenticate path — one
    // query where there were two, on the hot login path.
    expect(seen).toEqual(['confirmed']);
  });

  it('bounds the pending lookup by the enrollment TTL', async () => {
    // A stale pending row must be invisible to the enrollment branch even for an
    // admin with no confirmed factor, so an abandoned ceremony cannot be completed
    // by whoever reaches it next.
    const { service, doubles, admin } = buildLogin({
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 0, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(null),
    });

    const before = Date.now();
    const slug = await slugOf(() => service.totpVerify(admin, makeAttempt(), '123456', ctx()));
    const after = Date.now();

    expect(slug).toBe(ERR.MFA_NOT_ENROLLED);

    const [adminId, notBefore] = doubles.mfa.findPendingTotp.mock.calls[0] as [string, Date];
    expect(adminId).toBe(ADMIN_ID);
    // The cutoff is `now - ENROLLMENT_TTL_SECONDS`, computed per call.
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(
      before - MFA.ENROLLMENT_TTL_SECONDS * 1000,
    );
    expect(notBefore.getTime()).toBeLessThanOrEqual(after - MFA.ENROLLMENT_TTL_SECONDS * 1000);
  });
});

// ─── the management path (TwoFactorService) ───────────────────────────────────

function buildManagement(overrides: {
  factors?: Record<string, unknown>;
  mfa?: Record<string, unknown>;
} = {}) {
  const admin = makeAdmin({ id: ADMIN_ID });

  const doubles = {
    factors: {
      listFactors: vi.fn().mockResolvedValue([]),
      confirmTotpReplacing: vi.fn().mockResolvedValue(true),
      retireFactor: vi.fn().mockResolvedValue(true),
      renameFactor: vi.fn().mockResolvedValue(true),
      findFactor: vi.fn().mockResolvedValue({
        id: NEW_FACTOR_ID,
        kind: 'TOTP',
        label: 'Authenticator',
        createdAt: new Date(),
        lastUsedAt: null,
      }),
      ...overrides.factors,
    },
    mfa: {
      confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }),
      findConfirmedTotp: vi.fn().mockResolvedValue(null),
      findPendingTotp: vi.fn().mockResolvedValue(null),
      startTotpEnrollment: vi
        .fn()
        .mockResolvedValue(makeTotpFactor({ id: NEW_FACTOR_ID, confirmedAt: null })),
      discardStaleTotpEnrollments: vi.fn().mockResolvedValue(0),
      listPasskeys: vi.fn().mockResolvedValue([]),
      ...overrides.mfa,
    },
    admins: { findById: vi.fn().mockResolvedValue(admin), markMfaEnrolled: vi.fn() },
    cache: { set: vi.fn(), take: vi.fn().mockResolvedValue(null), consume: vi.fn() },
    mail: { sendSecurityChanged: vi.fn().mockResolvedValue(undefined) },
    elevation: { issue: vi.fn(), spend: vi.fn(), spendForAny: vi.fn() },
  };

  const service = new TwoFactorService(
    doubles.factors as never,
    doubles.mfa as never,
    doubles.admins as never,
    doubles.cache as never,
    doubles.mail as never,
    doubles.elevation as never,
  );

  const principal = {
    adminId: ADMIN_ID,
    sessionId: '01920000-0000-7000-8000-000000000006',
    familyId: '01920000-0000-7000-8000-00000000000f',
    role: 'ADMIN' as const,
  };

  return { service, doubles, principal };
}

describe('F06 — the replacement ceremony itself', () => {
  it('leaves the confirmed factor live when a replacement is started', async () => {
    const confirmedRow = makeTotpFactor({ id: OLD_FACTOR_ID, confirmedAt: new Date() });
    const { service, doubles, principal } = buildManagement({
      mfa: { findConfirmedTotp: vi.fn().mockResolvedValue(confirmedRow) },
    });

    const started = await service.totpAdd(principal, undefined);

    expect(started.replacing).toBe(true);
    expect(started.secret).toMatch(/^[A-Z2-7]+$/);
    // Nothing retired the old factor, and nothing marked it pending.
    expect(confirmedRow.confirmedAt).not.toBeNull();
    expect(confirmedRow.deletedAt).toBeNull();
    expect(doubles.factors.retireFactor).not.toHaveBeenCalled();
    // Prior PENDING rows are still cleared by starting another ceremony.
    expect(doubles.mfa.startTotpEnrollment).toHaveBeenCalledOnce();
  });

  it('confirms a fresh replacement, retiring the old factor in one transaction', async () => {
    const pending = liveTotp();
    const { service, doubles, principal } = buildManagement({
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(
          makeTotpFactor({ id: NEW_FACTOR_ID, confirmedAt: null, ...pending.fields }),
        ),
      },
    });

    await service.totpConfirm(principal, pending.code);

    // `confirmTotpReplacing`, NOT the sign-in path's `confirmTotp` — the former
    // retires the old factor in the same transaction, which is what keeps the
    // partial unique index satisfied.
    expect(doubles.factors.confirmTotpReplacing).toHaveBeenCalledWith({
      adminId: ADMIN_ID,
      factorId: NEW_FACTOR_ID,
      step: expect.any(BigInt),
    });
  });

  it('refuses a stale enrollment and discards it, leaving the confirmed factor alone', async () => {
    const confirmedRow = makeTotpFactor({ id: OLD_FACTOR_ID, confirmedAt: new Date() });
    const { service, doubles, principal } = buildManagement({
      mfa: {
        // Stale: outside the TTL, so the filtered lookup does not return it.
        findPendingTotp: vi.fn().mockResolvedValue(null),
        findConfirmedTotp: vi.fn().mockResolvedValue(confirmedRow),
        discardStaleTotpEnrollments: vi.fn().mockResolvedValue(1),
      },
    });

    const slug = await slugOf(() => service.totpConfirm(principal, '123456'));

    expect(slug).toBe(ERR.MFA_NOT_ENROLLED);
    expect(doubles.factors.confirmTotpReplacing).not.toHaveBeenCalled();
    // The stale secret is cleaned up...
    expect(doubles.mfa.discardStaleTotpEnrollments).toHaveBeenCalledOnce();
    // ...and the admin's real authenticator is untouched.
    expect(confirmedRow.confirmedAt).not.toBeNull();
    expect(confirmedRow.deletedAt).toBeNull();
  });

  it('still refuses when the cleanup itself fails', async () => {
    // Cleanup must never be able to turn an unexpected database state into a
    // successful enrollment. It runs on a path that has ALREADY decided to refuse,
    // so its failure changes nothing about the answer.
    const { service, doubles, principal } = buildManagement({
      mfa: {
        findPendingTotp: vi.fn().mockResolvedValue(null),
        discardStaleTotpEnrollments: vi.fn().mockRejectedValue(new Error('deadlock detected')),
      },
    });

    const slug = await slugOf(() => service.totpConfirm(principal, '123456'));

    expect(slug).toBe(ERR.MFA_NOT_ENROLLED);
    expect(doubles.factors.confirmTotpReplacing).not.toHaveBeenCalled();
  });

  it('bounds the pending lookup by the enrollment TTL here too', async () => {
    const { service, doubles, principal } = buildManagement();

    await slugOf(() => service.totpConfirm(principal, '123456'));

    const [adminId, notBefore] = doubles.mfa.findPendingTotp.mock.calls[0] as [string, Date];
    expect(adminId).toBe(ADMIN_ID);
    expect(Date.now() - notBefore.getTime()).toBeGreaterThanOrEqual(
      MFA.ENROLLMENT_TTL_SECONDS * 1000 - 5_000,
    );
  });
});

// ─── the cleanup statement (MfaDbOperation) ───────────────────────────────────

/**
 * A Prisma stand-in that records the arguments of every factor statement.
 *
 * What is being asserted is the SHAPE of the delete — specifically that ownership
 * and the cutoff are IN THE WHERE CLAUSE rather than checked beforehand. A fake
 * records that exactly, and it is the only thing worth checking here: whether
 * Postgres then deletes the right rows is not in doubt.
 */
function fakePrisma() {
  const deletes: Prisma.AdminTotpFactorDeleteManyArgs[] = [];
  const finds: Prisma.AdminTotpFactorFindFirstArgs[] = [];

  const adminTotpFactor = {
    deleteMany: vi.fn(async (args: Prisma.AdminTotpFactorDeleteManyArgs) => {
      deletes.push(args);
      return { count: 1 };
    }),
    findFirst: vi.fn(async (args: Prisma.AdminTotpFactorFindFirstArgs) => {
      finds.push(args);
      return null as AdminTotpFactor | null;
    }),
    create: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    count: vi.fn(async () => 0),
  };

  return {
    prisma: {
      adminTotpFactor,
      adminPasskey: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ adminTotpFactor, adminPasskey: {} }),
      ),
    },
    deletes,
    finds,
  };
}

describe('F06 — discardStaleTotpEnrollments is narrowly scoped', () => {
  it('puts the admin, the pending predicate AND the cutoff in the WHERE clause', async () => {
    const { prisma, deletes } = fakePrisma();
    const db = new MfaDbOperation(prisma as never);
    const cutoff = new Date('2026-06-15T11:45:00.000Z');

    await db.discardStaleTotpEnrollments(ADMIN_ID, cutoff);

    expect(deletes).toHaveLength(1);
    // All three conditions in one statement. Ownership checked in a preceding read
    // would be a race, and more importantly it would be something a future edit
    // could forget — here a row belonging to another admin simply does not match.
    expect(deletes[0]?.where).toEqual({
      adminId: ADMIN_ID,
      confirmedAt: null,
      createdAt: { lt: cutoff },
    });
  });

  it('cannot reach a confirmed factor', async () => {
    const { prisma, deletes } = fakePrisma();
    const db = new MfaDbOperation(prisma as never);

    await db.discardStaleTotpEnrollments(ADMIN_ID, new Date());

    // `confirmedAt: null` is not negotiable: a confirmed factor is a credential,
    // and this statement hard-deletes. The soft-delete path is `retireFactor`.
    expect(deletes[0]?.where).toHaveProperty('confirmedAt', null);
  });

  it('cannot reach a fresh enrollment', async () => {
    const { prisma, deletes } = fakePrisma();
    const db = new MfaDbOperation(prisma as never);
    const cutoff = new Date('2026-06-15T11:45:00.000Z');

    await db.discardStaleTotpEnrollments(ADMIN_ID, cutoff);

    // Strictly less than, so a row created exactly at the cutoff survives. The
    // boundary leans towards keeping a live ceremony rather than deleting one.
    expect(deletes[0]?.where?.createdAt).toEqual({ lt: cutoff });
  });

  it('filters findPendingTotp on the same cutoff', async () => {
    const { prisma, finds } = fakePrisma();
    const db = new MfaDbOperation(prisma as never);
    const notBefore = new Date('2026-06-15T11:45:00.000Z');

    await db.findPendingTotp(ADMIN_ID, notBefore);

    expect(finds[0]?.where).toEqual({
      adminId: ADMIN_ID,
      confirmedAt: null,
      deletedAt: null,
      createdAt: { gte: notBefore },
    });
  });
});
