import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/client';

/**
 * ═══ THIS WRITES TABLES IN A SCHEMA THIS SERVICE DOES NOT OWN ══════════════
 *
 * `identity.kyc_policies` and `identity.kyc_policy_versions` belong to
 * ../Orebit-backend, which ENFORCES them on every KYC evaluation. This service
 * configures them and never reads them for a decision.
 *
 * The queries are RAW and schema-qualified, and the tables are deliberately NOT
 * modelled in this repository's `db/schema.prisma` — that datasource is
 * `schemas = ["admin"]` on purpose. The arrangement, and the reasoning, are
 * `SecurityPolicyDbOperation`'s exactly: two Prisma clients modelling one table is two
 * sources of truth, and whichever migrates second wins.
 *
 * The consequence to know about: a column renamed over there breaks this writer and
 * nothing in either repository's type system will say so. `tests/kyc/kyc.drift.spec.ts`
 * is the only mechanical check.
 *
 * Schema-qualified so nothing depends on `search_path`: this service's connection
 * string names `admin`, and should never name `identity`.
 */

/** A row as the database returns it. Decimals arrive as strings — see `list`. */
export interface KycPolicyRow {
  readonly region: string;
  readonly level: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly triggers_only: boolean;
  readonly workflow_id: string | null;
  readonly renewal_workflow_id: string | null;
  readonly balance_threshold: string | null;
  readonly lifetime_deposit_threshold: string | null;
  readonly lifetime_withdrawal_threshold: string | null;
  readonly rolling_window_amount: string | null;
  readonly rolling_window_seconds: number | null;
  readonly rolling_window_operation: string | null;
  readonly threshold_currency: string | null;
  readonly features: string[];
  readonly sub_features: string[];
  readonly version: number;
  readonly updated_by_admin_id: string | null;
  readonly reason: string | null;
  readonly updated_at: Date;
}

export type KycPolicyVersionRow = Omit<KycPolicyRow, 'updated_at'> & {
  readonly recorded_at: Date;
};

/** What an accepted write produced, or why it was refused. */
export type KycPolicyWriteOutcome =
  | { readonly ok: true; readonly version: number }
  /** The compare-and-swap lost: the row moved, or does not exist, since the caller
   *  read it. `currentVersion: 0` means there is no row at all. */
  | { readonly ok: false; readonly currentVersion: number };

/** Everything a policy write stores. Thresholds are exact decimal strings. */
export interface KycPolicyWriteInput {
  readonly region: string;
  readonly level: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly triggersOnly: boolean;
  readonly workflowId: string | null;
  readonly renewalWorkflowId: string | null;
  readonly balanceThreshold: string | null;
  readonly lifetimeDepositThreshold: string | null;
  readonly lifetimeWithdrawalThreshold: string | null;
  readonly rollingWindowAmount: string | null;
  readonly rollingWindowSeconds: number | null;
  readonly rollingWindowOperation: string | null;
  readonly thresholdCurrency: string | null;
  readonly features: readonly string[];
  readonly subFeatures: readonly string[];
  readonly reason: string;
  readonly actorAdminId: string;
  readonly expectedVersion: number;
}

/**
 * The columns every read projects.
 *
 * ═══ `::text` ON THE DECIMALS IS NOT COSMETIC ══════════════════════════════
 *
 * Without it `$queryRaw` hands back `Prisma.Decimal` instances, which serialise into
 * JSON as their internal `{s,e,d}` representation — unusable to a client and not a
 * number anybody can compare. `numeric::text` renders the stored value non-exponential
 * at its full scale, which is the same form the consumer's `.toFixed()` produces. So
 * an admin screen shows exactly the string the enforcer compares against, and a value
 * read here can be posted straight back without loss.
 *
 * Trailing zeros are deliberately NOT trimmed: `10000.000000000000000000` is what is
 * in force, and it is still a valid input to this API on re-submit.
 */
const POLICY_COLUMNS = Prisma.sql`
  "region", "level", "enabled", "required", "triggers_only",
  "workflow_id", "renewal_workflow_id",
  "balance_threshold"::text             AS "balance_threshold",
  "lifetime_deposit_threshold"::text    AS "lifetime_deposit_threshold",
  "lifetime_withdrawal_threshold"::text AS "lifetime_withdrawal_threshold",
  "rolling_window_amount"::text         AS "rolling_window_amount",
  "rolling_window_seconds", "rolling_window_operation", "threshold_currency",
  "features", "sub_features",
  "version", "updated_by_admin_id", "reason"
`;

@Injectable()
export class KycPolicyDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every configured policy.
   *
   * Only the rows that EXIST, unlike `SecurityPolicyDbOperation.list`, which can
   * enumerate its whole cross-product because that is sixteen rows. The target space
   * here is every ISO country times two levels, so the un-created row is not a thing
   * this list can hand back — see `KYC_POLICY_CREATE_VERSION`.
   *
   * `("region" = '*') DESC` first because under a non-C collation `'*'` sorts
   * unpredictably against letters, and the global rule belongs at the top of a screen.
   */
  async list(): Promise<readonly KycPolicyRow[]> {
    return this.prisma.$queryRaw<KycPolicyRow[]>`
      SELECT ${POLICY_COLUMNS}, "updated_at"
        FROM "identity"."kyc_policies"
       ORDER BY ("region" = '*') DESC, "region", "level"`;
  }

  /**
   * Create or update one policy, and append its history, atomically.
   *
   * ═══ THE COMPARE-AND-SWAP ══════════════════════════════════════════════════
   *
   * `expectedVersion = 0` means "no row yet" and takes the INSERT branch; anything
   * else takes the conditional UPDATE. Both are races and both are closed by the
   * database rather than by a read-then-write, exactly as `SecurityPolicyDbOperation`
   * describes:
   *
   *   UPDATE — `WHERE version = expected` matches nothing if another admin has written
   *     since, and `count === 0` is the loser's signal.
   *   INSERT — two admins both believing the row is absent both try to insert, and
   *     `ux_kyc_policies_target` refuses the second. `ON CONFLICT DO NOTHING` turns
   *     that into a zero count so the loser takes the same path.
   *
   * ─── Two traps specific to these tables ────────────────────────────────────
   *
   * `updated_at` is `DEFAULT now()` and deliberately NOT Prisma's `@updatedAt`,
   * because the writer is this service using raw SQL. A default fires on INSERT only,
   * and there is no trigger behind it — so the UPDATE must set it by hand or every
   * edit would report the creation time forever.
   *
   * `kyc_policy_versions` has no defaults for `version`, `enabled`, `required` or
   * `triggers_only`, so the history INSERT supplies them explicitly.
   *
   * ─── Why `::numeric` on every threshold ────────────────────────────────────
   *
   * Prisma binds a JS string as a `text` parameter. Assigning text to a `numeric`
   * column in `UPDATE ... SET` is SQLSTATE 42804. `NULL::numeric` is valid, so the
   * cast is safe when the value is absent. Same device as `${actorAdminId}::uuid`.
   */
  async upsert(input: KycPolicyWriteInput): Promise<KycPolicyWriteOutcome> {
    const {
      region,
      level,
      enabled,
      required,
      triggersOnly,
      workflowId,
      renewalWorkflowId,
      balanceThreshold,
      lifetimeDepositThreshold,
      lifetimeWithdrawalThreshold,
      rollingWindowAmount,
      rollingWindowSeconds,
      rollingWindowOperation,
      thresholdCurrency,
      features,
      subFeatures,
      reason,
      actorAdminId,
      expectedVersion,
    } = input;

    return this.prisma.$transaction(async (tx) => {
      // ═══ VERSIONS ARE CONTINUOUS ACROSS A TARGET'S WHOLE HISTORY ═══════════
      //
      // A create cannot simply start at 1. `kyc_policy_versions` is append-only and
      // survives a delete, so a target that was configured, removed and is now being
      // re-created ALREADY has versions 1..n on record. Writing 1 again violates
      // `ux_kyc_policy_versions_target (region, level, version)` and the whole
      // transaction fails — a 500 on an ordinary create, for a target whose only sin
      // is having existed before.
      //
      // So the create resumes from where the history left off. Numbering then means
      // "the nth configuration this target has ever had", and the tombstone sitting at
      // the previous number explains the gap rather than being overwritten by it.
      //
      // The UPDATE branch needs no such lookup: the live row's version is always the
      // highest recorded for its target, so `expectedVersion + 1` is already clear of
      // the history.
      //
      // Concurrency is unchanged. Two creates can compute the same next version; only
      // one wins `ON CONFLICT ("region","level")` on the live table, and only the
      // winner reaches the history append.
      const resumed =
        expectedVersion === 0
          ? await tx.$queryRaw<Array<{ next: number }>>`
              SELECT COALESCE(MAX("version"), 0) + 1 AS "next"
                FROM "identity"."kyc_policy_versions"
               WHERE "region" = ${region} AND "level" = ${level}`
          : null;

      const nextVersion = resumed === null ? expectedVersion + 1 : Number(resumed[0]?.next ?? 1);

      const written =
        expectedVersion === 0
          ? await tx.$executeRaw`
              INSERT INTO "identity"."kyc_policies"
                ("id", "region", "level", "enabled", "required", "triggers_only",
                 "workflow_id", "renewal_workflow_id",
                 "balance_threshold", "lifetime_deposit_threshold",
                 "lifetime_withdrawal_threshold", "rolling_window_amount",
                 "rolling_window_seconds", "rolling_window_operation", "threshold_currency",
                 "features", "sub_features",
                 "version", "updated_by_admin_id", "reason", "created_at", "updated_at")
              VALUES (gen_random_uuid(), ${region}, ${level}, ${enabled}, ${required},
                      ${triggersOnly}, ${workflowId}, ${renewalWorkflowId},
                      ${balanceThreshold}::numeric, ${lifetimeDepositThreshold}::numeric,
                      ${lifetimeWithdrawalThreshold}::numeric, ${rollingWindowAmount}::numeric,
                      ${rollingWindowSeconds}, ${rollingWindowOperation}, ${thresholdCurrency},
                      ${features as string[]}, ${subFeatures as string[]},
                      ${nextVersion}, ${actorAdminId}::uuid, ${reason}, now(), now())
              ON CONFLICT ("region", "level") DO NOTHING`
          : await tx.$executeRaw`
              UPDATE "identity"."kyc_policies"
                 SET "enabled" = ${enabled},
                     "required" = ${required},
                     "triggers_only" = ${triggersOnly},
                     "workflow_id" = ${workflowId},
                     "renewal_workflow_id" = ${renewalWorkflowId},
                     "balance_threshold" = ${balanceThreshold}::numeric,
                     "lifetime_deposit_threshold" = ${lifetimeDepositThreshold}::numeric,
                     "lifetime_withdrawal_threshold" = ${lifetimeWithdrawalThreshold}::numeric,
                     "rolling_window_amount" = ${rollingWindowAmount}::numeric,
                     "rolling_window_seconds" = ${rollingWindowSeconds},
                     "rolling_window_operation" = ${rollingWindowOperation},
                     "threshold_currency" = ${thresholdCurrency},
                     "features" = ${features as string[]},
                     "sub_features" = ${subFeatures as string[]},
                     "version" = ${nextVersion},
                     "updated_by_admin_id" = ${actorAdminId}::uuid,
                     "reason" = ${reason},
                     "updated_at" = now()
               WHERE "region" = ${region}
                 AND "level" = ${level}
                 AND "version" = ${expectedVersion}`;

      if (written !== 1) return this.losingOutcome(tx, region, level);

      // One number for both branches now: `nextVersion` is the resumed value on a
      // create and `expectedVersion + 1` on an update, so the live row and its history
      // row cannot disagree about which version this write produced.
      const version = nextVersion;

      await this.appendVersion(tx, {
        region,
        level,
        version,
        enabled,
        required,
        triggersOnly,
        workflowId,
        renewalWorkflowId,
        balanceThreshold,
        lifetimeDepositThreshold,
        lifetimeWithdrawalThreshold,
        rollingWindowAmount,
        rollingWindowSeconds,
        rollingWindowOperation,
        thresholdCurrency,
        features,
        subFeatures,
        reason,
        actorAdminId,
      });

      return { ok: true as const, version };
    });
  }

  /**
   * Remove a policy, recording a tombstone version.
   *
   * ═══ WHY DELETING IS A REAL OPERATION AND NOT A MISSING DISABLE ════════════
   *
   * The consumer resolves exact country, then global `*`, and a DISABLED country row
   * STILL WINS its region — precedence is a property of the key, not of the contents.
   * So switching a country policy off does not restore the global rule; only removing
   * the row does, and the consumer names exactly that: "Falling back to global is then
   * an explicit DELETE of the India row, which is visible in the version history."
   *
   * ─── The tombstone ─────────────────────────────────────────────────────────
   *
   * `kyc_policy_versions` is append-only, and a deletion that wrote nothing there
   * would leave a history whose newest row claims a policy is in force that no longer
   * exists. So the deletion appends one more version — same target, next number,
   * `enabled: false` — and the history stays a complete account of what applied when.
   * `updated_by_admin_id` and `reason` name who removed it and why.
   *
   * The same compare-and-swap as an update: removing a row somebody has edited since
   * is refused exactly as overwriting it would be.
   */
  async remove(input: {
    readonly region: string;
    readonly level: string;
    readonly reason: string;
    readonly actorAdminId: string;
    readonly expectedVersion: number;
  }): Promise<KycPolicyWriteOutcome> {
    const { region, level, reason, actorAdminId, expectedVersion } = input;

    return this.prisma.$transaction(async (tx) => {
      // Read the row being removed, so the tombstone can carry what it actually held
      // rather than a row of nulls that would misreport the final state.
      const existing = await tx.$queryRaw<KycPolicyRow[]>`
        SELECT ${POLICY_COLUMNS}, "updated_at"
          FROM "identity"."kyc_policies"
         WHERE "region" = ${region} AND "level" = ${level}`;

      const written = await tx.$executeRaw`
        DELETE FROM "identity"."kyc_policies"
         WHERE "region" = ${region}
           AND "level" = ${level}
           AND "version" = ${expectedVersion}`;

      if (written !== 1) return this.losingOutcome(tx, region, level);

      const previous = existing[0];
      const version = expectedVersion + 1;

      await this.appendVersion(tx, {
        region,
        level,
        version,
        // The tombstone records the policy as OFF, whatever it was, because that is
        // what the removal means for anyone reading the history.
        enabled: false,
        required: previous?.required ?? false,
        triggersOnly: previous?.triggers_only ?? false,
        workflowId: previous?.workflow_id ?? null,
        renewalWorkflowId: previous?.renewal_workflow_id ?? null,
        balanceThreshold: previous?.balance_threshold ?? null,
        lifetimeDepositThreshold: previous?.lifetime_deposit_threshold ?? null,
        lifetimeWithdrawalThreshold: previous?.lifetime_withdrawal_threshold ?? null,
        rollingWindowAmount: previous?.rolling_window_amount ?? null,
        rollingWindowSeconds: previous?.rolling_window_seconds ?? null,
        rollingWindowOperation: previous?.rolling_window_operation ?? null,
        thresholdCurrency: previous?.threshold_currency ?? null,
        features: previous?.features ?? [],
        subFeatures: previous?.sub_features ?? [],
        reason,
        actorAdminId,
      });

      return { ok: true as const, version };
    });
  }

  /**
   * The history for one target, newest first.
   *
   * Read-only and append-only — there is deliberately no update or delete here. The
   * schema states that immutability is a service contract rather than a database
   * constraint, and this file is where that contract is kept: nothing in this service
   * can mutate a history row because no method exists to.
   */
  async history(
    region: string,
    level: string,
    limit: number,
  ): Promise<readonly KycPolicyVersionRow[]> {
    return this.prisma.$queryRaw<KycPolicyVersionRow[]>`
      SELECT ${POLICY_COLUMNS}, "created_at" AS "recorded_at"
        FROM "identity"."kyc_policy_versions"
       WHERE "region" = ${region} AND "level" = ${level}
       ORDER BY "version" DESC
       LIMIT ${Prisma.raw(String(Math.max(1, Math.min(200, Math.trunc(limit)))))}`;
  }

  /**
   * What to report when a conditional write matched nothing.
   *
   * `currentVersion: 0` genuinely means "no row", which the service renders as a
   * different instruction from a stale read — the precedent reports "it is now at
   * version 0" for this case, which is not a version anything ever had.
   */
  private async losingOutcome(
    tx: Prisma.TransactionClient,
    region: string,
    level: string,
  ): Promise<KycPolicyWriteOutcome> {
    const rows = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT "version" FROM "identity"."kyc_policies"
       WHERE "region" = ${region} AND "level" = ${level}`;
    return { ok: false as const, currentVersion: rows[0]?.version ?? 0 };
  }

  /**
   * Append one history row.
   *
   * Deliberately carries NO `ON CONFLICT`. If `ux_kyc_policy_versions_target` ever
   * fired here it would mean the live row's version had gone backwards — an invariant
   * violation that should surface as a loud failure, not a silently swallowed zero.
   */
  private async appendVersion(
    tx: Prisma.TransactionClient,
    row: Omit<KycPolicyWriteInput, 'expectedVersion'> & { readonly version: number },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "identity"."kyc_policy_versions"
        ("id", "region", "level", "version", "enabled", "required", "triggers_only",
         "workflow_id", "renewal_workflow_id",
         "balance_threshold", "lifetime_deposit_threshold",
         "lifetime_withdrawal_threshold", "rolling_window_amount",
         "rolling_window_seconds", "rolling_window_operation", "threshold_currency",
         "features", "sub_features",
         "updated_by_admin_id", "reason", "created_at")
      VALUES (gen_random_uuid(), ${row.region}, ${row.level}, ${row.version},
              ${row.enabled}, ${row.required}, ${row.triggersOnly},
              ${row.workflowId}, ${row.renewalWorkflowId},
              ${row.balanceThreshold}::numeric, ${row.lifetimeDepositThreshold}::numeric,
              ${row.lifetimeWithdrawalThreshold}::numeric, ${row.rollingWindowAmount}::numeric,
              ${row.rollingWindowSeconds}, ${row.rollingWindowOperation},
              ${row.thresholdCurrency},
              ${row.features as string[]}, ${row.subFeatures as string[]},
              ${row.actorAdminId}::uuid, ${row.reason}, now())`;
  }
}
