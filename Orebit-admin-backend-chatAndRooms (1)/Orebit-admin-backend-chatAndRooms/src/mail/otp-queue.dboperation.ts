import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../db/client';

/**
 * The two durable writes the OTP queue's COMPENSATION path needs.
 *
 * ═══ WHY THIS EXISTS RATHER THAN REUSING auth/'s DBOPERATIONS ══════════════════
 *
 * `ChallengeDbOperation.invalidate` and a decrement on `AdminLoginAttempt` already
 * exist in `auth/persistence/`, and reaching for them from here would be the obvious
 * move. It creates a module cycle: `AuthModule` imports `MailModule` (LoginService
 * sends mail), so `MailModule` importing `AuthModule` back closes the loop and Nest
 * refuses to resolve it.
 *
 * The alternatives were a `forwardRef` — which makes the cycle work while leaving it
 * there for the next person to trip over — or hoisting the persistence into a shared
 * module, which is a large rearrangement to serve two statements. Two statements it
 * is.
 *
 * This is the ninth class permitted to inject `PrismaService`; the list is in
 * auth/auth.dboperation.ts.
 *
 * ─── Everything here is best-effort ────────────────────────────────────────────
 *
 * Neither method throws. They run in a background worker, after a send has already
 * failed four times, with no request to fail and no caller to report to. A refund that
 * cannot be written costs the admin one slot of their send budget; letting the error
 * escape would kill the worker loop, which costs every admin every subsequent code.
 */
@Injectable()
export class OtpQueueDbOperation {
  private readonly logger = new Logger('OtpQueueDb');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retire a challenge whose code was never delivered.
   *
   * The compare-and-swap on `consumedAt: null` matters even here, where nothing is
   * racing to spend it: a code that WAS delivered on an earlier attempt and then
   * verified must not be reopened by a late compensation, and naming the column in the
   * WHERE clause is what makes that impossible rather than merely unlikely.
   */
  async invalidateChallenge(challengeId: string): Promise<void> {
    try {
      await this.prisma.adminChallenge.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    } catch (err) {
      this.logger.error({ err, challengeId }, 'could not invalidate an undelivered challenge');
    }
  }

  /**
   * Give back the per-attempt send that a failed delivery consumed.
   *
   * `otpSentCount` is documented on the model as meaning "codes actually emailed", and
   * the enqueue path increments it optimistically because it cannot know the outcome
   * yet. This is what makes the column honest again when the send never happened.
   *
   * Guarded with `gt: 0` so a double compensation — a job somehow processed twice —
   * cannot drive the counter negative and hand out unlimited sends. Belt and braces:
   * the queue's own `processing` list makes a double terminal-failure very unlikely,
   * but "very unlikely" is not the property a send budget should rest on.
   */
  async refundOtpSent(attemptId: string): Promise<void> {
    try {
      await this.prisma.adminLoginAttempt.updateMany({
        where: { id: attemptId, otpSentCount: { gt: 0 } },
        data: { otpSentCount: { decrement: 1 } },
      });
    } catch (err) {
      this.logger.error({ err, attemptId }, 'could not refund an undelivered send');
    }
  }
}
