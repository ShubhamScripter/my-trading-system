import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { User } from '@prisma/client';
import { USERNAME } from '../../../auth/auth.constants';
import { policy } from '../../../auth/limits';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import {
  UsernamePaymentRequiredError,
  UsernameRaceLostError,
  UsernameReservationDbOperation,
  UsernameTakenError,
} from '../../../auth/persistence/username-reservation.dboperation';
import { isUniqueViolation } from '../../../db/client';
import { CacheService, KEYS, UsernameBloomService } from '../../../redis';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import type {
  UsernameAvailabilityPayload,
  UsernameQuotaPayload,
  UsernameStatusPayload,
  UsernameUpdatedPayload,
} from './username.dto';
import {
  PREMIUM_PORT,
  USERNAME_PAID_CHANGE,
  type PremiumStatus,
  type PremiumStatusPort,
  type UnavailableReason,
} from './username.types';
import {
  USERNAME_PATTERN,
  assessUsername,
  isProtectedReservation,
  lengthBandFor,
  normaliseUsername,
  suggestionCandidates,
} from './username.utility';

/**
 * ═══ THE USERNAME SETTING ═══════════════════════════════════════════════════
 *
 * Three operations, and the interesting thing about them is that two of them answer the
 * same question with opposite priorities.
 *
 *   `status`       what the settings screen renders. No decisions.
 *   `availability` is this name free? Optimised for SPEED — it runs on a keystroke.
 *   `update`       take this name. Optimised for CORRECTNESS — it moves an identity.
 *
 * ─── The rule that keeps those two from contradicting each other ────────────
 *
 * `update` NEVER trusts a previous `availability`. Not as a defensive measure — as the
 * expected case. Two users can both be told a name is free, because it is, and the one
 * who saves second must be refused. So availability is advisory by construction and the
 * only authority is the write itself, under an advisory lock, against a partial unique
 * index. See `UsernameReservationDbOperation.changeUsername`.
 *
 * ─── What this service owns ─────────────────────────────────────────────────
 *
 * All of the policy: normalisation, the length band and where it comes from, the
 * reserved list, suggestions, the allowance, whether payment is due, and how long a
 * released username is held. The dboperation applies what it is handed at the one
 * instant it can be applied safely; the port answers what this service may not guess.
 */
@Injectable()
export class UsernameService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Username');

  constructor(
    private readonly reservations: UsernameReservationDbOperation,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    private readonly bloom: UsernameBloomService,
    @Inject(PREMIUM_PORT) private readonly premium: PremiumStatusPort,
  ) {}

  /**
   * Build the availability filter, once, from Postgres.
   *
   * `OnApplicationBootstrap` rather than `OnModuleInit` so the connections this needs
   * are up, and deliberately NOT awaited by the caller — see `run` below. The service
   * is fully correct before this finishes and after it fails; a cold filter simply
   * sends every check to Postgres.
   */
  onApplicationBootstrap(): void {
    void this.warmFilter();
  }

  // ─── status ───────────────────────────────────────────────────────────────

  /**
   * Everything the settings screen renders, already decided.
   *
   * The frontend computes nothing here — not the minimum length that applies to this
   * caller, not how many free changes are left, not whether the next one is paid, not
   * when the window turns over. Every one of those is a policy this service owns, and a
   * client that derived any of them would be a second implementation that drifts from
   * this one the first time a number changes.
   */
  async status(userId: string): Promise<UsernameStatusPayload> {
    const user = await this.requireUser(userId);
    const premium = await this.premiumFor(userId);
    const band = lengthBandFor(premium.active);

    const [reservations, quota] = await Promise.all([
      this.reservations.listLiveForUser(userId),
      this.quotaFor(userId),
    ]);

    return {
      outcome: 'username_status',
      username: user.username,
      rules: {
        minLength: band.minLength,
        defaultMinLength: USERNAME.DEFAULT_MIN_LENGTH,
        premiumMinLength: USERNAME.PREMIUM_MIN_LENGTH,
        maxLength: USERNAME.MAX_LENGTH,
        pattern: USERNAME_PATTERN,
      },
      premium: {
        active: premium.active,
        expiresAt: premium.expiresAt?.toISOString() ?? null,
      },
      quota,
      nextChange:
        quota.freeChangesRemaining > 0
          ? { requiresPayment: false, amountMinor: null, currency: null }
          : {
              requiresPayment: true,
              amountMinor: USERNAME_PAID_CHANGE.amountMinor,
              currency: USERNAME_PAID_CHANGE.currency,
            },
      reservations: reservations.map((reservation) => ({
        username: reservation.username,
        expiresAt: reservation.expiresAt.toISOString(),
        reclaimFree: isProtectedReservation(reservation),
      })),
    };
  }

  // ─── live availability ────────────────────────────────────────────────────

  /**
   * Is this username free? The endpoint the client calls while the user types.
   *
   * ─── Why an invalid username is a 200 and not a 400 ────────────────────────
   *
   * Because half a username is the normal state of this endpoint's input. A field being
   * typed into passes through `s`, `sh`, `shu` before it reaches anything legal, and
   * answering those with `validation_failed` would mean a client either debounces long
   * enough to feel broken or renders an error for every prefix of a valid name.
   *
   * So the rules are evaluated and REPORTED — `available: false`, `reason: 'invalid'`,
   * and the specific issues — which is the same information a 400 carries, in the shape
   * this particular caller can use. The mutation still refuses invalid input properly,
   * with `username_invalid`, because there the caller has committed.
   *
   * ─── The fast path ────────────────────────────────────────────────────────
   *
   *   normalise -> rules -> Bloom -> Postgres only if the Bloom says maybe
   *
   * A Bloom negative is conclusive and returns without touching the database, which is
   * the whole point: most names anyone types have never existed. A Bloom positive is
   * NOT conclusive and never treated as one — it is a false positive, a stale entry for
   * a released name, or a real hit, and only Postgres can say which.
   */
  async availability(userId: string, raw: string): Promise<UsernameAvailabilityPayload> {
    await this.cache.consume(
      KEYS.rate.usernameCheckByAccount(userId),
      policy().USERNAME.CHECK_BY_ACCOUNT,
      // Fail OPEN. Nothing is spent by a check — no mail, no code, no money — and
      // Postgres still decides who owns a name. A Redis outage that refused this would
      // break typing in order to protect nothing.
      'allow',
    );

    const username = normaliseUsername(raw);
    const premium = await this.premiumFor(userId);
    const assessment = assessUsername(username, lengthBandFor(premium.active));

    if (!assessment.ok) {
      return {
        outcome: 'username_availability',
        username,
        available: false,
        reason: 'invalid',
        issues: assessment.issues,
      };
    }

    const user = await this.requireUser(userId);
    if (user.usernameLower === username) {
      // Its own reason rather than `taken`: the remedy is "you already have it", and a
      // client that showed "username taken" for the caller's own name would be telling
      // them to pick something else for no reason.
      return { outcome: 'username_availability', username, available: false, reason: 'current' };
    }

    const reason = await this.unavailableReason(username, userId);
    if (reason === null) {
      return { outcome: 'username_availability', username, available: true };
    }

    return {
      outcome: 'username_availability',
      username,
      available: false,
      reason,
      suggestions: await this.suggestionsFor(username, premium, user),
    };
  }

  // ─── the change ───────────────────────────────────────────────────────────

  /**
   * Take `raw` as this account's username.
   *
   * Everything before the transaction is a cheap refusal — the rules, the caller's own
   * name — and none of it decides anything the transaction relies on. Availability, the
   * allowance and the write happen together, under the advisory lock, because they are
   * one decision and any gap between them is a race somebody wins.
   */
  async update(userId: string, raw: string): Promise<UsernameUpdatedPayload> {
    await this.cache.consume(
      KEYS.rate.usernameUpdateByAccount(userId),
      policy().USERNAME.UPDATE_BY_ACCOUNT,
      // Fail CLOSED, unlike the check. This one starts an advisory-locked transaction,
      // and most calls that reach it are refusals — the name went while the user was
      // deciding — so an unmetered path here is a way to make the database do work for
      // free.
      'deny',
    );

    const username = normaliseUsername(raw);
    const user = await this.requireUser(userId);
    const premium = await this.premiumFor(userId);

    const assessment = assessUsername(username, lengthBandFor(premium.active));
    if (!assessment.ok) {
      throw new ProblemException({
        type: ERR.USERNAME_INVALID,
        detail: assessment.issues[0]?.message,
        // The full list, so a form marks every problem at once rather than one per
        // round trip.
        extra: { issues: assessment.issues },
      });
    }

    if (user.usernameLower === username) {
      throw new ProblemException({
        type: ERR.USERNAME_SAME_AS_CURRENT,
        detail: 'That is already your username.',
      });
    }

    const windowStart = this.windowStart();

    try {
      const result = await this.reservations.changeUsername({
        userId,
        username,
        usernameLower: username,
        expectedCurrentLower: user.usernameLower,
        windowStart,
        freeChanges: USERNAME_PAID_CHANGE.FREE_CHANGES,
        protectedReclaim: isProtectedReservation,
        expiresAtFor: (churning) =>
          churning
            ? new Date(Date.now() + USERNAME.RELEASE_SECONDS * 1000)
            : new Date(Date.now() + USERNAME.RETENTION_DAYS * 24 * 60 * 60 * 1000),
      });

      // After the commit, and best-effort. Both names go in: the new one because it is
      // now taken, and the released one because it is now RESERVED — a reserved name
      // missing from the filter would take the "definitely absent" fast path and be
      // offered to somebody else.
      await this.bloom.add(username, result.released.username.toLowerCase());

      return {
        outcome: 'username_updated',
        username: result.user.username,
        previous: {
          username: result.released.username,
          reservedUntil: result.released.expiresAt.toISOString(),
        },
        quota: this.renderQuota(result.changesInWindow, await this.oldestChangeAt(userId)),
      };
    } catch (err) {
      throw this.translate(err);
    }
  }

  // ─── the pieces ───────────────────────────────────────────────────────────

  /**
   * Why this username cannot be used, or null if it can.
   *
   * THE Bloom fast path, and the only place in the feature that is allowed to answer
   * without asking Postgres.
   *
   *   'absent'  the name was never inserted into the filter, so it has never been
   *             claimed or reserved by anyone. Free. No database query.
   *   'maybe'   a real hit, a false positive, or a stale entry for a name that has since
   *             been released. Indistinguishable from in here, so Postgres decides.
   *
   * The stale case is the one worth being explicit about, because it is permanent: the
   * filter never deletes, so every username ever released stays in it forever and reads
   * as 'maybe' for the rest of time. That is fine, and it is fine BECAUSE of the line
   * below — Postgres reports it available, and this returns null. A stale bit costs one
   * query and can never make a free username unavailable.
   */
  private async unavailableReason(
    usernameLower: string,
    userId: string,
  ): Promise<UnavailableReason | null> {
    if ((await this.bloom.test(usernameLower)) === 'absent') return null;

    const { takenByAccount, reservation } = await this.reservations.availability(usernameLower);
    if (takenByAccount) return 'taken';
    if (reservation === null) return null;

    // The caller's own reservation is not an obstacle to the caller — reclaiming a
    // username you released is the thing the reservation exists to allow.
    return reservation.userId === userId ? null : 'reserved';
  }

  /**
   * Alternatives, checked against Postgres before any of them is offered.
   *
   * The Bloom filter is deliberately NOT used to decide this. It would be sound for the
   * names it calls absent, but it would also drop every candidate it calls 'maybe' —
   * including the false positives and the long tail of released names it can never
   * forget — so a filter that has been running for a year would quietly stop being able
   * to suggest anything. One batched query over both tables is two round trips for the
   * whole set and is always right.
   */
  private async suggestionsFor(
    stem: string,
    premium: PremiumStatus,
    user: User,
  ): Promise<readonly string[]> {
    const band = lengthBandFor(premium.active);
    const candidates = suggestionCandidates(stem, band, USERNAME.SUGGESTION_COUNT * 3).filter(
      // Never suggest what the caller already has, and never suggest something the
      // rules would refuse a moment later.
      (candidate) => candidate !== user.usernameLower && assessUsername(candidate, band).ok,
    );

    const available = await this.reservations.filterAvailable(candidates);
    return available.slice(0, USERNAME.SUGGESTION_COUNT);
  }

  private async quotaFor(userId: string): Promise<UsernameQuotaPayload> {
    const used = await this.reservations.countChangesSince(userId, this.windowStart());
    return this.renderQuota(used, await this.oldestChangeAt(userId));
  }

  /**
   * `nextFreeChangeAt` is when the OLDEST change in the window ages out, which is the
   * instant a slot frees. Computed here rather than sent as a raw timestamp for the
   * client to subtract from, for `security_change_cooldown`'s reason: a client doing
   * that arithmetic is a second copy of the allowance policy.
   */
  private renderQuota(used: number, oldestChangeAt: Date | null): UsernameQuotaPayload {
    const remaining = Math.max(0, USERNAME_PAID_CHANGE.FREE_CHANGES - used);
    const windowMs = USERNAME_PAID_CHANGE.FREE_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    return {
      freeChangesRemaining: remaining,
      freeChangesTotal: USERNAME_PAID_CHANGE.FREE_CHANGES,
      periodDays: USERNAME_PAID_CHANGE.FREE_CHANGE_WINDOW_DAYS,
      nextFreeChangeAt:
        remaining > 0 || oldestChangeAt === null
          ? null
          : new Date(oldestChangeAt.getTime() + windowMs).toISOString(),
    };
  }

  private async oldestChangeAt(userId: string): Promise<Date | null> {
    return this.reservations.oldestChangeSince(userId, this.windowStart());
  }

  private windowStart(): Date {
    const windowMs = USERNAME_PAID_CHANGE.FREE_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - windowMs);
  }

  /**
   * The entitlement, asked once per request and never taken from the caller.
   *
   * `statusFor` is contracted never to throw, so there is no error path here. That
   * contract is the security control: a provider that failed open would hand out
   * two-character usernames during an outage.
   */
  private async premiumFor(userId: string): Promise<PremiumStatus> {
    return this.premium.statusFor(userId);
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (user === null) {
      // A live session for an account that no longer exists. Not this feature's
      // refusal to explain.
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return user;
  }

  /**
   * Turn what the transaction threw into what the caller is told.
   *
   * `UsernameTakenError` and a raw unique violation both become `username_unavailable`,
   * and the caller cannot tell which refused them. That is correct: one is "we looked
   * and it was gone", the other is "we tried and lost the race", and they are the same
   * answer to the same question. Distinguishing them would leak how close the caller
   * came, and would suggest retrying is worth something.
   *
   * `UsernameRaceLostError` folds into the same slug for a different reason: the
   * account's username moved under the caller — another tab, or the Premium-expiry
   * reconciler — so the change they asked for no longer describes the account they
   * asked about. Re-reading the screen is the remedy, which is what an unavailable name
   * prompts anyway.
   */
  private translate(err: unknown): unknown {
    if (err instanceof UsernamePaymentRequiredError) {
      return new ProblemException({
        type: ERR.USERNAME_CHANGE_PAYMENT_REQUIRED,
        detail: 'You have used your free username changes for this period.',
        extra: {
          amountMinor: USERNAME_PAID_CHANGE.amountMinor,
          currency: USERNAME_PAID_CHANGE.currency,
        },
      });
    }

    if (
      err instanceof UsernameTakenError ||
      err instanceof UsernameRaceLostError ||
      isUniqueViolation(err)
    ) {
      return new ProblemException({
        type: ERR.USERNAME_UNAVAILABLE,
        detail: 'That username is no longer available.',
      });
    }

    return err;
  }

  // ─── the filter warm-up ───────────────────────────────────────────────────

  /**
   * Populate the Bloom filter from Postgres, then start trusting its negatives.
   *
   * Single-flight across instances, so a rolling deploy scans `users` once rather than
   * once per pod. Losing that race is the ordinary case and not an error — the winner
   * builds the filter, and the loser's own `bloom.test` starts returning 'absent' as
   * soon as the ready flag is set, because the flag lives in Redis.
   *
   * ─── Order is the only thing that matters here ─────────────────────────────
   *
   * Every username is added BEFORE the ready flag is set, and the flag is what makes
   * negatives trusted. Setting it first — or setting it after a partial pass — would
   * mean the filter reports 'absent' for names that exist, which is the one error a
   * Bloom filter is not allowed to make and the only way this feature could hand two
   * accounts the same username.
   *
   * A failure anywhere leaves the flag unset, so the filter stays off and every check
   * goes to Postgres. Slower, and right.
   */
  private async warmFilter(): Promise<void> {
    const claimed = await this.bloom.beginWarmUp(WARM_LOCK_SECONDS);
    if (!claimed) return;

    const started = Date.now();
    let added = 0;

    try {
      let afterUserId: string | null = null;
      for (;;) {
        const page = await this.reservations.pageClaimedUsernames(afterUserId, WARM_PAGE_SIZE);
        if (page.usernames.length === 0) break;
        await this.bloom.add(...page.usernames);
        added += page.usernames.length;
        afterUserId = page.lastUserId;
        if (afterUserId === null) break;
      }

      let afterId: string | null = null;
      for (;;) {
        const page = await this.reservations.pageReservedUsernames(afterId, WARM_PAGE_SIZE);
        if (page.usernames.length === 0) break;
        await this.bloom.add(...page.usernames);
        added += page.usernames.length;
        afterId = page.lastId;
        if (afterId === null) break;
      }

      await this.bloom.markReady();
      this.logger.log({ added, ms: Date.now() - started }, 'username filter warmed');
    } catch (err) {
      // The flag is never set, so the filter stays off and nothing reads a partial
      // bitmap. The next process to boot claims the lock when it expires and retries.
      this.logger.error({ err, added }, 'username filter warm-up failed; staying on the database');
    }
  }
}

/** Rows per warm-up page. Big enough that a large table is a few hundred round trips,
 *  small enough that none of them materialises a meaningful amount of memory. */
const WARM_PAGE_SIZE = 5_000;

/** How long one instance may hold the warm-up claim. Generous — a warm-up that takes
 *  longer than this on a real table means the page size is wrong — and finite, so an
 *  instance killed mid-pass does not leave the filter unbuildable forever. */
const WARM_LOCK_SECONDS = 15 * 60;
