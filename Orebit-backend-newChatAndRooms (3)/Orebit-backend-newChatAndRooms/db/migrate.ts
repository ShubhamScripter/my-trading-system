/**
 * Migration runner.
 *
 *   npm run db:migrate    apply Prisma migrations, then apply db/sql/*.sql
 *   npm run db:verify     apply nothing; assert the expected objects exist
 *
 * Why this exists instead of calling `prisma migrate deploy` directly: the schema
 * is only half the story. The partial unique indexes in db/sql/*.sql are the
 * authority behind username allocation and email uniqueness, and Prisma cannot
 * express them, so a deploy that ran migrations but not these files would leave a
 * database that looks migrated and silently permits duplicate accounts. Binding
 * the two together in one command is what makes that impossible to forget.
 *
 * Every statement in db/sql/*.sql is idempotent, so re-running is always safe.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const SQL_DIR = join(__dirname, 'sql');
const SCHEMA = join(__dirname, 'schema.prisma');

/** Objects db:verify insists on. A missing entry here is a silent correctness
 *  hole, so the list is explicit rather than derived from the SQL files. */
const EXPECTED_INDEXES = [
  'ix_users_email_active',
  'ix_users_username_active',
  'ix_users_public_code_active',
  'ix_users_referral_code_active',
  'ix_oauth_links_provider_subject_active',
  'ix_oauth_links_user_provider_active',
  'ix_registrations_resumable',
  'ix_registrations_continuation',
  'ux_challenges_live',
  'ix_challenges_live',
  'ix_sessions_live',
  'ix_sessions_device_live',
  'ux_trusted_devices_user_token_active',
  'ux_totp_factors_confirmed_active',
  'ux_passkeys_credential_active',
  'ux_recovery_codes_unused',
  'ux_login_attempts_token_live',
  'ix_users_purge_due',
  // The security-context history indexes. Without these the classifier that decides
  // whether a sensitive settings change came from a familiar context degrades to a
  // sequential scan over every session an account has ever had — and sessions are
  // never pruned. It still returns the right answer, which is why its absence would
  // otherwise be silent.
  'ix_sessions_device_history',
  'ix_sessions_ip_history',
  'ix_sessions_country_history',
  'ix_user_feature_restrictions_live',
  // NOTE: `ux_security_restriction_policies_target` and
  // `ux_security_restriction_policy_versions_target` are deliberately NOT listed here.
  // They are declared in schema.prisma and created by a Prisma migration, and
  // tests/db/constraints.spec.ts asserts this list is EXACTLY what db/sql/identity.sql
  // creates — in both directions. Prisma's own migration is what guarantees those two.
];

function directUrl(): string {
  const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set');
  return url;
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
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'identity'`,
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
  if (process.argv.includes('--verify')) {
    await verify();
    return;
  }

  // `migrate deploy` rather than `migrate dev`: deploy never prompts and never
  // resets, so the same command is correct locally and in CI.
  //
  // ─── Why the CLI is resolved rather than invoked through npx ───────────────
  //
  // This used to be `execFileSync('npx', ...)`, which cannot run on Windows and so
  // made `npm run db:migrate` unusable there. Two things break in sequence: bare
  // `npx` is an ENOENT because `execFileSync` does not go through a shell and
  // therefore does not apply PATHEXT, and naming `npx.cmd` instead is an EINVAL
  // because Node 20 refuses to spawn a `.cmd` without `shell: true`
  // (CVE-2024-27980).
  //
  // `shell: true` would fix both and reintroduce quoting as the thing standing
  // between a path with a space in it and a broken command line. Resolving the
  // CLI's entry point and running it with the Node binary already executing avoids
  // the shell entirely, and pins the prisma that is actually installed rather than
  // whatever npx would go and fetch.
  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', SCHEMA], {
    stdio: 'inherit',
  });
  await applySql();
  await verify();
}

void main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
