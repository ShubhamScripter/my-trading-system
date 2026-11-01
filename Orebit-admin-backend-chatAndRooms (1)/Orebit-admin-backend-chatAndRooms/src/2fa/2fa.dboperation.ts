import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/client';
import type { EnrolledFactor, FactorKind } from './2fa.types';

/**
 * Prisma access for second-factor MANAGEMENT.
 *
 * Read-and-retire only. Everything that CREATES a factor — sealing a TOTP secret,
 * storing a passkey — already exists in `auth/persistence/mfa.dboperation.ts` and
 * is reused rather than reimplemented, because two writers with two ideas of what
 * "confirmed" means is exactly the drift that file's own comment warns about.
 *
 * This is the sixth class in the service permitted to inject `PrismaService`; the
 * other five are listed in `auth/auth.dboperation.ts`. That restriction is review
 * discipline rather than something the framework enforces, so the property that
 * makes it auditable is that every such class appears in one of the two barrels.
 */
@Injectable()
export class TwoFactorDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every factor this admin can actually sign in with.
   *
   * CONFIRMED TOTP only, deliberately. A pending enrollment is a QR code nobody
   * proved they scanned, and listing it would invite an admin to believe they are
   * covered when the ceremony would still refuse the factor.
   */
  async listFactors(adminId: string): Promise<EnrolledFactor[]> {
    const [totp, passkeys] = await Promise.all([
      this.prisma.adminTotpFactor.findMany({
        where: { adminId, confirmedAt: { not: null }, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.adminPasskey.findMany({
        where: { adminId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return [
      ...totp.map((f) => ({
        id: f.id,
        kind: 'TOTP' as FactorKind,
        label: f.label,
        createdAt: f.createdAt,
        lastUsedAt: f.lastUsedAt,
      })),
      ...passkeys.map((p) => ({
        id: p.id,
        kind: 'PASSKEY' as FactorKind,
        label: p.label,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      })),
    ];
  }

  /**
   * ═══ THE TOTP ROTATION ═════════════════════════════════════════════════════
   *
   * Confirm a pending factor, retiring the admin's existing confirmed one in the
   * SAME transaction. Returns false if the target is no longer pending.
   *
   * ─── Why the order is retire-then-confirm, and why it cannot be reversed ────
   *
   * The partial unique index `ix_admin_totp_confirmed_unique` permits exactly one
   * confirmed factor per admin. Confirming first would therefore violate it
   * outright — there is no instant where two may be confirmed, deferrable or not.
   *
   * ─── Why the failure path throws rather than returns ───────────────────────
   *
   * Retiring happens first, so a failed confirmation MUST undo it. Returning
   * `false` from inside `$transaction` COMMITS, which would leave the admin with
   * their old authenticator retired and the new one still unconfirmed — locked
   * out by a request that failed. The throw is what rolls that back; the sentinel
   * class is how the caller tells "not pending" apart from a real database error,
   * which must keep propagating.
   *
   * `confirmedAt: null` in the WHERE clause is a compare-and-swap, so two
   * concurrent confirmations of one enrollment cannot both succeed.
   */
  async confirmTotpReplacing(input: {
    readonly adminId: string;
    readonly factorId: string;
    readonly step: bigint;
  }): Promise<boolean> {
    const now = new Date();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.adminTotpFactor.updateMany({
          where: {
            adminId: input.adminId,
            confirmedAt: { not: null },
            deletedAt: null,
            id: { not: input.factorId },
          },
          data: { deletedAt: now },
        });

        const { count } = await tx.adminTotpFactor.updateMany({
          where: {
            id: input.factorId,
            adminId: input.adminId,
            confirmedAt: null,
            deletedAt: null,
          },
          data: { confirmedAt: now, lastUsedStep: input.step, lastUsedAt: now },
        });

        if (count !== 1) throw new NotPending();
      });

      return true;
    } catch (err) {
      if (err instanceof NotPending) return false;
      throw err;
    }
  }

  /**
   * Retire a factor. Returns false when it does not exist, is already retired, or
   * belongs to someone else.
   *
   * `adminId` is in every WHERE clause rather than checked beforehand: a
   * read-then-write ownership check is a race, and more importantly it makes the
   * ownership rule something a future edit can forget. Here it is structural — a
   * factor id belonging to another admin simply matches no row.
   *
   * Soft delete, unlike `startTotpEnrollment`'s hard delete of PENDING factors: a
   * confirmed factor WAS a credential, so its history is worth keeping.
   */
  async retireFactor(input: {
    readonly adminId: string;
    readonly kind: FactorKind;
    readonly factorId: string;
  }): Promise<boolean> {
    const now = new Date();

    if (input.kind === 'TOTP') {
      const { count } = await this.prisma.adminTotpFactor.updateMany({
        where: {
          id: input.factorId,
          adminId: input.adminId,
          confirmedAt: { not: null },
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
      return count === 1;
    }

    const { count } = await this.prisma.adminPasskey.updateMany({
      where: { id: input.factorId, adminId: input.adminId, deletedAt: null },
      data: { deletedAt: now },
    });
    return count === 1;
  }

  /** Change a factor's display label. Same ownership-in-the-WHERE rule. */
  async renameFactor(input: {
    readonly adminId: string;
    readonly kind: FactorKind;
    readonly factorId: string;
    readonly label: string;
  }): Promise<boolean> {
    if (input.kind === 'TOTP') {
      const { count } = await this.prisma.adminTotpFactor.updateMany({
        where: {
          id: input.factorId,
          adminId: input.adminId,
          confirmedAt: { not: null },
          deletedAt: null,
        },
        data: { label: input.label },
      });
      return count === 1;
    }

    const { count } = await this.prisma.adminPasskey.updateMany({
      where: { id: input.factorId, adminId: input.adminId, deletedAt: null },
      data: { label: input.label },
    });
    return count === 1;
  }

  /** One factor, after a mutation, so the response can echo what changed. */
  async findFactor(input: {
    readonly adminId: string;
    readonly kind: FactorKind;
    readonly factorId: string;
  }): Promise<EnrolledFactor | null> {
    if (input.kind === 'TOTP') {
      const f = await this.prisma.adminTotpFactor.findFirst({
        where: { id: input.factorId, adminId: input.adminId, deletedAt: null },
      });
      return f === null
        ? null
        : {
            id: f.id,
            kind: 'TOTP',
            label: f.label,
            createdAt: f.createdAt,
            lastUsedAt: f.lastUsedAt,
          };
    }

    const p = await this.prisma.adminPasskey.findFirst({
      where: { id: input.factorId, adminId: input.adminId, deletedAt: null },
    });
    return p === null
      ? null
      : {
          id: p.id,
          kind: 'PASSKEY',
          label: p.label,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt,
        };
  }
}

/** Rollback sentinel for `confirmTotpReplacing`. Never escapes this file. */
class NotPending extends Error {}
