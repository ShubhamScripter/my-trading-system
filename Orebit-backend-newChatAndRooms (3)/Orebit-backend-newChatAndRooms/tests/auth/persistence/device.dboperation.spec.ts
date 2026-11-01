import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../db/client';
import { DeviceDbOperation } from '../../../auth/persistence/device.dboperation';

/**
 * Trusted devices, and the one thing about them that was wrong: the scope.
 *
 * A `tokenHash` identifies a BROWSER PROFILE. A trust belongs to an ACCOUNT. Those
 * are different cardinalities, and treating the hash as the key collapsed them —
 * so on any shared machine the second person to ask to be remembered took the
 * first person's trust away.
 *
 * Every assertion here is about `userId` appearing in a predicate it used to be
 * missing from. Cheap to write, and the failure it guards was invisible: nothing
 * errored, nobody was let in who should not have been, and one user was simply
 * signed out six days early.
 */

let updateMany: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let findFirst: ReturnType<typeof vi.fn>;
let ops: DeviceDbOperation;

beforeEach(() => {
  updateMany = vi.fn().mockResolvedValue({ count: 0 });
  create = vi.fn().mockImplementation(async ({ data }: { data: unknown }) => data);
  findFirst = vi.fn().mockResolvedValue(null);

  const tx = { trustedDevice: { updateMany, create } };
  const prisma = {
    trustedDevice: { updateMany, create, findFirst },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  ops = new DeviceDbOperation(prisma as unknown as PrismaService);
});

const INPUT = {
  userId: 'user-1',
  tokenHash: 'b'.repeat(64),
  ipClassAtTrust: '203.0.113.0/24',
  userAgentAtTrust: 'vitest',
  label: 'Windows · Chrome',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

describe('trust — superseding is scoped to the caller', () => {
  it('revokes only THIS user’s previous trust on the browser', async () => {
    // ═══ THE BUG ═══════════════════════════════════════════════════════════════
    //
    // The predicate used to be `{ tokenHash, revokedAt: null }` — no `userId` —
    // because the unique index was scoped to the hash and left no choice. On a
    // shared browser that meant Bob ticking "remember this device" revoked Alice's
    // trust. Her sessions kept a `rememberUntil` and a `trustedDeviceId` pointing at
    // a dead row, silently fell back to the 24-hour idle window on her next refresh,
    // and signed her out six days early with nothing anywhere reporting it.
    await ops.trust(INPUT);

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', tokenHash: INPUT.tokenHash, revokedAt: null },
      data: { revokedAt: expect.any(Date) as unknown as Date },
    });
  });

  it('still supersedes rather than stacking, so one account holds one live trust', async () => {
    // The half the old predicate got right, and which the fix must not lose:
    // re-trusting is "keep remembering me", not "remember me twice", and
    // `ux_trusted_devices_user_token_active` would refuse a second live row anyway.
    await ops.trust(INPUT);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('revokes and inserts in ONE transaction', async () => {
    // Between the two there is a moment with no live trust. If the insert failed
    // outside a transaction the user would have asked to be remembered and come away
    // less trusted than before they asked.
    const seen: string[] = [];
    updateMany.mockImplementation(async () => {
      seen.push('revoke');
      return { count: 1 };
    });
    create.mockImplementation(async ({ data }: { data: unknown }) => {
      seen.push('create');
      return data;
    });

    await ops.trust(INPUT);
    expect(seen).toEqual(['revoke', 'create']);
  });
});

describe('findLive — this user’s trust, not the browser’s', () => {
  it('scopes the lookup to the account', async () => {
    // It used to query on `tokenHash` alone and return whichever single row existed,
    // leaving the caller to compare `userId` afterwards. That worked only because
    // the index guaranteed there was at most one row per browser. Now that two
    // people may each hold a live trust on one machine, an unscoped `findFirst`
    // would return an arbitrary one of them — and the caller's check would then
    // reject a trust the user genuinely holds.
    await ops.findLive('b'.repeat(64), 'user-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        tokenHash: 'b'.repeat(64),
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) as unknown as Date },
      },
    });
  });

  it('excludes revoked and expired rows', async () => {
    await ops.findLive('b'.repeat(64), 'user-1');

    const { where } = findFirst.mock.calls[0]![0] as {
      where: { revokedAt: null; expiresAt: { gt: Date } };
    };
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });
});

describe('revoke — ownership lives in the predicate', () => {
  it('will not revoke a trust belonging to somebody else', async () => {
    // Ids are time-ordered UUIDv7, so one minted near yours is guessable. Without
    // `userId` here this is an IDOR that signs strangers out of their own devices.
    await ops.revoke('device-1', 'user-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'device-1', userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as unknown as Date },
    });
  });

  it('answers null when nothing was revoked, rather than reporting a row', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(await ops.revoke('device-1', 'someone-else')).toBeNull();
  });
});
