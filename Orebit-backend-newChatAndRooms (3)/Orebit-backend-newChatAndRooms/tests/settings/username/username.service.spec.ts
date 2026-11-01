import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USERNAME } from '../../../auth/auth.constants';
import {
  UsernamePaymentRequiredError,
  UsernameRaceLostError,
  UsernameTakenError,
} from '../../../auth/persistence/username-reservation.dboperation';
import { ERR } from '../../../src/contracts';
import type { ProblemException } from '../../../src/http';
import { UsernameService } from '../../../src/settings/username/username.service';
import { USERNAME_PAID_CHANGE } from '../../../src/settings/username/username.types';
import { makeUser, makeUsernameReservation, rawUniqueViolation } from '../../harness';

/**
 * The service, and specifically the two things it is responsible for that nothing else
 * can check: that a Bloom negative does NOT reach the database, and that a Bloom
 * positive always does.
 *
 * The filter double below is deliberately explicit — a test says `absent` or `maybe`
 * rather than inserting values — because the property under test is about what the
 * service does with each verdict, not about hashing. `username-bloom.spec.ts` tests the
 * filter itself.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';

let reservations: {
  availability: ReturnType<typeof vi.fn>;
  filterAvailable: ReturnType<typeof vi.fn>;
  listLiveForUser: ReturnType<typeof vi.fn>;
  countChangesSince: ReturnType<typeof vi.fn>;
  oldestChangeSince: ReturnType<typeof vi.fn>;
  changeUsername: ReturnType<typeof vi.fn>;
  pageClaimedUsernames: ReturnType<typeof vi.fn>;
  pageReservedUsernames: ReturnType<typeof vi.fn>;
};
let users: { findById: ReturnType<typeof vi.fn> };
let cache: { consume: ReturnType<typeof vi.fn> };
let bloom: { test: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
let premium: { statusFor: ReturnType<typeof vi.fn> };
let service: UsernameService;

function build(): UsernameService {
  return new UsernameService(
    reservations as never,
    users as never,
    cache as never,
    bloom as never,
    premium as never,
  );
}

/** Available as far as Postgres is concerned. */
const FREE_IN_DB = { takenByAccount: false, reservation: null };

async function problemFrom(run: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await run();
  } catch (err) {
    return err as ProblemException;
  }
  throw new Error('expected the call to be refused');
}

beforeEach(() => {
  reservations = {
    availability: vi.fn().mockResolvedValue(FREE_IN_DB),
    filterAvailable: vi.fn().mockImplementation(async (names: string[]) => names),
    listLiveForUser: vi.fn().mockResolvedValue([]),
    countChangesSince: vi.fn().mockResolvedValue(0),
    oldestChangeSince: vi.fn().mockResolvedValue(null),
    changeUsername: vi.fn(),
    pageClaimedUsernames: vi.fn().mockResolvedValue({ usernames: [], lastUserId: null }),
    pageReservedUsernames: vi.fn().mockResolvedValue({ usernames: [], lastId: null }),
  };
  users = {
    findById: vi
      .fn()
      .mockResolvedValue(makeUser({ id: USER_ID, username: 'Alpha_One', usernameLower: 'alpha_one' })),
  };
  cache = { consume: vi.fn().mockResolvedValue(undefined) };
  // 'maybe' is the conservative default, so a test that wants the fast path has to ask
  // for it and cannot get it by forgetting to configure the double.
  bloom = { test: vi.fn().mockResolvedValue('maybe'), add: vi.fn().mockResolvedValue(undefined) };
  premium = { statusFor: vi.fn().mockResolvedValue({ active: false, expiresAt: null }) };
  service = build();
});

describe('availability — the Bloom fast path', () => {
  it('answers a definite absence WITHOUT touching the database', async () => {
    bloom.test.mockResolvedValue('absent');

    await expect(service.availability(USER_ID, 'brand_new_name')).resolves.toMatchObject({
      available: true,
      username: 'brand_new_name',
    });

    // The entire point of the filter. If this ever starts querying, the endpoint is a
    // database round trip per keystroke again.
    expect(reservations.availability).not.toHaveBeenCalled();
  });

  it('always consults the database on a positive — a positive is a question', async () => {
    bloom.test.mockResolvedValue('maybe');

    await service.availability(USER_ID, 'maybe_taken');

    expect(reservations.availability).toHaveBeenCalledWith('maybe_taken');
  });

  it('reports a FALSE positive as available, because Postgres decides', async () => {
    bloom.test.mockResolvedValue('maybe');
    reservations.availability.mockResolvedValue(FREE_IN_DB);

    await expect(service.availability(USER_ID, 'never_used')).resolves.toMatchObject({
      available: true,
    });
  });

  it('reports a STALE entry as available — a released name is never permanently blocked', async () => {
    // The filter can never delete, so every username ever released stays in it forever
    // and reads as 'maybe' for good. This is the assertion that makes that survivable.
    bloom.test.mockResolvedValue('maybe');
    reservations.availability.mockResolvedValue(FREE_IN_DB);

    await expect(service.availability(USER_ID, 'long_released')).resolves.toMatchObject({
      available: true,
    });
  });

  it('falls through to the database when the filter is unavailable', async () => {
    // `test` is contracted to answer 'maybe' rather than throw, so an outage costs
    // speed and never correctness.
    bloom.test.mockResolvedValue('maybe');

    await expect(service.availability(USER_ID, 'some_name')).resolves.toMatchObject({
      available: true,
    });
    expect(reservations.availability).toHaveBeenCalled();
  });
});

describe('availability — the verdicts', () => {
  it('reports a live account as taken, with suggestions', async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });

    const result = await service.availability(USER_ID, 'taken_name');

    expect(result).toMatchObject({ available: false, reason: 'taken' });
    expect(result.suggestions?.length).toBeGreaterThan(0);
  });

  it("reports somebody else's live reservation as reserved, without saying whose", async () => {
    reservations.availability.mockResolvedValue({
      takenByAccount: false,
      reservation: makeUsernameReservation({ userId: OTHER_USER_ID, usernameLower: 'held_name' }),
    });

    const result = await service.availability(USER_ID, 'held_name');

    expect(result).toMatchObject({ available: false, reason: 'reserved' });
    // Nothing about the holder may leak — not an id, not an email, not a username.
    expect(JSON.stringify(result)).not.toContain(OTHER_USER_ID);
  });

  it("reports the caller's OWN reservation as available — reclaiming is the point", async () => {
    reservations.availability.mockResolvedValue({
      takenByAccount: false,
      reservation: makeUsernameReservation({ userId: USER_ID, usernameLower: 'my_old_name' }),
    });

    await expect(service.availability(USER_ID, 'my_old_name')).resolves.toMatchObject({
      available: true,
    });
  });

  it("reports the caller's current username as `current`, not as taken", async () => {
    // "Username taken" for your own name reads as an instruction to pick another.
    await expect(service.availability(USER_ID, 'Alpha_One')).resolves.toMatchObject({
      available: false,
      reason: 'current',
    });
  });

  it('normalises before deciding, so casing cannot dodge a collision', async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });

    const result = await service.availability(USER_ID, '  TAKEN_Name  ');

    expect(result.username).toBe('taken_name');
    expect(reservations.availability).toHaveBeenCalledWith('taken_name');
  });
});

describe('availability — invalid input is data, not an error', () => {
  it('reports a too-short username as invalid rather than raising', async () => {
    // This endpoint is called on a keystroke debounce; a 400 for `shu` would make a
    // half-typed name an error condition.
    const result = await service.availability(USER_ID, 'shu');

    expect(result).toMatchObject({ available: false, reason: 'invalid' });
    expect(result.issues?.map((i) => i.code)).toContain('too_short');
  });

  it('never queries the database for input that cannot be a username', async () => {
    await service.availability(USER_ID, 'no spaces!');

    expect(reservations.availability).not.toHaveBeenCalled();
    expect(bloom.test).not.toHaveBeenCalled();
  });

  it('accepts a two-character name for Premium and refuses it for everyone else', async () => {
    premium.statusFor.mockResolvedValue({ active: true, expiresAt: null });
    await expect(service.availability(USER_ID, 'ab')).resolves.toMatchObject({ available: true });

    premium.statusFor.mockResolvedValue({ active: false, expiresAt: null });
    await expect(service.availability(USER_ID, 'ab')).resolves.toMatchObject({
      available: false,
      reason: 'invalid',
    });
  });
});

describe('availability — metering', () => {
  it('meters the check but never spends a username change', async () => {
    await service.availability(USER_ID, 'some_name');

    expect(cache.consume).toHaveBeenCalledTimes(1);
    // The allowance is counted from reservation rows, and a check writes none.
    expect(reservations.changeUsername).not.toHaveBeenCalled();
  });

  it('fails OPEN, so a Redis outage does not break a typing field', async () => {
    const [, , onError] = cache.consume.mock.calls[0] ?? [];
    await service.availability(USER_ID, 'some_name');
    expect(cache.consume.mock.calls[0]?.[2] ?? onError).toBe('allow');
  });
});

describe('suggestions', () => {
  it('offers only names the authoritative state says are free', async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });
    // Everything the generator proposes is claimed except one.
    reservations.filterAvailable.mockImplementation(async (names: string[]) => names.slice(0, 1));

    const result = await service.availability(USER_ID, 'taken_name');

    expect(result.suggestions).toHaveLength(1);
    expect(reservations.filterAvailable).toHaveBeenCalled();
  });

  it('does not use the Bloom filter to decide them', async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });
    bloom.test.mockResolvedValue('maybe');

    const result = await service.availability(USER_ID, 'taken_name');

    // A filter that never forgets would eventually call every candidate 'maybe' and
    // quietly stop suggesting anything. Correctness before speed on this path.
    expect(result.suggestions?.length).toBeGreaterThan(0);
    expect(reservations.filterAvailable).toHaveBeenCalled();
  });

  it("never suggests the caller's own current username", async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });

    const result = await service.availability(USER_ID, 'alpha_one1');

    expect(result.suggestions).not.toContain('alpha_one');
  });

  it('offers no more than the configured count, and no duplicates', async () => {
    reservations.availability.mockResolvedValue({ takenByAccount: true, reservation: null });

    const result = await service.availability(USER_ID, 'taken_name');
    const suggestions = result.suggestions ?? [];

    expect(suggestions.length).toBeLessThanOrEqual(USERNAME.SUGGESTION_COUNT);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });
});

describe('update', () => {
  const changed = {
    user: makeUser({ id: USER_ID, username: 'bravo_two', usernameLower: 'bravo_two' }),
    released: { username: 'Alpha_One', expiresAt: new Date('2026-02-14T10:00:00.000Z') },
    changesInWindow: 1,
  };

  it('changes the username and reports the reservation left behind', async () => {
    reservations.changeUsername.mockResolvedValue(changed);

    await expect(service.update(USER_ID, 'Bravo_Two')).resolves.toMatchObject({
      outcome: 'username_updated',
      username: 'bravo_two',
      previous: { username: 'Alpha_One', reservedUntil: '2026-02-14T10:00:00.000Z' },
    });
  });

  it('passes the NORMALISED name to the write', async () => {
    reservations.changeUsername.mockResolvedValue(changed);

    await service.update(USER_ID, '  Bravo_Two  ');

    expect(reservations.changeUsername).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'bravo_two', usernameLower: 'bravo_two' }),
    );
  });

  it('adds both the new and the released name to the filter', async () => {
    reservations.changeUsername.mockResolvedValue(changed);

    await service.update(USER_ID, 'bravo_two');

    // The released one matters most: a reserved name missing from the filter would take
    // the "definitely absent" fast path and be offered to somebody else.
    expect(bloom.add).toHaveBeenCalledWith('bravo_two', 'alpha_one');
  });

  it('refuses an invalid username with every problem at once', async () => {
    const problem = await problemFrom(() => service.update(USER_ID, 'ab'));

    expect(problem.type).toBe(ERR.USERNAME_INVALID);
    expect(problem.extra?.issues).toBeDefined();
    expect(reservations.changeUsername).not.toHaveBeenCalled();
  });

  it('refuses the username the account already holds', async () => {
    const problem = await problemFrom(() => service.update(USER_ID, 'ALPHA_ONE'));

    expect(problem.type).toBe(ERR.USERNAME_SAME_AS_CURRENT);
  });

  it('never reads Premium from the caller — the port decides the band', async () => {
    premium.statusFor.mockResolvedValue({ active: false, expiresAt: null });

    const problem = await problemFrom(() => service.update(USER_ID, 'ab'));

    expect(problem.type).toBe(ERR.USERNAME_INVALID);
    expect(premium.statusFor).toHaveBeenCalledWith(USER_ID);
  });

  it('allows a Premium account the short name a free one is refused', async () => {
    premium.statusFor.mockResolvedValue({ active: true, expiresAt: null });
    reservations.changeUsername.mockResolvedValue({ ...changed, user: makeUser({ username: 'ab' }) });

    await expect(service.update(USER_ID, 'ab')).resolves.toMatchObject({
      outcome: 'username_updated',
    });
  });
});

describe('update — how refusals are reported', () => {
  it('turns a lost race into username_unavailable, not a 500', async () => {
    // The expected case: two people were both told the name was free, because it was.
    reservations.changeUsername.mockRejectedValue(new UsernameTakenError());

    const problem = await problemFrom(() => service.update(USER_ID, 'bravo_two'));
    expect(problem.type).toBe(ERR.USERNAME_UNAVAILABLE);
    expect(problem.status).toBe(409);
  });

  it('turns a raw unique-index violation into the SAME answer', async () => {
    // `ix_users_username_active` is a partial index Prisma cannot see, so it arrives as
    // a raw 23505. A caller must not be able to tell which check refused them.
    reservations.changeUsername.mockRejectedValue(rawUniqueViolation());

    const problem = await problemFrom(() => service.update(USER_ID, 'bravo_two'));
    expect(problem.type).toBe(ERR.USERNAME_UNAVAILABLE);
  });

  it('turns a username that moved underneath the caller into the same answer', async () => {
    reservations.changeUsername.mockRejectedValue(new UsernameRaceLostError('moved'));

    const problem = await problemFrom(() => service.update(USER_ID, 'bravo_two'));
    expect(problem.type).toBe(ERR.USERNAME_UNAVAILABLE);
  });

  it('reports a spent allowance as 402 with the price the SERVER decided', async () => {
    reservations.changeUsername.mockRejectedValue(new UsernamePaymentRequiredError());

    const problem = await problemFrom(() => service.update(USER_ID, 'bravo_two'));

    expect(problem.type).toBe(ERR.USERNAME_CHANGE_PAYMENT_REQUIRED);
    expect(problem.status).toBe(402);
    expect(problem.extra).toMatchObject({
      amountMinor: USERNAME_PAID_CHANGE.amountMinor,
      currency: USERNAME_PAID_CHANGE.currency,
    });
  });

  it('lets an unrecognised failure through rather than dressing it as unavailable', async () => {
    const boom = new Error('connection reset');
    reservations.changeUsername.mockRejectedValue(boom);

    await expect(service.update(USER_ID, 'bravo_two')).rejects.toBe(boom);
  });
});

describe('status', () => {
  it('resolves the length band for THIS caller so the client computes nothing', async () => {
    premium.statusFor.mockResolvedValue({ active: true, expiresAt: new Date('2026-06-01') });

    const status = await service.status(USER_ID);

    expect(status.rules.minLength).toBe(USERNAME.PREMIUM_MIN_LENGTH);
    expect(status.rules.defaultMinLength).toBe(USERNAME.DEFAULT_MIN_LENGTH);
    expect(status.rules.maxLength).toBe(USERNAME.MAX_LENGTH);
    expect(status.premium.active).toBe(true);
  });

  it('reports the free minimum for an account without Premium', async () => {
    const status = await service.status(USER_ID);
    expect(status.rules.minLength).toBe(USERNAME.DEFAULT_MIN_LENGTH);
  });

  it('reports the remaining allowance and that the next change is free', async () => {
    reservations.countChangesSince.mockResolvedValue(1);

    const status = await service.status(USER_ID);

    expect(status.quota).toMatchObject({
      freeChangesRemaining: USERNAME_PAID_CHANGE.FREE_CHANGES - 1,
      freeChangesTotal: USERNAME_PAID_CHANGE.FREE_CHANGES,
      periodDays: USERNAME_PAID_CHANGE.FREE_CHANGE_WINDOW_DAYS,
    });
    expect(status.nextChange.requiresPayment).toBe(false);
  });

  it('prices the next change once the allowance is spent', async () => {
    reservations.countChangesSince.mockResolvedValue(USERNAME_PAID_CHANGE.FREE_CHANGES);
    reservations.oldestChangeSince.mockResolvedValue(new Date('2026-01-15T10:00:00.000Z'));

    const status = await service.status(USER_ID);

    expect(status.nextChange).toEqual({
      requiresPayment: true,
      amountMinor: USERNAME_PAID_CHANGE.amountMinor,
      currency: USERNAME_PAID_CHANGE.currency,
    });
    // The client is told WHEN, so it never subtracts dates itself.
    expect(status.quota.nextFreeChangeAt).toBe('2026-02-14T10:00:00.000Z');
  });

  it('never reports a negative allowance', async () => {
    reservations.countChangesSince.mockResolvedValue(99);
    const status = await service.status(USER_ID);
    expect(status.quota.freeChangesRemaining).toBe(0);
  });

  it('says which reservations can be reclaimed free', async () => {
    const createdAt = new Date(Date.now() - 60_000);
    reservations.listLiveForUser.mockResolvedValue([
      makeUsernameReservation({
        username: 'Alpha_One',
        usernameLower: 'alpha_one',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + USERNAME.RETENTION_DAYS * 86_400_000),
      }),
      makeUsernameReservation({
        username: 'Bravo_Two',
        usernameLower: 'bravo_two',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + USERNAME.RELEASE_SECONDS * 1000),
      }),
    ]);

    const status = await service.status(USER_ID);

    expect(status.reservations).toEqual([
      expect.objectContaining({ username: 'Alpha_One', reclaimFree: true }),
      expect.objectContaining({ username: 'Bravo_Two', reclaimFree: false }),
    ]);
  });

  it('discloses nothing about other accounts', async () => {
    const status = await service.status(USER_ID);
    const serialised = JSON.stringify(status);

    expect(serialised).not.toContain(USER_ID);
    expect(serialised).not.toContain('@');
  });
});
