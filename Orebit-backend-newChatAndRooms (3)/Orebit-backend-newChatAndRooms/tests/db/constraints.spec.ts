import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══ THE DDL PRISMA CANNOT EXPRESS ══════════════════════════════════════════
 *
 * `db/sql/identity.sql` holds the partial unique indexes, applied by `db/migrate.ts`
 * after every migration. They are the uniqueness authority for `users` and
 * `oauth_links`, and Prisma cannot see them — which is precisely why they need a test
 * that does.
 *
 * Static, for the reason `migrations.spec.ts` gives: there is no test database here.
 * `npm run db:verify` proves these exist in a real schema; this proves they say what
 * the design says they say, which is the half a running database would not check.
 *
 * ─── The invariant this file exists for ─────────────────────────────────────
 *
 * Every uniqueness rule on a soft-deleting table must be PARTIAL on `deleted_at IS
 * NULL`. A plain unique constraint would keep a deleted account's email and username
 * reserved forever, so deleting an account would permanently burn its address and no
 * user could ever move one back. That argument is written at the top of `schema.prisma`
 * and is the reason none of these are `@unique` — and it is exactly the kind of thing
 * a later hand adds "for safety" without knowing.
 */

const IDENTITY_SQL = readFileSync(join(__dirname, '../../db/sql/identity.sql'), 'utf8');
const MIGRATE_TS = readFileSync(join(__dirname, '../../db/migrate.ts'), 'utf8');

/** One `CREATE [UNIQUE] INDEX ... ;` statement, by index name. */
function statementFor(indexName: string): string {
  const match = IDENTITY_SQL.match(
    new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${indexName}[\\s\\S]*?;`),
  );
  if (match === null) throw new Error(`no CREATE INDEX for ${indexName}`);
  return match[0];
}

const createdIndexes = [
  ...IDENTITY_SQL.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g),
].map((m) => m[1] as string);

const expectedIndexes = [
  ...(MIGRATE_TS.match(/const EXPECTED_INDEXES = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(
    /'([^']+)'/g,
  ),
].map((m) => m[1] as string);

describe('db:verify checks exactly what identity.sql creates', () => {
  it('lists every index the SQL creates', () => {
    // A missing entry is a silent correctness hole: the index would be absent in a
    // half-applied schema and `db:verify` would still exit 0. `migrate.ts` says the
    // list is explicit rather than derived for that reason — so this is what keeps the
    // explicit list honest.
    expect([...expectedIndexes].sort()).toEqual([...new Set(createdIndexes)].sort());
  });

  it('names nothing that does not exist', () => {
    for (const name of expectedIndexes) {
      expect(createdIndexes, `${name} is verified but never created`).toContain(name);
    }
  });
});

describe('uniqueness on soft-deleting tables is always partial', () => {
  it.each([
    'ix_users_email_active',
    'ix_users_username_active',
    'ix_users_public_code_active',
    'ix_users_referral_code_active',
    'ix_oauth_links_provider_subject_active',
  ])('%s excludes soft-deleted rows', (indexName) => {
    const statement = statementFor(indexName);

    expect(statement).toContain('UNIQUE');
    // Without this predicate, deleting an account would burn its identifiers forever.
    expect(statement).toContain('deleted_at IS NULL');
  });

  it('keeps username uniqueness on the NORMALISED column', () => {
    // Uniqueness must be case-insensitive, and it is achieved by indexing the folded
    // column rather than by a functional index — so every lookup and every write has to
    // pass through the same `normaliseUsername`.
    const statement = statementFor('ix_users_username_active');

    expect(statement).toContain('identity.users (username_lower)');
    expect(statement).not.toContain('(username)');
  });
});

describe('the username uniqueness authority', () => {
  it('is a partial index and NOT a Prisma @unique', () => {
    const schema = readFileSync(join(__dirname, '../../db/schema.prisma'), 'utf8');
    const userBlock = schema.match(/^model User \{([\s\S]*?)^\}/m)?.[1] ?? '';

    // The moment this becomes `@unique`, a soft-deleted account holds its username
    // forever. The index in identity.sql is the authority precisely because it can be
    // scoped to live rows.
    expect(userBlock).toContain('usernameLower String @map("username_lower")');
    expect(userBlock).not.toMatch(/usernameLower[^\n]*@unique/);
    expect(userBlock).not.toMatch(/@@unique\(\[[^\]]*usernameLower/);
  });

  it('is the index the code names when it classifies a collision', () => {
    // `violatedIndex(err, 'ix_users_username_active')` matches on the index NAME in the
    // raw Postgres error text, because Prisma reports partial-index violations with no
    // `meta`. Renaming the index without renaming the string would turn every username
    // race into an unhandled 500.
    const userService = readFileSync(
      join(__dirname, '../../auth/services/user.service.ts'),
      'utf8',
    );
    const named = [...userService.matchAll(/violatedIndex\(err, '([^']+)'\)/g)].map(
      (m) => m[1] as string,
    );

    for (const name of named) {
      expect(createdIndexes, `${name} is matched in code but never created`).toContain(name);
    }
  });
});
