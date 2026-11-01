import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEVATION } from '../../auth/auth.constants';
import { KEYS } from '../../redis';
import { CacheService } from '../../redis/cache';
import { ELEVATION_ANY, ElevationService } from '../../src/2fa/elevation';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ THE TEST THAT PROVES A PROOF BUYS EXACTLY ONE WRITE ═══════════════════
 *
 * Every mutating request in the admin panel must carry a fresh second-factor
 * proof. `ElevationService` is the whole mechanism, so these assertions are the
 * specification of "per-action" — and the difference between per-action and a sudo
 * window is invisible in the happy path.
 *
 * If a test here fails, the question is not "how do I fix the test" but "did I just
 * turn per-action re-auth into a time window".
 */

/**
 * The REAL `CacheService` over a Redis double, rather than a `CacheService`
 * double.
 *
 * The distinction is load-bearing and was previously got wrong here. A hand-
 * rolled `take` that does `store.get` then `store.delete` is atomic by accident —
 * both run inside one synchronous turn of the event loop — so the concurrency test
 * at the bottom of this file passed for the entire period the production `take`
 * was a non-atomic Redis GET followed by a separate DEL. The double's atomicity
 * was standing in for the code's, and the assertion proved nothing about
 * `CacheService`.
 *
 * Going through the real service means the concurrency test now depends on
 * `take` issuing a single `GETDEL`. `tests/redis/cache.spec.ts` asserts that
 * command choice directly, since atomicity itself is Redis's guarantee and not
 * something a double can demonstrate.
 */
function makeCache() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };

  const service = new CacheService(redis as never);
  return {
    store,
    redis,
    service,
    set: vi.spyOn(service, 'set'),
    take: vi.spyOn(service, 'take'),
  };
}

/**
 * Two distinct LOGINS — two browsers, two sign-in ceremonies.
 *
 * These were `FAMILY_A`/`FAMILY_B` and held refresh GENERATION ids. A ticket binds
 * to the login now, so every "cannot be spent by another" assertion below reads
 * against families — which is the property that was actually intended, and the one
 * cross-login isolation depends on. That a ticket also survives a rotation WITHIN one
 * login is the other half, and is tested in elevation-binding.spec.ts.
 */
const FAMILY_A = '01920000-0000-7000-8000-00000000aaaa';
const FAMILY_B = '01920000-0000-7000-8000-00000000bbbb';

/** Two distinct writes. The point of the action binding is that a proof for one is
 *  not a proof for the other. */
const RENAME = 'rename';
const REMOVE = 'remove';

function slugOf(err: unknown): string {
  return err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
}

describe('issuing a ticket', () => {
  let cache: ReturnType<typeof makeCache>;
  let service: ElevationService;

  beforeEach(() => {
    cache = makeCache();
    service = new ElevationService(cache.service);
  });

  it('stores the login id AND the action, so a ticket is bound to both', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    expect(cache.set).toHaveBeenCalledOnce();
    // No cast needed: `cache.set` is a spy on the real `CacheService.set`, so the
    // call tuple is typed from the method's own signature.
    const [key, value, ttl, onError] = cache.set.mock.calls[0] ?? [];
    expect(key).toBe(KEYS.elevation.ticket(ticket));
    // A JSON grant, not a bare id: the ticket carries WHICH write it was proved for
    // as well as which LOGIN proved it.
    expect(value).toBe(JSON.stringify({ familyId: FAMILY_A, action: RENAME }));
    expect(ttl).toBe(ELEVATION.TICKET_TTL_SECONDS);
    // Fail-closed at the MINTING end too. A ticket we could not store can never be
    // spent, so handing one back would be issuing a credential guaranteed to be
    // refused a moment later — and the client would read that refusal as "prove a
    // factor again" rather than as the outage it actually is.
    expect(onError).toBe('deny');
  });

  /**
   * The other half of that: an unwritable ticket is not returned at all.
   *
   * Asserts the TYPED refusal, not merely that something threw. A bare
   * `rejects.toThrow()` passes even when the raw ioredis error escapes — which is
   * the pre-fix behaviour, and reaches the client as an untyped 500 telling it to
   * retry rather than as a wait-and-try-again.
   */
  it('refuses to issue a ticket it could not store', async () => {
    cache.redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(service.issue(FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => err instanceof ProblemException && err.type === ERR.RATE_LIMITED,
    );
  });

  /**
   * Keyed on the ticket, not the session. Keyed on the session the value would be
   * "this session is elevated" — a flag true for its whole TTL, authorising any
   * number of writes. That is a window, not a per-action proof.
   */
  it('keys on the ticket rather than the session', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);
    const [key] = cache.set.mock.calls[0] ?? [];

    expect(key).not.toContain(FAMILY_A);
    expect(key).toBe(KEYS.elevation.ticket(ticket));
  });

  it('issues a different ticket every time', async () => {
    const first = await service.issue(FAMILY_A, RENAME);
    const second = await service.issue(FAMILY_A, RENAME);
    expect(first.ticket).not.toBe(second.ticket);
  });
});

describe('spending a ticket', () => {
  let cache: ReturnType<typeof makeCache>;
  let service: ElevationService;

  beforeEach(() => {
    cache = makeCache();
    service = new ElevationService(cache.service);
  });

  it('accepts a live ticket from its own session', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);
    await expect(service.spend(ticket, FAMILY_A, RENAME)).resolves.toBeUndefined();
  });

  /** ═══ THE ONE THAT MAKES IT PER-ACTION ══════════════════════════════════ */
  it('refuses the SAME ticket a second time', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);
    await service.spend(ticket, FAMILY_A, RENAME);

    await expect(service.spend(ticket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * A ticket lifted from a log, a proxy, or another tab is useless. Without the
   * stored session comparison the ticket would be a bearer credential of its own.
   */
  it("refuses a ticket minted by a different session", async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    await expect(service.spend(ticket, FAMILY_B, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['unknown', 'a-ticket-nobody-issued'],
  ])('refuses a %s ticket', async (_label, ticket) => {
    await expect(service.spend(ticket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * Redis unreachable makes `take` return null, which REFUSES the write.
   *
   * The opposite of the captcha penalty's fail-open, and deliberately: there an
   * outage degrades quota protection while the real defence still runs, whereas
   * here the ticket IS the defence. Failing open would turn a cache blip into an
   * unguarded write surface.
   *
   * Driven by making REDIS fail rather than by stubbing `CacheService.take`, so
   * this asserts the service's own fail-closed handling and not the stub's.
   */
  it('refuses when the cache cannot answer', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);
    cache.redis.getdel.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(service.spend(ticket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * One answer for "no such ticket", "already spent", "expired" and "wrong
   * session". A caller holding a bad ticket learns nothing about which, and the
   * remedy is identical in every case.
   */
  it('answers identically however the ticket is bad', async () => {
    const { ticket: spent } = await service.issue(FAMILY_A, RENAME);
    await service.spend(spent, FAMILY_A, RENAME);
    const { ticket: otherSession } = await service.issue(FAMILY_B, RENAME);

    const slugs = await Promise.all(
      [spent, otherSession, 'never-issued', null].map((t) =>
        service.spend(t, FAMILY_A, RENAME).then(
          () => 'did not throw',
          (err: unknown) => slugOf(err),
        ),
      ),
    );

    expect(new Set(slugs)).toEqual(new Set([ERR.REAUTH_REQUIRED]));
  });

  /**
   * Two concurrent requests cannot both spend one ticket — `take` is a single
   * `GETDEL`, so the loser sees null.
   *
   * Read `tests/redis/cache.spec.ts` alongside this: the assertion that carries
   * the weight is "take issues one command, and it is GETDEL". This test runs
   * through the real `CacheService`, but no in-process double can demonstrate
   * atomicity on its own — that is Redis's guarantee, and the command choice is
   * how we claim it.
   */
  it('lets exactly one of two concurrent spends win', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    const results = await Promise.all([
      service.spend(ticket, FAMILY_A, RENAME).then(() => 'won', () => 'lost'),
      service.spend(ticket, FAMILY_A, RENAME).then(() => 'won', () => 'lost'),
    ]);

    expect(results.filter((r) => r === 'won')).toHaveLength(1);
  });

  // ─── B3: a proof buys the write it was asked for, and no other ─────────────

  /**
   * ═══ THE ONE THAT MAKES IT PER-ACTION AND NOT MERELY PER-USE ═══════════════
   *
   * Single-use alone gives you "one proof, one write" — but any write. An admin who
   * taps their key intending to rename a factor held, for the next sixty seconds, a
   * permit that would authorise deleting one.
   *
   * Combined with the old non-atomic `take` (finding A1) the gap was wider still:
   * one tap, two writes, either of them anything.
   */
  it('refuses a ticket proved for a DIFFERENT action', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    await expect(service.spend(ticket, FAMILY_A, REMOVE)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * And it is spent either way. The refusal must not leave the ticket usable, or a
   * caller could probe actions one at a time until one landed — turning the binding
   * into a hint rather than a barrier.
   */
  it('consumes the ticket even when the action does not match', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    await service.spend(ticket, FAMILY_A, REMOVE).catch(() => undefined);

    await expect(service.spend(ticket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * A wrong action answers exactly as a wrong session, an unknown ticket and a spent
   * one do. Telling a caller "that ticket was for `rename`, not `remove`" would
   * confirm both that the ticket is live and what it is good for.
   */
  it('answers identically for a wrong action as for any other bad ticket', async () => {
    const { ticket: wrongAction } = await service.issue(FAMILY_A, RENAME);
    const { ticket: wrongSession } = await service.issue(FAMILY_B, REMOVE);

    const slugs = await Promise.all([
      service.spend(wrongAction, FAMILY_A, REMOVE).then(() => 'no', (e: unknown) => slugOf(e)),
      service.spend(wrongSession, FAMILY_A, REMOVE).then(() => 'no', (e: unknown) => slugOf(e)),
      service.spend('never-issued', FAMILY_A, REMOVE).then(() => 'no', (e: unknown) => slugOf(e)),
      service.spend(null, FAMILY_A, REMOVE).then(() => 'no', (e: unknown) => slugOf(e)),
    ]);

    expect(new Set(slugs)).toEqual(new Set([ERR.REAUTH_REQUIRED]));
  });

  /** Both halves are checked. A right action from the wrong session is still no. */
  it('requires the session AND the action to match', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);

    await expect(service.spend(ticket, FAMILY_B, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  /**
   * A ticket written by a previous deploy held a bare session id, not a JSON grant.
   * It must be refused rather than half-understood — the client's remedy is one tap,
   * and tickets live sixty seconds, so the window is one minute of one deploy.
   */
  it('refuses a ticket left over from before the action binding', async () => {
    const legacyTicket = 'legacy-ticket';
    await cache.service.set(
      KEYS.elevation.ticket(legacyTicket),
      FAMILY_A, // the old format: a bare session id
      ELEVATION.TICKET_TTL_SECONDS,
      'deny',
    );

    await expect(service.spend(legacyTicket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });
});

// ─── the migration sentinel ──────────────────────────────────────────────────

/**
 * `ELEVATION_ANY` is what a client that has not yet learned to send `intent` gets.
 *
 * It is accepted by the four ticketed actions that already shipped on `POST /2fa`,
 * and refused by `ElevationGuard` — so it keeps existing behaviour working without
 * opening any future mutating route to an unscoped proof. These tests are the fence
 * around that, because a sentinel that leaked would undo the whole finding.
 */
describe('spendForAny — the un-migrated client', () => {
  let cache: ReturnType<typeof makeCache>;
  let service: ElevationService;

  beforeEach(() => {
    cache = makeCache();
    service = new ElevationService(cache.service);
  });

  it('accepts a ticket bound to the specific action', async () => {
    const { ticket } = await service.issue(FAMILY_A, RENAME);
    await expect(
      service.spendForAny(ticket, FAMILY_A, [RENAME, ELEVATION_ANY]),
    ).resolves.toBeUndefined();
  });

  it('accepts a ticket bound to the sentinel', async () => {
    const { ticket } = await service.issue(FAMILY_A, ELEVATION_ANY);
    await expect(
      service.spendForAny(ticket, FAMILY_A, [RENAME, ELEVATION_ANY]),
    ).resolves.toBeUndefined();
  });

  /** The sentinel widens what is accepted; it does not stop the session check. */
  it('still refuses the sentinel from another session', async () => {
    const { ticket } = await service.issue(FAMILY_B, ELEVATION_ANY);
    await expect(
      service.spendForAny(ticket, FAMILY_A, [RENAME, ELEVATION_ANY]),
    ).rejects.toSatisfy((err) => slugOf(err) === ERR.REAUTH_REQUIRED);
  });

  /**
   * ═══ THE FENCE ═════════════════════════════════════════════════════════════
   *
   * A route that does NOT list the sentinel must refuse a sentinel-bound ticket.
   * This is what confines the compatibility to the twelve actions that already
   * existed: `ElevationGuard` always calls `spend` with one specific action, so a
   * proof given for nothing in particular reaches no future mutating route.
   */
  it('refuses a sentinel ticket where the sentinel is not listed', async () => {
    const { ticket } = await service.issue(FAMILY_A, ELEVATION_ANY);

    await expect(service.spend(ticket, FAMILY_A, RENAME)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });
});
