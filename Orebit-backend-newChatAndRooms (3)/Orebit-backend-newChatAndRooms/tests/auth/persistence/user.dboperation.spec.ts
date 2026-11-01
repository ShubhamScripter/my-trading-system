import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../db/client';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { UsernameTakenError } from '../../../auth/persistence/username-reservation.dboperation';
import { uniqueViolation } from '../../harness';

/**
 * `createAccount`, and specifically the half of username availability that
 * `ix_users_username_active` cannot enforce.
 *
 * That index constrains LIVE ACCOUNTS. Since usernames became changeable, a name can
 * also be RESERVED — held by an account that released it and may want it back — and
 * that lives in a different table which no index on `users` can see. So a signup that
 * only inserted and caught would satisfy the index perfectly while handing a new
 * account somebody else's released username.
 *
 * The calls are recorded in order because the fix is not just "check the reservation"
 * but "take the lock, THEN check": a reservation committing between a check and an
 * insert lands on the wrong side of the check, which is the window the lock closes.
 */

const RESERVATION_ID = '01940000-0000-7000-8000-0000000000e1';

let calls: string[];
let reservationCount: number;
let ops: UserDbOperation;
let userCreate: ReturnType<typeof vi.fn>;
let reservationCountArgs: unknown;
let lockedValues: unknown[];

function input(username = 'alpha_one') {
  return {
    email: 'Ada@Example.test',
    emailLower: 'ada@example.test',
    emailVerified: true,
    username,
    publicCode: 'OREBiT7Q9K2M4X',
    publicCodeKey: 'OREBIT7Q9K2M4X',
    referralCode: 'ABCD1234',
    referredByCode: null,
    referredByUserId: null,
    country: 'GB',
    countryIp: null,
    avatarUrl: null,
    passwordHash: 'argon2-hash',
    oauth: null,
    registrationId: RESERVATION_ID,
  };
}

beforeEach(() => {
  calls = [];
  reservationCount = 0;
  reservationCountArgs = undefined;
  lockedValues = [];

  userCreate = vi.fn().mockImplementation(async ({ data }: { data: unknown }) => {
    calls.push('user.create');
    return data;
  });

  const prisma: Record<string, unknown> = {
    user: { create: userCreate },
    credential: { create: vi.fn().mockResolvedValue({}) },
    oauthLink: { create: vi.fn().mockResolvedValue({}) },
    registration: { update: vi.fn().mockResolvedValue({}) },
    usernameReservation: {
      count: vi.fn().mockImplementation(async (args: unknown) => {
        calls.push('reservation.count');
        reservationCountArgs = args;
        return reservationCount;
      }),
    },
    // The advisory lock arrives as raw SQL, through `$executeRaw` — the function
    // returns `void`, and `$queryRaw` would try to deserialise that. See
    // `lockUsernameClaim`.
    //
    // `Prisma.sql` builds a prepared statement, so the username arrives as a bound
    // parameter rather than as SQL text — which is both the injection defence and how
    // this test can read what was actually locked.
    $executeRaw: vi.fn().mockImplementation(async (query: { values?: unknown[] }) => {
      calls.push('advisory-lock');
      lockedValues = query?.values ?? [];
      return 0;
    }),
    // Doubled but unused, deliberately: if the lock ever moves back to `$queryRaw` the
    // ordering assertions below stop seeing it and fail, rather than passing silently
    // against a statement a real Postgres would refuse.
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  ops = new UserDbOperation(prisma as unknown as PrismaService);
});

describe('createAccount — the username claim', () => {
  it('takes the advisory lock before it reads anything', async () => {
    await ops.createAccount(input());

    expect(calls[0]).toBe('advisory-lock');
    expect(calls.indexOf('advisory-lock')).toBeLessThan(calls.indexOf('reservation.count'));
  });

  it('checks the reservation before it inserts', async () => {
    await ops.createAccount(input());

    expect(calls.indexOf('reservation.count')).toBeLessThan(calls.indexOf('user.create'));
  });

  it('refuses a candidate somebody is still holding', async () => {
    reservationCount = 1;

    await expect(ops.createAccount(input())).rejects.toBeInstanceOf(UsernameTakenError);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it('accepts a candidate whose reservation has lapsed', async () => {
    // Liveness is `expires_at > now()`, evaluated per query — nothing has to run for a
    // reservation to stop blocking, so an expired one is simply not counted.
    reservationCount = 0;

    await expect(ops.createAccount(input())).resolves.toBeDefined();
    expect(reservationCountArgs).toMatchObject({
      where: { usernameLower: 'alpha_one', expiresAt: { gt: expect.any(Date) } },
    });
  });

  it('matches the reservation on the NORMALISED username', async () => {
    // The stored column is `username_lower`, and a check that compared the display
    // casing would miss every reservation whose owner typed capitals.
    await ops.createAccount(input('Alpha_One'));

    expect(reservationCountArgs).toMatchObject({ where: { usernameLower: 'alpha_one' } });
  });

  it('locks the same normalised value it checks', async () => {
    await ops.createAccount(input('Alpha_One'));

    // Two callers that disagreed about casing would take two different locks for one
    // name and serialise nothing at all.
    expect(lockedValues).toContain('alpha_one');
  });

  it('still stores the username in the casing the account chose', async () => {
    await ops.createAccount(input('Alpha_One'));

    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ username: 'Alpha_One', usernameLower: 'alpha_one' }),
      }),
    );
  });
});

/**
 * ═══ THE TWO DIRECTION-AWARE PASSWORD WRITES ════════════════════════════════
 *
 * `createPasswordIfAbsent` and `replacePassword` exist because `upsertPassword` is
 * direction-blind: it creates when there is no row and replaces when there is, and
 * cannot tell a caller which happened. For `src/settings/password/` the direction IS
 * the authorisation — `set` is authorised by the account having no password, `reset`
 * and `forgot` against an existing one — so each write states its precondition as a
 * PREDICATE and lets the database be the arbiter.
 *
 * A service-level read cannot substitute for that. There are hundreds of milliseconds
 * of argon2 between "does this account have a password?" and the write, which is ample
 * for a concurrent request to change the answer, and the unique index is the only
 * thing that cannot be raced.
 *
 * These assertions are therefore about the PREDICATES and the boolean, which is the
 * whole of what the callers depend on: `false` means "the precondition did not hold",
 * and a caller that received `true` may assume the write landed.
 */

const PASSWORD_USER_ID = '01940000-0000-7000-8000-0000000000d1';
const NEW_HASH = 'argon2-new';

/**
 * A fake Prisma centred on the `credentials` table.
 *
 * `uniqueViolation` models the `@@unique([userId, kind])` index, which is what makes
 * `createPasswordIfAbsent` race-safe. Constructed as the real error class from the
 * harness rather than a `{ code: 'P2002' }` literal, because `isUniqueViolation`
 * narrows with `instanceof` — a plain object would be rethrown as an unexpected error
 * and the refusal test would pass for the wrong reason.
 */
function passwordPrisma(options: {
  liveRow?: boolean;
  softDeletedRow?: boolean;
  emailChangedAt?: Date | null;
}) {
  const { liveRow = false, softDeletedRow = false, emailChangedAt = null } = options;
  const seen: string[] = [];

  const prisma: Record<string, unknown> = {
    credential: {
      updateMany: vi.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
        seen.push('updateMany');
        // The two writes pass different `deletedAt` predicates, and which one this is
        // decides what the fake should report.
        const wantsSoftDeleted =
          JSON.stringify(args.where['deletedAt'] ?? null).includes('not');
        if (wantsSoftDeleted) return { count: softDeletedRow ? 1 : 0 };
        return { count: liveRow ? 1 : 0 };
      }),
      create: vi.fn().mockImplementation(async () => {
        seen.push('create');
        if (liveRow) throw uniqueViolation('credentials_user_id_kind_key');
        return {};
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ email_changed_at: emailChangedAt }]),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return {
    ops: new UserDbOperation(prisma as unknown as PrismaService),
    prisma,
    seen,
  };
}

describe('createPasswordIfAbsent', () => {
  it('creates the credential when the account has none', async () => {
    const { ops: op, prisma } = passwordPrisma({});

    await expect(op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(true);

    const credential = prisma['credential'] as { create: ReturnType<typeof vi.fn> };
    expect(credential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: PASSWORD_USER_ID,
        kind: 'PASSWORD',
        passwordHash: NEW_HASH,
      }),
    });
  });

  it('refuses — without overwriting — when a live password already exists', async () => {
    // The write that must not happen. `false` rather than a throw, so the service can
    // answer `password_already_set` rather than a 500.
    const { ops: op } = passwordPrisma({ liveRow: true });

    await expect(op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(false);
  });

  it('lets the UNIQUE INDEX be the arbiter, not a prior read', async () => {
    // What makes two concurrent `set` requests safe: the loser learns from 23505, so
    // it does not matter that both observed an account with no password.
    const { ops: op, seen } = passwordPrisma({ liveRow: true });

    await op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH);

    expect(seen).toContain('create');
  });

  it('rethrows an error that is not a unique violation', async () => {
    // A connection failure must not be reported as "a password already exists",
    // which would send the caller to `reset` for an account that has none.
    const { ops: op, prisma } = passwordPrisma({});
    const credential = prisma['credential'] as { create: ReturnType<typeof vi.fn> };
    credential.create.mockRejectedValue(new Error('connection reset'));

    await expect(op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH)).rejects.toThrow(
      'connection reset',
    );
  });

  it('revives a soft-deleted row instead of colliding with it', async () => {
    // Unreachable today — nothing soft-deletes a credential — but the unique index
    // does NOT exclude soft-deleted rows, so such an account would read as "no
    // password" and yet refuse a create: neither `set` nor `reset` would work.
    const { ops: op, prisma, seen } = passwordPrisma({ softDeletedRow: true });

    await expect(op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(true);

    const credential = prisma['credential'] as { create: ReturnType<typeof vi.fn> };
    expect(credential.create).not.toHaveBeenCalled();
    expect(seen).toEqual(['updateMany']);
  });

  it('is refused by the row-locked cooldown, inside the transaction', async () => {
    // The last word on the freeze is taken HERE, not in the check the argon2 hash
    // outlived. A refusal throws, which rolls the transaction back with nothing
    // written.
    const { ops: op, prisma } = passwordPrisma({ emailChangedAt: new Date() });

    await expect(op.createPasswordIfAbsent(PASSWORD_USER_ID, NEW_HASH)).rejects.toThrow();

    const credential = prisma['credential'] as { create: ReturnType<typeof vi.fn> };
    expect(credential.create).not.toHaveBeenCalled();
  });
});

describe('replacePassword', () => {
  it('replaces an existing credential and clears the lockout', async () => {
    const { ops: op, prisma } = passwordPrisma({ liveRow: true });

    await expect(op.replacePassword(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(true);

    const credential = prisma['credential'] as { updateMany: ReturnType<typeof vi.fn> };
    expect(credential.updateMany).toHaveBeenCalledWith({
      where: { userId: PASSWORD_USER_ID, kind: 'PASSWORD', deletedAt: null },
      // A successful reset must not leave the account locked by the failures that
      // prompted it. `lockoutStrikes` is deliberately NOT cleared — matching
      // `upsertPassword` — because the ladder records how often this account has been
      // ground against, and a password change is not evidence that it has not been.
      data: { passwordHash: NEW_HASH, failedAttempts: 0, lockedUntil: null },
    });
  });

  it('refuses when there is no password to replace', async () => {
    // `updateMany` rather than `update`, so "no row" is an ordinary answer rather
    // than a P2025 the caller has to catch.
    const { ops: op } = passwordPrisma({});

    await expect(op.replacePassword(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(false);
  });

  it('never creates one', async () => {
    // The mirror of `createPasswordIfAbsent`'s guarantee: `reset` and `forgot` are
    // authorised against an EXISTING password, so a write that created one would
    // launder a flow whose preconditions were never checked.
    const { ops: op, prisma } = passwordPrisma({});

    await op.replacePassword(PASSWORD_USER_ID, NEW_HASH);

    const credential = prisma['credential'] as { create: ReturnType<typeof vi.fn> };
    expect(credential.create).not.toHaveBeenCalled();
  });

  it('ignores a soft-deleted row rather than reviving it', async () => {
    // `deletedAt: null` in the predicate. Reviving here would be a create in
    // disguise, on the path that must not create.
    const { ops: op } = passwordPrisma({ softDeletedRow: true });

    await expect(op.replacePassword(PASSWORD_USER_ID, NEW_HASH)).resolves.toBe(false);
  });

  it('is refused by the row-locked cooldown, inside the transaction', async () => {
    const { ops: op, prisma } = passwordPrisma({
      liveRow: true,
      emailChangedAt: new Date(),
    });

    await expect(op.replacePassword(PASSWORD_USER_ID, NEW_HASH)).rejects.toThrow();

    const credential = prisma['credential'] as { updateMany: ReturnType<typeof vi.fn> };
    expect(credential.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * The first reader of `@@index([userId])` on `oauth_links`.
 *
 * Every other OAuth path arrives holding a `(provider, subject)` pair and asks the
 * question from the other direction, so this predicate has no second implementation
 * to be checked against — the assertions below ARE the specification.
 */
describe('listOauthLinks — the settings screen, and the one-per-provider rule', () => {
  function linkPrisma() {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma: Record<string, unknown> = { oauthLink: { findMany } };
    return { ops: new UserDbOperation(prisma as unknown as PrismaService), findMany };
  }

  it('is scoped to one account', async () => {
    const { ops: op, findMany } = linkPrisma();
    await op.listOauthLinks('user-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it('excludes soft-deleted rows', async () => {
    // Unlinking is a soft delete. A retired row must not appear on the screen, and
    // must not make a provider look occupied when it is free to re-link.
    const { ops: op, findMany } = linkPrisma();
    await op.listOauthLinks('user-1');

    const [args] = findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where.deletedAt).toBeNull();
  });

  it('orders by when the link was made, so the screen is stable across reloads', async () => {
    const { ops: op, findMany } = linkPrisma();
    await op.listOauthLinks('user-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { linkedAt: 'asc' } }),
    );
  });
});
