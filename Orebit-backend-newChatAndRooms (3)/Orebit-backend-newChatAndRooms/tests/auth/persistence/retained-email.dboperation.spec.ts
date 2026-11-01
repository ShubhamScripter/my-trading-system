import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../db/client';
import { RetainedEmailDbOperation } from '../../../auth/persistence/retained-email.dboperation';
import { makeRetainedEmail } from '../../harness';

/**
 * The predicates, and the two transactions that move an account's email address.
 *
 * ═══ WHY THIS FILE EXISTS SEPARATELY FROM THE SERVICE SPEC ══════════════════
 *
 * The service spec asserts these methods are CALLED. This asserts what they actually
 * match, and here that gap is wider than anywhere else in the repository:
 *
 *  - a liveness test written as a flag instead of `expiresAt > now` is a reservation
 *    that never lapses, or one a missed cleanup job leaves blocking forever;
 *  - a reclaim scoped to the address instead of `(user, address)` is one account
 *    clearing another account's reservation;
 *  - a recovery that reads the ticket and then writes, instead of claiming it with a
 *    conditional update, is a ticket two concurrent requests can both spend.
 *
 * None of those throws, logs, or looks different to a mocked caller.
 */

interface Tx {
  user: { update: ReturnType<typeof vi.fn> };
  retainedEmail: {
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
}

let findFirst: ReturnType<typeof vi.fn>;
let findMany: ReturnType<typeof vi.fn>;
let findUnique: ReturnType<typeof vi.fn>;
let tx: Tx;
let ops: RetainedEmailDbOperation;

const USER_ID = '01940000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';
const RECORD_ID = '01940000-0000-7000-8000-0000000000d1';

beforeEach(() => {
  findFirst = vi.fn().mockResolvedValue(null);
  findMany = vi.fn().mockResolvedValue([]);
  findUnique = vi.fn().mockResolvedValue(null);

  tx = {
    user: { update: vi.fn().mockResolvedValue(undefined) },
    retainedEmail: {
      create: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const prisma = {
    retainedEmail: { findFirst, findMany, findUnique, ...tx.retainedEmail },
    user: tx.user,
    // The real transaction runs the callback against a tx client; the fake hands it the
    // same object, which is enough to observe every statement and their order.
    $transaction: async (fn: (t: Tx) => Promise<unknown>) => fn(tx),
  };

  ops = new RetainedEmailDbOperation(prisma as unknown as PrismaService);
});

// ─── reads ──────────────────────────────────────────────────────────────────

describe('findLiveByEmail — the probe registration runs on every signup', () => {
  it('matches on the address AND a future expiry, never on a flag', () => {
    // ═══ THE ASSERTION THAT MATTERS ═══════════════════════════════════════════
    //
    // Liveness has to be a comparison against the clock. A boolean column would be a
    // second source of truth that a missed sweep makes wrong — and the thing it would
    // make wrong is "may this stranger register this address", in the permissive
    // direction.
    void ops.findLiveByEmail('old@example.test');

    const [[call]] = findFirst.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(call.where).sort()).toEqual(['emailLower', 'expiresAt']);
    expect(call.where.emailLower).toBe('old@example.test');
    expect(call.where.expiresAt).toEqual({ gt: expect.any(Date) as unknown as Date });
  });

  it('takes the newest live row, because one address may have several over its life', async () => {
    // Retained, expired, registered by somebody else, released again. Only the live one
    // is an answer, and an unordered `findFirst` could return an expired one.
    await ops.findLiveByEmail('old@example.test');

    const [[call]] = findFirst.mock.calls as [[{ orderBy: unknown }]];
    expect(call.orderBy).toEqual({ expiresAt: 'desc' });
  });

  it('reports an unreserved address as null rather than throwing', async () => {
    expect(await ops.findLiveByEmail('free@example.test')).toBeNull();
  });

  it('says WHO holds the reservation, so a caller can tell its own from a stranger’s', async () => {
    // Registration refuses either way; an email change lets an account reclaim its own
    // released address. One query, two answers.
    findFirst.mockResolvedValue(makeRetainedEmail({ userId: USER_ID }));

    const held = await ops.findLiveByEmail('old.address@example.test');
    expect(held?.userId).toBe(USER_ID);
  });
});

describe('listLiveForUser — which previous address must authorise the next change', () => {
  it('is scoped to the account and to live rows', async () => {
    await ops.listLiveForUser(USER_ID);

    const [[call]] = findMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(Object.keys(call.where).sort()).toEqual(['expiresAt', 'userId']);
    expect(call.where.userId).toBe(USER_ID);
  });

  it('returns a LIST, so a broken invariant is visible instead of silently truncated', async () => {
    // Policy makes at most one live at a time. Returning one row here would make a
    // misconfiguration look like a correct account with fewer proofs required — which
    // is the silent weakening the service's assertion exists to catch.
    findMany.mockResolvedValue([makeRetainedEmail(), makeRetainedEmail({ id: 'second' })]);

    expect(await ops.listLiveForUser(USER_ID)).toHaveLength(2);
  });
});

describe('findByRecoveryTokenHash — resolving a ticket', () => {
  it('looks the record up BY the hash rather than fetching and comparing', async () => {
    // Comparing in application code would make the response time depend on whether a
    // record was found, which on a route reachable without a session is an oracle for
    // which addresses were recently changed away from.
    await ops.findByRecoveryTokenHash('hashed');

    expect(findFirst).toHaveBeenCalledWith({ where: { recoveryTokenHash: 'hashed' } });
  });

  it('returns a spent or expired record rather than hiding it', async () => {
    // The caller folds unknown, expired and spent into one refusal, and needs the row to
    // log which it actually was.
    findFirst.mockResolvedValue(
      makeRetainedEmail({ recoveryConsumedAt: new Date(), expiresAt: new Date(0) }),
    );

    expect(await ops.findByRecoveryTokenHash('hashed')).not.toBeNull();
  });
});

// ─── the change ─────────────────────────────────────────────────────────────

const CHANGE = {
  userId: USER_ID,
  newEmail: 'New@example.test',
  newEmailLower: 'new@example.test',
  releasedEmail: 'Old@example.test',
  releasedEmailLower: 'old@example.test',
  retentionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  recoveryTokenHash: 'token-hash',
  skippedRetainedId: null,
};

describe('changeEmail', () => {
  it('moves the account and reserves what it left, in one transaction', async () => {
    await ops.changeEmail(CHANGE);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        email: 'New@example.test',
        emailLower: 'new@example.test',
        emailVerifiedAt: expect.any(Date) as unknown as Date,
        // The security cooldown starts in the SAME statement that moves the address.
        // Asserted here rather than in a policy spec because this is the only place the
        // atomicity is decided: a separate write, even one line later in this
        // transaction, would be a window in which the address has moved and the freeze
        // has not — which is exactly the instant the freeze exists for.
        emailChangedAt: expect.any(Date) as unknown as Date,
      },
    });

    const [[created]] = tx.retainedEmail.create.mock.calls as [[{ data: Record<string, unknown> }]];
    expect(created.data.emailLower).toBe('old@example.test');
    expect(created.data.userId).toBe(USER_ID);
    expect(created.data.recoveryTokenHash).toBe('token-hash');
  });

  it('marks the new address verified, because a code just proved it', async () => {
    // Leaving the old timestamp would claim this mailbox had been proved when it had
    // not — and it is the same standard registration applies.
    await ops.changeEmail(CHANGE);

    const [[call]] = tx.user.update.mock.calls as [[{ data: { emailVerifiedAt?: Date } }]];
    expect(call.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('writes a time-ordered id it generates itself', async () => {
    await ops.changeEmail(CHANGE);

    const [[created]] = tx.retainedEmail.create.mock.calls as [[{ data: { id: string } }]];
    expect(created.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('releases only the CALLER’s claim on the target address', async () => {
    // ═══ THE OTHER ASSERTION THAT MATTERS ═════════════════════════════════════
    //
    // The reclaim is what lets a user move an address back to themselves. Scoped to the
    // address alone it would instead be this account deleting another account's
    // reservation — silently, and as a side effect of an ordinary change.
    await ops.changeEmail(CHANGE);

    const [[call]] = tx.retainedEmail.deleteMany.mock.calls as [
      [{ where: Record<string, unknown> }],
    ];
    expect(Object.keys(call.where).sort()).toEqual(['emailLower', 'userId']);
    expect(call.where.userId).toBe(USER_ID);
    expect(call.where.emailLower).toBe('new@example.test');
  });

  it('retires a skipped retention as part of the same commit', async () => {
    // Expired rather than deleted, so the record of an address having been held — and
    // skipped — survives for an operator to read.
    await ops.changeEmail({ ...CHANGE, skippedRetainedId: RECORD_ID });

    const [[call]] = tx.retainedEmail.updateMany.mock.calls as [
      [{ where: Record<string, unknown>; data: Record<string, unknown> }],
    ];
    expect(call.where).toEqual({ id: RECORD_ID, userId: USER_ID });
    expect(call.data.expiresAt).toBeInstanceOf(Date);
  });

  it('touches no retention when nothing was skipped', async () => {
    await ops.changeEmail(CHANGE);
    expect(tx.retainedEmail.updateMany).not.toHaveBeenCalled();
  });

  it('lets a uniqueness violation out, so the transaction rolls back', async () => {
    // `ix_users_email_active` is the authority on who holds an address. An error caught
    // here would leave the reservation written and the account unmoved.
    tx.user.update.mockRejectedValue(new Error('duplicate key value violates ... (SQLSTATE 23505)'));

    await expect(ops.changeEmail(CHANGE)).rejects.toThrow('23505');
  });
});

// ─── the recovery ───────────────────────────────────────────────────────────

const RECOVER = {
  retainedEmailId: RECORD_ID,
  userId: USER_ID,
  intent: 'restore' as const,
  targetEmail: 'Old@example.test',
  targetEmailLower: 'old@example.test',
  renewedExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  renewedRecoveryTokenHash: 'renewed-hash',
};

describe('recoverEmail', () => {
  it('claims the ticket with a conditional update covering its whole validity', async () => {
    // ═══ THE COMPARE-AND-SWAP ═════════════════════════════════════════════════
    //
    // Unspent, unexpired, and belonging to this account — all three in the predicate, so
    // the claim and the check cannot separate. A read-then-write would leave exactly the
    // gap an attacker holding the ticket would race in.
    await ops.recoverEmail(RECOVER);

    const [[claim]] = tx.retainedEmail.updateMany.mock.calls as [
      [{ where: Record<string, unknown>; data: Record<string, unknown> }],
    ];
    expect(Object.keys(claim.where).sort()).toEqual([
      'expiresAt',
      'id',
      'recoveryConsumedAt',
      'userId',
    ]);
    expect(claim.where.recoveryConsumedAt).toBeNull();
    expect(claim.where.expiresAt).toEqual({ gt: expect.any(Date) as unknown as Date });
    expect(claim.data.recoveryConsumedAt).toBeInstanceOf(Date);
  });

  it('changes nothing when the swap is lost', async () => {
    tx.retainedEmail.updateMany.mockResolvedValue({ count: 0 });

    expect(await ops.recoverEmail(RECOVER)).toBe(false);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.retainedEmail.deleteMany).not.toHaveBeenCalled();
  });

  it('restores the account to the retained address and drops the record', async () => {
    expect(await ops.recoverEmail(RECOVER)).toBe(true);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        email: 'Old@example.test',
        emailLower: 'old@example.test',
        emailVerifiedAt: expect.any(Date) as unknown as Date,
        // CLEARED on a restore. The account is back on the address it had, so the
        // change the cooldown existed for has been undone — and the person who just
        // proved the released mailbox is the owner the freeze was protecting. Leaving
        // it set would lock the victim of a takeover out of the password change and
        // factor sweep they need next.
        emailChangedAt: null,
      },
    });

    // An account does not hold a reservation against its own live address — leaving one
    // would make it a mailbox that must answer its next change.
    const deletes = tx.retainedEmail.deleteMany.mock.calls as [{ where: Record<string, unknown> }][];
    expect(deletes.some(([c]) => c.where.id === RECORD_ID)).toBe(true);
  });

  it('keeps the record on a replace, with a fresh window and a fresh ticket', async () => {
    await ops.recoverEmail({
      ...RECOVER,
      intent: 'replace',
      targetEmail: 'Third@example.test',
      targetEmailLower: 'third@example.test',
    });

    const renew = (tx.retainedEmail.updateMany.mock.calls as [{ data: Record<string, unknown> }][])
      .map(([c]) => c.data)
      .find((data) => data.recoveryTokenHash !== undefined);

    expect(renew?.recoveryTokenHash).toBe('renewed-hash');
    expect(renew?.expiresAt).toBe(RECOVER.renewedExpiresAt);
    // Un-spent: the window is fresh, so the ticket that goes with it must be spendable
    // again. The OLD token no longer matches the stored hash, which is what retires it.
    expect(renew?.recoveryConsumedAt).toBeNull();
  });

  it('never reserves the address being taken away', async () => {
    // In the case this flow exists for that is an attacker's address. Reserving it would
    // withhold it from its rightful owner AND make it a mailbox that must answer the
    // victim's next change — handing the attacker exactly the veto recovery exists to
    // remove.
    await ops.recoverEmail(RECOVER);

    expect(tx.retainedEmail.create).not.toHaveBeenCalled();
  });

  it('reclaims a target the account itself had released, without touching the ticket row', async () => {
    await ops.recoverEmail({
      ...RECOVER,
      intent: 'replace',
      targetEmailLower: 'third@example.test',
    });

    const reclaim = (
      tx.retainedEmail.deleteMany.mock.calls as [{ where: Record<string, unknown> }][]
    )
      .map(([c]) => c.where)
      .find((where) => where.emailLower === 'third@example.test');

    expect(reclaim?.userId).toBe(USER_ID);
    expect(reclaim?.id).toEqual({ not: RECORD_ID });
  });

  it('is scoped to the caller, so one account cannot spend another’s ticket', async () => {
    await ops.recoverEmail({ ...RECOVER, userId: OTHER_USER_ID });

    const [[claim]] = tx.retainedEmail.updateMany.mock.calls as [[{ where: { userId?: string } }]];
    expect(claim.where.userId).toBe(OTHER_USER_ID);
  });
});
