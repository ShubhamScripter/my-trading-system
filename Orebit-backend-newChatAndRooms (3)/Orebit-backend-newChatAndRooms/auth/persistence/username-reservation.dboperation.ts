import { Injectable } from '@nestjs/common';
import type { User, UsernameReservation } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { lockUsernameClaim } from './username-claim.lock';

/**
 * Persistence for `username_reservations`, and for the two writes that move a
 * `users.username` — the user-initiated change and the Premium-expiry rename.
 *
 * ─── Why this is in auth/persistence/ and not src/settings/username/ ────────
 *
 * `settings.module.ts` states the rule: a settings sub-feature may own a table only
 * when nothing outside its directory reaches it, which is why `payment_pins` has a
 * dboperation there and `retained_emails` does not — registration reads that one, so it
 * lives here.
 *
 * This table has exactly that two-sided shape. The signup allocator must not hand a new
 * account a username somebody reserved an hour ago, so `UserDbOperation.createAccount`
 * reads it too. One table, one access layer, and the layer sits where both callers can
 * reach it without `src/settings/` becoming a dependency of `auth/`.
 *
 * ─── Why every liveness test is `expiresAt > now` and never a flag ──────────
 *
 * `RetainedEmailDbOperation`'s reason, and it is worth restating because it is what
 * makes the "released usernames come back in minutes" requirement free: a reservation
 * stops blocking because time passed, not because a job ran. There is no job. An
 * expired row is indistinguishable from an absent one to every query in this file, so
 * correctness cannot depend on a sweep that might not have happened.
 *
 * ─── Why rows are never deleted ─────────────────────────────────────────────
 *
 * `created_at` is the change ledger the free-change allowance is counted from, so a
 * deleted row is a change that never happened. That is not a bookkeeping preference: a
 * user who reclaims their previous username would otherwise erase the row proving they
 * had changed away from it, and could ping-pong between two names forever without ever
 * spending their allowance. The reclaim therefore EXPIRES the row it reclaims — see
 * `changeUsername`.
 */

/** What a live reservation on a name means to a caller that is not its owner. */
export interface UsernameAvailability {
  /** A live, non-deleted account holds it. */
  readonly takenByAccount: boolean;
  /** A live reservation covers it. Carries the owner so the caller can recognise its
   *  own — never so it can be reported to anyone else. */
  readonly reservation: UsernameReservation | null;
}

export interface ChangeUsernameResult {
  readonly user: User;
  /** The username just given up, and when it stops being reserved. */
  readonly released: { readonly username: string; readonly expiresAt: Date };
  /** Rows in the allowance window AFTER this change, so the caller can render
   *  "remaining" without a second query. */
  readonly changesInWindow: number;
}

/** Thrown inside the transaction, which rolls it back. The service maps each to a slug. */
export class UsernameTakenError extends Error {}
export class UsernamePaymentRequiredError extends Error {}
/** The account's username moved between the caller's read and this write. */
export class UsernameRaceLostError extends Error {}

@Injectable()
export class UsernameReservationDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // ─── reads ────────────────────────────────────────────────────────────────

  /**
   * Is this username held or reserved right now?
   *
   * Two queries rather than a join, and issued together: they hit two different indexes
   * (`ix_users_username_active` and `ix_username_reservations_lookup`), and a join would
   * make Postgres choose one plan for what are really two independent point lookups.
   *
   * This is the authoritative answer the Bloom filter is only an optimisation over. It
   * runs whenever the filter says "maybe", and on every mutation regardless.
   */
  async availability(usernameLower: string): Promise<UsernameAvailability> {
    const [account, reservation] = await Promise.all([
      this.prisma.user.count({ where: { usernameLower, deletedAt: null } }),
      this.prisma.usernameReservation.findFirst({
        where: { usernameLower, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      }),
    ]);

    return { takenByAccount: account > 0, reservation };
  }

  /**
   * The same question for several usernames at once, answering only "is it free".
   *
   * For suggestions, which need three to five names checked before any of them is
   * offered. One query per candidate would be five round trips to render one refusal;
   * this is two, regardless of how many candidates are proposed.
   *
   * Returns the subset that is free, preserving the caller's order — which is the
   * preference order suggestions are generated in.
   */
  async filterAvailable(usernamesLower: readonly string[]): Promise<string[]> {
    if (usernamesLower.length === 0) return [];

    const [accounts, reservations] = await Promise.all([
      this.prisma.user.findMany({
        where: { usernameLower: { in: [...usernamesLower] }, deletedAt: null },
        select: { usernameLower: true },
      }),
      this.prisma.usernameReservation.findMany({
        where: { usernameLower: { in: [...usernamesLower] }, expiresAt: { gt: new Date() } },
        select: { usernameLower: true },
      }),
    ]);

    const unavailable = new Set([
      ...accounts.map((row) => row.usernameLower),
      ...reservations.map((row) => row.usernameLower),
    ]);
    return usernamesLower.filter((username) => !unavailable.has(username));
  }

  /** This account's live reservations, newest deadline first. For the status screen. */
  async listLiveForUser(userId: string): Promise<UsernameReservation[]> {
    return this.prisma.usernameReservation.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /**
   * Changes this account made since `since` — the free-change allowance, counted.
   *
   * One row per change, so this is a plain `count` over `ix_username_reservations_user`.
   * The unlocked read, for the status screen; the change path counts again inside its
   * own transaction, because a number rendered on a screen and a number that gates a
   * charge are not permitted to be the same read.
   */
  async countChangesSince(userId: string, since: Date): Promise<number> {
    return this.prisma.usernameReservation.count({
      where: { userId, createdAt: { gt: since } },
    });
  }

  /**
   * When the OLDEST change inside the window happened, or null if there is none.
   *
   * The window is rolling, so this is the instant a used slot ages out — which is what
   * the status screen reports as "your next free change". `select`ed down to the one
   * column and `take: 1`, because the whole answer is a single timestamp and the rest
   * of the row is of no interest to the caller.
   */
  async oldestChangeSince(userId: string, since: Date): Promise<Date | null> {
    const row = await this.prisma.usernameReservation.findFirst({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  /**
   * Every username the filter must know about, in id order, one page at a time.
   *
   * Both tables, because the filter's membership question is "has this name ever been
   * claimed or reserved" — a reserved name absent from the filter would take the
   * "definitely absent" fast path and be offered to somebody.
   *
   * Paged rather than a single `findMany`, so warming a filter on a large account table
   * does not materialise every username in memory at once.
   */
  async pageClaimedUsernames(
    afterUserId: string | null,
    take: number,
  ): Promise<{ usernames: string[]; lastUserId: string | null }> {
    const users = await this.prisma.user.findMany({
      where: afterUserId === null ? {} : { id: { gt: afterUserId } },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, usernameLower: true },
    });

    return {
      usernames: users.map((row) => row.usernameLower),
      lastUserId: users.at(-1)?.id ?? null,
    };
  }

  /** The reserved half of the same warm-up. Expired rows are included deliberately: the
   *  filter never deletes, so whether a name is reserved NOW does not change whether it
   *  has ever been seen — and a positive costs only a database query. */
  async pageReservedUsernames(
    afterId: string | null,
    take: number,
  ): Promise<{ usernames: string[]; lastId: string | null }> {
    const rows = await this.prisma.usernameReservation.findMany({
      where: afterId === null ? {} : { id: { gt: afterId } },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, usernameLower: true },
    });

    return { usernames: rows.map((row) => row.usernameLower), lastId: rows.at(-1)?.id ?? null };
  }

  // ─── the change ───────────────────────────────────────────────────────────

  /**
   * Move the account to `username`, reserving the one it leaves.
   *
   * ─── The order inside the transaction IS the design ────────────────────
   *
   *   lock the name -> lock the account -> decide availability -> decide the charge ->
   *   expire the reclaimed reservation -> reserve what was left -> move the account
   *
   * The advisory lock is first, before the availability read and not merely before the
   * write, because a reservation committing between a check and an insert is exactly
   * the window it exists to close. See `username-claim.lock.ts` for why the unique
   * index cannot cover this and why every claim path takes these two locks in this
   * order.
   *
   * ─── What this layer decides and what it is told ───────────────────────
   *
   * It decides nothing about policy. `freeChanges`, `windowStart` and the retention
   * deadlines arrive from `UsernameService`; this method only applies them at the one
   * instant they can be applied safely, which is under the lock. The split follows
   * `registerFailedAttempt`, which takes its lockout ladder as a callback for the same
   * reason.
   *
   * `expiresAtFor` is a callback rather than a date because the answer depends on a
   * fact only visible in here: whether this account already holds a live reservation.
   * If it does, the account is mid-churn and the username it is leaving now comes back
   * in minutes; if it does not, this is the first change of a sequence and the released
   * name is held for the full retention. That single question is the whole of the
   * "only the FIRST previous username is reserved for thirty days" rule.
   *
   * ─── The reclaim ───────────────────────────────────────────────────────
   *
   * An account taking back a username it reserved is not taking anything from anyone,
   * so the reservation is expired and the change proceeds. `protectedReclaim` — the
   * caller's verdict on whether that reservation was the long, identity-protecting one
   * rather than a few-minute churn artifact — additionally waives the charge. It has to
   * be waived for the long one: the reservation exists so a compromised account can get
   * its identity back, and an owner who cannot pay is exactly the person that protection
   * is for. It must NOT be waived for the short ones, or two names could be ping-ponged
   * between forever, every hop free.
   *
   * ─── What the database decides ─────────────────────────────────────────
   *
   * Uniqueness. `ix_users_username_active` is a partial index Prisma cannot see, so a
   * collision arrives as a raw `23505` inside this transaction and rolls all of it back.
   * The service translates it to the same `username_unavailable` the explicit check
   * above raises — the caller cannot tell which one refused them, which is correct,
   * because it is the same answer.
   */
  async changeUsername(input: {
    userId: string;
    username: string;
    usernameLower: string;
    /** The username the caller believes the account holds. The change is refused if it
     *  moved — see the conditional update at the end. */
    expectedCurrentLower: string;
    /** Start of the allowance window. Rows created after it count against the caller. */
    windowStart: Date;
    freeChanges: number;
    /** True when the caller's own reservation on the target was the long one. */
    protectedReclaim: (reservation: UsernameReservation) => boolean;
    expiresAtFor: (churning: boolean) => Date;
  }): Promise<ChangeUsernameResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUsernameClaim(tx, input.usernameLower);

      const current = await tx.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { username: true, usernameLower: true },
      });
      if (current === null) throw new UsernameRaceLostError('account not found');
      if (current.usernameLower !== input.expectedCurrentLower) {
        throw new UsernameRaceLostError('username moved');
      }

      // Copied out before anything else runs, rather than read off `current` later.
      // The row is about to be updated to the NEW username, and reading the released
      // name from a variable that may or may not still reflect the old one — depending
      // on whether the client hands back a detached object — is the kind of dependency
      // that works until it does not.
      const releasedUsername = current.username;
      const releasedUsernameLower = current.usernameLower;

      // Under the lock, so nothing can reserve or claim this name between here and the
      // update below.
      const [heldByAccount, reservation] = await Promise.all([
        tx.user.count({ where: { usernameLower: input.usernameLower, deletedAt: null } }),
        tx.usernameReservation.findFirst({
          where: { usernameLower: input.usernameLower, expiresAt: { gt: new Date() } },
          orderBy: { expiresAt: 'desc' },
        }),
      ]);
      if (heldByAccount > 0) throw new UsernameTakenError();
      if (reservation !== null && reservation.userId !== input.userId) {
        throw new UsernameTakenError();
      }

      const reclaiming = reservation !== null;
      const waived = reclaiming && input.protectedReclaim(reservation);

      // Asked BEFORE the reclaimed row is expired, so a reclaim counts as churn and the
      // username being given up now comes back in minutes rather than being held for a
      // month. An account that has changed once in the last thirty days is churning
      // whichever direction it is moving.
      const live = await tx.usernameReservation.count({
        where: { userId: input.userId, expiresAt: { gt: new Date() } },
      });

      if (!waived) {
        const used = await tx.usernameReservation.count({
          where: { userId: input.userId, createdAt: { gt: input.windowStart } },
        });
        if (used >= input.freeChanges) throw new UsernamePaymentRequiredError();
      }

      if (reservation !== null) {
        // Expired, not deleted. The row is a ledger entry as well as a reservation, and
        // deleting it would erase the change that created it — which is what would let
        // an account bounce between two names without ever spending its allowance.
        // Scoped to this user: another account's reservation is not ours to clear, and
        // the check above has already refused that case.
        await tx.usernameReservation.updateMany({
          where: { id: reservation.id, userId: input.userId },
          data: { expiresAt: new Date() },
        });
      }

      const releasedExpiresAt = input.expiresAtFor(live > 0);
      await tx.usernameReservation.create({
        data: {
          id: uuidv7(),
          userId: input.userId,
          username: releasedUsername,
          usernameLower: releasedUsernameLower,
          expiresAt: releasedExpiresAt,
        },
      });

      // Conditional, and the predicate is the username we read under the lock. The row
      // lock already serialises writers, so this is belt and braces — but it is the same
      // shape `renameForCompliance` depends on, where there is a real unlocked read to
      // defend, and having one shape for both is worth more than the statement saved.
      const { count } = await tx.user.updateMany({
        where: {
          id: input.userId,
          usernameLower: input.expectedCurrentLower,
          deletedAt: null,
        },
        data: { username: input.username, usernameLower: input.usernameLower },
      });
      if (count !== 1) throw new UsernameRaceLostError('username moved during the write');

      const user = await tx.user.findFirstOrThrow({ where: { id: input.userId } });
      const changesInWindow = await tx.usernameReservation.count({
        where: { userId: input.userId, createdAt: { gt: input.windowStart } },
      });

      return {
        user,
        released: { username: releasedUsername, expiresAt: releasedExpiresAt },
        changesInWindow,
      };
    });
  }

  // ─── the Premium-expiry rename ────────────────────────────────────────────

  /**
   * Lengthen a username that is only legal because of a Premium entitlement that has
   * lapsed. Returns false when there was nothing to do.
   *
   * Not a variant of `changeUsername`, and the differences are all deliberate: no
   * reservation is written and no allowance is spent, because the account did not
   * choose this change and must not be charged for it — nor should the name it is
   * forced off be held against the next person who wants it.
   *
   * ─── Idempotency, which is the whole contract ──────────────────────────
   *
   * This is driven by a sweeper that may run on several instances at once, may be
   * restarted mid-pass, and has no durable cursor. So it must be safe to call for the
   * same account any number of times, from any number of processes, and it is — by
   * checking the preconditions AGAIN here, under the row lock, after the caller checked
   * them without one:
   *
   *   the account still exists, is not deleted
   *   its username is still the one the caller measured    (`expectedCurrentLower`)
   *   that username is still shorter than the free floor   (`stillNonCompliant`)
   *
   * A second caller arriving after the first has committed fails the second and third
   * of those and returns false, having written nothing. That is the mechanism by which
   * a rename never happens twice, and it does not depend on the sweeper's scheduling.
   *
   * ─── Why the caller reads first and locks second ───────────────────────
   *
   * Because a candidate name has to exist before it can be locked, and the lock order
   * in `username-claim.lock.ts` puts the NAME before the account row. Reversing it here
   * — row first, then name — is the one arrangement that could deadlock against
   * `changeUsername`. So the caller computes a candidate from an unlocked read, and
   * everything decided from that read is re-decided in here.
   */
  async renameForCompliance(input: {
    userId: string;
    username: string;
    usernameLower: string;
    expectedCurrentLower: string;
    /** Re-run against the username found under the lock, so a name that stopped being
     *  too short between the caller's read and this write is left alone. */
    stillNonCompliant: (usernameLower: string) => boolean;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockUsernameClaim(tx, input.usernameLower);

      const current = await tx.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { usernameLower: true },
      });
      if (current === null) return false;
      if (current.usernameLower !== input.expectedCurrentLower) return false;
      if (!input.stillNonCompliant(current.usernameLower)) return false;

      const [heldByAccount, reserved] = await Promise.all([
        tx.user.count({ where: { usernameLower: input.usernameLower, deletedAt: null } }),
        tx.usernameReservation.count({
          where: { usernameLower: input.usernameLower, expiresAt: { gt: new Date() } },
        }),
      ]);
      if (heldByAccount > 0 || reserved > 0) throw new UsernameTakenError();

      const { count } = await tx.user.updateMany({
        where: { id: input.userId, usernameLower: input.expectedCurrentLower, deletedAt: null },
        data: { username: input.username, usernameLower: input.usernameLower },
      });
      return count === 1;
    });
  }
}
