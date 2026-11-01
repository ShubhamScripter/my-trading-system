import { Injectable } from '@nestjs/common';
import type { PaymentPin } from '@prisma/client';
import { PrismaService } from '../../../db/client';
import { assertNoRecentEmailChangeLocked } from '../../../auth/persistence/security-cooldown.lock';
import { stampRestrictionsLocked } from '../../../auth/persistence/restriction.lock';
import type { RestrictionPlan, SecurityContext } from '../../restrictions/restrictions.types';
import { uuidv7 } from '../../utils/public.utils';

/**
 * Persistence for `payment_pins` — one row per account, holding one argon2id hash.
 *
 * ─── Why src/settings/ grows a dboperation after declaring it has none ──────
 *
 * `settings.module.ts` states that the module deliberately has no `dboperation`,
 * because it owns no tables: the `passkey` and `recoveryCode` rows it changes belong to
 * `TwoFactorDbOperation`, and re-providing Prisma access would give the process two
 * access layers for one table.
 *
 * That argument still holds, and this does not contradict it. `payment_pins` is a table
 * nothing else reaches, so this is its FIRST access layer rather than a second one for
 * somebody else's rows. The parent module still owns no tables; this sub-feature owns
 * exactly one, and it is the only thing that touches it.
 *
 * ─── Why every mutation is a conditional updateMany/deleteMany ──────────────
 *
 * Never read-then-write. The house rule, and it earns its keep here: two concurrent
 * updates that both read the row and both write would leave the loser's PIN stored
 * with the winner's challenge already spent, and the user would be told their new PIN
 * was set when a different one was. A conditional write returning `count` makes the
 * loser visible.
 *
 * Ownership is in the WHERE clause and never checked afterwards, for
 * `TwoFactorDbOperation`'s stated reason: ids are time-ordered UUIDv7 and must never be
 * actionable by whoever can guess one. Every method here takes `userId` and none takes
 * a row id at all, so there is nothing to guess.
 *
 * ─── Why all three mutations are transactions now ───────────────────────────
 *
 * The security cooldown after an email change. `PaymentPinService` asks
 * `RecentSecurityChangePolicy` on entry, which is where a refusal is cheapest, and
 * that check is necessarily older than the write by an emailed code, a credential
 * proof and an argon2 hash. `assertNoRecentEmailChangeLocked` takes a row lock on the
 * account inside each transaction below, which serialises these writes against
 * `RetainedEmailDbOperation.changeEmail` so a change landing mid-request cannot be
 * outrun. The conditional predicates above are unchanged and still decide the other
 * race — two concurrent PIN writes — which the lock says nothing about.
 */
@Injectable()
export class PaymentPinDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account's PIN, or null.
   *
   * Null IS the setting being off — there is no `deletedAt` to filter and no `enabled`
   * column to consult, so "does a row exist" is the whole question and it has one
   * answer. See the note on the model for why disabling deletes rather than retires.
   */
  async findByUserId(userId: string): Promise<PaymentPin | null> {
    return this.prisma.paymentPin.findUnique({ where: { userId } });
  }

  /**
   * Store the account's first PIN.
   *
   * A plain `create`, and the unique index on `user_id` is what makes it safe: two
   * concurrent enables both find no row and both insert, and the loser gets `P2002`
   * rather than silently replacing the winner's PIN. The service lets that surface as
   * `payment_pin_already_enabled`, which is the same answer the pre-check would have
   * given a moment earlier — so the race and the ordinary case are indistinguishable to
   * the caller, which is the point.
   *
   * `uuidv7()` rather than `gen_random_uuid()`, per the schema's convention: time
   * ordered, so inserts stay at the right edge of the B-tree.
   */
  async create(userId: string, pinHash: string): Promise<PaymentPin> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      return tx.paymentPin.create({
        data: { id: uuidv7(), userId, pinHash },
      });
    });
  }

  /**
   * Replace the hash in place. Returns false when there was no PIN to replace.
   *
   * An UPDATE rather than a delete-and-insert so `createdAt` keeps meaning "when this
   * account first set a PIN", which is the only fact the row carries that an update
   * would otherwise destroy. `updatedAt` moves on its own — the model declares
   * `@updatedAt`.
   *
   * `updateMany` rather than `update`, which is not stylistic: `update` throws `P2025`
   * when the row is absent, and an absent row here is an ordinary answer — the PIN was
   * disabled between the challenge being minted and being spent — not an exception.
   * Returning false lets the service say `payment_pin_not_enabled`.
   */
  async replaceHash(
    userId: string,
    pinHash: string,
    /** The request context and the already-resolved consequence — see
     *  `stampRestrictionsLocked` for why both are values rather than collaborators. */
    context: SecurityContext,
    plan: RestrictionPlan,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const { count } = await tx.paymentPin.updateMany({
        where: { userId },
        data: { pinHash },
      });
      // Nothing changed, so nothing is owed. Returning before the stamp keeps a failed
      // update from restricting an account whose PIN was never touched.
      if (count !== 1) return false;

      // Same statement, same commit, no window. A PIN changed without its restriction
      // applied is exactly the instant an attacker needs, and this path sweeps no
      // sessions — see the note in `PaymentPinService.disable`.
      await stampRestrictionsLocked(tx, context, plan);
      return true;
    });
  }

  /**
   * Remove the account's PIN. Returns false when there was none.
   *
   * A hard delete, which is the only one in this repository besides the one
   * `replaceRecoveryCodes` was corrected away from — and the difference is what is
   * being destroyed. That one erased the audit trail of which recovery code had been
   * spent, a fact nothing else recorded. This destroys an argon2 hash of a secret the
   * user asked us to forget, and the fact that they did is recorded by the `logger.warn`
   * and the security-changed email that accompany it.
   *
   * See the model in db/schema.prisma for the full argument, including why neither
   * reason the rest of this schema soft-deletes for applies to this table.
   */
  async remove(
    userId: string,
    context: SecurityContext,
    plan: RestrictionPlan,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoRecentEmailChangeLocked(tx, userId);

      const { count } = await tx.paymentPin.deleteMany({ where: { userId } });
      if (count !== 1) return false;

      await stampRestrictionsLocked(tx, context, plan);
      return true;
    });
  }
}
