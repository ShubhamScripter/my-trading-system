import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * ═══ THIS WRITES A TABLE IN A SCHEMA THIS SERVICE DOES NOT OWN ═════════════
 *
 * `identity.security_restriction_policies` and its history table belong to
 * ../Orebit-backend, which ENFORCES them on every sensitive action. This service
 * configures them and never reads them for a decision.
 *
 * The queries are RAW and schema-qualified, and the tables are deliberately NOT
 * modelled in this repository's `db/schema.prisma` — that datasource is
 * `schemas = ["admin"]` on purpose. It is the same arrangement, in the opposite
 * direction, as `CaptchaProviderDbOperation` in the consumer backend, which reads
 * `admin.admin_captcha_providers` by raw SQL and states the reason: two Prisma
 * clients modelling one table is two sources of truth, and whichever migrates second
 * wins.
 *
 * The consequence to know about: a column renamed over there breaks this writer, and
 * nothing in either repository's type system will say so. The migration that created
 * these tables carries the matching warning, and `security-policies.contract.spec.ts`
 * is the only mechanical check.
 *
 * Both services point at one database today. If they are ever given separate roles,
 * this one needs `GRANT USAGE ON SCHEMA identity` and
 * `GRANT SELECT, INSERT, UPDATE ON` these two tables, and nothing more.
 *
 * Schema-qualified so nothing depends on `search_path`: this service's connection
 * string names `admin`, and should never name `identity`.
 */

export interface PolicyRow {
  readonly action: string;
  readonly context: string;
  readonly enabled: boolean;
  readonly features: string[];
  readonly sub_features: string[];
  readonly duration_seconds: number;
  readonly version: number;
  readonly updated_by_admin_id: string | null;
  readonly reason: string | null;
  readonly updated_at: Date;
}

/** What an accepted write produced, or why it was refused. */
export type UpsertOutcome =
  | { readonly ok: true; readonly version: number }
  /** The compare-and-swap lost: the row moved since the caller read it. */
  | { readonly ok: false; readonly currentVersion: number };

@Injectable()
export class SecurityPolicyDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** Every configured policy. At most sixteen rows, so the whole table every time. */
  async list(): Promise<readonly PolicyRow[]> {
    return this.prisma.$queryRaw<PolicyRow[]>`
      SELECT "action", "context", "enabled", "features", "sub_features",
             "duration_seconds", "version", "updated_by_admin_id", "reason", "updated_at"
        FROM "identity"."security_restriction_policies"
       ORDER BY "action", "context"`;
  }

  /**
   * Create or update one policy, and append its history, atomically.
   *
   * ═══ THE COMPARE-AND-SWAP, AND WHY BOTH BRANCHES NEED ONE ═════════════════
   *
   * `expectedVersion = 0` means "no row yet" and takes the INSERT branch;
   * anything else takes the conditional UPDATE. Both are races, and both are closed by
   * the database rather than by a read-then-write:
   *
   *   UPDATE — `WHERE version = expected` matches nothing if another admin has written
   *     since, and `count === 0` is the loser's signal. This is `Admin.reviewVersion`'s
   *     mechanism exactly.
   *
   *   INSERT — two admins both believing the row is absent both try to insert, and
   *     `ux_security_restriction_policies_target` refuses the second. `ON CONFLICT DO
   *     NOTHING` turns that into a zero row count rather than an exception, so the
   *     loser takes the same path as the UPDATE loser and the caller has one case to
   *     handle.
   *
   * ─── Why the history append is in the same transaction ────────────────────
   *
   * The invariant the schema states is that the live row is byte-identical to the
   * newest history row for its pair. Two statements outside a transaction would break
   * it on any failure between them, leaving a policy in force that no history explains
   * — which is precisely what `UserFeatureRestriction.policyVersion` points at.
   *
   * `ux_security_restriction_policy_versions_target` additionally makes a retried write
   * unable to record version N twice.
   */
  async upsert(input: {
    readonly action: string;
    readonly context: string;
    readonly enabled: boolean;
    readonly features: readonly string[];
    readonly subFeatures: readonly string[];
    readonly durationSeconds: number;
    readonly reason: string | null;
    readonly actorAdminId: string;
    readonly expectedVersion: number;
  }): Promise<UpsertOutcome> {
    const {
      action,
      context,
      enabled,
      features,
      subFeatures,
      durationSeconds,
      reason,
      actorAdminId,
      expectedVersion,
    } = input;

    return this.prisma.$transaction(async (tx) => {
      const nextVersion = expectedVersion + 1;

      const written =
        expectedVersion === 0
          ? await tx.$executeRaw`
              INSERT INTO "identity"."security_restriction_policies"
                ("id", "action", "context", "enabled", "features", "sub_features",
                 "duration_seconds", "version", "updated_by_admin_id", "reason",
                 "created_at", "updated_at")
              VALUES (gen_random_uuid(), ${action}, ${context}, ${enabled},
                      ${features as string[]}, ${subFeatures as string[]},
                      ${durationSeconds}, 1, ${actorAdminId}::uuid, ${reason},
                      now(), now())
              ON CONFLICT ("action", "context") DO NOTHING`
          : await tx.$executeRaw`
              UPDATE "identity"."security_restriction_policies"
                 SET "enabled" = ${enabled},
                     "features" = ${features as string[]},
                     "sub_features" = ${subFeatures as string[]},
                     "duration_seconds" = ${durationSeconds},
                     "version" = ${nextVersion},
                     "updated_by_admin_id" = ${actorAdminId}::uuid,
                     "reason" = ${reason},
                     "updated_at" = now()
               WHERE "action" = ${action}
                 AND "context" = ${context}
                 AND "version" = ${expectedVersion}`;

      if (written !== 1) {
        // Lost the swap, or tried to create a row that already exists. Report the
        // version that IS current so the caller can tell the operator what to re-read.
        const rows = await tx.$queryRaw<Array<{ version: number }>>`
          SELECT "version" FROM "identity"."security_restriction_policies"
           WHERE "action" = ${action} AND "context" = ${context}`;
        return { ok: false as const, currentVersion: rows[0]?.version ?? 0 };
      }

      const version = expectedVersion === 0 ? 1 : nextVersion;

      // The history row carries the state this write RESULTED IN, so the newest row
      // for a pair always matches the live row.
      await tx.$executeRaw`
        INSERT INTO "identity"."security_restriction_policy_versions"
          ("id", "action", "context", "version", "enabled", "features", "sub_features",
           "duration_seconds", "updated_by_admin_id", "reason", "created_at")
        VALUES (gen_random_uuid(), ${action}, ${context}, ${version}, ${enabled},
                ${features as string[]}, ${subFeatures as string[]},
                ${durationSeconds}, ${actorAdminId}::uuid, ${reason}, now())`;

      return { ok: true as const, version };
    });
  }

  /**
   * The history for one pair, newest first.
   *
   * Read-only and append-only — there is deliberately no update or delete here. The
   * schema notes that immutability is a service contract rather than a database
   * constraint, and this file is where that contract is kept: nothing in this service
   * can mutate a history row because no method exists to.
   */
  async history(action: string, context: string, limit: number): Promise<readonly PolicyRow[]> {
    return this.prisma.$queryRaw<PolicyRow[]>`
      SELECT "action", "context", "enabled", "features", "sub_features",
             "duration_seconds", "version", "updated_by_admin_id", "reason",
             "created_at" AS "updated_at"
        FROM "identity"."security_restriction_policy_versions"
       WHERE "action" = ${action} AND "context" = ${context}
       ORDER BY "version" DESC
       LIMIT ${Prisma.raw(String(Math.max(1, Math.min(200, Math.trunc(limit)))))}`;
  }
}
