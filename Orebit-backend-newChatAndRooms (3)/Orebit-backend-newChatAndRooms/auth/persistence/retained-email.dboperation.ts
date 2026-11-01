import { Injectable } from '@nestjs/common';
import type { RetainedEmail } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { stampRestrictionsLocked } from './restriction.lock';
import type { RestrictionPlan, SecurityContext } from '../../src/restrictions/restrictions.types';

/**
 * Persistence for `retained_emails`, and the two transactions that move an account's
 * email address.
 *
 * ─── Why this is in auth/ when the feature is in src/settings/email/ ───────
 *
 * Because the table has two readers on opposite sides of the module graph, and a table
 * gets exactly one owner. `src/settings/email/` writes it; `RegistrationService` reads it
 * on every signup, to refuse an address somebody released and may still want back.
 * `SettingsModule` imports `AuthModule`, so owning it in settings would mean auth
 * importing settings — a cycle, to reach one query.
 *
 * `verification_challenges` has exactly this shape and this resolution: it lives here,
 * `AuthModule` exports it, and `src/settings/` and `src/2fa/` consume it. So does
 * `users`, which the email change also writes. Following that keeps
 * `settings.module.ts`'s claim true — the module owns no tables — and keeps "where is
 * this written" to one answer.
 *
 * What stays in `src/settings/email/` is everything that is policy: which proofs are
 * required, how long an address is held, what a released address may still do. This
 * file knows none of it.
 *
 * ─── Why the mutations live HERE and not in the service ────────────────────
 *
 * `db/client.ts` confines `PrismaService` to `*.dboperation.ts` files, so a service
 * cannot open a transaction. That is not an inconvenience to route around: an email
 * change writes three rows that must move together — the account's address, the record
 * reserving the address it left, and the recovery ticket on that record — and a partial
 * apply is an account whose old address is unreserved, or reserved for an address it no
 * longer has. The transaction is the feature's correctness, so it belongs in the one
 * layer allowed to open one.
 *
 * ─── Why every liveness test is `expiresAt > now` and never a flag ─────────
 *
 * A retained address stops blocking when its window passes, full stop. No column says
 * "expired", nothing has to sweep, and no cleanup job has to run for the answer to be
 * right. A boolean would be a second source of truth that a missed job makes wrong, and
 * the thing it would make wrong is "may this stranger register this address".
 */
@Injectable()
export class RetainedEmailDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // ─── reads ──────────────────────────────────────────────────────────────

  /**
   * Is this address reserved for anyone right now?
   *
   * The probe registration runs, and the one an email change runs against the address
   * being claimed. Deliberately says WHO it is reserved for rather than just yes/no,
   * because the two callers need different answers from one query: registration refuses
   * regardless, while an email change lets an account reclaim its OWN released address.
   *
   * Ordered newest-first because one address may have several rows over its life —
   * retained, expired, registered by somebody else, released again — and only the live
   * one is an answer.
   */
  async findLiveByEmail(emailLower: string): Promise<RetainedEmail | null> {
    return this.prisma.retainedEmail.findFirst({
      where: { emailLower, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /**
   * The addresses this account has released that are still live.
   *
   * A list rather than a single row, and the plural is load-bearing. Policy makes at
   * most one live at a time — retention equals the change window, and each change
   * retains one address — but the SERVICE asserts that rather than this layer assuming
   * it. Returning one row here would make a broken configuration look like a correct
   * account with fewer proofs required, which is the silent weakening the assertion
   * exists to catch.
   */
  async listLiveForUser(userId: string): Promise<RetainedEmail[]> {
    return this.prisma.retainedEmail.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });
  }

  /** One record by id, live or not. */
  async findById(id: string): Promise<RetainedEmail | null> {
    return this.prisma.retainedEmail.findUnique({ where: { id } });
  }

  /**
   * The record a recovery ticket names, found BY the hash rather than fetched and then
   * compared.
   *
   * That ordering matters. Looking a record up some other way and comparing the hash in
   * application code would make the response time depend on whether a record was found,
   * which on an endpoint reachable without a session is an oracle for which addresses
   * have recently been changed away from. Here an unknown ticket and a wrong one take
   * the same path: an indexed miss.
   *
   * Returns the row whatever its state — expired, already spent — because the caller
   * folds all of those into one refusal and needs the row to log which it was.
   */
  async findByRecoveryTokenHash(recoveryTokenHash: string): Promise<RetainedEmail | null> {
    return this.prisma.retainedEmail.findFirst({ where: { recoveryTokenHash } });
  }

  /**
   * Every live record whose ticket is still spendable, for one account.
   *
   * Used by the status screen to answer "can I still go back". Not used to authorise
   * anything — the ticket in the mailbox is what authorises, and it is never in a
   * response.
   */
  async findSpendableForUser(userId: string): Promise<RetainedEmail | null> {
    return this.prisma.retainedEmail.findFirst({
      where: { userId, expiresAt: { gt: new Date() }, recoveryConsumedAt: null },
      orderBy: { expiresAt: 'desc' },
    });
  }

  // ─── the change ─────────────────────────────────────────────────────────

  /**
   * Move the account to `newEmail`, reserving the address it leaves.
   *
   * ─── The order inside the transaction is the design ────────────────────
   *
   *   release the caller's own claim on the target -> move the account ->
   *   reserve what it left -> retire a retention the caller was permitted to skip
   *
   * Releasing first is what lets an account reclaim an address it previously left: the
   * reservation is deleted before the write that would collide with it. Only the
   * CALLER's rows are deleted — another account's reservation is not the caller's to
   * clear, and the service refuses the change long before reaching here.
   *
   * ─── What the database decides and this code does not ──────────────────
   *
   * Uniqueness. `ix_users_email_active` is a partial index Prisma cannot see, so a
   * collision arrives as a raw `23505` rather than a typed `P2002`, and it arrives
   * INSIDE this transaction — which rolls the whole thing back. That is the point: two
   * accounts racing for one address cannot both win, and the loser changes nothing. The
   * service translates the violation; this layer just lets it out.
   *
   * Returns nothing. Every value the caller needs it already had.
   */
  async changeEmail(input: {
    userId: string;
    newEmail: string;
    newEmailLower: string;
    releasedEmail: string;
    releasedEmailLower: string;
    retentionExpiresAt: Date;
    recoveryTokenHash: string;
    /** A retention the caller was allowed to skip because its mailbox is unreachable.
     *  Retired as part of the same commit, so the escape cannot be taken twice. */
    skippedRetainedId: string | null;
    /** The request context and its already-resolved consequence. Optional because the
     *  RECOVERY paths reuse this method and are deliberately not a trigger action. */
    restriction?: { context: SecurityContext; plan: RestrictionPlan };
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The reclaim. Scoped to this user: a live reservation held by somebody else is
      // refused upstream, and deleting one here would be this account clearing another
      // account's claim.
      await tx.retainedEmail.deleteMany({
        where: { userId: input.userId, emailLower: input.newEmailLower },
      });

      await tx.user.update({
        where: { id: input.userId },
        data: {
          email: input.newEmail,
          emailLower: input.newEmailLower,
          // The address was just proved by an emailed code, so it is verified by the
          // same standard registration uses. Leaving the old timestamp would say this
          // mailbox had been proved when it had not.
          emailVerifiedAt: new Date(),
          // Starts the security cooldown, and it is written HERE rather than by the
          // service for the reason this whole method is a transaction: an address that
          // has moved without the freeze having started is precisely the instant an
          // attacker needs. Same statement, same commit, no window.
          emailChangedAt: new Date(),
        },
      });

      // Same statement, same commit, no window — the argument `emailChangedAt` above
      // already makes. An address that has moved without its restriction applied is the
      // same instant an attacker needs, and this path revokes EVERY session including
      // the caller's, so there is no later request to catch up on.
      if (input.restriction) {
        await stampRestrictionsLocked(tx, input.restriction.context, input.restriction.plan);
      }

      await tx.retainedEmail.create({
        data: {
          id: uuidv7(),
          userId: input.userId,
          email: input.releasedEmail,
          emailLower: input.releasedEmailLower,
          expiresAt: input.retentionExpiresAt,
          recoveryTokenHash: input.recoveryTokenHash,
        },
      });

      if (input.skippedRetainedId !== null) {
        // Expire rather than delete, so the record of an address having been held —
        // and skipped — survives for an operator to read.
        await tx.retainedEmail.updateMany({
          where: { id: input.skippedRetainedId, userId: input.userId },
          data: { expiresAt: new Date() },
        });
      }
    });
  }

  // ─── the recovery ───────────────────────────────────────────────────────

  /**
   * Spend a recovery ticket and move the account to `targetEmail`.
   *
   * ─── The compare-and-swap is the whole safety property ─────────────────
   *
   * `recoveryConsumedAt` is claimed by a conditional `updateMany` whose predicate is the
   * ticket's entire validity — unspent, unexpired, and belonging to this account — and
   * the write proceeds only when exactly one row moved. Two concurrent recoveries on one
   * ticket therefore produce one winner and one refusal, rather than two mutations that
   * both believe they were authorised.
   *
   * Read-then-write would not do: the gap between checking and claiming is precisely the
   * window an attacker who has the ticket would race in.
   *
   * ─── What happens to the address being taken away ──────────────────────
   *
   * Nothing. It is released outright with no reservation of its own, and that is
   * deliberate rather than an omission. In the case this flow exists for it is an
   * attacker's address, and reserving it would both withhold it from its rightful owner
   * and — worse — make it a mailbox that must answer the victim's NEXT email change.
   *
   * `intent` decides the retention that remains: `restore` deletes it, because the
   * address is the account's own again and an account does not reserve its live address.
   * `replace` keeps it with a fresh window and a fresh ticket, because the account has
   * moved somewhere new and the released address needs the same protection any change
   * gives.
   *
   * Returns false when the ticket was already spent or had expired.
   */
  async recoverEmail(input: {
    retainedEmailId: string;
    userId: string;
    intent: 'restore' | 'replace';
    targetEmail: string;
    targetEmailLower: string;
    /** For `replace` only: the fresh window and ticket for the address being kept on
     *  hold. Ignored when restoring, where the record is deleted. */
    renewedExpiresAt: Date;
    renewedRecoveryTokenHash: string;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.retainedEmail.updateMany({
        where: {
          id: input.retainedEmailId,
          userId: input.userId,
          recoveryConsumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { recoveryConsumedAt: new Date() },
      });

      // Lost the swap, or the window closed between the service's read and this write.
      // Return before touching the account: the winner has already moved it, or nobody
      // is entitled to.
      if (claimed.count !== 1) return false;

      // A `replace` may be moving to an address this account previously released.
      // Same reclaim as `changeEmail`, and scoped the same way.
      await tx.retainedEmail.deleteMany({
        where: {
          userId: input.userId,
          emailLower: input.targetEmailLower,
          id: { not: input.retainedEmailId },
        },
      });

      await tx.user.update({
        where: { id: input.userId },
        data: {
          email: input.targetEmail,
          emailLower: input.targetEmailLower,
          emailVerifiedAt: new Date(),
          // ─── The security cooldown, and why the two intents differ ───────────
          //
          // `restore` CLEARS it. The account is back on the address it had, so the
          // change the freeze existed for has been undone — and the person who just
          // proved the released mailbox is the owner the freeze was protecting. Leaving
          // it set would lock the victim out of the password change and the factor
          // sweep that are the first things they need after a takeover, which would
          // turn a defence into the attacker's second win.
          //
          // `replace` SETS it. The account has moved somewhere new; that is an email
          // change by every meaning the policy has, and it earns the same window a
          // voluntary change does.
          //
          // Neither is a decision the recovery REQUEST is subject to: nothing in this
          // flow consults the cooldown, so a frozen account can always recover. See
          // `RecentSecurityChangePolicy`.
          emailChangedAt: input.intent === 'restore' ? null : new Date(),
        },
      });

      if (input.intent === 'restore') {
        // The address is the account's live one again. An account does not hold a
        // reservation against itself, and leaving one would make its own address answer
        // its next change.
        await tx.retainedEmail.deleteMany({
          where: { id: input.retainedEmailId, userId: input.userId },
        });
      } else {
        await tx.retainedEmail.updateMany({
          where: { id: input.retainedEmailId, userId: input.userId },
          data: {
            expiresAt: input.renewedExpiresAt,
            recoveryTokenHash: input.renewedRecoveryTokenHash,
            // Un-spend it: the window is fresh, so the ticket that goes with it must be
            // spendable again. The OLD token no longer matches the stored hash, so
            // re-issuing here is what retires it.
            recoveryConsumedAt: null,
          },
        });
      }

      return true;
    });
  }
}
