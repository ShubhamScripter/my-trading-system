import type { Prisma } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { RestrictionPlan, SecurityContext } from '../../src/restrictions/restrictions.types';

/**
 * ═══ WRITE THE RESTRICTIONS IN THE MUTATION'S OWN TRANSACTION ══════════════
 *
 * A free function over a `Prisma.TransactionClient`, called from inside the
 * `$transaction` that performs the sensitive change — exactly the shape and exactly
 * the placement of `assertNoRecentEmailChangeLocked` next door, which is already
 * imported into `src/settings/paymentPin/payment-pin.dboperation.ts` and
 * `src/2fa/2fa.dboperation.ts`. No service gains a `PrismaService` injection and the
 * README's layering rule is untouched.
 *
 * ─── Why this cannot be a post-commit step ────────────────────────────────
 *
 * `RetainedEmailDbOperation.changeEmail` already settled this question for the one
 * restriction this codebase had before, and says so at the line that writes it:
 *
 *   "Starts the security cooldown, and it is written HERE rather than by the service
 *    for the reason this whole method is a transaction: an address that has moved
 *    without the freeze having started is precisely the instant an attacker needs.
 *    Same statement, same commit, no window."
 *
 * A password changed without its restriction applied is that same instant. Doing it
 * after the commit would leave a window that no retry closes and no sweeper can find —
 * a crash between the two writes leaves a PERMANENT hole, because nothing can sweep a
 * row that was never written.
 *
 * It matters most where it is least obvious: `PaymentPinService.update` and `.disable`
 * perform NO session sweep at all — deliberately, and argued at length in that file —
 * so for those two triggers this row is the only thing standing between whoever just
 * changed the PIN and the feature.
 *
 * ─── Why the plan is a VALUE and this function does no thinking ───────────
 *
 * Everything was decided before the transaction opened: the history was scanned, the
 * context classified, the policy resolved. All that is left is an INSERT keyed on
 * `user_id`.
 *
 * That is not tidiness, it is a hard constraint. Every one of these transactions
 * already holds `SELECT ... FOR UPDATE` on `identity.users` via the cooldown lock, and
 * every `$transaction` in this repository runs Prisma's defaults (`timeout: 5000`).
 * Putting the thirty-day history scan inside would risk `P2028` on a heavy account
 * AND would extend the window in which `RetainedEmailDbOperation.changeEmail` is
 * blocked on that same row.
 *
 * Lock order is unchanged — `users` first, then this table, never the reverse — so the
 * deadlock argument in `security-cooldown.lock.ts` still holds.
 *
 * ─── Failure ──────────────────────────────────────────────────────────────
 *
 * Throwing rolls the whole transaction back, so the sensitive mutation does not commit
 * either. That is the intended behaviour and it is what makes the post-commit
 * question — "what do we tell the client when the mutation landed and the restriction
 * did not?" — not exist. There is no such state.
 */
export async function stampRestrictionsLocked(
  tx: Prisma.TransactionClient,
  context: SecurityContext,
  plan: RestrictionPlan,
): Promise<number> {
  // An ordinary outcome, not an error: no policy configured, policy disabled, or every
  // target named a feature this build does not know — which is every target today,
  // while `PLATFORM_FEATURES` is empty. Returning early keeps the common path free of
  // a pointless round trip.
  if (plan.targets.length === 0) return 0;

  /**
   * ─── Idempotency, and what it can and cannot promise ────────────────────
   *
   * Keyed on the request id, so the SAME request processed twice writes one set.
   *
   * What it deliberately does NOT do is collapse two genuine changes. A user who
   * changes their password twice gets two sets of rows, because those are two
   * sensitive actions and each earns its consequence; the overlap is resolved at read
   * time by taking the latest `expiresAt`, never by summing. Uncontrolled growth is
   * bounded by the rate limits the sensitive actions already carry — the password path
   * meters ten an hour, the Payment PIN update three a day.
   *
   * Scoped to the account as well, so one account's request id can never suppress
   * another's write. Bounded by the account's own row count, which stays small.
   */
  if (context.requestId !== null) {
    const already = await tx.userFeatureRestriction.findFirst({
      where: { userId: context.userId, requestId: context.requestId },
      select: { id: true },
    });
    if (already !== null) return 0;
  }

  const startsAt = new Date();
  const expiresAt = new Date(startsAt.getTime() + plan.durationSeconds * 1000);

  const { assessment } = plan;

  await tx.userFeatureRestriction.createMany({
    data: plan.targets.map((target) => ({
      id: uuidv7(),
      userId: context.userId,
      feature: target.feature,
      subFeature: target.subFeature,
      triggerAction: plan.action,
      // Both, and they differ on the fail-safe path: `classification` records that the
      // evaluator could not place the request, `policyContext` records which policy it
      // was given anyway. Collapsing them would hide how often that happens.
      classification: assessment.classification,
      policyContext: assessment.policyContext,
      // Non-null whenever a target exists — a plan with targets came from a policy.
      policyVersion: plan.policyVersion ?? 0,
      startsAt,
      // Stored, never re-derived. An Admin shortening the policy afterwards must not
      // retroactively release an account that was already restricted for longer —
      // `OauthLink.unlinkAt` and `User.purgeAt` make the same argument.
      expiresAt,
      ipClassAtTrigger: assessment.observedIpClass,
      deviceFingerprintAtTrigger: assessment.observedDevice,
      countryAtTrigger: assessment.observedCountry,
      requestId: context.requestId,
    })),
  });

  return plan.targets.length;
}
