import { Prisma } from '@prisma/client';
import { assertNotInSecurityCooldown } from '../security/security-cooldown';

/**
 * The race-safe half of the security cooldown: read the timestamp under a row lock,
 * inside the transaction that is about to perform the protected mutation.
 *
 * ─── Why the service-layer policy is not enough on its own ──────────────────
 *
 * `RecentSecurityChangePolicy` runs early — before an emailed code is spent, before
 * argon2, before a WebAuthn verification — because that is where a refusal costs the
 * user least. That placement is right, and it is also precisely what opens a window:
 * between the policy's read and the write it protects there is real work, and an email
 * change committing inside that window would leave a password set moments after the
 * address moved, having passed a check that was true when it ran.
 *
 * So the last word belongs to the mutation itself.
 *
 * ─── How the lock actually serialises the two ───────────────────────────────
 *
 * `SELECT ... FOR UPDATE` takes the same row-level lock on `identity.users` that
 * `RetainedEmailDbOperation.changeEmail` takes when it updates the address. Postgres
 * therefore orders the two transactions rather than interleaving them, and both
 * orderings are correct:
 *
 *   email change commits first -> this SELECT blocks until it does, then reads the new
 *   `email_changed_at` and refuses. No mutation happens.
 *
 *   this transaction locks first -> the email change blocks on `user.update` until this
 *   commits. The protected change happened strictly BEFORE the address moved, which is
 *   exactly what the policy permits.
 *
 * There is no third outcome, and no interleaving in which both believe they won.
 *
 * Deadlock is not reachable: the email change locks `retained_emails` and then `users`,
 * while this locks `users` and then a table the email change never touches. The lock
 * ORDER never inverts, which is the condition a cycle needs.
 *
 * ─── Why raw SQL ────────────────────────────────────────────────────────────
 *
 * Prisma has no `FOR UPDATE`. `findFirst` inside a transaction is a plain read that
 * blocks nothing, so it would reproduce the very window this exists to close. The
 * parameter is bound rather than interpolated — `Prisma.sql` builds a prepared
 * statement — so the userId is never concatenated into the text.
 *
 * A soft-deleted account has no security settings anyone may change; it is filtered
 * here so the lock and the ordinary `deletedAt: null` lookups agree about what a row
 * is. A missing row yields no timestamp, and the caller's own authentication check is
 * what refuses that — this function's job is the cooldown and nothing else.
 *
 * Throws `SECURITY_CHANGE_COOLDOWN`, which rolls the enclosing transaction back, so a
 * refusal here can never leave a partial write behind.
 */
export async function assertNoRecentEmailChangeLocked(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ email_changed_at: Date | null }>>(
    Prisma.sql`
      SELECT "email_changed_at"
        FROM "identity"."users"
       WHERE "id" = ${userId}::uuid
         AND "deleted_at" IS NULL
         FOR UPDATE
    `,
  );

  assertNotInSecurityCooldown(rows[0]?.email_changed_at ?? null);
}
