import { beforeEach, describe, expect, it } from 'vitest';
import type { User, UsernameReservation } from '@prisma/client';
import type { PrismaService } from '../../../db/client';
import { USERNAME } from '../../../auth/auth.constants';
import {
  UsernamePaymentRequiredError,
  UsernameRaceLostError,
  UsernameReservationDbOperation,
  UsernameTakenError,
} from '../../../auth/persistence/username-reservation.dboperation';
import { isProtectedReservation } from '../../../src/settings/username/username.utility';
import { makeUser } from '../../harness';

/**
 * The transaction that moves a username, tested against a stateful in-memory model
 * rather than mocks.
 *
 * The behaviour under test is a SEQUENCE — A becomes reserved, B is released a minute
 * later and A's deadline does not move — and a spec built from `mockResolvedValue`
 * cannot express that. So the double below is a small database: rows go in, predicates
 * match against them, and the assertions read the resulting state. That is also the
 * only way to catch the failure this feature is most likely to have, which is a `where`
 * clause that quietly matches the wrong rows.
 *
 * It also records the ORDER of the calls, because the advisory lock has to come first
 * and nothing else would notice if it stopped doing so.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';

const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_MS = USERNAME.RETENTION_DAYS * DAY_MS;
const SHORT_MS = USERNAME.RELEASE_SECONDS * 1000;

interface Store {
  users: User[];
  reservations: UsernameReservation[];
  calls: string[];
}

/** The query shapes this dboperation issues, and no others. Spelling them out rather
 *  than reaching for `any` keeps the double honest: a call with an argument shape it
 *  does not model will not type-check. */
type Where = Record<string, unknown>;
type OrderBy = Record<string, 'asc' | 'desc'>;
interface FindArgs {
  where?: Where;
  orderBy?: OrderBy;
}
interface WriteArgs {
  where: Where;
  data: Record<string, unknown>;
}
interface CreateArgs {
  data: Record<string, unknown>;
}

let store: Store;
let ops: UsernameReservationDbOperation;
let nextId: number;

/** Only the predicate shapes this dboperation actually issues. An unrecognised key
 *  throws rather than matching everything, so a new query cannot pass by accident. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === 'object') {
      const condition = value as Record<string, unknown>;
      if ('gt' in condition) return (row[key] as Date).getTime() > (condition.gt as Date).getTime();
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      throw new Error(`unhandled condition on ${key}: ${JSON.stringify(condition)}`);
    }
    return row[key] === value;
  });
}

function makeClient(): Record<string, unknown> {
  const reservationModel = {
    findFirst: async ({ where, orderBy }: FindArgs) => {
      const found = store.reservations.filter((row) => matches(row as never, where ?? {}));
      if (orderBy?.expiresAt === 'desc') {
        found.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
      }
      if (orderBy?.createdAt === 'asc') {
        found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
      return found[0] === undefined ? null : { ...found[0] };
    },
    findMany: async ({ where, orderBy }: FindArgs) => {
      const found = store.reservations.filter((row) => matches(row as never, where ?? {}));
      if (orderBy?.expiresAt === 'desc') {
        found.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
      }
      return found;
    },
    count: async ({ where }: FindArgs) =>
      store.reservations.filter((row) => matches(row as never, where ?? {})).length,
    create: async ({ data }: CreateArgs) => {
      store.calls.push('reservation.create');
      const row = { ...data } as UsernameReservation;
      row.createdAt ??= new Date();
      store.reservations.push(row);
      return row;
    },
    updateMany: async ({ where, data }: WriteArgs) => {
      const found = store.reservations.filter((row) => matches(row as never, where ?? {}));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
  };

  // Every read returns a COPY. Prisma hands back detached plain objects, and a double
  // that returned live references would let production code accidentally depend on a
  // read reflecting a later write — which is exactly the bug this caught.
  const userModel = {
    findFirst: async ({ where }: FindArgs) => {
      const found = store.users.find((row) => matches(row as never, where ?? {}));
      return found === undefined ? null : { ...found };
    },
    findFirstOrThrow: async ({ where }: FindArgs) => {
      const found = store.users.find((row) => matches(row as never, where ?? {}));
      if (found === undefined) throw new Error('no such user');
      return { ...found };
    },
    count: async ({ where }: FindArgs) => store.users.filter((row) => matches(row as never, where ?? {})).length,
    findMany: async ({ where }: FindArgs) => store.users.filter((row) => matches(row as never, where ?? {})),
    updateMany: async ({ where, data }: WriteArgs) => {
      const found = store.users.filter((row) => matches(row as never, where ?? {}));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
  };

  const client: Record<string, unknown> = {
    user: userModel,
    usernameReservation: reservationModel,
    // The advisory lock arrives as raw SQL, through `$executeRaw` — the function
    // returns `void`, and `$queryRaw` would try to deserialise that. See
    // `lockUsernameClaim`. Recording it is the whole point: the lock has to be taken
    // before anything is read, and a regression there is invisible otherwise.
    $executeRaw: async () => {
      store.calls.push('advisory-lock');
      return 0;
    },
    // Doubled but unused, deliberately — see the note in user.dboperation.spec.ts.
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return client;
}

function seedUser(username: string, userId = USER_ID): void {
  store.users.push(
    makeUser({ id: userId, username, usernameLower: username.toLowerCase(), deletedAt: null }),
  );
}

function seedReservation(overrides: Partial<UsernameReservation>): UsernameReservation {
  nextId += 1;
  const createdAt = overrides.createdAt ?? new Date();
  const row: UsernameReservation = {
    id: `01940000-0000-7000-8000-0000000${String(nextId).padStart(5, '0')}`,
    userId: USER_ID,
    username: 'seed',
    usernameLower: 'seed',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + LONG_MS),
    ...overrides,
  };
  store.reservations.push(row);
  return row;
}

/** The production caller's own arguments, so the spec exercises the real policy rather
 *  than a simplified one. */
function change(username: string, overrides: Record<string, unknown> = {}) {
  const current = store.users.find((u) => u.id === USER_ID);
  return ops.changeUsername({
    userId: USER_ID,
    username,
    usernameLower: username.toLowerCase(),
    expectedCurrentLower: current?.usernameLower ?? '',
    windowStart: new Date(Date.now() - USERNAME.RETENTION_DAYS * DAY_MS),
    // Generous by default so the lifecycle blocks can make four changes without
    // tripping the allowance. The blocks that are ABOUT the allowance pass their own,
    // so the number being tested is always stated where it is tested.
    freeChanges: 10,
    protectedReclaim: isProtectedReservation,
    expiresAtFor: (churning: boolean) =>
      new Date(Date.now() + (churning ? SHORT_MS : LONG_MS)),
    ...overrides,
  });
}

const reservationFor = (usernameLower: string) =>
  store.reservations.find((row) => row.usernameLower === usernameLower);

const isLive = (row: UsernameReservation | undefined) =>
  row !== undefined && row.expiresAt.getTime() > Date.now();

beforeEach(() => {
  nextId = 0;
  store = { users: [], reservations: [], calls: [] };
  ops = new UsernameReservationDbOperation(makeClient() as unknown as PrismaService);
});

describe('changeUsername — the lock comes first', () => {
  it('takes the advisory lock before reading anything', async () => {
    seedUser('alpha_one');
    await change('bravo_two');

    // Not "before the write" — before the READ. A reservation committing between an
    // availability check and an insert lands on the wrong side of the check, which is
    // the entire window the lock exists to close.
    expect(store.calls[0]).toBe('advisory-lock');
    expect(store.calls.indexOf('advisory-lock')).toBeLessThan(
      store.calls.indexOf('reservation.create'),
    );
  });
});

describe('changeUsername — the previous-username lifecycle', () => {
  it('A -> B reserves A for the full retention period', async () => {
    seedUser('alpha_one');

    const result = await change('bravo_two');

    expect(result.user.usernameLower).toBe('bravo_two');
    expect(result.released.username).toBe('alpha_one');

    const alpha = reservationFor('alpha_one');
    expect(isLive(alpha)).toBe(true);
    // Within a second of thirty days out.
    expect(alpha!.expiresAt.getTime() - Date.now()).toBeGreaterThan(LONG_MS - 1000);
    expect(isProtectedReservation(alpha!)).toBe(true);
  });

  it('B -> C releases B in minutes and does NOT extend A', async () => {
    seedUser('alpha_one');
    await change('bravo_two');
    const alphaDeadline = reservationFor('alpha_one')!.expiresAt.getTime();

    await change('charlie_x');

    // A is untouched. This is the requirement's sharpest edge: the first reservation's
    // deadline is fixed at the change that created it and later churn cannot extend it.
    expect(reservationFor('alpha_one')!.expiresAt.getTime()).toBe(alphaDeadline);
    expect(isLive(reservationFor('alpha_one'))).toBe(true);

    // B is a churn release, not a thirty-day hold.
    const bravo = reservationFor('bravo_two')!;
    expect(bravo.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SHORT_MS);
    expect(isProtectedReservation(bravo)).toBe(false);
  });

  it('C -> D leaves A reserved, B available, and C releasing', async () => {
    seedUser('alpha_one');
    await change('bravo_two');
    await change('charlie_x');

    // Age B past its short window without touching anything else.
    reservationFor('bravo_two')!.expiresAt = new Date(Date.now() - 1000);

    await change('delta_four');

    expect(isLive(reservationFor('alpha_one'))).toBe(true);
    expect(isLive(reservationFor('bravo_two'))).toBe(false);
    expect(isProtectedReservation(reservationFor('charlie_x')!)).toBe(false);
    expect(store.users[0]!.usernameLower).toBe('delta_four');
  });

  it('never reserves more than one username for the long window', async () => {
    seedUser('alpha_one');
    await change('bravo_two');
    await change('charlie_x');
    await change('delta_four');

    const protectedRows = store.reservations.filter(isProtectedReservation);
    // The failure this guards is the obvious wrong implementation: reserving every
    // previous username for thirty days, which lets one account burn names without limit.
    expect(protectedRows).toHaveLength(1);
    expect(protectedRows[0]!.usernameLower).toBe('alpha_one');
  });

  it('starts a fresh long reservation once the previous one has lapsed', async () => {
    seedUser('alpha_one');
    await change('bravo_two');

    // Thirty days later: nothing of this account's is live any more.
    reservationFor('alpha_one')!.expiresAt = new Date(Date.now() - 1000);

    await change('charlie_x');

    // Not churn any more — this is the first change of a new sequence.
    expect(isProtectedReservation(reservationFor('bravo_two')!)).toBe(true);
  });
});

describe('changeUsername — availability under the lock', () => {
  it('refuses a username a live account holds', async () => {
    seedUser('alpha_one');
    seedUser('taken_name', OTHER_USER_ID);

    await expect(change('taken_name')).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it("refuses a username inside somebody else's reservation", async () => {
    seedUser('alpha_one');
    seedReservation({ userId: OTHER_USER_ID, username: 'their_old', usernameLower: 'their_old' });

    await expect(change('their_old')).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it('allows a username whose reservation has expired', async () => {
    seedUser('alpha_one');
    const stale = new Date(Date.now() - LONG_MS - 1000);
    seedReservation({
      userId: OTHER_USER_ID,
      username: 'their_old',
      usernameLower: 'their_old',
      createdAt: stale,
      expiresAt: new Date(Date.now() - 1000),
    });

    // Availability is a time predicate, so nothing had to run for this to become free.
    await expect(change('their_old')).resolves.toMatchObject({
      user: expect.objectContaining({ usernameLower: 'their_old' }),
    });
  });

  it('writes nothing when it refuses', async () => {
    seedUser('alpha_one');
    seedUser('taken_name', OTHER_USER_ID);

    await expect(change('taken_name')).rejects.toBeInstanceOf(UsernameTakenError);

    expect(store.reservations).toHaveLength(0);
    expect(store.users[0]!.usernameLower).toBe('alpha_one');
  });
});

describe('changeUsername — the free allowance', () => {
  /** Two free changes per window — the shipped default, stated here because these are
   *  the tests that are about it. */
  const free = (username: string) => change(username, { freeChanges: 2 });

  it('permits changes up to the allowance and refuses the next one', async () => {
    seedUser('alpha_one');

    await free('bravo_two');
    await free('charlie_x');

    await expect(free('delta_four')).rejects.toBeInstanceOf(UsernamePaymentRequiredError);
  });

  it('reports how many changes are in the window so the caller need not re-count', async () => {
    seedUser('alpha_one');

    expect((await free('bravo_two')).changesInWindow).toBe(1);
    expect((await free('charlie_x')).changesInWindow).toBe(2);
  });

  it('ignores changes older than the window', async () => {
    seedUser('alpha_one');
    // Two changes, both from long before the rolling window opened.
    const old = new Date(Date.now() - 90 * DAY_MS);
    seedReservation({ username: 'ancient1', usernameLower: 'ancient1', createdAt: old, expiresAt: old });
    seedReservation({ username: 'ancient2', usernameLower: 'ancient2', createdAt: old, expiresAt: old });

    await expect(free('bravo_two')).resolves.toBeDefined();
  });

  it('changes nothing when payment is required', async () => {
    seedUser('alpha_one');
    await free('bravo_two');
    await free('charlie_x');

    await expect(free('delta_four')).rejects.toBeInstanceOf(UsernamePaymentRequiredError);

    expect(store.users[0]!.usernameLower).toBe('charlie_x');
    expect(reservationFor('charlie_x')).toBeUndefined();
  });
});

describe('changeUsername — reclaiming your own username', () => {
  /** These are about what happens once the allowance is GONE, so they use the real one. */
  const free = (username: string) => change(username, { freeChanges: 2 });

  it('lets the owner take back a protected reservation with the allowance spent', async () => {
    seedUser('alpha_one');
    await free('bravo_two'); // alpha_one reserved, protected
    await free('charlie_x'); // allowance now spent

    // The point of the whole mechanism: after a takeover the owner must be able to get
    // their identity back, and an owner who cannot pay is exactly who it is for.
    await expect(free('alpha_one')).resolves.toMatchObject({
      user: expect.objectContaining({ usernameLower: 'alpha_one' }),
    });
  });

  it('does NOT waive the charge for a churn release', async () => {
    seedUser('alpha_one');
    await free('bravo_two');
    await free('charlie_x'); // bravo_two released short; allowance spent

    // Taking `bravo_two` back is a reclaim, but of a few-minute churn release rather
    // than the protected reservation. Waiving this is what would make an
    // A -> B -> A -> B ping-pong free forever.
    await expect(free('bravo_two')).rejects.toBeInstanceOf(UsernamePaymentRequiredError);
  });

  it('expires the reclaimed row rather than deleting it, so the ledger survives', async () => {
    seedUser('alpha_one');
    await change('bravo_two');
    const before = store.reservations.length;

    await change('alpha_one');

    // Deleting would erase the change that created the row, and the allowance is
    // counted from exactly those rows — which is how a ping-pong would reset it.
    expect(store.reservations.length).toBe(before + 1);
    expect(isLive(reservationFor('alpha_one'))).toBe(false);
  });

  it('treats a reclaim as churn, so the name given up comes back in minutes', async () => {
    seedUser('alpha_one');
    await change('bravo_two');

    await change('alpha_one');

    expect(isProtectedReservation(reservationFor('bravo_two')!)).toBe(false);
  });
});

describe('changeUsername — losing the race', () => {
  it('refuses when the account username moved since the caller read it', async () => {
    seedUser('alpha_one');

    await expect(
      change('bravo_two', { expectedCurrentLower: 'something_else' }),
    ).rejects.toBeInstanceOf(UsernameRaceLostError);

    expect(store.reservations).toHaveLength(0);
  });

  it('refuses for an account that no longer exists', async () => {
    await expect(change('bravo_two')).rejects.toBeInstanceOf(UsernameRaceLostError);
  });
});

describe('renameForCompliance — idempotent by construction', () => {
  const rename = (candidate: string, expected: string) =>
    ops.renameForCompliance({
      userId: USER_ID,
      username: candidate,
      usernameLower: candidate,
      expectedCurrentLower: expected,
      stillNonCompliant: (u) => u.length < USERNAME.DEFAULT_MIN_LENGTH,
    });

  it('lengthens a short username and reports that it wrote', async () => {
    seedUser('ab');

    await expect(rename('ab_x7q29', 'ab')).resolves.toBe(true);
    expect(store.users[0]!.usernameLower).toBe('ab_x7q29');
  });

  it('writes nothing on a second run — the length guard is the whole contract', async () => {
    seedUser('ab');
    await rename('ab_x7q29', 'ab');

    // A restart, a second instance, or a duplicate entry in the sweeper's list.
    await expect(rename('ab_a1b2c', 'ab')).resolves.toBe(false);
    expect(store.users[0]!.usernameLower).toBe('ab_x7q29');
  });

  it('writes nothing when the user renamed themselves in the meantime', async () => {
    seedUser('ab');
    store.users[0]!.usernameLower = 'chosen_name';

    await expect(rename('ab_x7q29', 'ab')).resolves.toBe(false);
    expect(store.users[0]!.usernameLower).toBe('chosen_name');
  });

  it('writes nothing when the username is already compliant', async () => {
    seedUser('long_enough');

    await expect(rename('long_enough_x', 'long_enough')).resolves.toBe(false);
  });

  it('writes nothing for a soft-deleted account', async () => {
    seedUser('ab');
    store.users[0]!.deletedAt = new Date();

    await expect(rename('ab_x7q29', 'ab')).resolves.toBe(false);
  });

  it('refuses a candidate that is taken or reserved, so the caller can retry', async () => {
    seedUser('ab');
    seedUser('ab_x7q29', OTHER_USER_ID);

    await expect(rename('ab_x7q29', 'ab')).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it('never writes a reservation — the account did not choose this change', async () => {
    seedUser('ab');
    await rename('ab_x7q29', 'ab');

    // No allowance spent and no thirty-day hold on a two-character name that somebody
    // else may now legitimately be entitled to.
    expect(store.reservations).toHaveLength(0);
  });

  it('takes the advisory lock first, in the same order as the change path', async () => {
    seedUser('ab');
    await rename('ab_x7q29', 'ab');

    // The lock order is what makes a deadlock against `changeUsername` unreachable.
    expect(store.calls[0]).toBe('advisory-lock');
  });
});

describe('availability and filterAvailable', () => {
  it('reports a live account as taken', async () => {
    seedUser('alpha_one');
    await expect(ops.availability('alpha_one')).resolves.toMatchObject({ takenByAccount: true });
  });

  it('reports an expired reservation as no reservation at all', async () => {
    seedReservation({
      username: 'lapsed',
      usernameLower: 'lapsed',
      createdAt: new Date(Date.now() - LONG_MS - 2000),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(ops.availability('lapsed')).resolves.toEqual({
      takenByAccount: false,
      reservation: null,
    });
  });

  it('filters a batch in one pass and preserves preference order', async () => {
    seedUser('taken_one');
    seedReservation({ username: 'held_name', usernameLower: 'held_name' });

    await expect(
      ops.filterAvailable(['free_one', 'taken_one', 'free_two', 'held_name']),
    ).resolves.toEqual(['free_one', 'free_two']);
  });

  it('returns nothing for an empty batch without querying', async () => {
    await expect(ops.filterAvailable([])).resolves.toEqual([]);
  });
});
