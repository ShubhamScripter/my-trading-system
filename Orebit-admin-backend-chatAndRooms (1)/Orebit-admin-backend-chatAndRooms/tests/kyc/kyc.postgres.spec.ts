import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { KycExemptionDbOperation } from '../../src/kyc/kyc-exemption.dboperation';
import { KycPolicyDbOperation } from '../../src/kyc/kyc-policy.dboperation';
import { KycRequirementDbOperation } from '../../src/kyc/kyc-requirement.dboperation';
import { databaseNameOf, prismaFor } from '../db/pg';
import { CONSTRAINT_CASES, VALID_POLICY } from './kyc.cases';

/**
 * The KYC writers against a REAL PostgreSQL.
 *
 * ═══ WHAT A DOUBLE CANNOT TELL YOU ═════════════════════════════════════════
 *
 * Everything asserted here is a property of the database, not of this code:
 *
 *   · whether `ON CONFLICT ("user_id") WHERE "revoked_at" IS NULL` actually INFERS the
 *     partial unique index — a bare conflict target raises "no unique or exclusion
 *     constraint matching the ON CONFLICT specification" at runtime and would pass
 *     every mocked test ever written;
 *   · whether the `::numeric` casts are needed and sufficient;
 *   · whether `updated_at` really moves, given the column is `DEFAULT now()` with no
 *     trigger and no Prisma `@updatedAt` behind it;
 *   · whether each CHECK constraint the DTO mirrors is actually live;
 *   · what two concurrent writers do to one row.
 *
 * ─── The schema comes from the consumer's OWN migrations ───────────────────
 *
 * Not a hand-written copy. `identity` is owned by ../Orebit-backend, so this applies
 * THAT repository's migration SQL — every `db/migrations/*` in order, then
 * `db/sql/identity.sql` — to the disposable test database. Real tables, real CHECK
 * constraints, real partial indexes, real foreign keys, and nothing here to drift
 * from them. See `ensureIdentitySchema` for why Prisma's migrate is not used.
 *
 * ─── It SKIPS rather than fails ────────────────────────────────────────────
 *
 * No Postgres, or no sibling checkout, and this suite skips: both are facts about the
 * checkout rather than defects, and `npm test` must stay runnable on a laptop and in
 * CI. `OREBIT_PG_TESTS=1` already turns an unreachable server into a hard failure.
 */

const CONSUMER = join(__dirname, '..', '..', '..', 'Orebit-backend');
const CONSUMER_MIGRATIONS = join(CONSUMER, 'db', 'migrations');
const CONSUMER_IDENTITY_SQL = join(CONSUMER, 'db', 'sql', 'identity.sql');

const pgAvailable = inject('pgAvailable');
const pgUrl = pgAvailable ? inject('pgUrl') : '';
const siblingPresent = existsSync(CONSUMER_MIGRATIONS) && existsSync(CONSUMER_IDENTITY_SQL);
const enabled = pgAvailable && siblingPresent;

if (pgAvailable && !siblingPresent) {
  // eslint-disable-next-line no-console
  console.warn(`[kyc pg] ${CONSUMER} not found — identity-schema specs SKIP.`);
}

/**
 * Create the consumer's `identity` schema in the disposable database.
 *
 * ═══ THE REAL MIGRATION SQL, BUT NOT PRISMA'S MIGRATE ══════════════════════
 *
 * The DDL is the consumer's own — every `db/migrations/*\/migration.sql` in order,
 * then `db/sql/identity.sql` for the partial indexes and CHECK constraints Prisma
 * cannot express. So there is no hand-written copy here to drift from the real schema,
 * which is the whole point.
 *
 * What is deliberately NOT reused is `prisma migrate deploy`. Both services keep a
 * `_prisma_migrations` bookkeeping table, and pointing the consumer's migrate at this
 * database makes the two histories collide — the admin's next `migrate deploy` then
 * finds a foreign, half-applied migration and refuses to run at all (P3009), which
 * breaks every other database spec in this repository. Executing the SQL directly
 * touches no bookkeeping and leaves this service's history exactly as it found it.
 *
 * Idempotent by a presence check rather than by `IF NOT EXISTS` everywhere: the
 * consumer's SQL is written for a fresh database, and re-running it would fail on the
 * first `CREATE TYPE`.
 */
async function ensureIdentitySchema(db: Client): Promise<void> {
  // Guard against a misconfigured OREBIT_TEST_PG_* pointing somewhere real. This
  // creates tables; it must only ever do so in the throwaway.
  const name = databaseNameOf(pgUrl);
  if (name !== 'orebit_test') {
    throw new Error(`refusing to create the identity schema in "${name}"; expected orebit_test`);
  }

  const { rowCount } = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'identity' AND table_name = 'kyc_policies'`,
  );
  if (rowCount !== null && rowCount > 0) return;

  const root = CONSUMER_MIGRATIONS;
  const migrations = readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .sort();

  for (const migration of migrations) {
    const file = join(root, migration, 'migration.sql');
    if (existsSync(file)) await db.query(readFileSync(file, 'utf8'));
  }

  await db.query(readFileSync(CONSUMER_IDENTITY_SQL, 'utf8'));
}

let client: Client;
let policies: KycPolicyDbOperation;
let exemptions: KycExemptionDbOperation;
let requirements: KycRequirementDbOperation;

/** A region nobody else is using. Spec files run in parallel and the precedent rules
 *  out truncation between tests, so isolation is by unique key instead. */
const regions: string[] = [];
function uniqueRegion(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const region = `${letters[Math.floor(Math.random() * 26)]}${letters[Math.floor(Math.random() * 26)]}`;
  regions.push(region);
  return region;
}

const users: string[] = [];
async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower,
                                email, email_lower, status, referral_code, registered_at)
     VALUES ($1, $2, $2, $3, $3, $4, $4, 'ACTIVE', $5, now())`,
    [id, `KYCT${id.slice(0, 8)}`, `kyct_${id.slice(0, 8)}`, `${id.slice(0, 8)}@kyc.test`, id.slice(0, 8)],
  );
  users.push(id);
  return id;
}

beforeAll(async () => {
  if (!enabled) return;

  client = new Client({ connectionString: pgUrl });
  await client.connect();
  await ensureIdentitySchema(client);

  const prisma = prismaFor(pgUrl, 'kyc-postgres-spec');
  policies = new KycPolicyDbOperation(prisma as never);
  exemptions = new KycExemptionDbOperation(prisma as never);
  requirements = new KycRequirementDbOperation(prisma as never);
}, 180_000);

afterEach(async () => {
  if (!enabled) return;
  // Keyed cleanup rather than TRUNCATE: other spec files may be running.
  for (const region of regions.splice(0)) {
    await client.query('DELETE FROM identity.kyc_policies WHERE region = $1', [region]);
    await client.query('DELETE FROM identity.kyc_policy_versions WHERE region = $1', [region]);
  }
  // Exemptions cascade from the account.
  for (const id of users.splice(0)) {
    await client.query('DELETE FROM identity.users WHERE id = $1', [id]);
  }
});

afterAll(async () => {
  // Guarded on the client rather than on `enabled`: if `beforeAll` threw partway
  // through, `enabled` is still true but there is no connection to close, and the
  // resulting TypeError would replace the real failure in the output.
  if (client !== undefined) await client.end();
});

const ADMIN = '0195f0a0-aaaa-7000-8000-000000000001';

function writeInput(region: string, overrides: Record<string, unknown> = {}) {
  return {
    region,
    level: 'L1',
    enabled: true,
    required: true,
    triggersOnly: false,
    workflowId: null,
    renewalWorkflowId: null,
    balanceThreshold: null,
    lifetimeDepositThreshold: null,
    lifetimeWithdrawalThreshold: null,
    rollingWindowAmount: null,
    rollingWindowSeconds: null,
    rollingWindowOperation: null,
    thresholdCurrency: null,
    features: [] as string[],
    subFeatures: [] as string[],
    reason: 'Test policy.',
    actorAdminId: ADMIN,
    expectedVersion: 0,
    ...overrides,
  };
}

describe.skipIf(!enabled)('policy writes against a real database', () => {
  it('creates a policy and its first history row in one transaction', async () => {
    const region = uniqueRegion();
    const outcome = await policies.upsert(writeInput(region));

    expect(outcome).toEqual({ ok: true, version: 1 });

    const live = await client.query(
      'SELECT version, enabled FROM identity.kyc_policies WHERE region = $1',
      [region],
    );
    const history = await client.query(
      'SELECT version FROM identity.kyc_policy_versions WHERE region = $1',
      [region],
    );
    expect(live.rowCount).toBe(1);
    expect(history.rowCount).toBe(1);
    expect(history.rows[0].version).toBe(1);
  });

  it('refuses a second create for the same target, via ux_kyc_policies_target', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));

    // `ON CONFLICT DO NOTHING` turns the duplicate-key into a zero row count, so the
    // loser takes the same path as a lost UPDATE and the caller has one case.
    expect(await policies.upsert(writeInput(region))).toEqual({ ok: false, currentVersion: 1 });
  });

  it('updates on a matching expectedVersion and appends the next history row', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));

    const outcome = await policies.upsert(
      writeInput(region, { expectedVersion: 1, enabled: false, reason: 'Paused.' }),
    );

    expect(outcome).toEqual({ ok: true, version: 2 });
    const history = await client.query(
      'SELECT version, enabled FROM identity.kyc_policy_versions WHERE region = $1 ORDER BY version',
      [region],
    );
    expect(history.rows.map((r: { version: number }) => r.version)).toEqual([1, 2]);
    expect(history.rows[1].enabled).toBe(false);
  });

  it('refuses an update whose expectedVersion is stale', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));
    await policies.upsert(writeInput(region, { expectedVersion: 1 }));

    expect(await policies.upsert(writeInput(region, { expectedVersion: 1 }))).toEqual({
      ok: false,
      currentVersion: 2,
    });
  });

  it('reports currentVersion 0 when there is no row to update', async () => {
    expect(await policies.upsert(writeInput(uniqueRegion(), { expectedVersion: 5 }))).toEqual({
      ok: false,
      currentVersion: 0,
    });
  });

  /**
   * The trap the column's own schema comment warns about: `updated_at` is
   * `DEFAULT now()` and deliberately NOT Prisma's `@updatedAt`, because the writer is
   * this service using raw SQL. A default fires on INSERT only. Miss the explicit
   * assignment and every edit reports the creation time forever.
   */
  it('moves updated_at on an update while leaving created_at alone', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));
    const before = await client.query(
      'SELECT created_at, updated_at FROM identity.kyc_policies WHERE region = $1',
      [region],
    );

    await new Promise((resolve) => setTimeout(resolve, 15));
    await policies.upsert(writeInput(region, { expectedVersion: 1 }));

    const after = await client.query(
      'SELECT created_at, updated_at FROM identity.kyc_policies WHERE region = $1',
      [region],
    );
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(
      before.rows[0].updated_at.getTime(),
    );
    expect(after.rows[0].created_at.getTime()).toBe(before.rows[0].created_at.getTime());
  });

  /** Proves the `::numeric` casts, and that a value beyond float64 survives intact. */
  it('round-trips a decimal at the full precision the column holds', async () => {
    const region = uniqueRegion();
    const amount = '12345678901234567890.123456789012345678';

    await policies.upsert(
      writeInput(region, { balanceThreshold: amount, thresholdCurrency: 'USD' }),
    );

    const [row] = await policies.list().then((rows) => rows.filter((r) => r.region === region));
    expect(row?.balance_threshold).toBe(amount);
  });

  it('stores an array column the consumer can split', async () => {
    const region = uniqueRegion();
    await policies.upsert(
      writeInput(region, { features: ['wallet'], subFeatures: ['wallet/withdraw'] }),
    );

    const [row] = await policies.list().then((rows) => rows.filter((r) => r.region === region));
    expect(row?.features).toEqual(['wallet']);
    expect(row?.sub_features).toEqual(['wallet/withdraw']);
  });

  it('returns history newest-first, bounded by the limit', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));
    await policies.upsert(writeInput(region, { expectedVersion: 1 }));
    await policies.upsert(writeInput(region, { expectedVersion: 2 }));

    const history = await policies.history(region, 'L1', 2);
    expect(history.map((row) => row.version)).toEqual([3, 2]);
  });
});

describe.skipIf(!enabled)('removing a policy', () => {
  it('deletes the row and appends a tombstone version', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));

    const outcome = await policies.remove({
      region,
      level: 'L1',
      reason: 'Back to the global rule.',
      actorAdminId: ADMIN,
      expectedVersion: 1,
    });

    expect(outcome).toEqual({ ok: true, version: 2 });

    const live = await client.query('SELECT 1 FROM identity.kyc_policies WHERE region = $1', [
      region,
    ]);
    expect(live.rowCount).toBe(0);

    // The history must still explain what was in force and when it stopped.
    const history = await client.query(
      'SELECT version, enabled, reason FROM identity.kyc_policy_versions WHERE region = $1 ORDER BY version',
      [region],
    );
    expect(history.rows.map((r: { version: number }) => r.version)).toEqual([1, 2]);
    expect(history.rows[1].enabled).toBe(false);
    expect(history.rows[1].reason).toBe('Back to the global rule.');
  });

  /**
   * ═══ RE-CREATING A TARGET THAT HAS BEEN DELETED BEFORE ═════════════════════
   *
   * The regression this exists for, found by using the API rather than by a test:
   * `kyc_policy_versions` is append-only and survives a delete, so a target that was
   * configured, removed and is being created again already has versions 1..n on
   * record. Starting the new row at 1 violates `ux_kyc_policy_versions_target` and the
   * transaction fails — a 500 on an ordinary create.
   *
   * Every other spec here uses a fresh random region, so none of them crossed a delete
   * with a re-create. This one deliberately does.
   */
  it('re-creates a deleted target, resuming its version numbering', async () => {
    const region = uniqueRegion();

    await policies.upsert(writeInput(region));                              // v1
    await policies.upsert(writeInput(region, { expectedVersion: 1 }));      // v2
    await policies.remove({
      region, level: 'L1', reason: 'Removed.', actorAdminId: ADMIN, expectedVersion: 2,
    });                                                                     // v3 tombstone

    // The live table is empty for this target, so the client legitimately sends 0.
    const recreated = await policies.upsert(writeInput(region));

    expect(recreated).toEqual({ ok: true, version: 4 });

    const live = await client.query(
      'SELECT version FROM identity.kyc_policies WHERE region = $1',
      [region],
    );
    expect(live.rows[0].version).toBe(4);

    // And the history is one unbroken run, with the tombstone still explaining the gap.
    const history = await client.query(
      'SELECT version, enabled FROM identity.kyc_policy_versions WHERE region = $1 ORDER BY version',
      [region],
    );
    expect(history.rows.map((r: { version: number }) => r.version)).toEqual([1, 2, 3, 4]);
    expect(history.rows[2].enabled).toBe(false);
  });

  it('keeps updating cleanly after a re-create', async () => {
    // The follow-on: the live row is at 4, so the next edit must send 4 and land at 5.
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));
    await policies.remove({
      region, level: 'L1', reason: 'Removed.', actorAdminId: ADMIN, expectedVersion: 1,
    });
    const recreated = await policies.upsert(writeInput(region));
    expect(recreated).toEqual({ ok: true, version: 3 });

    expect(await policies.upsert(writeInput(region, { expectedVersion: 3 }))).toEqual({
      ok: true,
      version: 4,
    });
  });

  it('refuses a removal whose expectedVersion is stale', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));

    expect(
      await policies.remove({
        region,
        level: 'L1',
        reason: 'x',
        actorAdminId: ADMIN,
        expectedVersion: 9,
      }),
    ).toEqual({ ok: false, currentVersion: 1 });
  });
});

/**
 * ═══ THE PARITY CHECK ══════════════════════════════════════════════════════
 *
 * The same table that drives the DTO spec, asserted from the other side: a direct
 * INSERT of each bad value must be refused by the constraint the DTO claims to mirror.
 * A CHECK added in the consumer without a rule here fails in this repository.
 */
describe.skipIf(!enabled)('every constraint the DTO mirrors is live', () => {
  const COLUMN: Record<string, string> = {
    balanceThreshold: 'balance_threshold',
    lifetimeDepositThreshold: 'lifetime_deposit_threshold',
    lifetimeWithdrawalThreshold: 'lifetime_withdrawal_threshold',
    rollingWindowAmount: 'rolling_window_amount',
    rollingWindowSeconds: 'rolling_window_seconds',
    rollingWindowOperation: 'rolling_window_operation',
    thresholdCurrency: 'threshold_currency',
    region: 'region',
    level: 'level',
  };

  it.each(CONSTRAINT_CASES.map((c) => [c.name, c] as const))(
    'the database refuses %s',
    async (_name, testCase) => {
      const region = uniqueRegion();
      const values: Record<string, unknown> = {
        region,
        level: 'L1',
        enabled: true,
        required: true,
        triggers_only: false,
        version: 1,
      };

      // Map the DTO patch onto columns; `insert` overrides where the names differ.
      for (const [field, value] of Object.entries(testCase.patch)) {
        const column = COLUMN[field];
        if (column !== undefined) values[column] = value;
      }
      Object.assign(values, testCase.insert ?? {});

      const columns = Object.keys(values);
      const placeholders = columns.map((_, index) => `$${index + 1}`);

      const failure = await client
        .query(
          `INSERT INTO identity.kyc_policies (id, ${columns.join(', ')}, created_at, updated_at)
           VALUES (gen_random_uuid(), ${placeholders.join(', ')}, now(), now())`,
          Object.values(values),
        )
        .then(() => null)
        .catch((err: { code?: string; constraint?: string }) => err);

      expect(failure, `expected the insert to be refused: ${testCase.name}`).not.toBeNull();
      expect(failure?.code, `expected a CHECK violation for: ${testCase.name}`).toBe('23514');
      expect(failure?.constraint).toBe(testCase.constraint);
    },
  );
});

/**
 * ═══ A GAP IN THE CONSUMER'S CONSTRAINT, PINNED RATHER THAN WORKED AROUND ══
 *
 * `ck_kyc_policies_rolling_window_complete` does NOT refuse an amount and a period
 * with a NULL operation, because the second arm contains `operation IN (...)`, which
 * is UNKNOWN for NULL — and a CHECK constraint refuses only on FALSE.
 *
 * So that row is storable, and the consumer's `narrowPolicy` then silently discards it
 * as `incomplete_rolling_window`: a policy an operator configured, sitting in the
 * table, enforcing nothing.
 *
 * This is asserted rather than fixed. The constraint belongs to ../Orebit-backend and
 * changing another service's schema is outside this phase — but the behaviour is now
 * recorded, and if it is ever tightened this test says so.
 *
 * Two consequences worth stating: the DTO's rolling-window rule is the ONLY thing
 * preventing this through the API, and `enforcementRejectionOf` has a genuinely
 * reachable case rather than being pure redundancy.
 */
describe.skipIf(!enabled)('a known gap in the rolling-window constraint', () => {
  it('stores an incomplete rolling window that the consumer will then discard', async () => {
    const region = uniqueRegion();

    await client.query(
      `INSERT INTO identity.kyc_policies
         (id, region, level, enabled, required, triggers_only, version,
          rolling_window_amount, rolling_window_seconds, threshold_currency,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'L1', true, true, false, 1,
               1000, 86400, 'USD', now(), now())`,
      [region],
    );

    const stored = await client.query(
      'SELECT rolling_window_operation FROM identity.kyc_policies WHERE region = $1',
      [region],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].rolling_window_operation).toBeNull();
  });

  it('the three variants that DO make the expression false are refused', async () => {
    // Each of these makes the CHECK evaluate to FALSE rather than UNKNOWN, which is
    // the difference between a refused row and an accepted one.
    const variants: ReadonlyArray<readonly [string, string]> = [
      ['rolling_window_seconds', 'null-period'],
      ['rolling_window_amount', 'null-amount'],
    ];

    for (const [omitted] of variants) {
      const region = uniqueRegion();
      const columns: Record<string, unknown> = {
        region,
        level: 'L1',
        enabled: true,
        required: true,
        triggers_only: false,
        version: 1,
        rolling_window_amount: 1000,
        rolling_window_seconds: 86_400,
        rolling_window_operation: 'WITHDRAWAL',
        threshold_currency: 'USD',
      };
      delete columns[omitted];

      const names = Object.keys(columns);
      const failure = await client
        .query(
          `INSERT INTO identity.kyc_policies (id, ${names.join(', ')}, created_at, updated_at)
           VALUES (gen_random_uuid(), ${names.map((_, i) => `$${i + 1}`).join(', ')}, now(), now())`,
          Object.values(columns),
        )
        .then(() => null)
        .catch((err: { constraint?: string }) => err);

      expect(failure?.constraint).toBe('ck_kyc_policies_rolling_window_complete');
    }
  });
});

describe.skipIf(!enabled)('exemptions against a real database', () => {
  it('grants, and the row reads as live', async () => {
    const userId = await seedUser();

    const outcome = await exemptions.grant({
      userId,
      effectiveLevel: 'L1',
      reason: 'Test grant.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });

    expect(outcome).toMatchObject({ ok: true, supersededExpired: false });
    const [row] = await exemptions.listForUser(userId, 10);
    expect(row?.live).toBe(true);
  });

  it('answers unknown_user rather than raising a foreign-key error', async () => {
    expect(
      await exemptions.grant({
        userId: crypto.randomUUID(),
        effectiveLevel: 'L1',
        reason: 'x',
        expiresAt: null,
        actorAdminId: ADMIN,
      }),
    ).toEqual({ ok: false, reason: 'unknown_user' });
  });

  /**
   * THE assertion this suite exists for.
   *
   * `ON CONFLICT ("user_id") WHERE "revoked_at" IS NULL` has to infer a PARTIAL unique
   * index. Get the predicate wrong and Postgres raises "no unique or exclusion
   * constraint matching the ON CONFLICT specification" — a runtime failure no mocked
   * test could ever see.
   */
  it('refuses a second live grant through the partial unique index', async () => {
    const userId = await seedUser();
    await exemptions.grant({
      userId,
      effectiveLevel: 'L1',
      reason: 'First.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });

    expect(
      await exemptions.grant({
        userId,
        effectiveLevel: 'L2',
        reason: 'Second.',
        expiresAt: null,
        actorAdminId: ADMIN,
      }),
    ).toEqual({ ok: false, reason: 'already_exempt' });
  });

  /**
   * The expired-slot trap, end to end.
   *
   * The index counts an expired-but-unrevoked row as occupying the account's slot;
   * the consumer's reader does not count it as granting anything. Without the closing
   * step, this account could never be granted relief again.
   */
  it('grants over a LAPSED exemption, closing the dead row first', async () => {
    const userId = await seedUser();
    await client.query(
      `INSERT INTO identity.kyc_exemptions
         (id, user_id, effective_level, reason, granted_by, granted_at, expires_at, created_at)
       VALUES (gen_random_uuid(), $1, 'L1', 'Lapsed.', $2, now() - interval '2 days',
               now() - interval '1 day', now())`,
      [userId, ADMIN],
    );

    const outcome = await exemptions.grant({
      userId,
      effectiveLevel: 'L2',
      reason: 'Replacement.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });

    expect(outcome).toMatchObject({ ok: true, supersededExpired: true });

    const rows = await exemptions.listForUser(userId, 10);
    expect(rows.filter((row) => row.live)).toHaveLength(1);
    expect(rows.find((row) => !row.live)?.revoke_reason).toContain('Expired exemption closed');
  });

  it('revokes, and the row stops reading as live', async () => {
    const userId = await seedUser();
    const granted = await exemptions.grant({
      userId,
      effectiveLevel: 'L1',
      reason: 'Test.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });
    const id = (granted as { id: string }).id;

    expect(
      await exemptions.revoke({ userId, exemptionId: id, reason: 'Done.', actorAdminId: ADMIN }),
    ).toEqual({ ok: true });

    const [row] = await exemptions.listForUser(userId, 10);
    expect(row?.live).toBe(false);
  });

  it('reports a second revoke as already_revoked', async () => {
    const userId = await seedUser();
    const granted = await exemptions.grant({
      userId,
      effectiveLevel: 'L1',
      reason: 'Test.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });
    const id = (granted as { id: string }).id;
    await exemptions.revoke({ userId, exemptionId: id, reason: 'Done.', actorAdminId: ADMIN });

    const second = await exemptions.revoke({
      userId,
      exemptionId: id,
      reason: 'Again.',
      actorAdminId: ADMIN,
    });
    expect(second).toMatchObject({ ok: false, reason: 'already_revoked' });
  });

  it('will not revoke another account’s exemption, and says not_found', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const granted = await exemptions.grant({
      userId: owner,
      effectiveLevel: 'L1',
      reason: 'Test.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });

    expect(
      await exemptions.revoke({
        userId: other,
        exemptionId: (granted as { id: string }).id,
        reason: 'Nope.',
        actorAdminId: ADMIN,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('frees the slot once revoked, so a replacement can be granted', async () => {
    const userId = await seedUser();
    const granted = await exemptions.grant({
      userId,
      effectiveLevel: 'L1',
      reason: 'First.',
      expiresAt: null,
      actorAdminId: ADMIN,
    });
    await exemptions.revoke({
      userId,
      exemptionId: (granted as { id: string }).id,
      reason: 'Replacing.',
      actorAdminId: ADMIN,
    });

    expect(
      await exemptions.grant({
        userId,
        effectiveLevel: 'L2',
        reason: 'Second.',
        expiresAt: null,
        actorAdminId: ADMIN,
      }),
    ).toMatchObject({ ok: true });
  });
});

/**
 * Two writers, two clients.
 *
 * A second `KycPolicyDbOperation` on its OWN Prisma client, because that is what two
 * admins actually are — two processes, two pools. Running both interactive
 * transactions through one client makes them compete for that client's connections,
 * and on a small pool the loser dies with "Unable to start a transaction in the given
 * time" — a property of the pool, not of the row contention under test.
 */
let policiesB: KycPolicyDbOperation;
let exemptionsB: KycExemptionDbOperation;

beforeAll(() => {
  if (!enabled) return;
  const prismaB = prismaFor(pgUrl, 'kyc-postgres-spec-b');
  policiesB = new KycPolicyDbOperation(prismaB as never);
  exemptionsB = new KycExemptionDbOperation(prismaB as never);
});

describe.skipIf(!enabled)('concurrency', () => {
  /** Two admins both believing the row is absent. Exactly one may win. */
  it('lets exactly one of two simultaneous creates through', async () => {
    const region = uniqueRegion();

    const [first, second] = await Promise.all([
      policies.upsert(writeInput(region)),
      policiesB.upsert(writeInput(region)),
    ]);

    const winners = [first, second].filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);

    const rows = await client.query('SELECT version FROM identity.kyc_policies WHERE region = $1', [
      region,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('lets exactly one of two simultaneous updates through', async () => {
    const region = uniqueRegion();
    await policies.upsert(writeInput(region));

    const [first, second] = await Promise.all([
      policies.upsert(writeInput(region, { expectedVersion: 1, reason: 'A' })),
      policiesB.upsert(writeInput(region, { expectedVersion: 1, reason: 'B' })),
    ]);

    expect([first, second].filter((outcome) => outcome.ok)).toHaveLength(1);

    // And the history did not record version 2 twice.
    const history = await client.query(
      'SELECT version FROM identity.kyc_policy_versions WHERE region = $1',
      [region],
    );
    expect(history.rowCount).toBe(2);
  });

  it('lets exactly one of two simultaneous grants through', async () => {
    const userId = await seedUser();

    const outcomes = await Promise.all([
      exemptions.grant({
        userId,
        effectiveLevel: 'L1',
        reason: 'A',
        expiresAt: null,
        actorAdminId: ADMIN,
      }),
      exemptionsB.grant({
        userId,
        effectiveLevel: 'L2',
        reason: 'B',
        expiresAt: null,
        actorAdminId: ADMIN,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await exemptions.listForUser(userId, 10)).filter((row) => row.live)).toHaveLength(1);
  });
});

describe.skipIf(!enabled)('manual KYC obligations, against a real database', () => {
  /**
   * ═══ WHAT ONLY A REAL DATABASE PROVES HERE ═════════════════════════════════
   *
   *   · that `ON CONFLICT ("user_id", "trigger_key") WHERE "satisfied_at" IS NULL AND
   *     "waived_at" IS NULL` actually INFERS `ux_kyc_requirements_open`. A bare
   *     conflict target raises "no unique or exclusion constraint matching the
   *     ON CONFLICT specification" at runtime and passes every mocked test;
   *   · that `updated_at` is set by hand — the column has no default and no trigger on
   *     this table, because the consumer declares it `@updatedAt` and Prisma maintains
   *     that only on writes Prisma performs;
   *   · that the CHECK on `required_level` is live;
   *   · what two concurrent writers do to one obligation.
   */

  const REFERENCE = 'CASE-4182';
  const KEY = `ADMIN:${REFERENCE}`;

  it('creates a fresh obligation and reports it as created', async () => {
    const userId = await seedUser();

    const outcome = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.created).toBe(true);
    expect(outcome.row).toMatchObject({
      user_id: userId,
      required_level: 'L1',
      trigger_kind: 'ADMIN',
      trigger_key: KEY,
      satisfied_at: null,
      waived_at: null,
      // Null for every ADMIN row — the cause was a human decision, not a policy.
      policy_region: null,
      policy_version: null,
      open: true,
    });
    // Set by hand; the column has no default on this table.
    expect(outcome.row.updated_at).toBeInstanceOf(Date);
  });

  it('ADOPTS the existing row on a repeat, without creating a second', async () => {
    const userId = await seedUser();
    const first = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    const second = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await requirements.listForUser(userId, 10)).toHaveLength(1);
  });

  it('keeps two references as two independent obligations', async () => {
    const userId = await seedUser();
    await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: 'ADMIN:CASE-A',
    });
    await requirements.require({
      userId,
      requiredLevel: 'L2',
      triggerKind: 'ADMIN',
      triggerKey: 'ADMIN:CASE-B',
    });

    expect(await requirements.listForUser(userId, 10)).toHaveLength(2);
  });

  it('refuses an account that does not exist, without a foreign-key error', async () => {
    // Probed rather than caught: a 23503 inside an interactive transaction has already
    // aborted it, so every later statement would fail with 25P02.
    const outcome = await requirements.require({
      userId: crypto.randomUUID(),
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });

    expect(outcome).toEqual({ ok: false, reason: 'unknown_user' });
  });

  it('refuses a level the CHECK constraint does not permit', async () => {
    // `ck_kyc_requirements_level` is live. The DTO refuses this first; this proves the
    // database would too, which is what protects a hand-written INSERT in psql.
    const userId = await seedUser();

    await expect(
      requirements.require({
        userId,
        requiredLevel: 'NONE',
        triggerKind: 'ADMIN',
        triggerKey: KEY,
      }),
    ).rejects.toThrow();
  });

  it('waives an open obligation, recording who and when', async () => {
    const userId = await seedUser();
    const created = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const outcome = await requirements.waive({
      userId,
      requirementId: created.row.id,
      actorAdminId: ADMIN,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.row.waived_at).toBeInstanceOf(Date);
    expect(outcome.row.waived_by).toBe(ADMIN);
    // Discharged by a human, so NOT satisfied — the two must never both be set.
    expect(outcome.row.satisfied_at).toBeNull();
    expect(outcome.row.open).toBe(false);
  });

  it('refuses a SECOND waiver and leaves the first waiver untouched', async () => {
    const userId = await seedUser();
    const created = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    if (!created.ok) return;

    const first = await requirements.waive({
      userId,
      requirementId: created.row.id,
      actorAdminId: ADMIN,
    });
    if (!first.ok) return;

    const OTHER_ADMIN = crypto.randomUUID();
    const second = await requirements.waive({
      userId,
      requirementId: created.row.id,
      actorAdminId: OTHER_ADMIN,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_closed');

    // The original waiver stands: the conditional WHERE is what guarantees a second
    // writer cannot overwrite the record of who lifted the obligation.
    const [row] = await requirements.listForUser(userId, 10);
    expect(row?.waived_by).toBe(ADMIN);
    expect(row?.waived_at?.getTime()).toBe(first.row.waived_at?.getTime());
  });

  it('answers not_found for a requirement belonging to another account', async () => {
    // Deliberately indistinguishable from "no such requirement", so this is not an
    // oracle for enumerating requirement ids.
    const owner = await seedUser();
    const stranger = await seedUser();
    const created = await requirements.require({
      userId: owner,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    if (!created.ok) return;

    expect(
      await requirements.waive({
        userId: stranger,
        requirementId: created.row.id,
        actorAdminId: ADMIN,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });

    expect(
      await requirements.waive({
        userId: stranger,
        requirementId: crypto.randomUUID(),
        actorAdminId: ADMIN,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('cannot waive an obligation an approved verification already discharged', async () => {
    const userId = await seedUser();
    const created = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    if (!created.ok) return;

    // What `satisfyRequirements` does in the consumer, inside the approval transaction.
    await client.query(
      `UPDATE identity.kyc_requirements SET satisfied_at = now() WHERE id = $1`,
      [created.row.id],
    );

    const outcome = await requirements.waive({
      userId,
      requirementId: created.row.id,
      actorAdminId: ADMIN,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Narrowed on `reason` before reading `satisfiedAt`: the refusal is a union and the
    // `not_found` arm carries no timestamps, so reading the field off the union is a
    // type error rather than a safe access. Asserting the discriminator first is what
    // makes the field reachable.
    expect(outcome.reason).toBe('already_closed');
    if (outcome.reason !== 'already_closed') return;
    expect(outcome.satisfiedAt).not.toBeNull();

    // And `waived_at` is still null — the evidence of HOW it was discharged survives.
    const [row] = await requirements.listForUser(userId, 10);
    expect(row?.waived_at).toBeNull();
  });

  it('lets a CLOSED key be re-imposed, because the index is partial', async () => {
    const userId = await seedUser();
    const first = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    if (!first.ok) return;
    await requirements.waive({ userId, requirementId: first.row.id, actorAdminId: ADMIN });

    const second = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
    expect(await requirements.listForUser(userId, 10)).toHaveLength(2);
  });

  it('produces ONE row under two concurrent requires of the same reference', async () => {
    // The index is the authority, not a read-then-write — which both writers would pass.
    const userId = await seedUser();
    const other = new KycRequirementDbOperation(
      prismaFor(pgUrl, 'kyc-requirement-concurrent') as never,
    );

    const outcomes = await Promise.all([
      requirements.require({
        userId,
        requiredLevel: 'L1',
        triggerKind: 'ADMIN',
        triggerKey: KEY,
      }),
      other.require({ userId, requiredLevel: 'L1', triggerKind: 'ADMIN', triggerKey: KEY }),
    ]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    // Exactly one of them created it; both report the same row.
    expect(outcomes.filter((outcome) => outcome.ok && outcome.created)).toHaveLength(1);
    expect(await requirements.listForUser(userId, 10)).toHaveLength(1);
  });

  it('lets exactly ONE of two concurrent waivers succeed', async () => {
    const userId = await seedUser();
    const created = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: KEY,
    });
    if (!created.ok) return;

    const other = new KycRequirementDbOperation(
      prismaFor(pgUrl, 'kyc-requirement-concurrent-waive') as never,
    );

    const outcomes = await Promise.all([
      requirements.waive({ userId, requirementId: created.row.id, actorAdminId: ADMIN }),
      other.waive({
        userId,
        requirementId: created.row.id,
        actorAdminId: crypto.randomUUID(),
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await requirements.listForUser(userId, 10)).toHaveLength(1);
  });

  it('orders open obligations before closed ones', async () => {
    const userId = await seedUser();
    const closed = await requirements.require({
      userId,
      requiredLevel: 'L1',
      triggerKind: 'ADMIN',
      triggerKey: 'ADMIN:CASE-OLD',
    });
    if (!closed.ok) return;
    await requirements.waive({ userId, requirementId: closed.row.id, actorAdminId: ADMIN });

    await requirements.require({
      userId,
      requiredLevel: 'L2',
      triggerKind: 'ADMIN',
      triggerKey: 'ADMIN:CASE-NEW',
    });

    const rows = await requirements.listForUser(userId, 10);
    expect(rows.map((row) => row.open)).toEqual([true, false]);
  });

  it('writes NOTHING outside kyc_requirements', () => {
    // ═══ THE CREDENTIAL BOUNDARY, ASSERTED STRUCTURALLY ══════════════════════
    //
    // The whole justification for letting Admin write this table is that an obligation
    // WITHHOLDS standing and cannot manufacture a verification. That holds only while
    // this writer names no other table, so it is checked rather than trusted.
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'kyc', 'kyc-requirement.dboperation.ts'),
      'utf8',
    );

    const mutations = [
      ...source.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+"identity"\."(\w+)"/g),
    ].map((match) => match[2] as string);

    expect(mutations.length).toBeGreaterThan(0);
    expect([...new Set(mutations)]).toEqual(['kyc_requirements']);

    // ═══ COMMENTS ARE STRIPPED BEFORE THE SUBSTRING CHECK ════════════════════
    //
    // The loop below asks whether the forbidden table names appear ANYWHERE in the
    // file, which is the right question about code and the wrong one about prose: this
    // writer's own header names `kyc_verifications`, `kyc_level_states` and
    // `kyc_exemptions` precisely in order to state that it does not touch them. Testing
    // the raw source therefore failed on the documentation of the very property it was
    // verifying.
    //
    // Stripping `//` and block comments keeps the assertion pointed at the statements.
    // It stays a substring check rather than becoming a second regex over SQL, because
    // the mutation assertion above already covers well-formed statements — this one is
    // the backstop for a name reaching the file some way that regex would not match.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');

    for (const forbidden of [
      'kyc_verifications',
      'kyc_level_states',
      'kyc_verification_devices',
      'kyc_provider_events',
      'kyc_policies',
      'kyc_renewal_settings',
      'kyc_exemptions',
    ]) {
      expect(code, `must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});
