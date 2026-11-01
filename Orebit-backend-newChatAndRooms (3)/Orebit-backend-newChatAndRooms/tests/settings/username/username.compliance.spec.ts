import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USERNAME } from '../../../auth/auth.constants';
import { UsernameTakenError } from '../../../auth/persistence/username-reservation.dboperation';
import { NullPremiumProvider } from '../../../src/settings/username/premium.service';
import { UsernameComplianceService } from '../../../src/settings/username/username.compliance';
import { assessUsername, lengthBandFor } from '../../../src/settings/username/username.utility';
import { makeUser } from '../../harness';

/**
 * The Premium-expiry reconciler.
 *
 * What is actually being tested is idempotency, so most of this file is about calling
 * `reconcile` twice, or from two "instances", and asserting that the second one writes
 * NOTHING. The sweeper may run on several processes at once, may be restarted
 * mid-pass, and keeps no durable cursor — so re-processing has to be free, and the
 * absence of a second suffix is the property that makes it so.
 *
 * The `renameForCompliance` double models the row lock's compare-and-swap rather than
 * stubbing a boolean: it only writes when the username it is handed still matches the
 * one in the store. That is the mechanism the whole contract rests on, and a stub that
 * always returned true would test nothing.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';

const FREE = lengthBandFor(false);

interface Store {
  username: string | null;
  writes: number;
}

/** The argument `UsernameComplianceService` hands to the transaction. Named rather than
 *  `any` so the double cannot silently drift from the real call. */
interface RenameInput {
  userId: string;
  username: string;
  usernameLower: string;
  expectedCurrentLower: string;
  stillNonCompliant: (usernameLower: string) => boolean;
}

let store: Store;
let reservations: {
  renameForCompliance: ReturnType<typeof vi.fn>;
};
let users: { findById: ReturnType<typeof vi.fn> };
let bloom: { add: ReturnType<typeof vi.fn> };
let premium: {
  statusFor: ReturnType<typeof vi.fn>;
  listRecentlyExpired: ReturnType<typeof vi.fn>;
};
let service: UsernameComplianceService;

function build(): UsernameComplianceService {
  return new UsernameComplianceService(
    reservations as never,
    users as never,
    bloom as never,
    premium as never,
  );
}

beforeEach(() => {
  store = { username: 'ab', writes: 0 };

  reservations = {
    // The transaction, modelled: the write lands only if the account still holds the
    // username the caller measured, and only if it is still non-compliant.
    renameForCompliance: vi.fn().mockImplementation(async (input: RenameInput) => {
      if (store.username === null) return false;
      if (store.username !== input.expectedCurrentLower) return false;
      if (!input.stillNonCompliant(store.username)) return false;
      store.username = input.usernameLower;
      store.writes += 1;
      return true;
    }),
  };

  users = {
    findById: vi.fn().mockImplementation(async () =>
      store.username === null
        ? null
        : makeUser({ id: USER_ID, username: store.username, usernameLower: store.username }),
    ),
  };

  bloom = { add: vi.fn().mockResolvedValue(undefined) };
  premium = {
    statusFor: vi.fn().mockResolvedValue({ active: false, expiresAt: null }),
    listRecentlyExpired: vi.fn().mockResolvedValue([]),
  };

  service = build();
});

describe('reconcile — the rename itself', () => {
  it('lengthens a username Premium was paying for', async () => {
    await expect(service.reconcile(USER_ID)).resolves.toBe(true);

    expect(store.username).not.toBe('ab');
    expect(store.username!.startsWith('ab_')).toBe(true);
    expect(assessUsername(store.username!, FREE).ok).toBe(true);
  });

  it('produces a username a free account may legally hold', async () => {
    await service.reconcile(USER_ID);

    expect(store.username!.length).toBeGreaterThanOrEqual(USERNAME.DEFAULT_MIN_LENGTH);
    expect(store.username!.length).toBeLessThanOrEqual(USERNAME.MAX_LENGTH);
  });

  it('teaches the availability filter about the new name', async () => {
    await service.reconcile(USER_ID);

    expect(bloom.add).toHaveBeenCalledWith(store.username);
  });

  it('does not wait for the owner to open the settings screen', async () => {
    // Nothing in this path reads a request, a session or a screen — the sweeper is the
    // only trigger, which is the requirement.
    await service.sweep();
    expect(premium.listRecentlyExpired).toHaveBeenCalled();
  });
});

describe('reconcile — idempotency', () => {
  it('writes once when called twice — the length guard stops the second', async () => {
    await expect(service.reconcile(USER_ID)).resolves.toBe(true);
    const afterFirst = store.username;

    // A restart mid-pass, a duplicate in the provider's list, or simply the next sweep.
    await expect(service.reconcile(USER_ID)).resolves.toBe(false);

    expect(store.writes).toBe(1);
    expect(store.username).toBe(afterFirst);
  });

  it('writes once when two instances race past the unlocked read', async () => {
    // Both read `ab` before either commits — the interleaving the row lock exists for.
    const first = build();
    const second = build();

    const results = await Promise.all([first.reconcile(USER_ID), second.reconcile(USER_ID)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.writes).toBe(1);
    // Specifically: no `ab_x7q29_a1b2c`. A second suffix is the failure mode.
    expect(store.username!.split('_')).toHaveLength(2);
  });

  it('writes nothing when the owner renamed themselves in between', async () => {
    users.findById.mockImplementationOnce(async () =>
      makeUser({ id: USER_ID, username: 'ab', usernameLower: 'ab' }),
    );
    // The user picks their own compliant name before the transaction runs.
    store.username = 'chosen_name';

    await expect(service.reconcile(USER_ID)).resolves.toBe(false);
    expect(store.writes).toBe(0);
    expect(store.username).toBe('chosen_name');
  });

  it('writes nothing for an account that is already compliant', async () => {
    store.username = 'long_enough_name';

    await expect(service.reconcile(USER_ID)).resolves.toBe(false);
    expect(reservations.renameForCompliance).not.toHaveBeenCalled();
  });

  it('writes nothing for an account that no longer exists', async () => {
    store.username = null;

    await expect(service.reconcile(USER_ID)).resolves.toBe(false);
    expect(store.writes).toBe(0);
  });
});

describe('reconcile — the entitlement is re-checked, never assumed', () => {
  it('leaves the username alone when Premium is actually still active', async () => {
    // The sweeper's list is a hint from a moment ago; a renewal that landed since must
    // win. This is the most likely thing to happen to an account that just lapsed.
    premium.statusFor.mockResolvedValue({ active: true, expiresAt: new Date() });

    await expect(service.reconcile(USER_ID)).resolves.toBe(false);
    expect(store.username).toBe('ab');
    expect(reservations.renameForCompliance).not.toHaveBeenCalled();
  });

  it('asks the port about the specific account rather than trusting the list', async () => {
    await service.reconcile(USER_ID);
    expect(premium.statusFor).toHaveBeenCalledWith(USER_ID);
  });
});

describe('reconcile — collisions', () => {
  it('retries with a different suffix when the first candidate is taken', async () => {
    const real = reservations.renameForCompliance.getMockImplementation()!;
    reservations.renameForCompliance
      .mockImplementationOnce(async () => {
        throw new UsernameTakenError();
      })
      .mockImplementationOnce(real);

    await expect(service.reconcile(USER_ID)).resolves.toBe(true);
    expect(reservations.renameForCompliance).toHaveBeenCalledTimes(2);

    const [first, second] = reservations.renameForCompliance.mock.calls;
    expect(first?.[0].usernameLower).not.toBe(second?.[0].usernameLower);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    reservations.renameForCompliance.mockRejectedValue(new UsernameTakenError());

    await expect(service.reconcile(USER_ID)).resolves.toBe(false);
    expect(reservations.renameForCompliance).toHaveBeenCalledTimes(
      USERNAME.MAX_COMPLIANCE_ATTEMPTS,
    );
    // Left non-compliant on purpose: the next sweep retries, and looping forever
    // against something structurally broken is worse.
    expect(store.username).toBe('ab');
  });

  it('lets an unexpected failure out rather than treating it as a collision', async () => {
    const boom = new Error('connection reset');
    reservations.renameForCompliance.mockRejectedValue(boom);

    await expect(service.reconcile(USER_ID)).rejects.toBe(boom);
  });
});

describe('reconcile — what it must NOT do', () => {
  it('never spends the account allowance or reserves the name it takes away', async () => {
    await service.reconcile(USER_ID);

    // The account did not choose this change. `renameForCompliance` is the only write
    // path used, and it writes no reservation row — see its own spec.
    expect(reservations.renameForCompliance).toHaveBeenCalledTimes(1);
    expect(Object.keys(reservations)).not.toContain('changeUsername');
  });
});

describe('sweep', () => {
  it('reconciles every account the port reports', async () => {
    premium.listRecentlyExpired.mockResolvedValue([USER_ID]);

    await service.sweep();

    expect(store.writes).toBe(1);
  });

  it('finishes the batch when one account fails', async () => {
    const other = '01940000-0000-7000-8000-0000000000c3';
    premium.listRecentlyExpired.mockResolvedValue([other, USER_ID]);
    premium.statusFor.mockImplementation(async (id: string) => {
      if (id === other) throw new Error('provider blew up');
      return { active: false, expiresAt: null };
    });

    await service.sweep();

    // One account's failure must not abandon the rest.
    expect(store.writes).toBe(1);
  });

  it('does not advance its window when the port fails, so nothing is skipped', async () => {
    premium.listRecentlyExpired.mockRejectedValueOnce(new Error('down'));
    await service.sweep();

    const firstSince = premium.listRecentlyExpired.mock.calls[0]?.[0] as Date;

    premium.listRecentlyExpired.mockResolvedValue([]);
    await service.sweep();
    const secondSince = premium.listRecentlyExpired.mock.calls[1]?.[0] as Date;

    // Under-reporting leaves an account holding a username it is not entitled to, and
    // nothing else would notice — so a failed sweep re-asks for the same period.
    expect(secondSince.getTime()).toBe(firstSince.getTime());
  });

  it('advances its window after a successful pass', async () => {
    premium.listRecentlyExpired.mockResolvedValue([]);
    await service.sweep();
    await service.sweep();

    const first = premium.listRecentlyExpired.mock.calls[0]?.[0] as Date;
    const second = premium.listRecentlyExpired.mock.calls[1]?.[0] as Date;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it('looks back further than one interval, so a restart misses nothing', async () => {
    await service.sweep();
    const since = premium.listRecentlyExpired.mock.calls[0]?.[0] as Date;

    expect(Date.now() - since.getTime()).toBeGreaterThan(60 * 60 * 1000);
  });

  it('never throws — the interval that calls it must survive a bad pass', async () => {
    premium.listRecentlyExpired.mockRejectedValue(new Error('down'));
    await expect(service.sweep()).resolves.toBeUndefined();
  });
});

describe('NullPremiumProvider — the shipped binding', () => {
  const provider = new NullPremiumProvider();

  it('reports every account non-Premium, so nobody can hold a short username', async () => {
    await expect(provider.statusFor(USER_ID)).resolves.toEqual({
      active: false,
      expiresAt: null,
    });
  });

  it('reports no expirations, which makes the sweeper a no-op rather than disabled', async () => {
    await expect(provider.listRecentlyExpired(new Date())).resolves.toEqual([]);
  });

  it('returns empty rather than throwing — this answers a timer, not a user', async () => {
    // The opposite of `NullKycProvider.reverify`, which throws because returning a
    // verdict would cost a user one of their attempts. "No accounts need attention" is
    // both true and free, and throwing every tick is how a real failure later goes
    // unnoticed.
    await expect(provider.listRecentlyExpired(new Date())).resolves.toBeInstanceOf(Array);
  });

  it('sweeps nothing when it is the bound provider', async () => {
    const withNull = new UsernameComplianceService(
      reservations as never,
      users as never,
      bloom as never,
      new NullPremiumProvider() as never,
    );

    await withNull.sweep();

    expect(store.writes).toBe(0);
  });
});
