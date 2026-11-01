import { Injectable } from '@nestjs/common';
import type { AdminChallenge, AdminChallengePurpose } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';

/**
 * Prisma access for `admin.admin_challenges` — emailed one-time codes.
 *
 * The protocol that uses these lives in security/challenge.ts; this file is only
 * the four statements it needs. The two that matter are `incrementAttempts`,
 * which must return the database's value, and `consume`, which must be a
 * compare-and-swap.
 */
@Injectable()
export class ChallengeDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issue a code, superseding any live one for the same purpose.
   *
   * Superseding is what makes "resend" mean resend rather than "now two codes
   * work". Without it, every resend would leave its predecessor valid, so the
   * attempt cap would apply per code instead of per flow and five resends would
   * buy twenty-five guesses.
   */
  async issue(input: {
    readonly adminId: string;
    readonly purpose: AdminChallengePurpose;
    readonly codeHash: string;
    readonly expiresAt: Date;
    readonly ipAddress: string;
  }): Promise<AdminChallenge> {
    return this.prisma.$transaction(async (tx) => {
      await tx.adminChallenge.updateMany({
        where: { adminId: input.adminId, purpose: input.purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      return tx.adminChallenge.create({
        data: {
          id: uuidv7(),
          adminId: input.adminId,
          purpose: input.purpose,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
          ipAddress: input.ipAddress,
        },
      });
    });
  }

  /** The one unspent challenge for this (admin, purpose). Newest first, though
   *  `issue` makes more than one impossible. */
  async findLive(adminId: string, purpose: AdminChallengePurpose): Promise<AdminChallenge | null> {
    return this.prisma.adminChallenge.findFirst({
      where: { adminId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Returns the NEW attempt count from the database, so the caller judges the
   *  value the increment produced rather than one it read beforehand. */
  async incrementAttempts(challengeId: string): Promise<number> {
    const updated = await this.prisma.adminChallenge.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  /**
   * Spend the challenge. Returns false if something else already did.
   *
   * `consumedAt: null` in the WHERE clause is the compare-and-swap, and it is the
   * only thing stopping one correct code from being redeemed twice — which for
   * the sign-in flow would mean two attempts advanced by one emailed code.
   */
  async consume(challengeId: string): Promise<boolean> {
    const { count } = await this.prisma.adminChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /** Retire a challenge without it having been used successfully — an expired
   *  code, or one whose attempts ran out. */
  async invalidate(challengeId: string): Promise<void> {
    await this.prisma.adminChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
}
