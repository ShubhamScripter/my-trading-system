import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';

/**
 * ═══ WHAT ACTUALLY DESTROYS A DELETED ACCOUNT ═══════════════════════════════
 *
 * `POST /settings/security/delete-account` moves `status` to DELETED, revokes every
 * session and writes a deadline. It destroys nothing — the account is LOCKED, not gone,
 * and stays fully restorable for thirty days.
 *
 * This is the only thing that turns that deadline into an erasure, and the erasure is a
 * real one: `purgeAccount` issues `DELETE FROM users`, which cascades to every child
 * table. There is no tombstone and no terminal status — after it commits the account
 * does not exist in the data model at all, reactivation is impossible rather than
 * refused, and the email and username are free because no row holds them.
 *
 * That is a line with no path back across it, which is the reason this class is as
 * conservative as it is.
 *
 * ─── Why an interval and not a job framework ────────────────────────────────
 *
 * Because this repository has no scheduler and adding one for this would be larger than
 * the feature. There is no `@nestjs/schedule`, no BullMQ and no cron; the four existing
 * periodic tasks — `UsernameComplianceService`, `RateLimitPolicyService`,
 * `CaptchaSettingsService` and `SocialUnlinkSweeper` — are each an unref'd
 * `setInterval` calling one method, and this is a fifth of exactly that shape. The mail
 * queue is the only real worker, and it is a Redis Stream consumer built for
 * at-least-once delivery of MESSAGES, which a periodic scan of a table is not.
 *
 * ─── Why the thirty-day promise does not depend on this process ─────────────
 *
 * The deadline lives in Postgres. This class never remembers anything — no cursor, no
 * timer per account, no Redis key — it only ever asks "which deleted accounts are due
 * right now". So a restart, a deployment, a Redis outage or a crash costs nothing: the
 * next process to boot asks the same question and gets the same answer, including for
 * accounts that came due while nothing was running.
 *
 * The direction of that failure is worth stating, because it is the safe one. If this
 * never runs, accounts stay recoverable longer than promised and no data is destroyed
 * early. The alternative design — purging at request time and keeping a recovery copy —
 * fails the other way.
 *
 * ─── Why running it twice is harmless ───────────────────────────────────────
 *
 * Every instance in a multi-instance deployment runs this, concurrently, and that is
 * fine rather than merely tolerated. `purgeAccount` opens with a conditional `UPDATE`
 * that re-states every precondition and takes the row lock; the second writer blocks
 * until the first commits, then matches no rows — the account is gone — and stops
 * before touching anything.
 *
 * The claim is inside the same transaction as the destruction, which is what makes a
 * retry after a partial failure safe rather than merely likely to work. A crash midway
 * rolls the claim back too, so the account stays exactly as due as it was and the next
 * sweep repeats the whole thing — where a claim committed on its own would have left a
 * row marked purged, invisible to `listDuePurges`, with its credentials still on disk.
 *
 * ─── The lag, and why it is acceptable ──────────────────────────────────────
 *
 * An account is purged at the first tick at or after its deadline, not at the deadline
 * itself, so its data can survive up to `SWEEP_INTERVAL_MS` past the thirty days. That
 * is deliberate and safe in both directions: the account grants nothing during the
 * overrun — `status` has been DELETED since the request and every sign-in path refuses
 * it — and a reactivation arriving inside the overrun is refused by
 * `reactivateAccount`'s `purgeAt > now` predicate rather than being silently allowed.
 * The two predicates are complementary, so the lag cannot open a window in which both
 * or neither apply.
 */
@Injectable()
export class AccountPurgeSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AccountPurgeSweeper');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly users: UserDbOperation) {}

  onApplicationBootstrap(): void {
    // One pass at boot, before the first interval.
    //
    // Without it a deployment or a restart silently costs up to a full interval: the
    // accounts that came due while nothing was running would sit due until the timer
    // happened to fire. Since the query is "what is due now" and the purge is
    // idempotent, running it immediately is one indexed read.
    //
    // Not awaited — `onApplicationBootstrap` must not block startup on a database round
    // trip — and `sweep` never throws, so there is nothing to catch here.
    void this.sweep();

    // `unref` so a pending sweep never holds the process open — the same thing
    // `SocialUnlinkSweeper` and `UsernameComplianceService` do with their timers.
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Never throws.
   *
   * A sweep that dies takes the interval with it, and this is the only thing that
   * completes a deletion — so every failure is caught, logged and left for the next
   * tick, which will ask the same question and get the same rows.
   *
   * Public so tests can drive it directly. No spec in this repository lets an interval
   * fire, and this one does not need to: the timer's only job is to call this.
   */
  async sweep(): Promise<void> {
    // Captured BEFORE the query and reused for the writes, so an account that comes due
    // mid-sweep is caught by the next pass rather than falling between the read and the
    // update. It is also the instant each claim is checked against, which keeps the
    // whole batch consistent about when it ran.
    const sweptAt = new Date();

    let due;
    try {
      due = await this.users.listDuePurges(sweptAt, BATCH_SIZE);
    } catch (err) {
      this.logger.error({ err }, 'could not list accounts due for purge; retrying next sweep');
      return;
    }

    let purged = 0;
    for (const user of due) {
      try {
        // `purgeAccount` returns every address this account ever answered to, collected
        // INSIDE its transaction before anything was destroyed. It has to come from
        // there rather than from the row read above: `mail_deliveries` has no foreign
        // key to `users` and is reached by value, and the addresses an account has
        // RELEASED by changing its email live in `retained_emails`, which the purge
        // itself deletes. Reading `user.emailLower` here would scrub the current
        // address and silently miss every previous one.
        const recipients = await this.users.purgeAccount(user.id, sweptAt);
        if (recipients === null) {
          // Not a failure: the account was reactivated between the read and the write,
          // or another instance purged it first. Both are states this sweep wanted.
          continue;
        }
        purged += 1;

        // Deliberately AFTER the purge and outside its transaction, and deliberately
        // allowed to fail on its own. These rows are a delivery audit trail with no
        // relation to the account, so a failure here must not roll back an erasure that
        // otherwise succeeded — it would leave the account's credentials destroyed and
        // its state still due, which is a worse outcome than a delivery log that keeps
        // an address for one more tick. The next sweep does not retry it, so this is
        // logged loudly enough to be noticed.
        try {
          const scrubbed = await this.users.scrubMailDeliveries(recipients);
          if (scrubbed > 0) {
            this.logger.log({ userId: user.id, scrubbed }, 'delivery log scrubbed');
          }
        } catch (err) {
          this.logger.error(
            { err, userId: user.id },
            'account purged but its delivery log could not be scrubbed; needs manual cleanup',
          );
        }

        // `userId` and the deadline only. The identifiers are exactly what this
        // operation exists to remove from the record, so putting them in a log line
        // would undo the work one line above.
        // The last line that will ever name this id: the row it refers to no longer
        // exists. `userId` and the deadline only — the identifiers are exactly what this
        // operation exists to remove, so putting them in a log line would undo the work.
        this.logger.warn(
          { userId: user.id, purgeAt: user.purgeAt },
          'account permanently deleted after its recovery period',
        );
      } catch (err) {
        // One row's failure must not abandon the batch. It stays due, and the next
        // sweep picks it up again — there is no cursor to advance past it.
        this.logger.error({ err, userId: user.id }, 'could not purge one due account');
      }
    }

    if (purged > 0) this.logger.log({ purged }, 'due account purges completed');
  }
}

/**
 * How often to look for due accounts.
 *
 * Hourly, matching `SocialUnlinkSweeper`. The deadline is thirty days out, so an hour
 * of lag is a tenth of a percent of the window and is invisible to a user reading a
 * date; a tighter loop would only poll an almost-always-empty table harder.
 *
 * The one thing it must not be is longer than the shortest useful notice, and nothing
 * here is measured in less than days.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How many accounts one pass may purge.
 *
 * Smaller than `SocialUnlinkSweeper`'s 200, and for a reason rather than by accident:
 * retiring a link is one `UPDATE`, while purging an account is a transaction across
 * fourteen tables plus a delivery-log scrub. A ceiling that made sense for the former
 * would let one tick hold a long transaction open against `users` and everything that
 * references it.
 *
 * A ceiling rather than a target: due accounts arrive at the rate users deleted
 * themselves thirty days ago, so in practice a pass finds zero or a handful. Anything
 * left over is still due on the next tick, ordered oldest-deadline first.
 */
const BATCH_SIZE = 50;
