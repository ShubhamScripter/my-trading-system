import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { USERNAME } from '../../../auth/auth.constants';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import {
  UsernameReservationDbOperation,
  UsernameTakenError,
} from '../../../auth/persistence/username-reservation.dboperation';
import { isUniqueViolation } from '../../../db/client';
import { UsernameBloomService } from '../../../redis';
import { PREMIUM_PORT, type PremiumStatusPort } from './username.types';
import { complianceCandidate } from './username.utility';

/**
 * ═══ WHAT HAPPENS TO A SHORT USERNAME WHEN PREMIUM LAPSES ═══════════════════
 *
 * Premium buys usernames from two characters; a free account's floor is seven. So an
 * entitlement that expires leaves an account holding a name it is no longer entitled
 * to, and the product's answer is to lengthen it with a random suffix — `ab` becomes
 * `ab_x7q29` — rather than to take it away or to leave it.
 *
 * The requirement is explicit that this must not wait for the user to open the settings
 * screen, which rules out doing it lazily on read. So it is swept.
 *
 * ─── Why a `setInterval` and not a job framework ────────────────────────────
 *
 * Because this repository has no scheduler and adding one for this would be the largest
 * thing in the feature. There is no `@nestjs/schedule`, no BullMQ, no cron; the two
 * existing periodic tasks — `RateLimitPolicyService` and `CaptchaSettingsService` — are
 * both an unref'd `setInterval` calling one method, and this is a third of exactly that
 * shape. The mail queue is the only real worker, and it is a Redis Stream consumer
 * built for at-least-once delivery of messages, which this is not.
 *
 * ─── Why the whole thing is a no-op today, honestly ─────────────────────────
 *
 * `NullPremiumProvider.listRecentlyExpired` returns nothing, because there is no
 * entitlement system, so this sweeps an empty list and renames nobody. That is the
 * correct state rather than a disabled one: with no way to obtain Premium there are no
 * short usernames to lengthen. The reconciler is written, race-safe, and tested against
 * its own doubles, and it starts working the moment `PREMIUM_PORT` is rebound.
 */
@Injectable()
export class UsernameComplianceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('UsernameCompliance');

  private timer: NodeJS.Timeout | null = null;

  /**
   * How far back the next sweep looks. In memory only, and deliberately.
   *
   * A persisted cursor would be a table, a migration and a new failure mode — a cursor
   * ahead of the work it describes silently skips accounts — to buy something
   * `reconcile` already provides for free. Re-processing an account that has already
   * been fixed costs one short read that returns false, so a restart re-scanning a whole
   * look-back window is cheap and cannot double-apply.
   *
   * Starts one look-back window in the past so a process that has been down does not
   * miss the accounts that expired while it was.
   */
  private since = new Date(Date.now() - LOOK_BACK_MS);

  constructor(
    private readonly reservations: UsernameReservationDbOperation,
    private readonly users: UserDbOperation,
    private readonly bloom: UsernameBloomService,
    @Inject(PREMIUM_PORT) private readonly premium: PremiumStatusPort,
  ) {}

  onApplicationBootstrap(): void {
    // `unref` so a sweep pending in the event loop never holds the process open —
    // `RateLimitPolicyService` does the same with its poll.
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Never throws — a sweep that dies takes the interval with it, and this is
   * the only thing keeping usernames compliant.
   */
  async sweep(): Promise<void> {
    // Captured BEFORE the query, so an account that expires while the query runs is
    // caught by the next sweep rather than falling between the two.
    const sweptAt = new Date();

    let expired: readonly string[];
    try {
      expired = await this.premium.listRecentlyExpired(this.since);
    } catch (err) {
      // The window is deliberately NOT advanced, so the next sweep re-asks for the same
      // period. Over-reporting costs no-ops; under-reporting leaves an account holding a
      // username it is not entitled to, and nothing else would notice.
      this.logger.error({ err }, 'could not list expired entitlements; retrying next sweep');
      return;
    }

    let renamed = 0;
    for (const userId of expired) {
      try {
        if (await this.reconcile(userId)) renamed += 1;
      } catch (err) {
        // One account's failure must not abandon the rest of the batch. It stays
        // non-compliant and the next sweep tries again, because the look-back window
        // still covers it.
        this.logger.error({ err, userId }, 'username compliance failed for one account');
      }
    }

    this.since = sweptAt;
    if (renamed > 0) this.logger.log({ renamed }, 'usernames brought back into compliance');
  }

  /**
   * Bring one account's username back inside the free-tier rules. Returns whether
   * anything was written.
   *
   * ─── THE IDEMPOTENCY CONTRACT ──────────────────────────────────────────────
   *
   * Safe to call for the same account any number of times, from any number of
   * processes, concurrently or not. Every one of those collapses to a no-op rather than
   * to a second rename, and none of it depends on the sweeper's scheduling.
   *
   * The guard is that NOTHING is decided from the unlocked read. Below, three things
   * are read without a lock — whether Premium is really gone, what the username is, and
   * whether it is too short — and all three are checked AGAIN inside
   * `renameForCompliance`, under the account's row lock, against the values seen here.
   * A second caller arriving after the first has committed finds the username changed
   * and no longer short, and writes nothing.
   *
   * ─── Why the read is unlocked in the first place ───────────────────────────
   *
   * Lock ordering. `username-claim.lock.ts` requires every claim path to take the NAME
   * lock before the account row, and a candidate name cannot be computed before the
   * current username has been read. Reading under the row lock first would invert the
   * order against `changeUsername` and deadlock. So: read, derive, lock the name, lock
   * the row, re-verify, write.
   *
   * ─── Why Premium is re-checked inside the transaction ──────────────────────
   *
   * A renewal landing mid-sweep is not exotic — it is the most likely thing to happen to
   * an account that just lapsed. The sweeper's list is a hint from a moment ago;
   * `statusFor` is asked again under the lock, and an account that has become Premium
   * again keeps its short username.
   */
  async reconcile(userId: string): Promise<boolean> {
    // Read one: is the entitlement really gone? The sweeper's list is a hint, and a
    // provider that has since reported the account active must be believed over it.
    const premium = await this.premium.statusFor(userId);
    if (premium.active) return false;

    const user = await this.users.findById(userId);
    if (user === null) return false;

    // Read two, and THE idempotency guard: a username that already satisfies the free
    // floor has either never been short or has already been reconciled. Either way there
    // is nothing to do, and this is the check that makes a restart mid-pass free.
    if (!isTooShort(user.usernameLower)) return false;

    const expectedCurrentLower = user.usernameLower;

    for (let attempt = 0; attempt < USERNAME.MAX_COMPLIANCE_ATTEMPTS; attempt += 1) {
      const candidate = complianceCandidate(expectedCurrentLower);

      try {
        const renamed = await this.reservations.renameForCompliance({
          userId,
          username: candidate,
          usernameLower: candidate,
          expectedCurrentLower,
          // Re-run against whatever is found under the lock, not against what was read
          // above. A username that stopped being short in between — the user renamed
          // themselves, or another instance got here first — is left alone.
          stillNonCompliant: isTooShort,
        });

        if (!renamed) return false;

        // No reservation is written for the name being given up, and that is deliberate:
        // the account did not choose this change, so it must not spend an allowance, and
        // the two-character name it is losing should go straight back to whoever is
        // entitled to one rather than being held for thirty days.
        await this.bloom.add(candidate);

        this.logger.warn(
          { userId, from: expectedCurrentLower.length, to: candidate.length },
          'premium expired; username lengthened to meet the free minimum',
        );
        return true;
      } catch (err) {
        // The candidate was taken between generating it and claiming it, or the unique
        // index refused it. Both mean the same thing — try another suffix — and the
        // suffix is random, so a second collision is already implausible.
        if (err instanceof UsernameTakenError || isUniqueViolation(err)) continue;
        throw err;
      }
    }

    // Every candidate collided. With five random base32 characters this is not a
    // plausible outcome, so reaching here means something is structurally wrong rather
    // than unlucky, and the account is left non-compliant on purpose: the alternative is
    // looping forever against whatever is actually broken. The next sweep retries.
    this.logger.error(
      { userId, attempts: USERNAME.MAX_COMPLIANCE_ATTEMPTS },
      'exhausted compliance candidates; username left unchanged',
    );
    return false;
  }
}

/** The one question this file asks about a username, in one place so the sweep and the
 *  transaction cannot disagree about the answer. */
function isTooShort(usernameLower: string): boolean {
  return usernameLower.length < USERNAME.DEFAULT_MIN_LENGTH;
}

/**
 * How often to sweep. Five minutes: an account holding a username it is no longer
 * entitled to is a product-correctness issue rather than a security one, so minutes of
 * lag are acceptable and a tighter loop would only poll an empty list harder.
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far back a cold start looks for expirations it may have missed.
 *
 * A day, which is far more than the sweep interval on purpose: the cost of looking too
 * far back is a batch of no-ops, and the cost of looking too little is an account that
 * keeps a username forever because the process happened to be restarting when its
 * entitlement lapsed.
 */
const LOOK_BACK_MS = 24 * 60 * 60 * 1000;
