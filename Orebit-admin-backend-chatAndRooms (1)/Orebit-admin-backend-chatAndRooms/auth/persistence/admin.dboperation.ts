import { Injectable } from '@nestjs/common';
import type { Admin, AdminCredential } from '@prisma/client';
import { PrismaService } from '../../db/client';

/** An account and its password, which every read for a sign-in needs together. */
export interface AdminWithCredential {
  readonly admin: Admin;
  readonly credential: AdminCredential | null;
}

/**
 * Prisma access for `admin.admins` and `admin.admin_credentials`.
 *
 * Kept as one dboperation rather than two because the two tables are read
 * together on every sign-in and never independently — splitting them would mean
 * two collaborators injected everywhere for one logical read.
 */
@Injectable()
export class AdminDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account for an address, together with its password — ONE round trip.
   *
   * ─── Why this is one method and not two ────────────────────────────────────
   *
   * It was two: `findByEmail` resolved the account, and `findWithCredential` then
   * re-read the SAME row by id purely to reach the credential. The second query's
   * `admin` was discarded by the only caller, so the whole of what it added over a
   * join was a second round trip on the password step — invisible against a local
   * database and roughly the cost of the argon2 hash against a remote one.
   *
   * Merging them also removes a smaller problem the split had: the two reads were
   * not atomic, so an account soft-deleted between them produced a null credential
   * rather than a missing account. One statement cannot disagree with itself.
   *
   * Live accounts only. Every read in this file filters `deletedAt: null`, which
   * is what makes a soft delete actually remove access — the partial unique index
   * lets the row keep its email, so a query that forgot this filter would let a
   * removed admin sign in. The credential carries the same filter, plus
   * `kind: 'PASSWORD'`, so a retired credential is `null` here rather than usable.
   *
   * Returns `credential: null` — NOT null overall — for an account that exists with
   * no password row. Those are different answers and the caller distinguishes them:
   * a missing ACCOUNT is the unknown-email path, which must burn the argon2 timing
   * mask, while a missing CREDENTIAL is an anomaly on a known account.
   */
  async findByEmailWithCredential(emailLower: string): Promise<AdminWithCredential | null> {
    const admin = await this.prisma.admin.findFirst({
      where: { emailLower, deletedAt: null },
      include: {
        credentials: { where: { kind: 'PASSWORD', deletedAt: null }, take: 1 },
      },
    });
    if (admin === null) return null;

    const { credentials, ...rest } = admin;
    return { admin: rest as Admin, credential: credentials[0] ?? null };
  }

  async findById(id: string): Promise<Admin | null> {
    return this.prisma.admin.findFirst({ where: { id, deletedAt: null } });
  }

  // ─── lockout counters ─────────────────────────────────────────────────────

  /**
   * Record a wrong password, and escalate once the threshold is hit.
   *
   * One statement for the increment, not read-then-write: the increment and the
   * comparison happen inside the database, so two concurrent wrong passwords cannot
   * both read `failedAttempts: 9` and each conclude they were the ninth. Every branch
   * below is decided from the value the database RETURNED, never from one read
   * beforehand.
   *
   * ═══ THREE OUTCOMES, NOT TWO ══════════════════════════════════════════════════
   *
   * This used to return `{ locked: boolean }`. The boolean cannot express the second
   * rung, and widening it to a discriminated result rather than adding a second flag
   * is what stops a caller from having to work out which combination of `locked` and
   * `reviewOpened` is legal (only three of the four are).
   *
   *   'counted'        under the cap. Nothing else happened.
   *   'locked'         first lock, or a lock whose predecessor has expired from the
   *                    strike memory. A wait, and the caller reports it.
   *   'review-opened'  second lock inside the memory. The account is DISABLED, every
   *                    in-flight sign-in is retired, and a super admin must decide.
   */
  async registerFailedAttempt(
    credentialId: string,
    policy: {
      readonly maxAttempts: number;
      readonly lockDurationSeconds: number;
      readonly strikeMemorySeconds: number;
    },
  ): Promise<{ outcome: 'counted' | 'locked' | 'review-opened' }> {
    const updated = await this.prisma.adminCredential.update({
      where: { id: credentialId },
      data: { failedAttempts: { increment: 1 } },
      select: {
        failedAttempts: true,
        adminId: true,
        lockoutStrikes: true,
        lockoutStrikeAt: true,
      },
    });

    if (updated.failedAttempts < policy.maxAttempts) return { outcome: 'counted' };

    const now = new Date();

    // Is the previous strike still remembered? A strike with no timestamp is a row
    // the service never writes (the two are always set together), and is treated as
    // unremembered rather than trusted — the conservative direction, because the
    // alternative sends an account to manual review on the strength of a half-written
    // row.
    const remembered =
      updated.lockoutStrikes > 0 &&
      updated.lockoutStrikeAt !== null &&
      now.getTime() - updated.lockoutStrikeAt.getTime() <= policy.strikeMemorySeconds * 1000;

    if (!remembered) {
      // First lock, or one whose predecessor has aged out. The attempt counter is
      // reset as the lock is applied, so when the lock expires the admin gets a full
      // budget again rather than being locked out permanently by one bad afternoon.
      //
      // The strike is stamped here even for an aged-out predecessor: `lockoutStrikes`
      // is a running total for the audit trail, and `lockoutStrikeAt` moving forward
      // is what re-arms the memory for the NEXT lock.
      await this.prisma.adminCredential.update({
        where: { id: credentialId },
        data: {
          failedAttempts: 0,
          lockedUntil: new Date(now.getTime() + policy.lockDurationSeconds * 1000),
          lockoutStrikes: { increment: 1 },
          lockoutStrikeAt: now,
        },
      });
      return { outcome: 'locked' };
    }

    // ═══ SECOND LOCK INSIDE THE MEMORY ══════════════════════════════════════════
    //
    // One transaction, because a partial application is the worst outcome available:
    // an account marked PENDING whose in-flight sign-in was never retired is one a
    // half-authenticated caller can still walk forward, and a retired attempt on an
    // account that was never marked is a sign-in interrupted for no recorded reason.
    //
    // `lockedUntil` is deliberately NOT set. A wait is the wrong answer now — the
    // account does not come back on a timer, and leaving a deadline on the row would
    // have `checkPassword` reporting a `Retry-After` that means nothing.
    await this.prisma.$transaction(async (tx) => {
      await tx.adminCredential.update({
        where: { id: credentialId },
        data: {
          failedAttempts: 0,
          lockedUntil: null,
          lockoutStrikes: { increment: 1 },
          lockoutStrikeAt: now,
        },
      });

      await tx.admin.update({
        where: { id: updated.adminId },
        data: {
          status: 'DISABLED',
          loginReviewStatus: 'PENDING',
          loginDisabledAt: now,
          loginDisabledReason: 'REPEATED_PASSWORD_LOCKOUT',
        },
      });

      // Retire every unfinished sign-in, nulling the secret as `AttemptDbOperation`
      // does. A live step-up secret on an account under review is precisely the
      // credential this state exists to invalidate.
      await tx.adminLoginAttempt.updateMany({
        where: {
          adminId: updated.adminId,
          completedAt: null,
          state: { notIn: ['EXPIRED'] },
        },
        data: { state: 'EXPIRED', stepUpSecretHash: null },
      });
    });

    return { outcome: 'review-opened' };
  }

  /**
   * A successful password: clear the streak, keep the memory.
   *
   * `lockoutStrikes` and `lockoutStrikeAt` are deliberately untouched. A correct
   * password proves the account's owner turned up; it does not prove that whatever
   * produced the previous lockout has stopped, and clearing the memory here would
   * hand an attacker who can occasionally guess right an unlimited supply of first
   * offences. Only a super admin resolving a review clears them.
   */
  async clearFailedAttempts(credentialId: string): Promise<void> {
    await this.prisma.adminCredential.update({
      where: { id: credentialId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  async markEmailVerified(adminId: string): Promise<void> {
    await this.prisma.admin.update({
      where: { id: adminId },
      // Only on the first verification. Overwriting it on every sign-in would
      // destroy the one piece of evidence about when the address was first proven.
      data: { emailVerifiedAt: { set: new Date() } },
    });
  }

  /**
   * Stamp `mfaEnrolledAt` if it is not already set.
   *
   * Conditional so that enrolling a second factor years later does not rewrite
   * the date the first one was confirmed. The `updateMany` form is what makes the
   * condition part of the WHERE clause rather than a read-then-write.
   */
  async markMfaEnrolled(adminId: string): Promise<void> {
    await this.prisma.admin.updateMany({
      where: { id: adminId, mfaEnrolledAt: null },
      data: { mfaEnrolledAt: new Date() },
    });
  }

  async touchLastSeen(adminId: string): Promise<void> {
    await this.prisma.admin.update({
      where: { id: adminId },
      data: { lastSeenAt: new Date() },
    });
  }

}

/**
 * ─── `replacePassword` was here, and is gone ─────────────────────────────────
 *
 * It was the last limb of the removed password-reset flow and had no callers. Left
 * in place it was worse than merely dead: it cleared `failedAttempts` and
 * `lockedUntil` as a side effect of writing a hash, so the first person to reach for
 * it — for a change-password feature, say — would have silently handed themselves a
 * lockout bypass. Now that the lockout escalates to a manual review, that bypass
 * would also have skipped the review.
 *
 * A change-password route should write the hash and decide about the lockout
 * counters explicitly, in the open.
 */
