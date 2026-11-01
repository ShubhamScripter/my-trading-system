import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Creates and migrates the integration-test database, ONCE, before any spec runs.
 *
 * ═══ WHY THE CONCURRENCY SPECS NEED A REAL DATABASE ══════════════════════════
 *
 * Every other spec in this suite runs against doubles, and that is right for them:
 * they assert the shape of a write, which a fake records exactly. The revocation
 * race cannot be tested that way even in principle. What went wrong was a property
 * of PostgreSQL's READ COMMITTED snapshots — a row invisible to one statement and
 * visible to the next — and a fake that reproduced it would be a fake encoding the
 * very belief under test. See tests/auth/persistence/session.concurrency.spec.ts.
 *
 * ═══ MISSING POSTGRES SKIPS, IT DOES NOT FAIL ════════════════════════════════
 *
 * `npm test` must stay runnable on a laptop with no database and in CI, which has
 * no Postgres service container. So an unreachable server is reported through
 * `provide` and the specs skip themselves; it is never thrown from here, because a
 * throw in global setup fails the entire run rather than one file.
 *
 * The trade is that a broken database looks the same as an absent one — the run goes
 * green with those specs silently skipped. `OREBIT_PG_TESTS=1` is the guard against
 * that: it turns an unreachable server back into a hard failure, which is what CI
 * should set once a service container exists.
 */

const TEST_DB = 'orebit_test';
const HOST = process.env['OREBIT_TEST_PG_HOST'] ?? 'localhost:5432';
const CREDS = process.env['OREBIT_TEST_PG_CREDS'] ?? 'orebit:orebit';

export const TEST_DATABASE_URL = `postgresql://${CREDS}@${HOST}/${TEST_DB}?schema=admin`;
const MAINTENANCE_URL = `postgresql://${CREDS}@${HOST}/postgres`;

declare module 'vitest' {
  interface ProvidedContext {
    /** Whether the concurrency specs may run. Read with `inject('pgAvailable')`,
     *  which is synchronous — an async probe could not feed `describe.skipIf`. */
    pgAvailable: boolean;
    pgUrl: string;
  }
}

async function ensureDatabase(): Promise<void> {
  // A short timeout so an absent server costs a second, not the default TCP wait.
  const client = new Client({ connectionString: MAINTENANCE_URL, connectionTimeoutMillis: 1000 });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DB,
    ]);
    // CREATE DATABASE cannot run inside a transaction block, which is why this is a
    // bare query on its own connection rather than part of the migration run.
    if (rowCount === 0) await client.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await client.end();
  }
}

function migrate(): void {
  // db/migrate.ts directly, NOT `npm run db:migrate` — that script passes
  // `--env-file=.env`, which would override the URL below with the developer's real
  // database. Running the same file under the same Node keeps the migration path
  // identical to production's while pointing it somewhere disposable.
  //
  // `migrate deploy` and db/sql/*.sql are both idempotent, so this costs a second or
  // two on every run and is always in step with the schema.
  execFileSync(process.execPath, [require.resolve('tsx/cli'), join(__dirname, '../../db/migrate.ts')], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_DIRECT_URL: TEST_DATABASE_URL,
    },
    stdio: 'pipe',
  });
}

/**
 * Structural, rather than `import type { TestProject } from 'vitest/node'` — that
 * module is ESM-only and this project compiles as CommonJS, so importing the type
 * needs a `resolution-mode` attribute for a shape this small. Only `provide` is
 * used, so only `provide` is described.
 */
interface GlobalSetupContext {
  provide: <K extends 'pgAvailable' | 'pgUrl'>(
    key: K,
    value: K extends 'pgAvailable' ? boolean : string,
  ) => void;
}

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const required = process.env['OREBIT_PG_TESTS'] === '1';

  if (process.env['OREBIT_PG_TESTS'] === '0') {
    provide('pgAvailable', false);
    provide('pgUrl', TEST_DATABASE_URL);
    return;
  }

  try {
    await ensureDatabase();
    migrate();
    provide('pgAvailable', true);
  } catch (err) {
    if (required) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      `\n  [pg] ${TEST_DB} unavailable — database-backed specs will SKIP.` +
        `\n      ${(err as Error).message.split('\n')[0]}` +
        `\n      Set OREBIT_PG_TESTS=1 to make this a failure instead.\n`,
    );
    provide('pgAvailable', false);
  }
  provide('pgUrl', TEST_DATABASE_URL);
}
