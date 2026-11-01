const { readFile, readdir, writeFile } = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { join } = require('node:path');
const pg = require('pg');
const WALLET_COMPATIBILITY_PREREQUISITE = '20260901000013_reference_mutation_guard';
const WALLET_COMPATIBILITY_OVERLAY = join(__dirname, 'test-wallet-compatibility-overlay.sql');

function validatePriceTestDatabaseEnvironment(env = process.env) {
  const raw = env.PRICE_TEST_DATABASE_URL;
  if (!raw) throw new Error('PRICE_TEST_DATABASE_URL is required');
  let url;
  try { url = new URL(raw); } catch { throw new Error('PRICE_TEST_DATABASE_URL must be a valid URL'); }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PRICE_TEST_DATABASE_URL must use PostgreSQL');
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== 55433
    || databaseName !== 'orebit_price_test' || url.username === ''
    || url.searchParams.getAll('schema').length !== 1
    || url.searchParams.get('schema') !== 'price_conversion_test'
    || [...url.searchParams.keys()].some((key) => key !== 'schema')) {
    throw new Error('PRICE_TEST_DATABASE_URL must be the exact disposable target');
  }
  if (env.PRICE_TEST_ALLOW_RESET !== 'true') throw new Error('PRICE_TEST_ALLOW_RESET=true is required');
  return { connectionString: url.toString(), databaseName };
}

async function provisionPriceTestDatabase(env = process.env, options = {}) {
  const config = validatePriceTestDatabaseEnvironment(env);
  const targetUrl = new URL(config.connectionString);
  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  try {
    const identity = (await target.query(`SELECT current_database() database,
      current_setting('cluster_name') cluster,inet_server_port() port`)).rows[0];
    if (identity?.database !== 'orebit_price_test' || identity?.cluster !== 'orebit_price_test'
      || Number(identity?.port) !== 5432) throw new Error('PRICE_TEST_DATABASE_IDENTITY_INVALID');
    await target.query('DROP SCHEMA IF EXISTS price_conversion_test CASCADE');
    const migrationsRoot = join(__dirname, 'migrations');
    const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .filter((name) => options.through === undefined || name <= options.through);
    for (const directory of directories) {
      const migration = await readFile(join(migrationsRoot, directory, 'migration.sql'), 'utf8');
      await target.query(migration.replaceAll('price_conversion', 'price_conversion_test'));
    }
    if (directories.includes(WALLET_COMPATIBILITY_PREREQUISITE)) {
      const overlay = await readFile(WALLET_COMPATIBILITY_OVERLAY, 'utf8');
      await target.query(overlay.replaceAll('price_conversion', 'price_conversion_test'));
    }
    await target.query(`CREATE TABLE price_conversion_test._prisma_migrations (
      id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0
    )`);
    for (const directory of directories) {
      const migration = await readFile(join(migrationsRoot, directory, 'migration.sql'), 'utf8');
      await target.query(`INSERT INTO price_conversion_test._prisma_migrations
        (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES ($1, $2, now(), $3, 1)`, [
        randomUUID(), createHash('sha256').update(migration).digest('hex'), directory,
      ]);
    }
  } finally {
    await target.end();
  }
  const canonicalSchema = await readFile(join(__dirname, 'schema.prisma'), 'utf8');
  await writeFile(
    join(__dirname, 'schema.test.prisma'),
    canonicalSchema.replaceAll('price_conversion', 'price_conversion_test'),
    'utf8',
  );
}

exports.provisionPriceTestDatabase = provisionPriceTestDatabase;
exports.validatePriceTestDatabaseEnvironment = validatePriceTestDatabaseEnvironment;

if (require.main === module) {
  provisionPriceTestDatabase()
    .then(() => console.log('isolated price-conversion test database provisioned'))
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
