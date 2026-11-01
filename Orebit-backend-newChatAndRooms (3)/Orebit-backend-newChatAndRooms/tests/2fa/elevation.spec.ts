import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEVATION_ACTIONS, ElevationService, isElevationAction } from '../../src/2fa/elevation';
import { policy } from '../../auth/limits';
import { KEYS, type CacheService } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The per-action re-authentication ticket.
 *
 * Three properties carry the whole mechanism, and each is a separate way for a
 * proof to be worth more than it should be:
 *
 *   ONE proof buys ONE write — `take` is a GETDEL, so a captured ticket is spent.
 *   A ticket is bound to the SESSION that proved it, so it is not a bearer
 *   credential someone else can pick up out of a log or a proxy.
 *   A ticket is bound to the ACTION it was proved for, so tapping a key intending
 *   to link a Google account does not also authorise deleting an authenticator.
 *
 * All three fail the same way — `reauth_required` — because a caller holding a bad
 * ticket learns nothing from which, and the remedy is identical in every case.
 */

/** A fake `CacheService` with a real map behind it, so `take` genuinely deletes. */
function createCache() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _ttl: number) => void store.set(key, value)),
    take: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    consume: vi.fn().mockResolvedValue(undefined),
  };
}

let cache: ReturnType<typeof createCache>;
let service: ElevationService;

beforeEach(() => {
  cache = createCache();
  service = new ElevationService(cache as unknown as CacheService);
});

async function problem(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('issuing a ticket', () => {
  it('stores the grant under a HASH of the ticket, never the ticket itself', async () => {
    // Same rule as every other caller-supplied secret in the service: a Redis dump
    // must not hand over live credentials.
    const { ticket } = await service.issue('session-1', 'account.oauth.link');

    const [key] = cache.set.mock.calls[0]!;
    expect(key).toBe(KEYS.elevation.ticket(ticket));
    expect(key).not.toContain(ticket);
  });

  it('binds the grant to the session AND the action', async () => {
    await service.issue('session-1', 'account.mfa.remove');

    const [, value] = cache.set.mock.calls[0]!;
    expect(JSON.parse(value)).toEqual({
      sessionId: 'session-1',
      action: 'account.mfa.remove',
    });
  });

  it('expires the ticket in seconds, not minutes', async () => {
    // Sixty seconds covers the round trip between proving and writing, and makes a
    // ticket captured from a log or a proxy worthless by the time anyone reads it.
    await service.issue('session-1', 'account.oauth.link');

    const [, , ttl] = cache.set.mock.calls[0]!;
    expect(ttl).toBe(policy().MFA.ELEVATION_TICKET_TTL_SECONDS);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('mints a different ticket every time', async () => {
    const a = await service.issue('session-1', 'account.oauth.link');
    const b = await service.issue('session-1', 'account.oauth.link');

    expect(a.ticket).not.toBe(b.ticket);
  });
});

describe('spending a ticket', () => {
  it('accepts the ticket it issued, for the action it was issued for', async () => {
    const { ticket } = await service.issue('session-1', 'account.oauth.link');

    await expect(service.spend(ticket, 'session-1', 'account.oauth.link')).resolves.toBeUndefined();
  });

  it('is SINGLE USE — one proof buys one write', async () => {
    // The distinction between this and "mark the session elevated for N minutes",
    // which is a sudo window rather than a per-action proof. Invisible in the happy
    // path, and the entire security difference.
    const { ticket } = await service.issue('session-1', 'account.oauth.link');
    await service.spend(ticket, 'session-1', 'account.oauth.link');

    const err = await problem(service.spend(ticket, 'session-1', 'account.oauth.link'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses a ticket minted by a DIFFERENT session', async () => {
    // Without this the ticket is a bearer credential of its own: anything that
    // obtained one — a shared log, a proxy, a second tab belonging to someone else
    // — could spend it.
    const { ticket } = await service.issue('session-1', 'account.oauth.link');

    const err = await problem(service.spend(ticket, 'session-2', 'account.oauth.link'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses a ticket proved for a DIFFERENT action', async () => {
    // Otherwise a ticket is per-action only in the sense of being spent once: a
    // proof given to link a provider would authorise removing an authenticator.
    const { ticket } = await service.issue('session-1', 'account.oauth.link');

    const err = await problem(service.spend(ticket, 'session-1', 'account.mfa.remove'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses an absent ticket, and says which action to prove for', async () => {
    const err = await problem(service.spend(null, 'session-1', 'account.mfa.enroll'));

    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
    // Named so a client can request the right ticket without hardcoding the mapping
    // from route to action.
    expect(err.extra).toEqual({ action: 'account.mfa.enroll' });
  });

  it('refuses an empty string as firmly as a missing one', async () => {
    const err = await problem(service.spend('', 'session-1', 'account.mfa.enroll'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses a grant that is not the shape we wrote', async () => {
    // A value written by an older deploy, or by something that is not us. Refusing
    // rather than half-understanding it costs one re-proof and nothing else.
    cache.store.set(KEYS.elevation.ticket('forged'), '"just-a-session-id"');

    const err = await problem(service.spend('forged', 'session-1', 'account.oauth.link'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses a grant naming an action that no longer exists', async () => {
    cache.store.set(
      KEYS.elevation.ticket('stale'),
      JSON.stringify({ sessionId: 'session-1', action: 'account.something.removed' }),
    );

    const err = await problem(service.spend('stale', 'session-1', 'account.oauth.link'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('spends the ticket even when it turns out to be wrong', async () => {
    // `take` deletes as it reads, so a caller cannot probe a ticket against every
    // action in turn to discover what it is good for.
    const { ticket } = await service.issue('session-1', 'account.oauth.link');
    await problem(service.spend(ticket, 'session-1', 'account.mfa.remove'));

    expect(cache.store.size).toBe(0);
  });
});

describe('the action union', () => {
  it('recognises the five real actions and nothing else', () => {
    expect(isElevationAction('account.oauth.link')).toBe(true);
    expect(isElevationAction('account.mfa.enroll')).toBe(true);
    expect(isElevationAction('account.mfa.remove')).toBe(true);
    // Settings → Social accounts. Its own action rather than reusing
    // `account.oauth.link`, because its proof policy differs in both directions —
    // see the note on the union.
    expect(isElevationAction('account.social.link')).toBe(true);
    // And its opposite. Same proof and same route, different permit.
    expect(isElevationAction('account.social.unlink')).toBe(true);
    // Settings → Delete account. The most destructive write in the service, and the
    // only one the caller cannot reverse from the session that made it.
    expect(isElevationAction('account.delete')).toBe(true);
    expect(isElevationAction('*')).toBe(false);
    expect(isElevationAction('')).toBe(false);
  });

  it('is exactly those six', () => {
    // A count as well as the membership checks above, because the title of this
    // suite has already been wrong once: adding a member breaks no assertion
    // unless one of them is exhaustive, so this is the one that would notice.
    expect([...ELEVATION_ACTIONS]).toEqual([
      'account.oauth.link',
      'account.mfa.enroll',
      'account.mfa.remove',
      'account.social.link',
      'account.social.unlink',
      'account.delete',
    ]);
  });
});

/**
 * The two social writes are earned from the SAME route under the SAME proof policy,
 * so nothing upstream of the ticket distinguishes them. The action stamped into the
 * grant is the only thing that does, and `spend` is the only place it is checked —
 * which makes this suite the whole of the separation between "may attach a provider"
 * and "may remove one".
 */
describe('linking and unlinking are separate permits', () => {
  it('refuses a link ticket presented for the unlink', async () => {
    const { ticket } = await service.issue('session-1', 'account.social.link');

    const err = await problem(service.spend(ticket, 'session-1', 'account.social.unlink'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses an unlink ticket presented for the link', async () => {
    // The other direction matters as much: a proof given to remove a provider must
    // not silently authorise attaching a different one.
    const { ticket } = await service.issue('session-1', 'account.social.unlink');

    const err = await problem(service.spend(ticket, 'session-1', 'account.social.link'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('accepts an unlink ticket for the unlink, once', async () => {
    const { ticket } = await service.issue('session-1', 'account.social.unlink');

    await expect(
      service.spend(ticket, 'session-1', 'account.social.unlink'),
    ).resolves.toBeUndefined();

    const replay = await problem(service.spend(ticket, 'session-1', 'account.social.unlink'));
    expect(replay.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('refuses an unlink ticket minted by a different session', async () => {
    const { ticket } = await service.issue('session-1', 'account.social.unlink');

    const err = await problem(service.spend(ticket, 'session-2', 'account.social.unlink'));
    expect(err.type).toBe(ERR.REAUTH_REQUIRED);
  });

  it('does not reveal what a wrong ticket WAS for', async () => {
    // A wrong-action refusal must be indistinguishable from a no-such-ticket one, or
    // a caller learns that a ticket they hold is live and what it is good for.
    const { ticket } = await service.issue('session-1', 'account.social.link');

    const wrongAction = await problem(
      service.spend(ticket, 'session-1', 'account.social.unlink'),
    );
    const absent = await problem(
      service.spend('no-such-ticket', 'session-1', 'account.social.unlink'),
    );

    expect(wrongAction.type).toBe(absent.type);
    expect(wrongAction.detail).toBe(absent.detail);
    // Names only what was being ATTEMPTED, never what the ticket held.
    expect(wrongAction.extra).toEqual({ action: 'account.social.unlink' });
  });
});
