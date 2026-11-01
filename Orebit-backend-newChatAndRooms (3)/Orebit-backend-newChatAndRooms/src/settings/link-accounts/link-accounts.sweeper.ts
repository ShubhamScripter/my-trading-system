import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';

/**
 * ═══ WHAT ACTUALLY REMOVES A SOCIAL LOGIN ═══════════════════════════════════
 *
 * `POST /settings/security/social-accounts/unlink` writes a deadline and nothing
 * else. This is the only thing in the service that turns that deadline into a
 * soft-deleted row, and therefore the only thing that ever sets `OauthLink.deletedAt`.
 *
 * ─── Why an interval and not a job framework ────────────────────────────────
 *
 * Because this repository has no scheduler and adding one for this would be larger
 * than the feature. There is no `@nestjs/schedule`, no BullMQ and no cron; the three
 * existing periodic tasks — `UsernameComplianceService`, `RateLimitPolicyService` and
 * `CaptchaSettingsService` — are each an unref'd `setInterval` calling one method, and
 * this is a fourth of exactly that shape. The mail queue is the only real worker, and
 * it is a Redis Stream consumer built for at-least-once delivery of MESSAGES, which a
 * periodic scan of a table is not.
 *
 * ─── Why the seven-day promise does not depend on this process ──────────────
 *
 * The deadline lives in Postgres. This class never remembers anything — no cursor, no
 * timer per link, no Redis key — it only ever asks "which live links are due right
 * now". So a restart, a deployment, a Redis outage or a crash costs nothing: the next
 * process to boot asks the same question and gets the same answer, including for links
 * that came due while nothing was running. A `setTimeout` per request would have had
 * the opposite property, which is why there is not one.
 *
 * ─── Why running it twice is harmless ───────────────────────────────────────
 *
 * Every instance in a multi-instance deployment runs this, concurrently, and that is
 * fine rather than merely tolerated. The retirement is a conditional `UPDATE` that
 * re-states every precondition, so the second writer matches no rows and reports
 * nothing. The same property makes a retry after a partial failure safe.
 *
 * ─── The lag, and why it is acceptable ──────────────────────────────────────
 *
 * A link is retired at the first tick at or after its deadline, not at the deadline
 * itself, so it can stay usable for up to `SWEEP_INTERVAL_MS` past the seven days.
 * That is deliberate: the delay is a notice period, not an expiry that grants anyone
 * anything, and an hour on top of a week changes nothing a user or an attacker can
 * act on. Reading the deadline at sign-in time would remove the lag and would mean
 * editing the OAuth login path, which this feature does not touch.
 */
@Injectable()
export class SocialUnlinkSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('SocialUnlinkSweeper');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly users: UserDbOperation) {}

  onApplicationBootstrap(): void {
    // One pass at boot, before the first interval.
    //
    // Without it a deployment or a restart silently costs up to a full interval: the
    // links that came due while nothing was running would sit retired-in-name-only
    // until the timer happened to fire. Since the query is "what is due now" and the
    // retirement is idempotent, running it immediately is one indexed read and makes
    // the catch-up property actually immediate rather than eventual.
    //
    // Not awaited — `onApplicationBootstrap` must not block startup on a database
    // round trip — and `sweep` never throws, so there is nothing to catch here.
    void this.sweep();

    // `unref` so a pending sweep never holds the process open — the same thing
    // `UsernameComplianceService` and `RateLimitPolicyService` do with their timers.
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
   * completes an unlink — so every failure is caught, logged and left for the next
   * tick, which will ask the same question and get the same rows.
   *
   * Public so tests can drive it directly. No spec in this repository lets an interval
   * fire, and this one does not need to: the timer's only job is to call this.
   */
  async sweep(): Promise<void> {
    // Captured BEFORE the query and reused for the writes, so a link that comes due
    // mid-sweep is caught by the next pass rather than falling between the read and
    // the update. It is also the value written to `deletedAt`, which keeps the whole
    // batch consistent about when it ran.
    const sweptAt = new Date();

    let due;
    try {
      due = await this.users.listDueOauthUnlinks(sweptAt, BATCH_SIZE);
    } catch (err) {
      this.logger.error({ err }, 'could not list due social unlinks; retrying next sweep');
      return;
    }

    let retired = 0;
    for (const link of due) {
      try {
        if (await this.users.retireDueOauthLink(link.id, sweptAt)) {
          retired += 1;
          this.logger.warn(
            { userId: link.userId, provider: link.provider, unlinkAt: link.unlinkAt },
            'social account unlinked after its waiting period',
          );
        }
        // A `false` here is not a failure: the link was cancelled by a re-link, or
        // another instance retired it first. Both are states this sweep wanted.
      } catch (err) {
        // One row's failure must not abandon the batch. It stays due, and the next
        // sweep picks it up again — there is no cursor to advance past it.
        this.logger.error({ err, linkId: link.id }, 'could not retire one due social unlink');
      }
    }

    if (retired > 0) this.logger.log({ retired }, 'due social unlinks completed');
  }
}

/**
 * How often to look for due links.
 *
 * Hourly. The deadline is seven days out, so an hour of lag is under a percent of the
 * window and is invisible to a user reading a date; a tighter loop would only poll an
 * empty table harder. The one thing it must not be is longer than the shortest useful
 * notice, and nothing here is measured in less than days.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How many links one pass may retire.
 *
 * A ceiling rather than a target: due links arrive at the rate users request unlinks,
 * so in practice a pass finds zero or a handful. The bound exists so that a backlog —
 * a long outage, or a bulk correction — cannot turn one tick into an unbounded read.
 * Anything left over is still due on the next tick, ordered oldest-deadline first.
 */
const BATCH_SIZE = 200;
