import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../auth/auth.constants';
import { KEYS } from '../../redis';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ TWO DIMENSIONS ON RE-AUTHENTICATION ═══════════════════════════════════
 *
 * `reauthVerify` used to charge one bucket, keyed on the ADMIN. That bounds the
 * total correctly and leaves a lever: every session an admin holds draws on the
 * same five, so an attacker who steals ONE session can spend all of them. The real
 * admin is then refused re-authentication in every other session for the rest of
 * the window — the attacker still cannot produce a factor, but nobody else can
 * either, which is a denial of service handed to whoever arrives first.
 *
 * Keying on the session alone is the mirror failure: a fresh session is a fresh
 * budget.
 *
 * So both are charged. The account bucket is the ceiling; the session bucket is
 * what one session may take out of it, and it is deliberately tighter (3 vs 5) so
 * a single session cannot reach the ceiling on its own.
 *
 * `intent` is passed through to the elevation ticket and is not what these tests
 * are about; the proof is stubbed to succeed so the limiter is the only thing
 * under examination.
 */

const PRINCIPAL = {
  adminId: '01a057c3-2676-71ea-90e4-2838cadbe0fc',
  sessionId: '01a05d18-be56-7a55-9a04-d01224179e30',
  familyId: '01a05d18-0000-7000-8000-0000000000f1',
  role: 'SUPER_ADMIN' as const,
};

/** A second LOGIN — a different browser. Its budget is separate. */
const OTHER_LOGIN = {
  ...PRINCIPAL,
  sessionId: '01a05d18-0000-7000-8000-000000000000',
  familyId: '01a05d18-0000-7000-8000-0000000000f2',
};

/**
 * The SAME login after a background token rotation: new generation, same family.
 *
 * This is the fixture F08 turns on. Keyed on `sessionId` the bucket moved with every
 * rotation, so the per-session cap reset roughly every fifteen minutes and a caller
 * who could provoke a refresh got a fresh budget on demand.
 */
const SAME_LOGIN_ROTATED = {
  ...PRINCIPAL,
  sessionId: '01a05d18-9999-7000-8000-000000000000',
};

function build() {
  const cache = {
    consume: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    take: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
  };

  const service = new TwoFactorService(
    {} as never,
    // A confirmed TOTP factor, so the proof path has something to verify against.
    { confirmedFactorCounts: vi.fn().mockResolvedValue({ totp: 1, passkey: 0 }) } as never,
    {} as never,
    cache as never,
    {} as never,
    { issue: vi.fn().mockResolvedValue({ ticket: 't', expiresInSeconds: 60 }) } as never,
  );

  // The proof itself is not under test — stubbed so a limiter refusal is the only
  // thing that can stop the call, and a passing limiter is visible as a different
  // failure further down rather than as a false success.
  vi.spyOn(
    service as unknown as { verifyReauthTotp: (...a: unknown[]) => Promise<void> },
    'verifyReauthTotp',
  ).mockResolvedValue(undefined);

  return { service, cache };
}

const totp = { kind: 'totp' as const, code: '123456' };

async function refusal(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

describe('reauthVerify rate limiting', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('charges the login bucket and the account bucket', async () => {
    await ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create').catch(() => undefined);

    const keys = ctx.cache.consume.mock.calls.map(([key]) => key as string);
    expect(keys).toContain(KEYS.rate.reauthByLogin(PRINCIPAL.familyId));
    expect(keys).toContain(KEYS.rate.twoFactorProofByAdmin(PRINCIPAL.adminId));
  });

  /**
   * Session first, so a session that has spent its own three is refused without
   * also burning a slot from the account's five. The other order would let a single
   * session drain the account ceiling anyway, one refusal at a time — which is the
   * exact failure the session bucket was added to prevent.
   */
  it('charges the login bucket BEFORE the account bucket', async () => {
    await ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create').catch(() => undefined);

    const keys = ctx.cache.consume.mock.calls.map(([key]) => key as string);
    expect(keys[0]).toBe(KEYS.rate.reauthByLogin(PRINCIPAL.familyId));
    expect(keys[1]).toBe(KEYS.rate.twoFactorProofByAdmin(PRINCIPAL.adminId));
  });

  it('does not touch the account bucket when the login bucket refuses', async () => {
    ctx.cache.consume.mockRejectedValueOnce(new ProblemException({ type: ERR.RATE_LIMITED }));

    const err = await refusal(
      ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create'),
    );

    expect(err.type).toBe(ERR.RATE_LIMITED);
    expect(ctx.cache.consume).toHaveBeenCalledOnce();
  });

  /** ═══ THE LOCKOUT THIS CLOSES ══════════════════════════════════════════ */
  it('keys the bucket per login, so one login cannot spend another’s', async () => {
    await ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create').catch(() => undefined);
    await ctx.service
      .reauthVerify(OTHER_LOGIN as never, totp, 'admins:create')
      .catch(() => undefined);

    const keys = ctx.cache.consume.mock.calls.map(([key]) => key as string);
    // Two DIFFERENT login keys. A stolen session draining its own budget leaves the
    // admin's other logins with theirs.
    expect(keys).toContain(KEYS.rate.reauthByLogin(PRINCIPAL.familyId));
    expect(keys).toContain(KEYS.rate.reauthByLogin(OTHER_LOGIN.familyId));
    expect(KEYS.rate.reauthByLogin(PRINCIPAL.familyId)).not.toBe(
      KEYS.rate.reauthByLogin(OTHER_LOGIN.familyId),
    );
  });

  /**
   * ═══ F08 — THE BUDGET SURVIVES A ROTATION, WHICH IS THE SECURITY HALF ═════
   *
   * Keyed on the refresh generation, this cap was resettable by anyone who could
   * cause a token rotation — which under the BFF is anyone holding the session, by
   * doing nothing more than waiting for the access token to approach expiry. Three
   * guesses per fifteen minutes was really three per generation, and the only
   * surviving bound was the per-admin five.
   *
   * Same family, new generation, SAME bucket. This is a tightening: a user who
   * genuinely fumbles codes across a rotation now reaches the cap sooner. That is
   * the correct behaviour, and if the limit proves too tight the remedy is the
   * constant, never a rotation-resettable key.
   */
  it('does not reset the budget when the refresh generation changes', async () => {
    await ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create').catch(() => undefined);
    await ctx.service
      .reauthVerify(SAME_LOGIN_ROTATED as never, totp, 'admins:create')
      .catch(() => undefined);

    const loginKeys = ctx.cache.consume.mock.calls
      .map(([key]) => key as string)
      .filter((k) => k.startsWith('rate:reauth:login:'));

    // Both charges landed on ONE key, even though the two calls carried different
    // `sessionId`s.
    expect(loginKeys).toHaveLength(2);
    expect(new Set(loginKeys).size).toBe(1);
    expect(loginKeys[0]).toBe(KEYS.rate.reauthByLogin(PRINCIPAL.familyId));
    // And the generation is nowhere in the key, so it cannot influence it.
    expect(PRINCIPAL.sessionId).not.toBe(SAME_LOGIN_ROTATED.sessionId);
  });

  it('denies on cache failure for both buckets', async () => {
    const modes = ctx.cache.consume.mock.calls;
    await ctx.service.reauthVerify(PRINCIPAL as never, totp, 'admins:create').catch(() => undefined);

    // `deny`, not `allow`. There is no login-attempt row on this path, so an
    // unreadable limiter must not leave an access-token holder unmetered against a
    // code that does not rotate.
    for (const call of modes) expect(call[2]).toBe('deny');
    expect(modes.length).toBeGreaterThan(0);
  });
});

describe('the limits themselves', () => {
  /** ═══ THE ORDERING THAT MAKES THE PAIR WORK ════════════════════════════ */
  it('bounds one session below the account ceiling', () => {
    // If the session limit were >= the account limit, one session could still
    // exhaust the account and the second bucket would be decoration.
    expect(LIMITS.REAUTH_BY_SESSION.limit).toBeLessThan(LIMITS.TWO_FACTOR_PROOF_BY_ADMIN.limit);
  });

  it('uses the same window for both, so neither outlives the other', () => {
    expect(LIMITS.REAUTH_BY_SESSION.windowSeconds).toBe(
      LIMITS.TWO_FACTOR_PROOF_BY_ADMIN.windowSeconds,
    );
  });

  it('leaves room for a second session after one exhausts itself', () => {
    const remaining = LIMITS.TWO_FACTOR_PROOF_BY_ADMIN.limit - LIMITS.REAUTH_BY_SESSION.limit;
    expect(remaining).toBeGreaterThan(0);
  });
});
