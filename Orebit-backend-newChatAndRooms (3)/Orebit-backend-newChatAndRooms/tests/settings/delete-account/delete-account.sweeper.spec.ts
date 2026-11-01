import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { AccountPurgeSweeper } from '../../../src/settings/delete-account/delete-account.sweeper';
import { makeUser } from '../../harness';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * This class is the only thing that ever erases an account, and the only thing that
 * ever writes `User.deletedAt`. Everything asserted below is a property the thirty-day
 * promise rests on:
 *
 *   - it purges only what is DUE, so nobody loses an account early;
 *   - it is safe to run twice, because every instance in a deployment runs it
 *     concurrently and a retry after a partial failure must not double-destroy;
 *   - one row's failure does not abandon the batch, because a sweep that dies takes
 *     the interval with it and this is the only thing that completes a deletion;
 *   - the delivery-log scrub is allowed to fail on its own, because rolling back an
 *     erasure over an audit-log write would be the worse outcome.
 *
 * ─── On the double ──────────────────────────────────────────────────────────
 *
 * `purgeAccount` models the real conditional claim rather than returning a constant:
 * it writes only when the row is still DELETED, unpurged and due, and reports whether
 * it wrote. A stub that always answered `true` would let the idempotency assertions
 * pass against an implementation that has none.
 *
 * The timer is never allowed to fire. `sweep()` is public precisely so a spec can drive
 * it directly, and no spec in this repository lets an interval run.
 */

const HOUR_MS = 60 * 60 * 1000;

/** An account inside its recovery window, due at `purgeAt`. */
function dueUser(id: string, purgeAt: Date): User {
  return makeUser({
    id,
    emailLower: `${id}@example.test`,
    status: 'DELETED',
    deletedAt: null,
    deletionRequestedAt: new Date(purgeAt.getTime() - 30 * 24 * HOUR_MS),
    purgeAt,
  });
}

function createUsers(rows: User[] = []) {
  const state = { rows };

  return {
    state,
    listDuePurges: vi.fn(async (now: Date, take: number) =>
      state.rows
        .filter(
          (row) =>
            row.status === 'DELETED' && row.deletedAt === null && (row.purgeAt?.getTime() ?? Infinity) <= now.getTime(),
        )
        .sort((a, b) => (a.purgeAt?.getTime() ?? 0) - (b.purgeAt?.getTime() ?? 0))
        .slice(0, take),
    ),
    // Returns the addresses to scrub, or null when the claim matched nothing — the real
    // contract. It hands back BOTH forms of the account's address plus a released one,
    // because the whole point of returning a list is that a purge must reach every
    // address the account ever answered to, not just its current one.
    purgeAccount: vi.fn(async (id: string, now: Date): Promise<readonly string[] | null> => {
      const row = state.rows.find((candidate) => candidate.id === id);
      // The real claim: still DELETED, not already purged, still due.
      if (row === undefined || row.status !== 'DELETED' || row.deletedAt !== null) return null;
      if ((row.purgeAt?.getTime() ?? Infinity) > now.getTime()) return null;
      state.rows = state.rows.map((candidate) =>
        candidate.id === id ? { ...candidate, deletedAt: now } : candidate,
      );
      return [row.email, row.emailLower, `old-${row.emailLower}`];
    }),
    scrubMailDeliveries: vi.fn(async (_recipients: readonly string[]) => 1),
  };
}

function sweeperFor(users: ReturnType<typeof createUsers>) {
  return new AccountPurgeSweeper(users as never);
}

describe('AccountPurgeSweeper.sweep', () => {
  it('purges an account whose window has closed', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);

    await sweeperFor(users).sweep();

    expect(users.purgeAccount).toHaveBeenCalledWith('u1', expect.any(Date));
    expect(users.state.rows[0]?.deletedAt).not.toBeNull();
  });

  it('leaves an account whose window is still open', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() + HOUR_MS))]);

    await sweeperFor(users).sweep();

    // The account is DELETED but not yet due. Purging it here would take a recovery
    // window away from somebody who still has one.
    expect(users.purgeAccount).not.toHaveBeenCalled();
    expect(users.state.rows[0]?.deletedAt).toBeNull();
  });

  it('writes deletedAt — the one thing that makes a deletion terminal', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);

    await sweeperFor(users).sweep();

    // Until this write the row still resolves in every lookup and still holds its email
    // and username. After it, neither is true and there is no path back.
    expect(users.state.rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a second pass purges nothing', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    const sweeper = sweeperFor(users);

    await sweeper.sweep();
    users.purgeAccount.mockClear();
    await sweeper.sweep();

    // Every instance in a multi-instance deployment runs this concurrently. The claim
    // re-states its preconditions, so the second writer matches no rows.
    expect(users.purgeAccount).not.toHaveBeenCalled();
  });

  it('reports nothing when another instance claimed the row first', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    users.purgeAccount.mockResolvedValue(null);

    await sweeperFor(users).sweep();

    // A `false` is not a failure: the account was reactivated between the read and the
    // write, or another instance got there first. Both are states this sweep wanted, so
    // nothing downstream of the claim runs.
    expect(users.scrubMailDeliveries).not.toHaveBeenCalled();
  });

  it('skips an account reactivated between the read and the write', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    users.listDuePurges.mockResolvedValue([users.state.rows[0] as User]);
    // The owner restored it after the unlocked read.
    users.state.rows = [makeUser({ id: 'u1', status: 'ACTIVE', deletedAt: null, purgeAt: null })];

    await sweeperFor(users).sweep();

    expect(users.state.rows[0]?.status).toBe('ACTIVE');
    expect(users.state.rows[0]?.deletedAt).toBeNull();
  });

  it('scrubs the delivery log for EVERY address the purge reported', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);

    await sweeperFor(users).sweep();

    // The list comes from inside the purge transaction, collected before anything was
    // destroyed. Reading `user.emailLower` here instead would scrub the current address
    // and miss every address the account had RELEASED by changing its email — whose
    // `retained_emails` rows the purge itself deletes, making them unlocatable
    // afterwards. `mail_deliveries` has no foreign key, so this is the only way in.
    const [recipients] = users.scrubMailDeliveries.mock.calls[0] as [readonly string[]];
    expect(recipients).toContain('u1@example.test');
    expect(recipients).toContain('old-u1@example.test');
    expect(recipients.length).toBeGreaterThan(1);
  });

  it('does not scrub the delivery log when the claim matched nothing', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    users.purgeAccount.mockResolvedValue(null);

    await sweeperFor(users).sweep();

    expect(users.scrubMailDeliveries).not.toHaveBeenCalled();
  });

  it('does not roll back a purge when the delivery-log scrub fails', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    users.scrubMailDeliveries.mockRejectedValue(new Error('delivery log unavailable'));

    await expect(sweeperFor(users).sweep()).resolves.toBeUndefined();

    // Rolling back would leave the account's credentials destroyed and its state still
    // due — strictly worse than a delivery log that keeps an address for one more tick.
    expect(users.state.rows[0]?.deletedAt).not.toBeNull();
  });

  it('continues the batch when one row fails', async () => {
    const users = createUsers([
      dueUser('u1', new Date(Date.now() - 2 * HOUR_MS)),
      dueUser('u2', new Date(Date.now() - HOUR_MS)),
    ]);
    users.purgeAccount.mockImplementationOnce(async () => {
      throw new Error('deadlock');
    });

    await sweeperFor(users).sweep();

    // There is no cursor to advance past the failure: the failed row stays due and the
    // next sweep picks it up again.
    expect(users.purgeAccount).toHaveBeenCalledTimes(2);
    expect(users.purgeAccount).toHaveBeenLastCalledWith('u2', expect.any(Date));
  });

  it('never throws, even when the listing fails', async () => {
    const users = createUsers();
    users.listDuePurges.mockRejectedValue(new Error('database unavailable'));

    // A sweep that dies takes the interval with it, and this is the only thing that
    // completes a deletion.
    await expect(sweeperFor(users).sweep()).resolves.toBeUndefined();
  });

  it('bounds the batch so a backlog cannot become one unbounded read', async () => {
    const users = createUsers();

    await sweeperFor(users).sweep();

    const [, take] = users.listDuePurges.mock.calls[0] as [Date, number];
    expect(take).toBeGreaterThan(0);
    // Smaller than the social sweeper's 200: retiring a link is one UPDATE, purging an
    // account is a transaction across fourteen tables.
    expect(take).toBeLessThanOrEqual(50);
  });

  it('uses one instant for the whole pass', async () => {
    const users = createUsers([
      dueUser('u1', new Date(Date.now() - 2 * HOUR_MS)),
      dueUser('u2', new Date(Date.now() - HOUR_MS)),
    ]);

    await sweeperFor(users).sweep();

    // Captured before the query and reused for the writes, so an account that comes due
    // mid-sweep is caught by the next pass rather than falling between read and update.
    const [listedAt] = users.listDuePurges.mock.calls[0] as [Date, number];
    for (const [, purgedAt] of users.purgeAccount.mock.calls as [string, Date][]) {
      expect(purgedAt.getTime()).toBe(listedAt.getTime());
    }
  });

  it('takes the oldest deadline first', async () => {
    const users = createUsers([
      dueUser('newer', new Date(Date.now() - HOUR_MS)),
      dueUser('older', new Date(Date.now() - 5 * HOUR_MS)),
    ]);

    await sweeperFor(users).sweep();

    expect((users.purgeAccount.mock.calls[0] as [string, Date])[0]).toBe('older');
  });
});

describe('AccountPurgeSweeper — lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('sweeps once at boot, before the first interval', async () => {
    const users = createUsers([dueUser('u1', new Date(Date.now() - HOUR_MS))]);
    const sweeper = sweeperFor(users);

    sweeper.onApplicationBootstrap();
    // Not awaited by the hook — startup must not block on a database round trip — so
    // yield once to let the floating promise settle.
    await new Promise((resolve) => setImmediate(resolve));
    sweeper.onApplicationShutdown();

    // Without the boot pass, a restart silently costs up to a full interval for every
    // account that came due while nothing was running.
    expect(users.purgeAccount).toHaveBeenCalledWith('u1', expect.any(Date));
  });

  it('does not hold the process open', () => {
    const users = createUsers();
    const sweeper = sweeperFor(users);
    const unref = vi.fn();
    const spy = vi.spyOn(global, 'setInterval').mockReturnValue({ unref } as never);

    sweeper.onApplicationBootstrap();

    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
    sweeper.onApplicationShutdown();
  });

  it('clears its timer on shutdown', () => {
    const users = createUsers();
    const sweeper = sweeperFor(users);
    const clear = vi.spyOn(global, 'clearInterval');

    sweeper.onApplicationBootstrap();
    sweeper.onApplicationShutdown();

    expect(clear).toHaveBeenCalled();
    // Idempotent: a second shutdown must not clear a timer that is already gone.
    expect(() => sweeper.onApplicationShutdown()).not.toThrow();
    clear.mockRestore();
  });
});

describe('the purge is atomic', () => {
  it('purges all-or-nothing, with the claim inside the transaction', () => {
    // A source-level assertion because the property is about transaction BOUNDARIES,
    // which a unit test with a doubled Prisma cannot observe.
    //
    // The failure it rules out: a claim committed on its own leaves a row marked purged
    // — and therefore invisible to `listDuePurges`, which filters `deletedAt: null` —
    // with every credential still on disk, and nothing that would ever look at it again.
    const dbop = readFileSync(
      join(process.cwd(), 'auth', 'persistence', 'user.dboperation.ts'),
      'utf8',
    );
    const body = dbop.slice(dbop.indexOf('async purgeAccount'));
    const method = body.slice(0, body.indexOf('\n  async '));

    const transactionAt = method.indexOf('$transaction');
    const claimAt = method.indexOf('deletedAt: now');

    expect(transactionAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(transactionAt);
    // And every destructive statement runs on the transaction client, never the outer
    // one — a stray `this.prisma.` inside would be outside the atomic unit.
    expect(method).not.toMatch(/this\.prisma\.(?!\$transaction)/);
  });
});

describe('the purge reaches the records a foreign key cannot', () => {
  // Source-level, because these are predicates inside one Prisma transaction and a
  // doubled client cannot observe them. Each assertion pins a gap that was real: the
  // first three were found in review and every one of them left PII on disk after a
  // purge reported success.
  const METHOD = (() => {
    const file = readFileSync(join(process.cwd(), 'auth', 'persistence', 'user.dboperation.ts'), 'utf8');
    const from = file.indexOf('async purgeAccount');
    // Bounded by the NEXT method in the file, so the slice needs no escape.
    return file.slice(from, file.indexOf('async scrubMailDeliveries', from));
  })();

  it('deletes sign-in attempts by identifier, not only by userId', () => {
    // `LoginAttempt.userId` is written only by `promoteAttempt`, which runs AFTER a
    // first factor succeeds. So every mistyped password and abandoned sign-in leaves a
    // row with userId NULL and `identifierLower` holding the address the user typed.
    // Nothing else ever removes those — the table has no retention sweep.
    expect(METHOD).toMatch(/loginAttempt\.deleteMany/);
    expect(METHOD).toMatch(/identifierLower:\s*\{\s*in:/);
  });

  it('scrubs registration attempts that never got a userId', () => {
    // `Registration.userId` is set only on the attempt that COMPLETED. Earlier attempts
    // at the same address keep their email and IP forever, and `SetNull` means a cascade
    // would never reach them either.
    expect(METHOD).toMatch(/registration\.findMany/);
    expect(METHOD).toMatch(/\{ userId \}, \{ emailLower: owner\.emailLower \}/);
  });

  it('nulls the provider profile photo on the registration row', () => {
    // `User.avatarUrl` is nulled, and it was COPIED from this at account creation.
    // Keeping the original would retain a fetchable picture of the person.
    expect(METHOD).toMatch(/oauthAvatarUrl: null/);
    expect(METHOD).toMatch(/oauthProvider: null/);
  });

  it('collects every address the account answered to, before destroying the records of them', () => {
    // `retained_emails` is the only record of the addresses an account RELEASED by
    // changing its email, and it is CASCADE — so the `DELETE FROM users` below takes it.
    // The collection has to happen first or those addresses are both un-scrubbed and
    // unlocatable.
    const collect = METHOD.indexOf('retainedEmail.findMany');
    const destroy = METHOD.indexOf('user.delete');
    expect(collect).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(-1);
    expect(collect).toBeLessThan(destroy);
  });

  it('physically DELETES the user row — no tombstone, no purged status', () => {
    // The requirement: after thirty days the account is completely gone. A surviving row
    // with a flag set is not that, and it is also a row a future query could mistake for
    // a recoverable one.
    expect(METHOD).toMatch(/tx\.user\.delete\(\{ where: \{ id: userId \} \}\)/);
    // Nothing scrubs `users` any more, because there is no row left to scrub.
    expect(METHOD).not.toMatch(/tx\.user\.update\(/);
  });

  it('scrubs the SET NULL survivor before the row goes', () => {
    // `registrations.user_id` is SET NULL, so the row outlives the user and a cascade
    // never reaches it. After the DELETE there is no `userId` left to find it by.
    const scrub = METHOD.indexOf('registration.updateMany');
    const destroy = METHOD.indexOf('user.delete');
    expect(scrub).toBeGreaterThan(-1);
    expect(scrub).toBeLessThan(destroy);
  });

  it('does the whole thing in ONE transaction', () => {
    // A crash must never leave "claimed" without "deleted". The claim is the first
    // statement inside the transaction and the DELETE is the last.
    const tx = METHOD.indexOf('$transaction');
    const claim = METHOD.indexOf('deletedAt: now');
    const destroy = METHOD.indexOf('user.delete');
    expect(tx).toBeGreaterThan(-1);
    expect(tx).toBeLessThan(claim);
    expect(claim).toBeLessThan(destroy);
    expect(METHOD).not.toMatch(/this\.prisma\.(?!\$transaction)/);
  });
});
