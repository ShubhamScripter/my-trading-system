import { Injectable } from '@nestjs/common';
import type { AdminPasskey, AdminTotpFactor } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { SealedSecret } from '../security/totp';

/**
 * Buffer → the exact `Uint8Array<ArrayBuffer>` Prisma's `Bytes` columns want.
 *
 * Node's Buffer is `Buffer<ArrayBufferLike>`, which may be backed by a
 * SharedArrayBuffer and is therefore not assignable to Prisma's narrower type.
 * One conversion helper rather than a cast, because a cast here would be
 * asserting something about memory backing that we cannot actually know.
 */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(buffer.length));
  out.set(buffer);
  return out;
}

/**
 * Prisma access for the two second-factor tables.
 *
 * One dboperation for both because every caller asks about them together — "what
 * can this admin sign in with" is one question, and answering it from two
 * injected collaborators would only invite the two to disagree about what
 * "confirmed" means.
 */
@Injectable()
export class MfaDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // ─── TOTP ─────────────────────────────────────────────────────────────────

  /**
   * The confirmed factor, if there is one.
   *
   * `confirmedAt: { not: null }` is in every read that authorises a sign-in. An
   * unconfirmed factor is a scanned QR code nobody proved they scanned, so
   * treating it as usable would let an interrupted enrollment become a working
   * credential.
   */
  async findConfirmedTotp(adminId: string): Promise<AdminTotpFactor | null> {
    return this.prisma.adminTotpFactor.findFirst({
      where: { adminId, confirmedAt: { not: null }, deletedAt: null },
    });
  }

  /**
   * The pending enrollment, if one is in flight AND still inside its window.
   *
   * ═══ `notBefore` IS REQUIRED, AND THAT IS THE POINT ════════════════════════
   *
   * This used to take only `adminId`, so an unconfirmed row was completable
   * forever — see `MFA.ENROLLMENT_TTL_SECONDS`. Making the cutoff a parameter
   * rather than an optional filter means no caller can read a pending factor
   * without having decided how old is too old, which is what stops the unbounded
   * lookup being reintroduced by a future call site.
   *
   * A stale row is simply NOT FOUND. Callers therefore get `null` for "no ceremony"
   * and "an expired ceremony" alike, and refuse identically — which is also the
   * right answer for a caller who should not learn that a secret they cannot use
   * exists. Discarding it is a separate statement; see
   * `discardStaleTotpEnrollments`.
   */
  async findPendingTotp(adminId: string, notBefore: Date): Promise<AdminTotpFactor | null> {
    return this.prisma.adminTotpFactor.findFirst({
      where: { adminId, confirmedAt: null, deletedAt: null, createdAt: { gte: notBefore } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Hard-delete this admin's abandoned enrollments. Returns how many went.
   *
   * ═══ THE SCOPE IS THE SAFETY PROPERTY ═════════════════════════════════════
   *
   * This is a HARD delete on the table that holds second factors, so what it can
   * reach matters more than what it does. Three predicates, all in the WHERE
   * clause, and each rules out one way this could go wrong:
   *
   *   adminId               another admin's rows are unreachable. In the statement
   *                         rather than checked by a preceding read, for the reason
   *                         `retireFactor` gives: a read-then-write ownership check
   *                         is a race, and worse, it is something a future edit can
   *                         forget. Here a foreign row simply matches nothing.
   *   confirmedAt: null     a CONFIRMED factor is a credential and is never hard
   *                         deleted — its history is worth keeping, which is what
   *                         `retireFactor`'s soft delete is for. Only an
   *                         unconfirmed secret, which was never a credential, is
   *                         erasable here.
   *   createdAt < before    a LIVE ceremony is never destroyed. Strictly less than,
   *                         so a row created exactly at the cutoff survives — the
   *                         boundary leans towards keeping a ceremony somebody may
   *                         still be completing.
   *
   * Hard rather than soft for the same reason `startTotpEnrollment` hard-deletes:
   * keeping a graveyard of abandoned secrets means keeping decryptable material
   * around for something that was never a credential and never will be.
   *
   * ─── This must never be load-bearing for a refusal ─────────────────────────
   *
   * Callers run it on a path that has ALREADY decided to refuse. It is cleanup, not
   * a check: nothing about the answer they give may depend on whether it ran, how
   * many rows it took, or whether it threw. `findPendingTotp`'s cutoff is what
   * makes a stale row unusable; this only stops it lingering.
   */
  async discardStaleTotpEnrollments(adminId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.adminTotpFactor.deleteMany({
      where: { adminId, confirmedAt: null, createdAt: { lt: before } },
    });
    return count;
  }

  /**
   * Start (or restart) a TOTP enrollment.
   *
   * Any previous PENDING factor is hard-deleted rather than soft-deleted, and
   * that is the one place in this schema where a hard delete is right: an
   * unconfirmed secret was never a credential, nothing references it, and keeping
   * a graveyard of abandoned secrets would mean keeping decryptable material
   * around for no reason at all. Confirmed factors are never touched here.
   */
  async startTotpEnrollment(input: {
    readonly adminId: string;
    readonly sealed: SealedSecret;
    readonly label: string;
  }): Promise<AdminTotpFactor> {
    return this.prisma.$transaction(async (tx) => {
      await tx.adminTotpFactor.deleteMany({
        where: { adminId: input.adminId, confirmedAt: null },
      });

      return tx.adminTotpFactor.create({
        data: {
          id: uuidv7(),
          adminId: input.adminId,
          // `bytes()` rather than passing the Buffer straight through. Prisma
          // types a `Bytes` column as `Uint8Array<ArrayBuffer>`, and Node's
          // Buffer is `Buffer<ArrayBufferLike>` — which may be backed by a
          // SharedArrayBuffer and so is not assignable. The copy is a few bytes.
          secretCiphertext: bytes(input.sealed.ciphertext),
          secretIv: bytes(input.sealed.iv),
          secretTag: bytes(input.sealed.tag),
          label: input.label,
        },
      });
    });
  }

  /**
   * Confirm a pending factor. Returns false if it is no longer pending.
   *
   * `confirmedAt: null` in the WHERE clause is a compare-and-swap, so two
   * concurrent confirmations of one enrollment cannot both succeed. The unique
   * partial index `ix_admin_totp_confirmed_unique` is the second line of defence:
   * even if this swap were removed, the database would refuse a second confirmed
   * factor for one admin.
   */
  async confirmTotp(factorId: string, step: bigint): Promise<boolean> {
    const { count } = await this.prisma.adminTotpFactor.updateMany({
      where: { id: factorId, confirmedAt: null, deletedAt: null },
      data: { confirmedAt: new Date(), lastUsedStep: step, lastUsedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * ═══ THE TOTP REPLAY DEFENCE ═══════════════════════════════════════════════
   *
   * Claim a time step for this factor, or report that it was already spent.
   *
   * `lastUsedStep: { lt: step }` in the WHERE clause is the entire mechanism, and
   * it MUST stay in the WHERE clause. The read-then-write version of this —
   * fetch the factor, compare in TypeScript, then update — lets two requests
   * presenting the same code both observe the old value and both pass, which is
   * precisely the replay this exists to prevent. Here the database serialises
   * them and the loser gets `count === 0`.
   *
   * `OR: [{ lastUsedStep: null }]` covers the first authentication after a
   * confirmation that somehow left the column null; without it that admin could
   * never sign in.
   *
   * ─── Still required at `TOTP.WINDOW: 0`, and worth saying why ──────────────
   *
   * This used to be justified by the ~90 seconds a code stayed arithmetically
   * valid under the old ±1-step window. That window is gone: a code now dies with
   * its own step. The defence is NOT redundant, because a step is still 30 seconds
   * wide — a code read over a shoulder or off a shared screen can be presented
   * inside the same step the owner used it in, and two concurrent requests
   * carrying one code both arrive inside it by definition. Narrowing the window
   * shortened the race; only this closes it.
   */
  async claimTotpStep(factorId: string, step: bigint): Promise<boolean> {
    const { count } = await this.prisma.adminTotpFactor.updateMany({
      where: {
        id: factorId,
        deletedAt: null,
        confirmedAt: { not: null },
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step, lastUsedAt: new Date() },
    });
    return count === 1;
  }

  // ─── passkeys ─────────────────────────────────────────────────────────────

  async listPasskeys(adminId: string): Promise<AdminPasskey[]> {
    return this.prisma.adminPasskey.findMany({
      where: { adminId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findPasskeyByCredentialId(credentialId: string): Promise<AdminPasskey | null> {
    return this.prisma.adminPasskey.findFirst({
      where: { credentialId, deletedAt: null },
    });
  }

  /**
   * Register a passkey.
   *
   * No availability check first. The partial unique index
   * `ix_admin_passkeys_credential_active` is the authority, and a check-then-insert
   * would lose the race against a concurrent registration of the same credential.
   * The caller catches the unique violation and reports
   * `passkey_already_registered` — see `isUniqueViolation` in db/client.ts.
   */
  async createPasskey(input: {
    readonly adminId: string;
    readonly credentialId: string;
    readonly publicKey: Buffer;
    readonly signCount: bigint;
    readonly transports: readonly string[];
    readonly aaguid: string | null;
    readonly label: string;
  }): Promise<AdminPasskey> {
    return this.prisma.adminPasskey.create({
      data: {
        id: uuidv7(),
        adminId: input.adminId,
        credentialId: input.credentialId,
        publicKey: bytes(input.publicKey),
        signCount: input.signCount,
        transports: [...input.transports],
        aaguid: input.aaguid,
        label: input.label,
      },
    });
  }

  /**
   * Persist the authenticator's new signature counter.
   *
   * Unconditional, unlike `claimTotpStep`. A passkey assertion is not replayable
   * the way a TOTP code is — the challenge it signed was single-use and is gone
   * from Redis by the time this runs — so there is no CAS to win here, and
   * refusing a non-advancing counter would lock out every authenticator that
   * reports a permanent 0. See the reasoning in security/passkey.ts.
   */
  async recordPasskeyUse(passkeyId: string, signCount: bigint): Promise<void> {
    await this.prisma.adminPasskey.update({
      where: { id: passkeyId },
      data: { signCount, lastUsedAt: new Date() },
    });
  }

  // ─── enrollment status ────────────────────────────────────────────────────

  /**
   * What this admin can actually sign in with.
   *
   * The single source of truth for the enroll-versus-authenticate decision, and
   * for `totp-enroll`'s downgrade guard. Both counts are of CONFIRMED factors
   * only, and both are computed here rather than read from `Admin.mfaEnrolledAt`
   * — that column is a denormalised convenience, and letting a security decision
   * depend on it would mean a stale value could widen what enrollment is allowed
   * to do.
   */
  async confirmedFactorCounts(adminId: string): Promise<{ totp: number; passkey: number }> {
    const [totp, passkey] = await Promise.all([
      this.prisma.adminTotpFactor.count({
        where: { adminId, confirmedAt: { not: null }, deletedAt: null },
      }),
      this.prisma.adminPasskey.count({ where: { adminId, deletedAt: null } }),
    ]);
    return { totp, passkey };
  }
}
