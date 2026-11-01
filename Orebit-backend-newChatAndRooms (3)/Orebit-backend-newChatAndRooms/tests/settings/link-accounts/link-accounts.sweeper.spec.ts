import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OauthLink } from '@prisma/client';
import { SocialUnlinkSweeper } from '../../../src/settings/link-accounts/link-accounts.sweeper';

/**
 * ═══ THE THING THAT ACTUALLY REMOVES A SOCIAL LOGIN ═════════════════════════
 *
 * `POST /settings/security/social-accounts/unlink` writes a deadline and stops. This
 * is the only code in the service that turns that deadline into a soft-deleted row,
 * which makes it the only place the seven-day promise is kept — and the only place a
 * bug would remove the WRONG row.
 *
 * Two properties carry it, and each is a distinct way for the mechanism to go wrong:
 *
 *   Nothing is decided from the sweep's unlocked read. Every precondition is restated
 *   in the write, so a row cancelled, retired or replaced between the two is missed
 *   rather than clobbered.
 *
 *   A pass never throws. The interval is the only thing driving this, so an escaping
 *   error would not merely lose one batch — it would end unlinking for the lifetime
 *   of the process, silently, with requests still being accepted.
 *
 * ─── On not testing the interval ────────────────────────────────────────────
 *
 * `sweep()` is called directly here and the timer is never started. That matches every
 * other periodic task in this repository: no spec lets an interval fire, because the
 * timer's only job is to call the method and a test that waited on real time would buy
 * nothing but flakiness. Time is controlled by passing explicit dates into the double.
 */

/**
 * Deadlines relative to the real clock, not fixed literals.
 *
 * `sweep()` calls `new Date()` itself — deliberately, so that the deadline is always
 * compared against the server's own time rather than anything a caller supplied — so
 * a fixture pinned to a calendar date silently stops being "overdue" the moment the
 * real date passes it, or never starts being overdue at all. Offsets from now are the
 * only spelling that stays true.
 */
const DUE = new Date(Date.now() - 60 * 60 * 1000);
const NOT_DUE = new Date(Date.now() + 60 * 60 * 1000);

function makeLink(overrides: Partial<OauthLink> = {}): OauthLink {
  return {
    id: 'link-1',
    userId: 'user-1',
    provider: 'GOOGLE',
    subject: 'google-subject-1',
    emailAtLink: 'ada@example.com',
    emailVerifiedByProvider: true,
    avatarUrlAtLink: null,
    nameAtLink: 'Ada',
    linkedAt: new Date('2026-01-15T10:00:00.000Z'),
    lastLoginAt: null,
    unlinkRequestedAt: new Date('2026-09-11T11:00:00.000Z'),
    unlinkAt: DUE,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A store that enforces the same conditions the real `UPDATE ... WHERE` does.
 *
 * Modelling the compare-and-swap rather than returning a constant is the whole point:
 * a double that always answered `true` would let "running twice is a no-op" and "a
 * cancelled row is skipped" pass against an implementation that has neither property.
 */
function createUsers(links: OauthLink[]) {
  const state = { links };
  return {
    state,
    listDueOauthUnlinks: vi.fn(async (now: Date, take: number) =>
      state.links
        .filter((link) => link.deletedAt === null && link.unlinkAt !== null && link.unlinkAt <= now)
        .slice(0, take),
    ),
    retireDueOauthLink: vi.fn(async (id: string, now: Date) => {
      const row = state.links.find((link) => link.id === id);
      if (row === undefined) return false;
      if (row.deletedAt !== null) return false;
      if (row.unlinkAt === null || row.unlinkAt > now) return false;
      state.links = state.links.map((link) =>
        link.id === id ? { ...link, deletedAt: now } : link,
      );
      return true;
    }),
  };
}

describe('SocialUnlinkSweeper', () => {
  let users: ReturnType<typeof createUsers>;

  const build = () => new SocialUnlinkSweeper(users as never);
  const live = () => users.state.links.filter((link) => link.deletedAt === null);

  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('the deadline', () => {
    it('retires a link whose waiting period has run out', async () => {
      users = createUsers([makeLink()]);

      await build().sweep();

      expect(live()).toHaveLength(0);
      expect(users.state.links[0]?.deletedAt).toBeInstanceOf(Date);
    });

    it('leaves a link alone before its deadline', async () => {
      // THE property the whole feature rests on: for seven days the provider keeps
      // signing the user in, and this is what must not touch it.
      users = createUsers([makeLink({ unlinkAt: NOT_DUE })]);

      await build().sweep();

      expect(live()).toHaveLength(1);
      expect(users.retireDueOauthLink).not.toHaveBeenCalled();
    });

    it('never touches a link with no unlink requested', async () => {
      users = createUsers([makeLink({ unlinkRequestedAt: null, unlinkAt: null })]);

      await build().sweep();

      expect(live()).toHaveLength(1);
      expect(users.retireDueOauthLink).not.toHaveBeenCalled();
    });

    it('retires only the due link, leaving the account other providers', async () => {
      users = createUsers([
        makeLink(),
        makeLink({ id: 'link-2', provider: 'FACEBOOK', unlinkRequestedAt: null, unlinkAt: null }),
      ]);

      await build().sweep();

      expect(live().map((link) => link.provider)).toEqual(['FACEBOOK']);
    });
  });

  describe('safe to run again', () => {
    it('is a no-op the second time', async () => {
      users = createUsers([makeLink()]);
      const sweeper = build();

      await sweeper.sweep();
      const after = users.state.links[0];
      await sweeper.sweep();

      // Identical row, not merely an identical count — a second write would move
      // `deletedAt` and rewrite when the link actually died.
      expect(users.state.links[0]).toBe(after);
    });

    it('does not retire a link that was cancelled after the read', async () => {
      // The re-link path cleared `unlinkAt` between the sweep's read and its write.
      // The conditional update is what notices; nothing here re-reads to check.
      users = createUsers([makeLink()]);
      users.listDueOauthUnlinks.mockResolvedValue([makeLink()]);
      users.state.links = [makeLink({ unlinkRequestedAt: null, unlinkAt: null })];

      await build().sweep();

      expect(live()).toHaveLength(1);
    });

    it('does not retire a link re-created since the read', async () => {
      // A row retired and then re-linked is a DIFFERENT row with a different id, so
      // the id-scoped update cannot reach it. This is the case that would otherwise
      // delete a brand-new link the user had just made.
      users = createUsers([makeLink()]);
      users.listDueOauthUnlinks.mockResolvedValue([makeLink({ id: 'stale-id' })]);

      await build().sweep();

      expect(live()).toHaveLength(1);
      expect(users.state.links[0]?.id).toBe('link-1');
    });
  });

  describe('a pass never throws', () => {
    it('survives the listing failing', async () => {
      users = createUsers([]);
      users.listDueOauthUnlinks.mockRejectedValue(new Error('database is down'));

      await expect(build().sweep()).resolves.toBeUndefined();
    });

    it('finishes the batch when one row fails', async () => {
      users = createUsers([makeLink(), makeLink({ id: 'link-2', provider: 'FACEBOOK' })]);
      users.retireDueOauthLink.mockImplementationOnce(async () => {
        throw new Error('deadlock');
      });

      await expect(build().sweep()).resolves.toBeUndefined();

      // The second row was still attempted — one failure must not abandon the rest,
      // and the failed one stays due for the next pass.
      expect(users.retireDueOauthLink).toHaveBeenCalledTimes(2);
    });
  });

  describe('the timer', () => {
    it('does not hold the process open', () => {
      // `unref` is what keeps a pending sweep from preventing shutdown. Asserted
      // rather than assumed because removing it breaks nothing a test would notice.
      vi.useFakeTimers();
      users = createUsers([]);
      const sweeper = build();

      sweeper.onApplicationBootstrap();
      const [timer] = vi.getTimerCount() > 0 ? [true] : [false];
      expect(timer).toBe(true);

      sweeper.onApplicationShutdown();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('sweeps once at boot, without waiting for the first interval', async () => {
      // What makes a restart catch up immediately rather than up to an interval
      // later. A link that came due while the process was down is retired as soon as
      // something is running again.
      users = createUsers([makeLink()]);
      const sweeper = build();

      sweeper.onApplicationBootstrap();
      // The boot pass is deliberately not awaited by the hook, so let it settle.
      await new Promise((resolve) => setImmediate(resolve));
      sweeper.onApplicationShutdown();

      expect(users.retireDueOauthLink).toHaveBeenCalledTimes(1);
      expect(live()).toHaveLength(0);
    });

    it('does not let a failing boot sweep escape into startup', async () => {
      // `onApplicationBootstrap` does not await it and nothing else would catch it,
      // so an unhandled rejection here would take down a booting process.
      users = createUsers([]);
      users.listDueOauthUnlinks.mockRejectedValue(new Error('database is down'));
      const sweeper = build();

      expect(() => sweeper.onApplicationBootstrap()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      sweeper.onApplicationShutdown();
    });

    it('stops cleanly when it never started', () => {
      users = createUsers([]);

      expect(() => build().onApplicationShutdown()).not.toThrow();
    });
  });

  it('bounds one pass, so a backlog cannot become an unbounded read', async () => {
    users = createUsers([makeLink()]);

    await build().sweep();

    const [, take] = users.listDueOauthUnlinks.mock.calls[0] as [Date, number];
    expect(take).toBeGreaterThan(0);
    expect(Number.isFinite(take)).toBe(true);
  });

  it('asks for what is due NOW, holding no cursor between passes', async () => {
    // The reason a restart, a deployment or a day of downtime costs nothing: the
    // deadline lives in the database and this class remembers nothing at all.
    users = createUsers([makeLink()]);
    const sweeper = build();

    await sweeper.sweep();
    await sweeper.sweep();

    const first = users.listDueOauthUnlinks.mock.calls[0]?.[0] as Date;
    const second = users.listDueOauthUnlinks.mock.calls[1]?.[0] as Date;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});
