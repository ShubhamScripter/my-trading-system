import { Injectable } from '@nestjs/common';
import type { TrustedDevice } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';

/**
 * Persistence for `trusted_devices` — one row per browser the user asked to be
 * remembered.
 *
 * The lookup key is `(userId, tokenHash)` — the account, and the peppered hash of
 * the `orebit_device` cookie secret. The hash alone is NOT a key: the cookie is one
 * per browser profile and a trust belongs to an account, so two people sharing a
 * browser legitimately hold two live trusts against one hash. Scoping it to the
 * hash alone is what made the second of them revoke the first.
 *
 * The same hash is on `Session.deviceFingerprint`, which is what makes "every
 * session this trust is holding open" a plain equality query rather than a join
 * through the trust row.
 */
@Injectable()
export class DeviceDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Trust a device for ONE user, or extend the trust they already have on it.
   *
   * Re-trusting an already-trusted browser must not create a second live row —
   * `ux_trusted_devices_user_token_active` would refuse it, and the user's intent is
   * "keep remembering me" rather than "remember me twice". Revoking first and
   * inserting fresh keeps the audit trail (each trust is its own row with its own
   * dates) while leaving exactly one row live.
   *
   * ─── `userId` in the revoke predicate is the whole fix ─────────────────────
   *
   * It used to revoke by `tokenHash` alone, because the unique index was scoped that
   * way and left no choice. On a shared browser that meant the second person to ask
   * to be remembered revoked the FIRST person's trust — whose sessions then kept a
   * `rememberUntil` and a `trustedDeviceId` pointing at a dead row, silently fell
   * back to the idle window on their next refresh, and signed them out a week early
   * with nothing anywhere reporting it.
   */
  async trust(input: {
    userId: string;
    tokenHash: string;
    ipClassAtTrust: string;
    userAgentAtTrust: string | null;
    label: string | null;
    expiresAt: Date;
  }): Promise<TrustedDevice> {
    return this.prisma.$transaction(async (tx) => {
      await tx.trustedDevice.updateMany({
        where: { userId: input.userId, tokenHash: input.tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return tx.trustedDevice.create({ data: { id: uuidv7(), ...input } });
    });
  }

  /**
   * This user's live trust on this browser, if there is one.
   *
   * `userId` is part of the query rather than checked by the caller afterwards. Both
   * callers already did check it — and had to, because the unscoped version returned
   * whichever single row existed for the browser, which on a shared machine was
   * somebody else's. Now that two live rows can coexist, an unscoped `findFirst`
   * would return an arbitrary one of them and the caller's check would reject a
   * trust the user genuinely holds.
   */
  async findLive(tokenHash: string, userId: string): Promise<TrustedDevice | null> {
    return this.prisma.trustedDevice.findFirst({
      where: { userId, tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  async findById(id: string): Promise<TrustedDevice | null> {
    return this.prisma.trustedDevice.findUnique({ where: { id } });
  }

  /** Every live trust for one user, newest first — the device list. */
  async listForUser(userId: string): Promise<TrustedDevice[]> {
    return this.prisma.trustedDevice.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revoke a trust, scoped to its owner.
   *
   * `userId` is in the predicate rather than checked by the caller: this is the
   * only way a trust is revoked by id, and a missing ownership check here would be
   * an IDOR on a table whose ids are time-ordered UUIDv7. Returns the row so the
   * caller can sweep the sessions it was holding open — nothing else knows which
   * `tokenHash` to sweep on once the row is gone.
   */
  async revoke(id: string, userId: string): Promise<TrustedDevice | null> {
    const { count } = await this.prisma.trustedDevice.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return null;

    return this.prisma.trustedDevice.findUnique({ where: { id } });
  }

  /** Throttled like the session's, by the caller. */
  async touch(id: string): Promise<void> {
    await this.prisma.trustedDevice.updateMany({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }
}
