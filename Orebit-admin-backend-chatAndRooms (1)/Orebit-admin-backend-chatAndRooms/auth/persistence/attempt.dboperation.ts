import { Injectable } from '@nestjs/common';
import type { AdminLoginAttempt, AdminLoginState, AdminMfaMethod } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { ClientContext } from '../auth.types';

/**
 * Prisma access for `admin.admin_login_attempts` — the step-up state machine.
 *
 * Two properties in here are load-bearing and easy to break by "simplifying":
 * every state transition is a CONDITIONAL update that names the state it expects
 * to find, and the step-up secret is only ever matched by hash.
 */
@Injectable()
export class AttemptDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a new attempt, retiring any the same admin left unfinished.
   *
   * Superseding rather than reusing is the safer direction. A resumable attempt
   * would let someone who obtained one step-up secret keep it alive indefinitely
   * by starting fresh sign-ins; expiring the old one means the most recent
   * password proof is the only one that counts, and a secret from an abandoned
   * attempt stops working the moment a new sign-in begins.
   *
   * One transaction, so there is no window in which two live attempts exist for
   * one admin.
   */
  async open(input: {
    readonly adminId: string;
    readonly stepUpSecretHash: string;
    readonly client: ClientContext;
    readonly expiresAt: Date;
  }): Promise<AdminLoginAttempt> {
    return this.prisma.$transaction(async (tx) => {
      await tx.adminLoginAttempt.updateMany({
        where: { adminId: input.adminId, completedAt: null, state: { notIn: ['EXPIRED'] } },
        // The secret is nulled as well as the state changed. Leaving it behind
        // would keep a spent value in the unique index and, worse, keep it
        // matchable if a later query forgot to filter on state.
        data: { state: 'EXPIRED', stepUpSecretHash: null },
      });

      return tx.adminLoginAttempt.create({
        data: {
          id: uuidv7(),
          adminId: input.adminId,
          state: 'PASSWORD_VERIFIED',
          stepUpSecretHash: input.stepUpSecretHash,
          ipAddress: input.client.ip,
          userAgent: input.client.userAgent,
          expiresAt: input.expiresAt,
          // Zero, NOT one. The caller sends the first code immediately after this
          // and `recordOtpSent` counts it — pre-counting here made the first code
          // consume two of the five sends, so a client was told it had three
          // resends left when it had four.
          otpSentCount: 0,
          lastOtpSentAt: null,
        },
      });
    });
  }

  /**
   * Resolve an attempt from the secret the client presented.
   *
   * Matched on the HASH, never the plaintext — the column holds only a digest, so
   * there is nothing else to match on. `completedAt: null` is part of the WHERE
   * rather than checked afterwards, so a spent secret resolves to nothing at all
   * rather than to a row a caller might then forget to validate.
   *
   * The plain equality lookup is safe without a constant-time compare: the
   * comparison happens inside a B-tree index probe on a digest the attacker
   * cannot influence one byte at a time.
   */
  async findBySecretHash(stepUpSecretHash: string): Promise<AdminLoginAttempt | null> {
    return this.prisma.adminLoginAttempt.findFirst({
      where: { stepUpSecretHash, completedAt: null },
    });
  }

  /**
   * Advance the state, but only from the state the caller expects.
   *
   * `updateMany` with `state: from` in the WHERE clause makes this a
   * compare-and-swap. A plain `update` would let two concurrent requests both
   * read `PASSWORD_VERIFIED` and both advance — which for `verify-email` would
   * mean one emailed code advancing an attempt twice.
   *
   * Returns false when the swap lost, and every caller treats that as a failure
   * rather than retrying: losing means something else already advanced this
   * attempt, and the second caller has no way to know it was the same actor.
   */
  async advanceState(
    attemptId: string,
    from: AdminLoginState,
    to: AdminLoginState,
  ): Promise<boolean> {
    const { count } = await this.prisma.adminLoginAttempt.updateMany({
      where: { id: attemptId, state: from, completedAt: null },
      data: { state: to },
    });
    return count === 1;
  }

  /**
   * Close the attempt and retire its secret. The last write of a successful
   * ceremony.
   *
   * Nulling `stepUpSecretHash` in the same statement that sets `completedAt` is
   * what makes the secret single-use: there is no interval, however small, in
   * which a completed attempt still has a matchable secret.
   */
  async complete(attemptId: string, mfaMethod: AdminMfaMethod): Promise<boolean> {
    const { count } = await this.prisma.adminLoginAttempt.updateMany({
      where: { id: attemptId, completedAt: null, state: 'EMAIL_VERIFIED' },
      data: {
        state: 'COMPLETED',
        completedAt: new Date(),
        mfaMethod,
        stepUpSecretHash: null,
      },
    });
    return count === 1;
  }

  /**
   * Charge a wrong second-factor guess.
   *
   * Returns the NEW count, from the database, so the caller judges the value the
   * increment actually produced rather than one it read beforehand. Two concurrent
   * wrong codes therefore consume two attempts, not one.
   */
  async incrementMfaAttempts(attemptId: string): Promise<number> {
    const updated = await this.prisma.adminLoginAttempt.update({
      where: { id: attemptId },
      data: { mfaAttempts: { increment: 1 } },
      select: { mfaAttempts: true },
    });
    return updated.mfaAttempts;
  }

  /** Record that another code went out. */
  async recordOtpSent(attemptId: string): Promise<AdminLoginAttempt> {
    return this.prisma.adminLoginAttempt.update({
      where: { id: attemptId },
      data: { otpSentCount: { increment: 1 }, lastOtpSentAt: new Date() },
    });
  }

  /** Retire an attempt without completing it — used when it is found expired. */
  async expire(attemptId: string): Promise<void> {
    await this.prisma.adminLoginAttempt.updateMany({
      where: { id: attemptId, completedAt: null },
      data: { state: 'EXPIRED', stepUpSecretHash: null },
    });
  }
}
