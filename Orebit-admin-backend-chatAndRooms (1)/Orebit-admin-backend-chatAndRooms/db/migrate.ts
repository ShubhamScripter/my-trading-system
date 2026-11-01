/**
 * Migration runner.
 *
 *   npm run db:migrate    apply Prisma migrations, then apply db/sql/*.sql
 *   npm run db:verify     apply nothing; assert the expected objects exist
 *
 * Why this exists instead of calling `prisma migrate deploy` directly: the schema
 * is only half the story. The partial indexes in db/sql/*.sql are the authority
 * behind email uniqueness, passkey registration and the TOTP downgrade guard, and
 * Prisma cannot express them — so a deploy that ran migrations but not these files
 * would leave a database that looks migrated and silently permits duplicates.
 * Binding the two together in one command is what makes that impossible to forget.
 *
 * Every statement in db/sql/*.sql is idempotent, so re-running is always safe.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const SQL_DIR = join(__dirname, 'sql');
const SCHEMA = join(__dirname, 'schema.prisma');
const PG_SCHEMA = 'admin';

/** Objects db:verify insists on. A missing entry here is a silent correctness
 *  hole, so the list is explicit rather than derived from the SQL files. */
const EXPECTED_INDEXES = [
  'ix_admins_email_active',
  'ix_admin_passkeys_credential_active',
  'ix_admin_login_attempts_stepup',
  'ix_admin_login_attempts_live',
  'ix_admin_challenges_live',
  'ix_admin_totp_confirmed_unique',
  'ix_admin_sessions_live',
  'ix_admin_session_families_live',
  'ix_admin_credentials_pending_review',
];

function directUrl(): string {
  const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set');
  return url;
}

/**
 * Refuse to touch a database whose URL does not name this service's schema.
 *
 * This service shares a Postgres instance with the main Orebit backend. Prisma
 * resolves `_prisma_migrations` against the schema in the connection string, so
 * without `?schema=admin` both services write one history table and each reads
 * the other's migrations as unknown drift. Checked here as well as in
 * src/config.ts, because this script runs via tsx and never imports config.
 */
function assertSchemaScoped(): void {
  for (const name of ['DATABASE_URL', 'DATABASE_DIRECT_URL'] as const) {
    const value = process.env[name];
    if (value !== undefined && !new RegExp(`[?&]schema=${PG_SCHEMA}(&|$)`).test(value)) {
      throw new Error(
        `${name} must carry ?schema=${PG_SCHEMA}.\n` +
          `  This service owns the \`${PG_SCHEMA}\` Postgres schema and needs its own Prisma\n` +
          `  migration history, separate from the main Orebit backend's in \`public\`.`,
      );
    }
  }
}

function sqlFiles(): string[] {
  try {
    // Lexicographic, so a numeric prefix is how you force ordering between files
    // that depend on each other.
    return readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return [];
  }
}

async function applySql(): Promise<void> {
  const files = sqlFiles();
  if (files.length === 0) {
    console.log('no db/sql/*.sql files to apply');
    return;
  }

  const client = new Client({ connectionString: directUrl() });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(join(SQL_DIR, file), 'utf8');
      // One transaction per file: a file is the unit that either fully applies or
      // leaves nothing behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`applied db/sql/${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`db/sql/${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function verify(): Promise<void> {
  const client = new Client({ connectionString: directUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [PG_SCHEMA],
    );
    const present = new Set(rows.map((r) => r.indexname));
    const missing = EXPECTED_INDEXES.filter((name) => !present.has(name));

    if (missing.length > 0) {
      console.error(`missing ${missing.length} expected index(es):`);
      for (const name of missing) console.error(`  ${name}`);
      process.exit(1);
    }
    console.log(`verified ${EXPECTED_INDEXES.length} expected indexes`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  assertSchemaScoped();

  if (process.argv.includes('--verify')) {
    await verify();
    return;
  }

  // `migrate deploy` rather than `migrate dev`: deploy never prompts and never
  // resets, so the same command is correct locally and in CI.
  //
  // Prisma's own entry point under the current `node`, not `npx`.
  //
  // `npx` cannot be spawned portably from `execFileSync`. It does no PATHEXT
  // resolution, so a bare `npx` is `ENOENT` on Windows where the shim is
  // `npx.cmd`; and naming `npx.cmd` is `EINVAL`, because Node 20+ refuses to
  // spawn `.cmd`/`.bat` without `shell: true` (the CVE-2024-27980 hardening).
  // `shell: true` would work and is what most projects reach for, but it hands the
  // argument list to cmd.exe for re-parsing to solve what is only a filename
  // problem.
  //
  // `require.resolve` finds the installed CLI wherever the package manager put it
  // — hoisted, nested, or in a workspace root — and `process.execPath` runs it
  // under the same Node that is running this script, so the version cannot drift
  // from the one `npx` would have picked.
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', SCHEMA],
    { stdio: 'inherit' },
  );
  await applySql();
  await verify();
}

void main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
