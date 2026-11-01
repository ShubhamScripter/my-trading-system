import { Injectable } from '@nestjs/common';
import type { ChallengePurpose, VerificationChallenge } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';

/** Prisma reports a unique-index race with this stable error code. */
function isLiveChallengeConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Persistence for `verification_challenges` — post-account one-time codes
 * (login for passwordless accounts, and password reset).
 */

@Injectable()
export class ChallengeDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issue a code, superseding any live one for the same (user, purpose).
   *
   * The supersede is the important half. Without it, requesting a second code
   * would leave the first one valid, so every resend would widen the set of
   * accepted codes — five resends would mean five live codes and five times the
   * guessing surface. One live code per purpose, always.
   */
  async issue(input: {
    userId: string;
    purpose: ChallengePurpose;
    codeHash: string;
    expiresAt: Date;
    ipAddress: string;
    /**
     * Where the code was MAILED, normalised. Omitted by every purpose that mails the
     * account's own address — which is all three original ones, where the recipient is
     * `user.email` and the row needs no second copy of it.
     *
     * Set by the email-change purposes, where the recipient is an address the account
     * does not own yet. `verifyChallengeCode` keys on `(userId, purpose)`, so without
     * this the code mailed to the current inbox would satisfy the proof for the new
     * one.
     */
    targetEmailLower?: string;
  }): Promise<VerificationChallenge> {
    // `ux_challenges_live` makes the one-live-code rule authoritative. Two requests
    // can still both reach the insert after consuming the prior code, so retry the
    // loser once: on its second transaction it consumes the winner's code and stores
    // its own. The caller always receives the newest code as the only valid one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.verificationChallenge.updateMany({
            where: { userId: input.userId, purpose: input.purpose, consumedAt: null },
            data: { consumedAt: new Date() },
          });

          return tx.verificationChallenge.create({
            data: {
              id: uuidv7(),
              userId: input.userId,
              purpose: input.purpose,
              codeHash: input.codeHash,
              expiresAt: input.expiresAt,
              ipAddress: input.ipAddress,
              targetEmailLower: input.targetEmailLower ?? null,
            },
          });
        });
      } catch (error) {
        if (!isLiveChallengeConflict(error) || attempt === 1) throw error;
      }
    }

    throw new Error('Unreachable: challenge issuance retry loop exhausted');
  }

  /** The one live challenge for (user, purpose), or null. Backed by
   *  `ix_challenges_live`. */
  async findLive(
    userId: string,
    purpose: ChallengePurpose,
  ): Promise<VerificationChallenge | null> {
    return this.prisma.verificationChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async incrementAttempts(id: string): Promise<number> {
    const { attempts } = await this.prisma.verificationChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return attempts;
  }

  /**
   * Spend the challenge — a compare-and-swap on `consumedAt`.
   *
   * `updateMany` with `consumedAt: null` rather than a plain update, so two
   * requests presenting the same correct code cannot both succeed. Returns false
   * for the loser, and the caller must treat that as a failed verification: for
   * password reset, both succeeding would mean two passwords set from one code.
   */
  async consume(id: string): Promise<boolean> {
    const { count } = await this.prisma.verificationChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /** Retire the live challenge without spending it — used when a code is dead
   *  from too many wrong guesses, so the next request is told to request a new
   *  one rather than re-testing a code that can no longer succeed. */
  async invalidate(id: string): Promise<void> {
    await this.prisma.verificationChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Retire exactly the challenge created for a queue operation that was refused. */
  async invalidateIfHash(id: string, codeHash: string): Promise<void> {
    await this.prisma.verificationChallenge.updateMany({
      where: { id, codeHash, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
}
