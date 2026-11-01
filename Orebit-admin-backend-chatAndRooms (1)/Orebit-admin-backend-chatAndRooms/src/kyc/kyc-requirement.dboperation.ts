import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * ═══ MANUALLY IMPOSED KYC OBLIGATIONS ══════════════════════════════════════
 *
 * `identity.kyc_requirements` belongs to ../Orebit-backend, which EVALUATES it on
 * every KYC decision and closes a row when an approved verification discharges it.
 * This module writes the two things an obligation can acquire from a human: its
 * existence, and its waiver.
 *
 * Raw, schema-qualified SQL, and the table is deliberately not modelled in this
 * repository's `db/schema.prisma` — that datasource is `schemas = ["admin"]` on
 * purpose. `KycPolicyDbOperation`'s reasoning applies unchanged: two Prisma clients
 * modelling one table is two sources of truth, and whichever migrates second wins. The
 * consequence is the same too — a column renamed over there breaks this writer and
 * neither repository's type system will say so. `tests/kyc/kyc.drift.spec.ts` is the
 * only guard.
 *
 * ═══ WHAT THIS MAY WRITE, AND WHAT IT STRUCTURALLY CANNOT ══════════════════
 *
 * It writes `kyc_requirements` and nothing else. It cannot mark an account verified,
 * because it has no statement touching `kyc_level_states`, `kyc_verifications`,
 * `kyc_verification_devices` or `kyc_provider_events` — and a requirement row is not a
 * credential in any reading: every consumer treats it as something the account OWES.
 *
 * The distinction that makes this write acceptable where editing a verification would
 * not be: an obligation WITHHOLDS standing. It cannot fabricate a provider decision,
 * which is the one thing a compliance trail cannot survive.
 *
 * ═══ NO VALIDITY LOGIC HERE, AND NONE ANYWHERE IN THIS SERVICE ═════════════
 *
 * Nothing below reads `kyc_level_states`, `kyc_exemptions` or `kyc_renewal_settings`,
 * and nothing computes an effective level. Whether a recorded obligation is currently
 * EFFECTIVE is the consumer's question, answered by `evaluate` filtering open rows
 * against the account's effective level. This file records; it does not judge.
 */

/** A row as the database returns it. */
export interface KycRequirementRow {
  readonly id: string;
  readonly user_id: string;
  readonly required_level: string;
  readonly trigger_kind: string;
  readonly trigger_key: string;
  readonly satisfied_at: Date | null;
  readonly satisfied_by_verification_id: string | null;
  readonly waived_at: Date | null;
  readonly waived_by: string | null;
  readonly policy_region: string | null;
  readonly policy_version: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  /** Computed by the DATABASE, against its own clock — see `KycRequirementView`. */
  readonly open: boolean;
}

/**
 * What a `require` produced.
 *
 * `created: false` is a SUCCESS, not a conflict: the obligation this admin asked for
 * already stands, which is the answer they wanted. `unknown_user` is the only refusal.
 */
export type KycRequireOutcome =
  | { readonly ok: true; readonly row: KycRequirementRow; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'unknown_user' };

/**
 * What a `waive` produced.
 *
 * Three answers rather than a boolean, because they are three different instructions
 * for the operator — and the middle one must not confirm that a row they may not see
 * exists. See `waive` below.
 */
export type KycWaiveOutcome =
  | { readonly ok: true; readonly row: KycRequirementRow }
  | { readonly ok: false; readonly reason: 'not_found' }
  | {
      readonly ok: false;
      readonly reason: 'already_closed';
      readonly satisfiedAt: Date | null;
      readonly waivedAt: Date | null;
    };

/**
 * The columns every read projects.
 *
 * `open` is derived in SQL rather than in Node, for `KycExemptionView.live`'s reason:
 * the consumer's `listOpenRequirements` filters on exactly this predicate against the
 * database clock, and a panel computing it from the Node clock could disagree with the
 * evaluator that is gating the user.
 */
const REQUIREMENT_COLUMNS = Prisma.sql`
  "id", "user_id", "required_level", "trigger_kind", "trigger_key",
  "satisfied_at", "satisfied_by_verification_id",
  "waived_at", "waived_by",
  "policy_region", "policy_version",
  "created_at", "updated_at",
  ("satisfied_at" IS NULL AND "waived_at" IS NULL) AS "open"
`;

@Injectable()
export class KycRequirementDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One account's obligations, open first, then newest.
   *
   * `open DESC` leads because an operator opening this screen is almost always asking
   * "what does this account owe right now"; the closed rows below it are the trail.
   * Served by `kyc_requirements_user_id_satisfied_at_idx`.
   */
  async listForUser(userId: string, limit: number): Promise<readonly KycRequirementRow[]> {
    return this.prisma.$queryRaw<KycRequirementRow[]>`
      SELECT ${REQUIREMENT_COLUMNS}
        FROM "identity"."kyc_requirements"
       WHERE "user_id" = ${userId}::uuid
       ORDER BY ("satisfied_at" IS NULL AND "waived_at" IS NULL) DESC, "created_at" DESC
       LIMIT ${Prisma.raw(clamp(limit))}`;
  }

  /**
   * Record an obligation, or adopt the one already recorded.
   *
   * ═══ THE INDEX DECIDES, NOT A READ ═════════════════════════════════════════
   *
   * `ux_kyc_requirements_open (user_id, trigger_key) WHERE satisfied_at IS NULL AND
   * waived_at IS NULL` is the authority, exactly as it is for the consumer's own
   * `ensureRequirement`. Two admins imposing the same case reference at the same
   * moment both insert; the index refuses the second, `ON CONFLICT DO NOTHING` turns
   * that into a zero count, and the loser re-reads and returns the winner's row.
   *
   * A read-then-write would lose that race and produce two obligations for one
   * decision, each needing its own discharge.
   *
   * ─── The conflict target restates the index predicate ─────────────────────
   *
   * `ON CONFLICT ("user_id", "trigger_key") WHERE "satisfied_at" IS NULL AND
   * "waived_at" IS NULL` is how Postgres infers a PARTIAL unique index. A bare
   * `ON CONFLICT ("user_id", "trigger_key")` fails outright with "no unique or
   * exclusion constraint matching the ON CONFLICT specification" — the same trap
   * `KycExemptionDbOperation.grant` documents.
   *
   * It also means a CLOSED row with this key does not block a new one, which is
   * correct: the same case can legitimately be re-imposed after being waived, and the
   * partial predicate is what frees the slot.
   *
   * ─── Why the user is probed rather than the FK violation caught ────────────
   *
   * `KycExemptionDbOperation.grant`'s reason, verbatim in consequence: a caught 23503
   * inside an interactive transaction has already aborted it, so every later statement
   * fails with 25P02. The probe is both the better error and the only shape that
   * works. A concurrent account deletion between probe and insert still raises 23503
   * and becomes a 500 — genuinely exceptional, and it should be loud.
   *
   * ─── `policy_region` / `policy_version` are NULL, deliberately ────────────
   *
   * `ck_kyc_requirements_policy_region` permits null precisely for this case. The
   * cause is a human decision rather than a configuration, and pointing the row at a
   * policy version would claim a rule that did not raise it.
   */
  async require(input: {
    readonly userId: string;
    readonly requiredLevel: string;
    readonly triggerKind: string;
    readonly triggerKey: string;
  }): Promise<KycRequireOutcome> {
    const { userId, requiredLevel, triggerKind, triggerKey } = input;

    return this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "identity"."users" WHERE "id" = ${userId}::uuid`;
      if (users.length === 0) return { ok: false as const, reason: 'unknown_user' as const };

      const id = crypto.randomUUID();

      // `updated_at` has no database default on this table — the consumer declares it
      // `@updatedAt`, which Prisma maintains only on writes PRISMA performs, and the
      // writer here is another service using raw SQL. So it is set by hand, exactly as
      // `KycPolicyDbOperation.upsert` sets `updated_at` for the same reason.
      const written = await tx.$executeRaw`
        INSERT INTO "identity"."kyc_requirements"
          ("id", "user_id", "required_level", "trigger_kind", "trigger_key",
           "policy_region", "policy_version", "created_at", "updated_at")
        VALUES (${id}::uuid, ${userId}::uuid, ${requiredLevel}, ${triggerKind}, ${triggerKey},
                NULL, NULL, now(), now())
        ON CONFLICT ("user_id", "trigger_key")
          WHERE "satisfied_at" IS NULL AND "waived_at" IS NULL
          DO NOTHING`;

      const rows = await tx.$queryRaw<KycRequirementRow[]>`
        SELECT ${REQUIREMENT_COLUMNS}
          FROM "identity"."kyc_requirements"
         WHERE "user_id" = ${userId}::uuid
           AND "trigger_key" = ${triggerKey}
           AND "satisfied_at" IS NULL
           AND "waived_at" IS NULL`;

      const row = rows[0];

      // The re-read found nothing, which can only mean a concurrent approval or waiver
      // closed the winning row between the insert and this select. Reported as an
      // unknown-user-shaped refusal would be a lie, so it surfaces as a 500 instead:
      // the obligation the admin asked for neither exists nor was created, and no
      // honest answer is available without guessing.
      if (row === undefined) {
        throw new Error('kyc requirement vanished between insert and read-back');
      }

      return { ok: true as const, row, created: written === 1 };
    });
  }

  /**
   * Discharge an obligation by administrative decision.
   *
   * ═══ THE WHERE CLAUSE IS THE WHOLE GUARANTEE ═══════════════════════════════
   *
   * Scoped by BOTH id and account, and conditional on the row still being open. The id
   * alone would identify the row; the pair is what stops a console that has paired a
   * displayed user with a stale row id from discharging somebody else's obligation —
   * `KycExemptionDbOperation.revoke`'s argument exactly, and the ownership test is in
   * the WHERE rather than a comparison afterwards so no later edit can drop it.
   *
   * Conditional on `satisfied_at IS NULL AND waived_at IS NULL` because the consumer's
   * invariant is that the two are never both set. A waiver racing an approval must
   * write nothing rather than overwrite the evidence of how the obligation was really
   * discharged — the consumer states this as "the WHERE is what guarantees it rather
   * than a check in the caller", and this writer honours the same rule.
   *
   * ─── Why the refusals are told apart, and where that stops ────────────────
   *
   * A row that is already closed is a STALE PAYLOAD: the operator is looking at an old
   * screen, and re-reading fixes it. A row that does not exist, or belongs to another
   * account, is `not_found` — and those two are deliberately the SAME answer, because
   * distinguishing them would make this an oracle for enumerating requirement ids.
   * `KycExemptionService.revoke` draws the line in the same place.
   */
  async waive(input: {
    readonly userId: string;
    readonly requirementId: string;
    readonly actorAdminId: string;
  }): Promise<KycWaiveOutcome> {
    const { userId, requirementId, actorAdminId } = input;

    return this.prisma.$transaction(async (tx) => {
      const written = await tx.$executeRaw`
        UPDATE "identity"."kyc_requirements"
           SET "waived_at" = now(),
               "waived_by" = ${actorAdminId}::uuid,
               "updated_at" = now()
         WHERE "id" = ${requirementId}::uuid
           AND "user_id" = ${userId}::uuid
           AND "satisfied_at" IS NULL
           AND "waived_at" IS NULL`;

      if (written === 1) {
        const rows = await tx.$queryRaw<KycRequirementRow[]>`
          SELECT ${REQUIREMENT_COLUMNS}
            FROM "identity"."kyc_requirements"
           WHERE "id" = ${requirementId}::uuid`;
        const row = rows[0];
        if (row === undefined) throw new Error('kyc requirement vanished after waiver');
        return { ok: true as const, row };
      }

      // Nothing matched. Read back ONLY within this account, so a row belonging to
      // somebody else is indistinguishable from one that never existed.
      const rows = await tx.$queryRaw<
        Array<{ satisfied_at: Date | null; waived_at: Date | null }>
      >`
        SELECT "satisfied_at", "waived_at"
          FROM "identity"."kyc_requirements"
         WHERE "id" = ${requirementId}::uuid AND "user_id" = ${userId}::uuid`;

      const existing = rows[0];
      if (existing === undefined) return { ok: false as const, reason: 'not_found' as const };

      return {
        ok: false as const,
        reason: 'already_closed' as const,
        satisfiedAt: existing.satisfied_at,
        waivedAt: existing.waived_at,
      };
    });
  }
}

/**
 * `LIMIT` cannot be a bind parameter in this position, so it is interpolated — and
 * this clamp is the only thing between `Prisma.raw` and SQL injection. `Math.trunc`
 * plus the bounds makes a non-integer or out-of-range value impossible; the DTO's
 * `z.coerce.number().int()` is the first line and this is the second. Copied from
 * `KycExemptionDbOperation` rather than shared, because a helper imported across two
 * files is a helper somebody later "simplifies".
 */
function clamp(limit: number): string {
  return String(Math.max(1, Math.min(200, Math.trunc(limit))));
}
