import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══ THE MIGRATIONS, READ RATHER THAN RUN ═══════════════════════════════════
 *
 * These specs are static. They parse `db/migrations/*` and `db/schema.prisma` and
 * assert things about the DDL text; they never open a connection.
 *
 * ─── Why static, and what that does and does not buy ────────────────────────
 *
 * There is no test database in this repository — every suite runs against hand-written
 * doubles, which is the property the dboperation split exists to preserve (README,
 * "Module convention"). Introducing testcontainers for one folder would make `npm test`
 * depend on Docker, which is a far larger decision than this file.
 *
 * So this does not prove a migration APPLIES. `npm run db:migrate` proves that, and
 * `db:verify` proves the expected indexes exist afterwards. What this catches is the
 * class of mistake that survives review and then produces a schema nobody intended:
 * a model added to `schema.prisma` with no migration behind it, a column that is
 * nullable in one and not the other, a foreign key that forgets `ON DELETE CASCADE`,
 * or a uniqueness rule quietly added where the design says there must not be one.
 *
 * Those are all decidable from the text, and the text is what gets reviewed.
 */

const MIGRATIONS_DIR = join(__dirname, '../../db/migrations');
const SCHEMA = readFileSync(join(__dirname, '../../db/schema.prisma'), 'utf8');

/** Directories only. `migration_lock.toml` and `.gitkeep` live alongside them, and a
 *  filter written as "not .toml" would have to be extended for each new stray file. */
const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function sqlOf(dirName: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dirName, 'migration.sql'), 'utf8');
}

/** Every migration's SQL, concatenated. The schema is the sum of them, so a question
 *  like "is this table ever created" is asked of all of them at once. */
const ALL_SQL = migrationDirs.map(sqlOf).join('\n');

/** The body of one `model X { ... }` block in schema.prisma. */
function modelBlock(name: string): string {
  const match = SCHEMA.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (match === null) throw new Error(`no model ${name} in schema.prisma`);
  return match[1] as string;
}

describe('the migration directory', () => {
  it('names every migration <timestamp>_<snake_case>', () => {
    for (const name of migrationDirs) {
      expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
    }
  });

  it('gives every migration exactly one migration.sql', () => {
    for (const name of migrationDirs) {
      expect(readdirSync(join(MIGRATIONS_DIR, name))).toEqual(['migration.sql']);
    }
  });

  it('keeps the timestamps unique and ordered, so replay order is the write order', () => {
    const stamps = migrationDirs.map((name) => name.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps.slice().sort());
  });

  it('qualifies every table it creates with the identity, chat or rain schema', () => {
    // `schemas = ["identity"]` is declared in schema.prisma, and an unqualified CREATE
    // would land in `public` — where Prisma would not find it and `db:verify` would not
    // look for its indexes.
    //
    // Both spellings are accepted. Most migrations quote the identifiers because that
    // is what `prisma migrate` emits, and `20260902110000_rate_limit_policy_versions`
    // writes `identity.rate_limit_policy_versions` unquoted. They are the same table —
    // Postgres folds unquoted identifiers to lower case and these are already lower
    // case — so this asserts the SCHEMA is named, which is the part that matters, and
    // not a house style neither the tooling nor the database cares about.
    const creates = [...ALL_SQL.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\S+)/gi)];
    expect(creates.length).toBeGreaterThan(10);

    for (const [, target] of creates) {
      // `rain` is raw SQL only (no Prisma models), so it is named here rather than in schema.prisma.
      expect(target).toMatch(/^(?:"(?:identity|chat|rain)"\.|(?:identity|chat|rain)\.)/);
    }
  });
});

/** `"identity"."x"` or `identity.x`, or the same in the chat schema — see the note above. */
function createsTable(table: string): boolean {
  return ['identity', 'chat'].some(
    (schema) => ALL_SQL.includes(`"${schema}"."${table}"`) || ALL_SQL.includes(`${schema}.${table}`),
  );
}

describe('every model in schema.prisma has a migration behind it', () => {
  const models = [...SCHEMA.matchAll(/^model (\w+) \{/gm)].map((m) => m[1] as string);

  it('finds a CREATE TABLE for each model’s mapped table name', () => {
    expect(models.length).toBeGreaterThan(10);

    for (const model of models) {
      const mapped = modelBlock(model).match(/@@map\("([^"]+)"\)/)?.[1];
      expect(mapped, `${model} has no @@map`).toBeDefined();
      expect(createsTable(mapped as string), `no CREATE TABLE for ${mapped}`).toBe(true);
    }
  });
});

describe('username_reservations', () => {
  const MIGRATION = '20260907120000_username_reservations';
  const sql = sqlOf(MIGRATION);
  const model = modelBlock('UsernameReservation');

  it('creates the table', () => {
    expect(sql).toContain('CREATE TABLE "identity"."username_reservations"');
    expect(model).toContain('@@map("username_reservations")');
    expect(model).toContain('@@schema("identity")');
  });

  it('declares every column the model does, with matching nullability', () => {
    // `expires_at` NOT NULL is the load-bearing one: liveness is `expires_at > now()`,
    // and a null would make a reservation that neither blocks nor expires.
    const columns: [string, string, boolean][] = [
      ['id', 'UUID', false],
      ['user_id', 'UUID', false],
      ['username', 'TEXT', false],
      ['username_lower', 'TEXT', false],
      ['expires_at', 'TIMESTAMPTZ', false],
      ['created_at', 'TIMESTAMPTZ', false],
    ];

    for (const [column, type, nullable] of columns) {
      const line = sql
        .split('\n')
        .find((l) => l.trim().startsWith(`"${column}"`));
      expect(line, `no column ${column}`).toBeDefined();
      expect(line).toContain(type);
      expect(line!.includes('NOT NULL')).toBe(!nullable);
    }
  });

  it('has no nullable column at all — every field on this row is required', () => {
    // The model declares no `?` on any field, and the two must agree or Prisma will
    // happily write a null the database then refuses.
    expect(model).not.toMatch(/^\s+\w+\s+\w+\?/m);
  });

  it('carries a primary key on id', () => {
    expect(sql).toContain('CONSTRAINT "username_reservations_pkey" PRIMARY KEY ("id")');
  });

  it('cascades from users, so a deleted account stops reserving names', () => {
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(model).toContain('onDelete: Cascade');
  });

  it('indexes the availability probe and the per-account window, and nothing else', () => {
    expect(sql).toContain('CREATE INDEX "ix_username_reservations_lookup"');
    expect(sql).toContain('("username_lower", "expires_at")');
    expect(sql).toContain('CREATE INDEX "ix_username_reservations_user"');
    expect(sql).toContain('("user_id", "created_at" DESC)');

    // Two indexes plus the primary key. An unused index on a table written once per
    // username change is pure write cost.
    expect(sql.match(/CREATE (UNIQUE )?INDEX/g)).toHaveLength(2);
  });

  it('does NOT make username_lower unique — that would forbid the second cycle', () => {
    // One username may legitimately be reserved, expire, be claimed by somebody else,
    // and be released again. Uniqueness here would break that on the second pass, and
    // it is not needed: `ix_users_username_active` is the uniqueness authority, and
    // this table's liveness is a time predicate.
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^;]*username_reservations/);
    expect(model).not.toContain('@unique');
    expect(model).not.toContain('@@unique');
  });

  it('does not add a column to users — the ledger lives in this table', () => {
    // `created_at` here already answers "how many changes in the window", so a
    // `username_changed_at` on `users` would be a second copy that can disagree.
    expect(sql).not.toContain('ALTER TABLE "identity"."users"');
  });
});

describe('the schema’s own conventions hold for the new model', () => {
  const model = modelBlock('UsernameReservation');

  it('uses snake_case column mappings and a plural table name', () => {
    expect(model).toContain('@map("user_id")');
    expect(model).toContain('@map("username_lower")');
    expect(model).toContain('@map("expires_at")');
    expect(model).toContain('@@map("username_reservations")');
  });

  it('stores time as timestamptz', () => {
    for (const line of model.split('\n').filter((l) => l.includes('DateTime'))) {
      expect(line).toContain('@db.Timestamptz');
    }
  });

  it('keeps the display casing beside the normalised value', () => {
    // The house rule for user-supplied identifiers: `x` as typed for display, `xLower`
    // normalised, and the normalised one is what every lookup matches.
    expect(model).toMatch(/username\s+String\s*$/m);
    expect(model).toContain('usernameLower String @map("username_lower")');
  });

  it('takes its id as a UUID the application generates', () => {
    // uuidv7() from src/utils, never gen_random_uuid() — time-ordered, so inserts stay
    // at the right edge of the B-tree.
    expect(model).toContain('id     String @id @db.Uuid');
    expect(model).not.toContain('@default(uuid())');
    expect(model).not.toContain('dbgenerated');
  });
});

/**
 * ═══ THE ANTI-PHISHING COLUMNS ══════════════════════════════════════════════
 *
 * An `ALTER TABLE` rather than a new table, so the "every model has a CREATE TABLE"
 * check above does not cover it. These are the assertions that do.
 *
 * The one worth reading is the last: this is the SECOND place in the schema that
 * stores a reversible secret, and it must look like the first. A future reader
 * comparing them should find the same four-column envelope shape rather than two
 * different answers to one problem.
 */
describe('the anti-phishing code columns', () => {
  const MIGRATION = '20260908120000_anti_phishing_code';
  const sql = sqlOf(MIGRATION);
  const model = modelBlock('User');

  it('alters users rather than creating a table', () => {
    // On `users` deliberately: every outbound email needs this value and the
    // notification callers already load this row, so a side table would add a query to
    // every message the service sends.
    expect(sql).toContain('ALTER TABLE "identity"."users"');
    expect(sql).not.toContain('CREATE TABLE');
  });

  it('adds the four envelope columns plus the timestamp, all nullable', () => {
    const columns: [string, string][] = [
      ['anti_phishing_ciphertext', 'BYTEA'],
      ['anti_phishing_iv', 'BYTEA'],
      ['anti_phishing_tag', 'BYTEA'],
      ['anti_phishing_key_version', 'INTEGER'],
      ['anti_phishing_set_at', 'TIMESTAMPTZ'],
    ];

    for (const [column, type] of columns) {
      const line = sql.split('\n').find((l) => l.includes(`"${column}"`));
      expect(line, `no column ${column}`).toBeDefined();
      expect(line).toContain(type);
      // NOT NULL on any of them would be unsatisfiable: every existing account has no
      // code, and there is nothing to backfill — a made-up code printed in a user's
      // email is worse than none at all.
      expect(line).not.toContain('NOT NULL');
    }
  });

  it('declares all five on the model, nullable, with snake_case mappings', () => {
    expect(model).toContain('antiPhishingCiphertext Bytes? @map("anti_phishing_ciphertext")');
    expect(model).toContain('antiPhishingIv         Bytes? @map("anti_phishing_iv")');
    expect(model).toContain('antiPhishingTag        Bytes? @map("anti_phishing_tag")');
    expect(model).toContain('antiPhishingKeyVersion Int?   @map("anti_phishing_key_version")');
    expect(model).toContain('@map("anti_phishing_set_at")');
  });

  it('stores the timestamp as timestamptz, like every other instant in the schema', () => {
    const line = model.split('\n').find((l) => l.includes('antiPhishingSetAt'));
    expect(line).toContain('@db.Timestamptz');
  });

  it('adds no index — every read is by primary key', () => {
    // The code is resolved for one account at a time, on a row the caller has already
    // loaded or is loading anyway. An index here would be maintained for no reader.
    expect(sql).not.toContain('CREATE INDEX');
    expect(sql).not.toContain('CREATE UNIQUE INDEX');
  });

  it('does not store the code in any recoverable-by-inspection form', () => {
    // No TEXT column, no VARCHAR: if a plaintext column had been added, a database
    // reader would hold every account's code — and could forge mail passing the exact
    // check this feature teaches users to make, for every user at once.
    const added = sql.split('\n').filter((l) => l.includes('ADD COLUMN'));
    for (const line of added) {
      expect(line).not.toMatch(/\bTEXT\b|\bVARCHAR\b/);
    }
  });

  it('uses the same envelope shape as the schema’s only other sealed secret', () => {
    // `TotpFactor` is the precedent: ciphertext / iv / tag / keyVersion, four columns
    // so a rotation can rewrite them per row. Two different shapes for one problem is
    // two things to get right; this asserts there is one.
    const totp = modelBlock('TotpFactor');

    for (const part of ['Ciphertext', 'Iv', 'Tag']) {
      expect(totp).toContain(`secret${part}`);
      expect(model).toContain(`antiPhishing${part}`);
    }
    expect(totp).toContain('keyVersion');
    expect(model).toContain('antiPhishingKeyVersion');
  });
});
