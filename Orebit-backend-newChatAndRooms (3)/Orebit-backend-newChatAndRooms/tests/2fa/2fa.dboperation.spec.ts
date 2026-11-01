import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCooldownLockQuery } from '../harness';
import type { PrismaService } from '../../db/client';
import { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { CONTEXT, noPlan } from '../restrictions/double';

/**
 * The soft-delete predicates, and specifically the one whose SCOPE is load-bearing.
 *
 * `src/settings/` disables a factor by sweeping the account rather than deleting a
 * named id, and the correctness of that sweep is entirely in the `where` clause a
 * mocked dboperation cannot show. The service spec asserts the sweep is CALLED; this
 * file asserts what it actually matches.
 *
 * Cheap to write, and the failure it guards is invisible: nothing errors, nothing is
 * logged, and an account the user believes has no authenticator keeps a row that can
 * be turned back into one.
 */

let totpUpdateMany: ReturnType<typeof vi.fn>;
let passkeyUpdateMany: ReturnType<typeof vi.fn>;
let ops: TwoFactorDbOperation;

beforeEach(() => {
  totpUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
  passkeyUpdateMany = vi.fn().mockResolvedValue({ count: 3 });

  // Both sweeps now run inside a transaction, because each takes the security-cooldown
  // row lock before it writes — see `assertNoRecentEmailChangeLocked`. The fake hands
  // the callback the same object, which is enough to observe the statements, and
  // answers the lock's raw SELECT with an account whose address has never moved.
  const prisma = {
    totpFactor: { updateMany: totpUpdateMany },
    passkey: { updateMany: passkeyUpdateMany },
    $queryRaw: makeCooldownLockQuery(),
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(prisma),
  };

  ops = new TwoFactorDbOperation(prisma as unknown as PrismaService);
});

describe('softDeleteAllTotpFactors — the scope is the whole account', () => {
  it('matches every live row for the user, CONFIRMED OR NOT', async () => {
    // ═══ WHY THE ABSENCE OF `confirmedAt` IS THE ASSERTION ═════════════════════
    //
    // `TWO_FACTOR_REQUIRES['totp-confirm']` is `'bearer'` — no elevation ticket —
    // and an unconfirmed `TotpFactor` row is DURABLE, unlike a passkey registration
    // challenge, which lives in Redis behind a TTL and is read with `GETDEL`.
    //
    // So a pending row that survives a disable is a row a bare access token can
    // confirm later, re-enabling the authenticator without presenting any of the
    // four proof paths the disable exists to require. Narrowing this predicate to
    // `confirmedAt: { not: null }` — which reads like a tidy-up — reopens exactly
    // that. The predicate must therefore be `userId` + liveness and nothing else.
    await ops.softDeleteAllTotpFactors('user-1', CONTEXT, noPlan());

    expect(totpUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) as unknown as Date },
    });

    const [[call]] = totpUpdateMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(call.where).sort()).toEqual(['deletedAt', 'userId']);
  });

  it('is scoped to the caller, so one account cannot retire another’s factors', async () => {
    await ops.softDeleteAllTotpFactors('user-1', CONTEXT, noPlan());

    const [[call]] = totpUpdateMany.mock.calls as [[{ where: { userId?: string } }]];
    expect(call.where.userId).toBe('user-1');
  });

  it('answers how many were live rather than whether one id existed', async () => {
    // A count, not a boolean: zero is not an error here. A caller disabling an
    // already-disabled setting has asked for a state that is now true, which is the
    // opposite of `softDeleteTotpFactor`, where zero means the named id did not
    // exist and must refuse.
    await expect(ops.softDeleteAllTotpFactors('user-1', CONTEXT, noPlan())).resolves.toBe(2);

    totpUpdateMany.mockResolvedValue({ count: 0 });
    await expect(ops.softDeleteAllTotpFactors('user-1', CONTEXT, noPlan())).resolves.toBe(0);
  });
});

describe('softDeleteAllPasskeys — the same shape, stated so the pair cannot drift', () => {
  it('matches every live passkey for the user', async () => {
    await ops.softDeleteAllPasskeys('user-1', CONTEXT, noPlan());

    expect(passkeyUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) as unknown as Date },
    });
  });

  it('answers how many were live', async () => {
    await expect(ops.softDeleteAllPasskeys('user-1', CONTEXT, noPlan())).resolves.toBe(3);
  });
});
