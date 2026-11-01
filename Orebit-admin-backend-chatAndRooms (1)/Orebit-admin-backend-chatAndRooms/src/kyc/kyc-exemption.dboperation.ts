import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * ═══ THIS WRITES A TABLE IN A SCHEMA THIS SERVICE DOES NOT OWN ═════════════
 *
 * `identity.kyc_exemptions` belongs to ../Orebit-backend, which reads it on EVERY KYC
 * evaluation: `findLiveExemption` feeds `effectiveLevel`, so a row here raises an
 * account's standing platform-wide without any provider attesting anything.
 *
 * Raw, schema-qualified, and deliberately not modelled in this repository's Prisma
 * schema — the same arrangement and the same reasoning as `KycPolicyDbOperation`.
 */

export interface KycExemptionRow {
  readonly id: string;
  readonly user_id: string;
  readonly effective_level: string;
  readonly reason: string;
  readonly granted_by: string;
  readonly granted_at: Date;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
  readonly revoke_reason: string | null;
  readonly live: boolean;
}

export type GrantOutcome =
  | { readonly ok: true; readonly id: string; readonly supersededExpired: boolean }
  /** No such account. The FK would otherwise raise 23503, which aborts the
   *  transaction and surfaces as a 500 rather than a useful answer. */
  | { readonly ok: false; readonly reason: 'unknown_user' }
  /** The account genuinely holds a live exemption right now. */
  | { readonly ok: false; readonly reason: 'already_exempt' };

export type RevokeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'already_revoked'; readonly revokedAt: Date };

/**
 * `live` as the CONSUMER computes it, evaluated by the database.
 *
 * ═══ ONE CLOCK, ONE ANSWER ═════════════════════════════════════════════════
 *
 * The enforcer decides whether an exemption applies using the database's `now()`. An
 * admin screen that decided the same question from this Node process's clock could
 * disagree with the service actually gating the user — so the question is asked where
 * the answer is authoritative.
 *
 * The predicate is `findLiveExemption`'s, character for character: not revoked, and
 * either no expiry or an expiry still in the future.
 */
const LIVE = Prisma.sql`("revoked_at" IS NULL AND ("expires_at" IS NULL OR "expires_at" > now()))`;

const EXEMPTION_COLUMNS = Prisma.sql`
  "id", "user_id", "effective_level", "reason", "granted_by", "granted_at",
  "expires_at", "revoked_at", "revoked_by", "revoke_reason"
`;

@Injectable()
export class KycExemptionDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** One account's exemptions, newest grant first. */
  async listForUser(userId: string, limit: number): Promise<readonly KycExemptionRow[]> {
    return this.prisma.$queryRaw<KycExemptionRow[]>`
      SELECT ${EXEMPTION_COLUMNS}, ${LIVE} AS "live"
        FROM "identity"."kyc_exemptions"
       WHERE "user_id" = ${userId}::uuid
       ORDER BY "granted_at" DESC
       LIMIT ${Prisma.raw(clamp(limit))}`;
  }

  /**
   * Every account currently holding relief.
   *
   * The compliance-review question — "who is exempt right now" — and unanswerable
   * without it. Bounded by the partial unique index, which permits one live row per
   * account.
   */
  async listLive(limit: number): Promise<readonly KycExemptionRow[]> {
    return this.prisma.$queryRaw<KycExemptionRow[]>`
      SELECT ${EXEMPTION_COLUMNS}, ${LIVE} AS "live"
        FROM "identity"."kyc_exemptions"
       WHERE ${LIVE}
       ORDER BY "granted_at" DESC
       LIMIT ${Prisma.raw(clamp(limit))}`;
  }

  /**
   * Grant an exemption.
   *
   * ═══ THREE STEPS, AND THE MIDDLE ONE IS THE INTERESTING ONE ════════════════
   *
   * The partial unique index and the consumer's reader DISAGREE about what "live"
   * means, and the gap is a trap:
   *
   *   ux_kyc_exemptions_live   ON (user_id) WHERE revoked_at IS NULL
   *   findLiveExemption        revoked_at IS NULL AND (expires_at IS NULL
   *                                                    OR expires_at > now)
   *
   * So a row that EXPIRED but was never revoked occupies the account's one slot while
   * granting nothing. Without step 2, an account whose exemption lapsed could never be
   * granted another, and the operator would be told "already exempt" about a row that
   * exempts nobody.
   *
   * Step 2 closes exactly those rows — `expires_at <= now()` is the precise complement
   * of the reader's `>`, so a row is either live to the consumer or closable here,
   * never both and never neither.
   *
   * ─── Why the user is probed rather than the FK violation caught ────────────
   *
   * A caught 23503 inside an interactive transaction has already aborted it; every
   * later statement then fails with 25P02. The probe is both the better error and the
   * only shape that works. A concurrent account deletion between probe and insert
   * still raises 23503 and becomes a 500 — that race is genuinely exceptional and
   * should be loud.
   *
   * ─── The conflict target restates the index predicate ─────────────────────
   *
   * `ON CONFLICT ("user_id") WHERE "revoked_at" IS NULL` is how Postgres infers a
   * PARTIAL unique index. A bare `ON CONFLICT ("user_id")` fails outright with "no
   * unique or exclusion constraint matching the ON CONFLICT specification".
   */
  async grant(input: {
    readonly userId: string;
    readonly effectiveLevel: string;
    readonly reason: string;
    readonly expiresAt: string | null;
    readonly actorAdminId: string;
  }): Promise<GrantOutcome> {
    const { userId, effectiveLevel, reason, expiresAt, actorAdminId } = input;

    return this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "identity"."users" WHERE "id" = ${userId}::uuid`;
      if (users.length === 0) return { ok: false as const, reason: 'unknown_user' as const };

      const closed = await tx.$executeRaw`
        UPDATE "identity"."kyc_exemptions"
           SET "revoked_at" = now(),
               "revoked_by" = ${actorAdminId}::uuid,
               "revoke_reason" = 'Expired exemption closed automatically by a new grant'
         WHERE "user_id" = ${userId}::uuid
           AND "revoked_at" IS NULL
           AND "expires_at" IS NOT NULL
           AND "expires_at" <= now()`;

      const id = crypto.randomUUID();

      const written = await tx.$executeRaw`
        INSERT INTO "identity"."kyc_exemptions"
          ("id", "user_id", "effective_level", "reason", "granted_by", "granted_at",
           "expires_at", "created_at")
        VALUES (${id}::uuid, ${userId}::uuid, ${effectiveLevel}, ${reason},
                ${actorAdminId}::uuid, now(), ${expiresAt}::timestamptz, now())
        ON CONFLICT ("user_id") WHERE "revoked_at" IS NULL DO NOTHING`;

      if (written !== 1) {
        // Step 2 committing here is deliberate and harmless: closing an already-inert
        // row is idempotent bookkeeping that the winning grant would have done anyway,
        // and `revoke_reason` records that it was automatic.
        return { ok: false as const, reason: 'already_exempt' as const };
      }

      return { ok: true as const, id, supersededExpired: closed === 1 };
    });
  }

  /**
   * Withdraw an exemption.
   *
   * Scoped by BOTH id and account. The id alone would identify the row; the pair is
   * what stops a console that has paired a displayed user with a stale row id from
   * revoking somebody else's relief. The ownership test is in the WHERE clause rather
   * than a comparison afterwards, so no later edit can drop it.
   *
   * Revoking an EXPIRED row is permitted — the predicate is only `revoked_at IS NULL`.
   * That is legitimate bookkeeping, and it also frees the account's slot.
   */
  async revoke(input: {
    readonly userId: string;
    readonly exemptionId: string;
    readonly reason: string;
    readonly actorAdminId: string;
  }): Promise<RevokeOutcome> {
    const { userId, exemptionId, reason, actorAdminId } = input;

    return this.prisma.$transaction(async (tx) => {
      const written = await tx.$executeRaw`
        UPDATE "identity"."kyc_exemptions"
           SET "revoked_at" = now(),
               "revoked_by" = ${actorAdminId}::uuid,
               "revoke_reason" = ${reason}
         WHERE "id" = ${exemptionId}::uuid
           AND "user_id" = ${userId}::uuid
           AND "revoked_at" IS NULL`;

      if (written === 1) return { ok: true as const };

      // Distinguish "nothing to revoke" from "already revoked", but ONLY for a row
      // that belongs to this account. A row under another account answers not_found —
      // confirming its existence would make this an oracle for enumerating ids.
      const rows = await tx.$queryRaw<Array<{ revoked_at: Date | null }>>`
        SELECT "revoked_at" FROM "identity"."kyc_exemptions"
         WHERE "id" = ${exemptionId}::uuid AND "user_id" = ${userId}::uuid`;

      const revokedAt = rows[0]?.revoked_at ?? null;
      if (revokedAt === null) return { ok: false as const, reason: 'not_found' as const };
      return { ok: false as const, reason: 'already_revoked' as const, revokedAt };
    });
  }
}

/**
 * `LIMIT` cannot be a bind parameter in this position, so it is interpolated — and
 * this clamp is the only thing between `Prisma.raw` and SQL injection. `Math.trunc`
 * plus the bounds makes a non-integer or out-of-range value impossible; the DTO's
 * `z.coerce.number().int()` is the first line and this is the second.
 */
function clamp(limit: number): string {
  return String(Math.max(1, Math.min(200, Math.trunc(limit))));
}
