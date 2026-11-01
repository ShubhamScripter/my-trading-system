import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/client';

/**
 * ═══ THE GLOBAL KYC RENEWAL PERIODS — X AND Y ══════════════════════════════
 *
 * `identity.kyc_renewal_settings` belongs to ../Orebit-backend, which reads it on EVERY
 * KYC evaluation and derives every renewal deadline from it. This service configures it
 * and never reads it for a decision.
 *
 * Raw, schema-qualified SQL, and the table is deliberately not modelled in this
 * repository's `db/schema.prisma` — that datasource is `schemas = ["admin"]` on purpose.
 * `KycPolicyDbOperation`'s reasoning applies unchanged: two Prisma clients modelling one
 * table is two sources of truth, and whichever migrates second wins. The consequence to
 * know about is the same too — a column renamed over there breaks this writer and
 * neither repository's type system will say so. `tests/kyc/kyc.drift.spec.ts` is the
 * only guard.
 *
 * ═══ ONE ROW, TWO COLUMNS, NO HISTORY ══════════════════════════════════════
 *
 * The table holds exactly one row and the consumer's migration seeded it with both
 * periods NULL, so there is no create path: every write is an UPDATE of that row.
 * `ck_kyc_renewal_settings_singleton` enforces the same thing from the database side,
 * because a `BOOLEAN PRIMARY KEY` admits both `true` and `false`.
 *
 * There is no compare-and-swap and no versions table. Both shipped with the first cut
 * and were removed by the consumer's
 * `20260917210000_simplify_kyc_renewal_settings` migration. What that costs, stated
 * plainly: two super admins editing the periods at the same moment now resolve
 * last-write-wins instead of the second being refused, and this table no longer answers
 * "what was X in March". The audit event `KYC_RENEWAL_SETTINGS_UPDATED` records every
 * write with its periods, so the second question still has an answer; the first is an
 * accepted trade for a configuration two people are not expected to race over.
 *
 * ═══ WHAT NULL MEANS, AND WHY IT IS THE SHIPPED STATE ══════════════════════
 *
 * NULL is not "unset pending a default" — it is a configuration, and it is the one
 * every deployment starts in:
 *
 *   mandatory_period_seconds NULL   verifications NEVER expire
 *   voluntary_period_seconds NULL   same-level redo stays closed
 *
 * Nothing in either service substitutes a default for a null, and nothing may start.
 * Writing a number here is the ONLY way renewal ever begins, which is why `impactOf`
 * exists below: the first non-null mandatory period invalidates every account whose
 * verification predates it, all at once, with no grace period.
 */

/** The live row, as the database returns it. The whole of it. */
export interface KycRenewalSettingsRow {
  readonly mandatory_period_seconds: number | null;
  readonly voluntary_period_seconds: number | null;
}

export interface KycRenewalWriteInput {
  readonly mandatoryPeriodSeconds: number | null;
  readonly voluntaryPeriodSeconds: number | null;
}

/**
 * How many accounts a proposed mandatory period would invalidate, right now.
 *
 * Deliberately TWO plain counts and not a verdict per account. The precise consequence
 * for one user follows the level ladder — an expired L1 takes its L2 with it — and that
 * rule lives in the consumer's `kyc.validity.ts`. Re-deriving it here in SQL would be a
 * second implementation that eventually disagrees with the one actually enforcing.
 *
 * So this answers the operational question honestly and narrowly: how many stored
 * credentials fall outside the proposed window, and how many distinct people hold at
 * least one of them.
 */
export interface KycRenewalImpact {
  readonly levelsAffected: number;
  readonly usersAffected: number;
}

@Injectable()
export class KycRenewalDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** The live configuration, or null if the singleton row is missing. */
  async read(): Promise<KycRenewalSettingsRow | null> {
    const rows = await this.prisma.$queryRaw<KycRenewalSettingsRow[]>`
      SELECT "mandatory_period_seconds", "voluntary_period_seconds"
        FROM "identity"."kyc_renewal_settings"
       WHERE "id" = true`;
    return rows[0] ?? null;
  }

  /**
   * How many stored credentials a proposed mandatory period would put out of date.
   *
   * A pure READ — it writes nothing and is safe to call repeatedly. It is NOT part of
   * the API contract: the number goes to the audit event and the warning log, which is
   * where an incident review looks for the blast radius of a configuration change.
   *
   * `null` means "no mandatory period", which expires nothing, so the answer is zero
   * without touching the database.
   *
   * Counted against `verified_at`, which is the same anchor the consumer derives every
   * deadline from, so this number is the one that will actually happen rather than an
   * approximation of it.
   */
  async impactOf(mandatoryPeriodSeconds: number | null): Promise<KycRenewalImpact> {
    if (mandatoryPeriodSeconds === null) return { levelsAffected: 0, usersAffected: 0 };

    const rows = await this.prisma.$queryRaw<
      Array<{ levels: bigint; users: bigint }>
    >`
      SELECT count(*)                  AS "levels",
             count(DISTINCT "user_id") AS "users"
        FROM "identity"."kyc_level_states"
       WHERE "verified_at" < now() - (${mandatoryPeriodSeconds}::int * interval '1 second')`;

    // `count()` is bigint over the wire and serialises to a BigInt, which JSON.stringify
    // refuses outright. Narrowed here rather than at the controller so no caller has to
    // know that.
    return {
      levelsAffected: Number(rows[0]?.levels ?? 0n),
      usersAffected: Number(rows[0]?.users ?? 0n),
    };
  }

  /**
   * Write the periods onto the one row.
   *
   * No transaction, because there is nothing to keep in step with: one statement, one
   * row, and the two columns move together or not at all.
   *
   * Returns false when the statement matched nothing, which can only mean the singleton
   * row is absent — a broken deployment rather than a caller error. `KycRenewalService`
   * turns that into the same refusal a read of the missing row gives, so an operator
   * never sees a write silently succeed against a table that is not there.
   */
  async write(input: KycRenewalWriteInput): Promise<boolean> {
    const written = await this.prisma.$executeRaw`
      UPDATE "identity"."kyc_renewal_settings"
         SET "mandatory_period_seconds" = ${input.mandatoryPeriodSeconds},
             "voluntary_period_seconds" = ${input.voluntaryPeriodSeconds},
             "updated_at" = now()
       WHERE "id" = true`;
    return written === 1;
  }
}
