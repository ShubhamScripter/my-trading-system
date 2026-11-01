import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Admin,
  type AdminLoginReviewStatus,
  type AdminStatus,
} from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * Prisma access for ADMINISTERING OTHER ADMINS.
 *
 * The first and only place in this service where a write is aimed at an account
 * other than the caller's own, which is why it is its own class rather than rows
 * added to `TwoFactorDbOperation`. Every method here takes a target `adminId` from
 * a request body; every method in that one takes it from a verified principal, and
 * mixing the two would make "whose account is this touching" a question you have to
 * read the call site to answer.
 *
 * This is one of the classes permitted to inject `PrismaService`. See
 * `auth/auth.dboperation.ts` for the full list, why it is kept short, and where it
 * lives.
 */
@Injectable()
export class AdminsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** The target of an administrative action, or null. Soft-deleted rows are not
   *  targets — an account that has been removed is not one to administer. */
  async findById(adminId: string): Promise<Admin | null> {
    return this.prisma.admin.findFirst({ where: { id: adminId, deletedAt: null } });
  }

  /**
   * ═══ RETIRE EVERY SECOND FACTOR ON ONE ACCOUNT ═════════════════════════════
   *
   * The recovery action: an admin who has lost their authenticator gets their
   * factor set emptied so their next sign-in goes through forced enrollment, exactly
   * as a freshly seeded account does.
   *
   * ─── Why one transaction ───────────────────────────────────────────────────
   *
   * A partial retirement is the worst outcome available. Clearing the TOTP factor
   * but not the passkeys leaves the admin still locked out (they have lost the
   * device the passkey is on) while `MfaService.enrollmentState` reports that no
   * enrollment is needed — so the sign-in routes them to `mfa_required` for a factor
   * they cannot produce, and there is no enrollment branch to fall through to. All
   * or nothing.
   *
   * ─── Why `mfaEnrolledAt` is nulled here ────────────────────────────────────
   *
   * It is a denormalised convenience and nothing security-critical reads it — the
   * enrollment decision counts confirmed factors instead, precisely so a stale value
   * cannot widen what enrollment may do. But leaving it set would make `GET
   * /auth/me` tell the admin they have a factor while the ceremony demands they
   * enroll one, and an operator reading the table would draw the wrong conclusion.
   *
   * Soft delete, consistent with `retireFactor`: a confirmed factor WAS a
   * credential, and an account recovery is precisely the event whose history is
   * worth being able to reconstruct.
   *
   * Returns what was retired, so the caller can log it and decline to act when
   * there was nothing there.
   */
  async retireAllFactors(adminId: string): Promise<{ totp: number; passkey: number }> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const totp = await tx.adminTotpFactor.updateMany({
        // Every row, pending enrollments included. A pending TOTP secret is a
        // half-finished credential on an account being recovered, and leaving one
        // behind would let a stale QR code be confirmed afterwards.
        where: { adminId, deletedAt: null },
        data: { deletedAt: now },
      });

      const passkey = await tx.adminPasskey.updateMany({
        where: { adminId, deletedAt: null },
        data: { deletedAt: now },
      });

      await tx.admin.update({ where: { id: adminId }, data: { mfaEnrolledAt: null } });

      return { totp: totp.count, passkey: passkey.count };
    });
  }

  /**
   * Set an account's status.
   *
   * `AdminStatus.DISABLED` was previously reachable only by a direct database write,
   * which is exactly the operation an admin panel exists to remove: unauditable, and
   * performed with a psql prompt open on production.
   *
   * Returns false when nothing matched, so the caller can answer `not_found` rather
   * than reporting success for an account that does not exist.
   */
  async setStatus(adminId: string, status: AdminStatus): Promise<boolean> {
    const { count } = await this.prisma.admin.updateMany({
      where: { id: adminId, deletedAt: null },
      data: { status },
    });
    return count === 1;
  }

  // --- the manual-review queue ----------------------------------------------

  /**
   * === THE REVIEW QUEUE, WITH THE EVIDENCE ATTACHED =========================
   *
   * One page of accounts in the given review state, each with a summary of the auth
   * events that put it there.
   *
   * --- Why this is raw SQL --------------------------------------------------
   *
   * `COUNT(DISTINCT ...)`. Prisma's `groupBy` cannot express it at all, and the
   * alternative through the query builder is to fetch every event row for every
   * pending admin and count in JavaScript - unbounded work on an append-only table to
   * produce four integers. The LATERAL subquery below does it in the index.
   *
   * --- Why a LATERAL rather than a GROUP BY join ----------------------------
   *
   * The page is at most 100 admins and the aggregate is per-admin, so the planner
   * visits `admin_auth_events` once per selected row using `(admin_id, created_at)` -
   * not aggregate the whole table and then discard everything outside the page, which
   * is what a plain grouped join invites.
   *
   * --- Keyset, not OFFSET ---------------------------------------------------
   *
   * `(login_disabled_at, id)` descending, matching
   * `ix_admin_credentials_pending_review` so the ORDER BY and the cursor comparison
   * are both served without a sort. The row comparison `(a, b) < (x, y)` is the tuple
   * form, which is what makes the tie-break on `id` correct rather than approximately
   * correct when two accounts are disabled in the same millisecond.
   *
   * `limit + 1` rows are fetched so the caller can tell "this is the last page" from
   * "the next page is empty" without a second query.
   */
  async listLoginReviews(
    status: AdminLoginReviewStatus,
    limit: number,
    cursor: { disabledAt: Date | null; id: string } | null,
  ): Promise<readonly LoginReviewRow[]> {
    // COALESCE to the epoch on both sides rather than relying on NULLS ordering: a row
    // with no `login_disabled_at` would otherwise make the tuple comparison evaluate
    // to NULL, which is not TRUE, so the page would silently end early.
    const cursorClause =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND (COALESCE(a.login_disabled_at, TIMESTAMPTZ 'epoch'), a.id)
                       < (${cursor.disabledAt ?? new Date(0)}::timestamptz, ${cursor.id}::uuid)`;

    return this.prisma.$queryRaw<LoginReviewRow[]>`
      SELECT
        a.id,
        a.email,
        a.name,
        a.role,
        a.status,
        a.email_verified_at     AS "emailVerifiedAt",
        a.mfa_enrolled_at       AS "mfaEnrolledAt",
        a.created_at            AS "createdAt",
        a.login_review_status   AS "loginReviewStatus",
        a.login_disabled_at     AS "loginDisabledAt",
        a.login_disabled_reason AS "loginDisabledReason",
        a.review_version        AS "reviewVersion",
        a.reviewed_at           AS "reviewedAt",
        a.review_reason         AS "reviewReason",
        COALESCE(e.account_failures, 0) AS "accountFailures",
        COALESCE(e.distinct_ips, 0)     AS "distinctIps",
        COALESCE(e.distinct_devices, 0) AS "distinctDevices",
        e.last_failure_at               AS "lastFailureAt"
      FROM admin.admins a
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)                           AS account_failures,
          COUNT(DISTINCT ev.ip_class)        AS distinct_ips,
          COUNT(DISTINCT ev.device_key_hash) AS distinct_devices,
          MAX(ev.created_at)                 AS last_failure_at
        FROM admin.admin_auth_events ev
        WHERE ev.admin_id = a.id
          AND ev.deleted_at IS NULL
          AND ev.event_type IN ('ADMIN_LOGIN_PASSWORD_FAILURE', 'ADMIN_LOGIN_LOCKED')
      ) e ON TRUE
      WHERE a.login_review_status = ${status}::admin."AdminLoginReviewStatus"
        AND a.deleted_at IS NULL
        ${cursorClause}
      ORDER BY COALESCE(a.login_disabled_at, TIMESTAMPTZ 'epoch') DESC, a.id DESC
      LIMIT ${limit + 1}
    `;
  }

  /**
   * === DECIDE A REVIEW, UNDER OPTIMISTIC CONCURRENCY ========================
   *
   * `updateMany` naming both `reviewVersion` and `loginReviewStatus: 'PENDING'` in its
   * WHERE clause, which makes the whole thing a compare-and-swap. A plain `update`
   * would let two super admins looking at the same queue both act, and the second
   * would silently overwrite the first - including in the direction that re-enables an
   * account somebody had just decided to keep disabled.
   *
   * Same shape as `AttemptDbOperation.advanceState`, and for the same reason: the
   * check has to be part of the statement, not a read followed by a write.
   *
   * --- ENABLE clears the credential's lockout state too ---------------------
   *
   * In the SAME transaction, and the strikes go with it. This is the ONLY place
   * `lockoutStrikes` is ever cleared - `clearFailedAttempts` deliberately preserves
   * it, because a correct password does not prove the grinding stopped. A human
   * deciding "this was our own admin fumbling" is a different kind of evidence, and it
   * is the only kind that should reset the ladder. Leaving the strikes set would send
   * the account straight back to review on the next ten failures, which would make an
   * ENABLE decision worth about ten wrong passwords.
   */
  async resolveLoginReview(input: {
    readonly adminId: string;
    readonly expectedVersion: number;
    readonly decision: 'ENABLE' | 'KEEP_DISABLED';
    readonly reviewedBy: string;
    readonly reason: string;
  }): Promise<{ ok: boolean; reviewVersion: number }> {
    const now = new Date();
    const enable = input.decision === 'ENABLE';

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.admin.updateMany({
        where: {
          id: input.adminId,
          deletedAt: null,
          loginReviewStatus: 'PENDING',
          reviewVersion: input.expectedVersion,
        },
        data: {
          loginReviewStatus: enable ? 'RESOLVED' : 'REJECTED',
          // Only ENABLE puts the account back in service. KEEP_DISABLED leaves
          // `status` and the disable reason exactly as the lockout left them, so the
          // row still reads as "out of service, and here is why".
          ...(enable
            ? { status: 'ACTIVE' as const, loginDisabledAt: null, loginDisabledReason: null }
            : {}),
          reviewVersion: { increment: 1 },
          reviewedAt: now,
          reviewedBy: input.reviewedBy,
          reviewReason: input.reason,
        },
      });

      // Lost the swap: the row was already decided, or somebody moved the version
      // between the read and this write. Nothing is written, and the caller reports it.
      if (count !== 1) return { ok: false, reviewVersion: input.expectedVersion };

      if (enable) {
        await tx.adminCredential.updateMany({
          where: { adminId: input.adminId, kind: 'PASSWORD', deletedAt: null },
          data: {
            failedAttempts: 0,
            lockedUntil: null,
            lockoutStrikes: 0,
            lockoutStrikeAt: null,
          },
        });
      }

      return { ok: true, reviewVersion: input.expectedVersion + 1 };
    });
  }
}

/**
 * One row as Postgres returns it from `listLoginReviews`.
 *
 * Declared rather than inferred because `$queryRaw` is untyped by construction - the
 * generic is an assertion, not a check. Writing the shape out is what makes a renamed
 * column a compile error at the mapping site instead of an `undefined` in a response.
 *
 * The counts arrive as `bigint`: Postgres `COUNT(*)` is `int8`, and the driver hands
 * those back as BigInt rather than number to avoid silently truncating past 2^53. The
 * service narrows them.
 */
export interface LoginReviewRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Admin['role'];
  readonly status: AdminStatus;
  readonly emailVerifiedAt: Date | null;
  readonly mfaEnrolledAt: Date | null;
  readonly createdAt: Date;
  readonly loginReviewStatus: AdminLoginReviewStatus;
  readonly loginDisabledAt: Date | null;
  readonly loginDisabledReason: string | null;
  readonly reviewVersion: number;
  readonly reviewedAt: Date | null;
  readonly reviewReason: string | null;
  readonly accountFailures: bigint;
  readonly distinctIps: bigint;
  readonly distinctDevices: bigint;
  readonly lastFailureAt: Date | null;
}
