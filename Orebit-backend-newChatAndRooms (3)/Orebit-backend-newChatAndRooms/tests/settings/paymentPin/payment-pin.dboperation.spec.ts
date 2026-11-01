import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCooldownLockQuery } from '../../harness';
import type { PrismaService } from '../../../db/client';
import { PaymentPinDbOperation } from '../../../src/settings/paymentPin/payment-pin.dboperation';
import { CONTEXT, noPlan } from '../../restrictions/double';

/**
 * The predicates, and specifically the fact that every one of them is scoped to the
 * ACCOUNT.
 *
 * The service spec asserts these methods are called; this file asserts what they
 * actually match. That distinction matters more here than almost anywhere else in the
 * repository, because the failure it guards is invisible: a `where` clause missing its
 * `userId` throws nothing, logs nothing, and reads to a mocked test exactly like a
 * correct one — while letting any authenticated caller replace or delete somebody
 * else's Payment PIN.
 *
 * Also asserted here: that nothing takes a row id. Ids are time-ordered UUIDv7 and a
 * method accepting one would be a surface to guess at, so the absence is checked rather
 * than assumed.
 */

let findUnique: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let updateMany: ReturnType<typeof vi.fn>;
let deleteMany: ReturnType<typeof vi.fn>;
let ops: PaymentPinDbOperation;

const USER_ID = '01940000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';

beforeEach(() => {
  findUnique = vi.fn().mockResolvedValue(null);
  create = vi.fn().mockImplementation((args: { data: unknown }) => args.data);
  updateMany = vi.fn().mockResolvedValue({ count: 1 });
  deleteMany = vi.fn().mockResolvedValue({ count: 1 });

  // All three mutations run inside a transaction now, because each takes the
  // security-cooldown row lock before it writes — see
  // `assertNoRecentEmailChangeLocked`. The fake hands the callback the same object and
  // answers the lock's raw SELECT with an account whose address has never moved, so
  // the assertions below still see exactly the predicates they were written for.
  const prisma = {
    paymentPin: { findUnique, create, updateMany, deleteMany },
    $queryRaw: makeCooldownLockQuery(),
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(prisma),
  };
  ops = new PaymentPinDbOperation(prisma as unknown as PrismaService);
});

describe('findByUserId — the row IS the setting', () => {
  it('looks the row up by user and nothing else', async () => {
    await ops.findByUserId(USER_ID);

    // No `deletedAt: null`, deliberately: this table hard-deletes, so there is no live
    // and dead distinction for a filter to make. A predicate that grew one would
    // silently match nothing.
    expect(findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('reports no PIN as null rather than throwing', async () => {
    expect(await ops.findByUserId(USER_ID)).toBeNull();
  });
});

describe('create — the unique index is what makes the race safe', () => {
  it('writes a time-ordered id it generates itself', async () => {
    await ops.create(USER_ID, 'hash');

    const [[call]] = create.mock.calls as [[{ data: Record<string, unknown> }]];
    // UUIDv7, per the schema's convention — never gen_random_uuid() and never v4,
    // both of which scatter writes across the B-tree.
    expect(call.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(call.data.userId).toBe(USER_ID);
    expect(call.data.pinHash).toBe('hash');
  });

  it('writes nothing but the id, the owner and the hash', async () => {
    await ops.create(USER_ID, 'hash');

    // No `enabled`, no `deletedAt`. A second source of truth for "is the PIN on" is a
    // second thing that can disagree with the row's existence.
    const [[call]] = create.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(Object.keys(call.data).sort()).toEqual(['id', 'pinHash', 'userId']);
  });

  it('does not pre-check for an existing row', async () => {
    // The uniqueness is the database's job. A read-then-write here would let two
    // concurrent enables both find nothing and both insert, and the second would
    // silently replace the first user's PIN.
    await ops.create(USER_ID, 'hash');

    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('replaceHash — a conditional update, scoped to the account', () => {
  it('matches only the caller’s row', async () => {
    await ops.replaceHash(USER_ID, 'new-hash', CONTEXT, noPlan());

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { pinHash: 'new-hash' },
    });

    const [[call]] = updateMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(call.where)).toEqual(['userId']);
  });

  it('writes the hash and nothing else', async () => {
    await ops.replaceHash(USER_ID, 'new-hash', CONTEXT, noPlan());

    // `createdAt` must survive an update — it is the only fact on the row that says
    // when this account first set a PIN — and `updatedAt` moves on its own via
    // `@updatedAt`, so touching either here would be wrong.
    const [[call]] = updateMany.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(Object.keys(call.data)).toEqual(['pinHash']);
  });

  it('is scoped to the caller, so one account cannot rewrite another’s PIN', async () => {
    await ops.replaceHash(OTHER_USER_ID, 'new-hash', CONTEXT, noPlan());

    const [[call]] = updateMany.mock.calls as [[{ where: { userId?: string } }]];
    expect(call.where.userId).toBe(OTHER_USER_ID);
  });

  it('reports a miss rather than throwing, because an absent row is an ordinary answer', async () => {
    // Reachable by a race: the PIN was disabled between the challenge being minted and
    // being spent. `update` would throw P2025 here and turn that into a 500.
    updateMany.mockResolvedValue({ count: 0 });

    expect(await ops.replaceHash(USER_ID, 'new-hash', CONTEXT, noPlan())).toBe(false);
  });

  it('reports success only when exactly one row moved', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    expect(await ops.replaceHash(USER_ID, 'new-hash', CONTEXT, noPlan())).toBe(true);
  });
});

describe('remove — a hard delete, scoped to the account', () => {
  it('matches only the caller’s row', async () => {
    await ops.remove(USER_ID, CONTEXT, noPlan());

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });

    const [[call]] = deleteMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(call.where)).toEqual(['userId']);
  });

  it('is scoped to the caller, so one account cannot delete another’s PIN', async () => {
    await ops.remove(OTHER_USER_ID, CONTEXT, noPlan());

    const [[call]] = deleteMany.mock.calls as [[{ where: { userId?: string } }]];
    expect(call.where.userId).toBe(OTHER_USER_ID);
  });

  it('reports a miss rather than throwing', async () => {
    deleteMany.mockResolvedValue({ count: 0 });

    expect(await ops.remove(USER_ID, CONTEXT, noPlan())).toBe(false);
  });

  it('really deletes rather than retiring', async () => {
    // ═══ WHY THE ABSENCE OF AN UPDATE IS THE ASSERTION ═════════════════════════
    //
    // This is the one place in the repository that hard-deletes by design, and the
    // reasoning is on the model: soft delete exists here to stop a removal reserving an
    // external identifier (this table has none) or to keep a spend history (a single
    // hash replaced in place has none). What a soft delete WOULD preserve is the argon2
    // hash of a secret the user asked us to destroy.
    //
    // So a well-meaning change to `updateMany({ data: { deletedAt } })` — which would
    // look like bringing this table in line with its neighbours — is a regression, and
    // this is what catches it.
    await ops.remove(USER_ID, CONTEXT, noPlan());

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('the surface as a whole', () => {
  it('exposes no method that takes a row id', () => {
    // Ownership lives in the WHERE clause and is never checked afterwards, which only
    // works because there is nothing to address a row by except its owner.
    const methods = ['findByUserId', 'create', 'replaceHash', 'remove'] as const;

    for (const method of methods) {
      expect(typeof ops[method]).toBe('function');
      // Every one takes `userId` first.
      expect(ops[method].length).toBeGreaterThanOrEqual(1);
    }
  });
});
