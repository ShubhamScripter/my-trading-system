const { execFile } = require('node:child_process');
const { readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { promisify } = require('node:util');
const pg = require('pg');
const { mapSchemaIdentifiers, verifyMappedSql, assertMappedSql, hasSchemaTarget } = require('./test-sql-mapping.cjs');

const execFileAsync = promisify(execFile);
const TEST = Object.freeze({
  containerName: 'orebit-wallet-core-postgres-test',
  clusterName: 'orebit_wallet_core_test',
  host: '127.0.0.1',
  hostPort: 55435,
  serverPort: 5432,
  databaseName: 'orebit_wallet_core_test',
  username: 'orebit_wallet_core_test_owner',
  password: 'local_wallet_core_test_only',
  schema: 'wallet_core_test',
  schemas: Object.freeze(['admin_test', 'price_conversion_test', 'wallet_core_test', 'ledger_test']),
  runtimeUrlNames: Object.freeze([
    'WALLET_CORE_DATABASE_URL', 'WALLET_CORE_DATABASE_DIRECT_URL',
    'DATABASE_URL', 'DATABASE_DIRECT_URL',
    'PRICE_DATABASE_URL', 'PRICE_DATABASE_DIRECT_URL',
  ]),
});

const IDENTITY_SQL = `SELECT current_database() AS database,
  current_setting('cluster_name') AS cluster,
  inet_server_addr()::text AS address,
  inet_server_port() AS port`;

const AUDIT_MIGRATION = resolve(__dirname,
  '../../admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql');
const AUDIT_RECONCILIATION_MIGRATION = resolve(__dirname,
  '../../admin-audits/migrations/20260906000001_reconciliation_inactive_null/migration.sql');
const PRICE_MIGRATIONS = Object.freeze([
  '20260831000000_canonical_price_conversion',
  '20260831000001_seed_price_configuration',
  '20260831000002_review_hardening',
  '20260831000003_governance_audit',
  '20260831000004_complete_price_hardening',
  '20260901000005_final_review_hardening',
  '20260901000006_final_isolation_and_dlq',
  '20260901000007_per_currency_view_and_ledger_read',
  '20260901000008_wall_clock_and_lifecycle_guards',
  '20260901000009_future_timestamp_guard',
  '20260901000010_strict_lifecycle_invariants',
  '20260901000011_sensitive_crypto_only',
  '20260901000012_revision_and_view_cadence',
  '20260901000013_reference_mutation_guard',
]);
const PRICE_MIGRATIONS_ROOT = resolve(__dirname, '../price-conversion/migrations');
const WALLET_MIGRATIONS = Object.freeze([
  '20260903000000_wallet_core_expand',
  '20260906000001_wallet_partial_preferences',
  '20260906000002_wallet_runtime_foundation',
  '20260906000003_wallet_core_contract',
  '20260906000004_wallet_reconciliation_runtime',
  '20260907000005_wallet_reconciliation_capture_set',
  '20260907000006_wallet_alert_null_guard',
  '20260907000007_wallet_alert_string_guard',
  '20260907000008_wallet_reconciliation_finite_amounts',
  '20260907000009_wallet_custody_statement_limit',
  '20260907000010_wallet_logo_assets',
  '20260907000011_wallet_changelog_reference',
  '20260908000012_wallet_logo_cleanup_partial',
]);

const RESET_SQL = `DROP SCHEMA IF EXISTS admin_test CASCADE;
DROP SCHEMA IF EXISTS price_conversion_test CASCADE;
DROP SCHEMA IF EXISTS wallet_core_test CASCADE;
DROP SCHEMA IF EXISTS ledger_test CASCADE;`;
const LIFECYCLE_AUDIT_MEMBERSHIP_SQL = `SELECT membership.admin_option,
  membership.inherit_option,membership.set_option,
  membership.grantor=current_user::regrole AS current_grantor
  FROM pg_auth_members membership
  WHERE membership.roleid=to_regrole('orebit_admin_audit_writer')
    AND membership.member=to_regrole('wallet_lifecycle_test_worker')`;
const REVOKE_LIFECYCLE_AUDIT =
  'REVOKE orebit_admin_audit_writer FROM wallet_lifecycle_test_worker';

function unwrapMigrationTransaction(source) {
  const match = /^BEGIN;\r?\n([\s\S]+)\r?\nCOMMIT;\s*$/.exec(source);
  if (!match || !match[1].trim()) throw new Error('Canonical Audit transaction wrapper changed');
  return match[1];
}

function membershipOptions(rows) {
  if (rows.length > 1) throw new Error('Known lifecycle Audit membership options invalid');
  const row = rows[0];
  if (!row) return null;
  if (typeof row.admin_option!=='boolean' || typeof row.inherit_option!=='boolean'
    || typeof row.set_option!=='boolean' || row.current_grantor!==true) {
    throw new Error('Known lifecycle Audit membership options invalid');
  }
  return row;
}
const sqlBoolean = value => value ? 'TRUE' : 'FALSE';

async function applyMappedAuditBootstrap(client, sources) {
  if (sources.length!==2) throw new Error('Canonical Audit requires exactly two migration units');
  const units=sources.map(unwrapMigrationTransaction);
  await client.query('BEGIN');
  try {
    const saved=membershipOptions((await client.query(LIFECYCLE_AUDIT_MEMBERSHIP_SQL)).rows);
    if (saved) await client.query(REVOKE_LIFECYCLE_AUDIT);
    await client.query(RESET_SQL);
    for (const unit of units) await client.query(unit);
    if (saved) {
      await client.query(`GRANT orebit_admin_audit_writer TO wallet_lifecycle_test_worker
        WITH ADMIN ${sqlBoolean(saved.admin_option)}, INHERIT ${sqlBoolean(saved.inherit_option)},
        SET ${sqlBoolean(saved.set_option)}
        GRANTED BY CURRENT_USER`.replace(/\s+/g,' ').trim());
      const restored=membershipOptions((await client.query(LIFECYCLE_AUDIT_MEMBERSHIP_SQL)).rows);
      if (!restored || restored.admin_option!==saved.admin_option
        || restored.inherit_option!==saved.inherit_option
        || restored.set_option!==saved.set_option) {
        throw new Error('Known lifecycle Audit membership restore failed');
      }
    }
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  }
}


function parseUrl(value, name) {
  if (!value) throw new Error(`${name} is required`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !url.username) throw new Error(`${name} must contain database credentials`);
  return { url, database };
}

function normalizedEndpoint(parsed) {
  const host = parsed.url.hostname.toLowerCase() === 'localhost'
    ? TEST.host : parsed.url.hostname.toLowerCase();
  return { host, port: Number(parsed.url.port || TEST.serverPort), database: parsed.database };
}

function validateEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test is required');
  if (env.WALLET_CORE_TEST_ALLOW_RESET !== 'true') {
    throw new Error('WALLET_CORE_TEST_ALLOW_RESET=true is required');
  }
  const parsed = parseUrl(env.WALLET_CORE_TEST_DATABASE_URL, 'WALLET_CORE_TEST_DATABASE_URL');
  const schemas = parsed.url.searchParams.getAll('schema');
  if (
    parsed.url.hostname !== TEST.host
    || Number(parsed.url.port) !== TEST.hostPort
    || parsed.database !== TEST.databaseName
    || decodeURIComponent(parsed.url.username) !== TEST.username
    || decodeURIComponent(parsed.url.password) !== TEST.password
    || schemas.length !== 1
    || schemas[0] !== TEST.schema
    || [...parsed.url.searchParams.keys()].some((key) => key !== 'schema')
  ) throw new Error('WALLET_CORE_TEST_DATABASE_URL must be the exact disposable target');

  for (const name of TEST.runtimeUrlNames) {
    if (!env[name] && !name.startsWith('WALLET_CORE_')) continue;
    const runtime = parseUrl(env[name], name);
    const endpoint = normalizedEndpoint(runtime);
    if (
      (endpoint.host === TEST.host && endpoint.port === TEST.hostPort)
      || endpoint.database === TEST.databaseName
    ) throw new Error(`${name} must not target the Wallet Core test database or endpoint`);
  }
  return parsed.url.toString();
}

function validateDockerInspection(inspection) {
  if (!Array.isArray(inspection) || inspection.length !== 1) {
    throw new Error('Wallet Core test Docker identity is invalid');
  }
  const container = inspection[0];
  const ports = container?.NetworkSettings?.Ports;
  const portNames = ports && typeof ports === 'object' ? Object.keys(ports) : [];
  const bindings = ports?.['5432/tcp'];
  if (
    container?.Name !== `/${TEST.containerName}`
    || container?.State?.Running !== true
    || portNames.length !== 1
    || !Array.isArray(bindings)
    || bindings.length !== 1
    || bindings[0]?.HostIp !== TEST.host
    || bindings[0]?.HostPort !== String(TEST.hostPort)
  ) throw new Error('Wallet Core test Docker identity or binding is invalid');
}

async function inspectDocker() {
  const { stdout } = await execFileAsync('docker', ['inspect','--format',
    '[{"Name":{{json .Name}},"State":{"Running":{{.State.Running}}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}]',TEST.containerName]);
  try { return JSON.parse(stdout); } catch { throw new Error('Wallet Core Docker inspection was invalid'); }
}

async function connect(connectionString) {
  return new pg.Pool({ connectionString, max: 2 });
}

async function assertSafeWalletCoreTestDatabase(
  env = process.env,
  open = connect,
  inspect = inspectDocker,
) {
  const connectionString = validateEnvironment(env);
  validateDockerInspection(await inspect());
  const pool = await open(connectionString);
  try {
    const { rows } = await pool.query(IDENTITY_SQL);
    const identity = rows[0];
    if (
      rows.length !== 1
      || identity?.database !== TEST.databaseName
      || identity?.cluster !== TEST.clusterName
      || !identity?.address
      || Number(identity?.port) !== TEST.serverPort
    ) throw new Error('Connected server is not the Wallet Core disposable cluster');
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function canonicalSources() {
  const actualPriceMigrations = (await readdir(PRICE_MIGRATIONS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actualPriceMigrations) !== JSON.stringify(PRICE_MIGRATIONS)) {
    throw new Error('Canonical Price migration set or order changed');
  }
  const auditSources = await Promise.all([AUDIT_MIGRATION,AUDIT_RECONCILIATION_MIGRATION]
    .map(file=>readFile(file,'utf8')));
  const priceSources = [];
  for (const name of PRICE_MIGRATIONS) {
    priceSources.push(await readFile(resolve(PRICE_MIGRATIONS_ROOT, name, 'migration.sql'), 'utf8'));
  }
  const actualWallet = (await readdir(resolve(__dirname, 'migrations'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (JSON.stringify(actualWallet) !== JSON.stringify(WALLET_MIGRATIONS)) throw new Error('Canonical Wallet migration set or order changed');
  const walletSources = await Promise.all(WALLET_MIGRATIONS.map(name => readFile(resolve(__dirname, 'migrations', name, 'migration.sql'), 'utf8')));
  return { auditSources, priceSources, walletSources };
}

function mapWalletMigration(source) {
  const wallet = mapSchemaIdentifiers(source, 'wallet_core', 'wallet_core_test');
  return hasSchemaTarget(wallet, 'price_conversion')
    ? mapSchemaIdentifiers(wallet, 'price_conversion', 'price_conversion_test') : wallet;
}

/** Applies only the approved forward preference migration; never invokes the reset/provision path. */
async function applyWalletCoreTestPreferenceMigration(env = process.env, open = connect, inspect = inspectDocker) {
  const pool = await assertSafeWalletCoreTestDatabase(env, open, inspect);
  try {
    const source = await readFile(resolve(__dirname, 'migrations', WALLET_MIGRATIONS[1], 'migration.sql'), 'utf8');
    const sql = mapWalletMigration(source);
    assertMappedSql(sql);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE wallet_core_test.user_preferences IN ACCESS EXCLUSIVE MODE');
      const applied = await client.query(`SELECT 1 FROM pg_constraint
        WHERE conrelid='wallet_core_test.user_preferences'::regclass AND conname='user_preferences_nonempty'`);
      if (!applied.rows.length) await client.query(sql);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

/** Forward-only runtime upgrade on the exact guarded disposable target; never resets schemas. */
async function applyWalletCoreTestRuntimeMigration(env = process.env) {
  const pool = await assertSafeWalletCoreTestDatabase(env);
  try {
    const applied = await pool.query(`SELECT 1 FROM pg_constraint
      WHERE conrelid='wallet_core_test.delisting_executions'::regclass
        AND conname='delisting_executions_positive_revision'`);
    if (applied.rows.length) return;
    const source = await readFile(resolve(__dirname, 'migrations', WALLET_MIGRATIONS[2], 'migration.sql'), 'utf8');
    const sql = mapWalletMigration(source);
    assertMappedSql(sql);
    const client = await pool.connect();
    try { await client.query(sql); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}
/** Adds only the approved canonical audit recovery condition on the guarded disposable database. */
async function applyWalletCoreTestAuditReconciliationMigration(env=process.env) {
  const pool=await assertSafeWalletCoreTestDatabase(env);
  const client=await pool.connect();
  try {
    const sql=mapSchemaIdentifiers(await readFile(AUDIT_RECONCILIATION_MIGRATION,'utf8'),'admin','admin_test');
    assertMappedSql(sql);await client.query(sql);
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();await pool.end();}
}

/** Completes only the known disposable BTC legacy seed; never invents a production binding. */
async function seedWalletCoreContractFixture(client) {
  const identity=(await client.query(IDENTITY_SQL)).rows[0];
  if (identity?.database!==TEST.databaseName || identity?.cluster!==TEST.clusterName
    || Number(identity?.port)!==TEST.serverPort) throw new Error('Contract fixture requires disposable Wallet cluster');
  await client.query(`INSERT INTO wallet_core_test.currency_settings(currency_id)
    SELECT id FROM price_conversion_test.currencies ON CONFLICT(currency_id) DO NOTHING`);
  const unresolved=await client.query(`SELECT legacy.currency_id,currency.symbol,legacy.chain_code
    FROM wallet_core_test.legacy_currency_chain_codes legacy JOIN price_conversion_test.currencies currency
      ON currency.id=legacy.currency_id WHERE legacy.mapped_binding_id IS NULL`);
  for (const row of unresolved.rows) {
    if (row.symbol!=='BTC' || row.chain_code!=='btc') throw new Error('Unexpected disposable legacy binding');
    const providerId=String(BigInt(Date.now())*1000n+BigInt(process.pid));
    const chain=(await client.query(`INSERT INTO wallet_core_test.chains
      (provider_chain_id,short_name,name,is_evm) VALUES ($1::bigint,'FIX'||$1::text,'Disposable contract Bitcoin',false)
      RETURNING id`,[providerId])).rows[0].id;
    const binding=(await client.query(`INSERT INTO wallet_core_test.currencies
      (currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
      VALUES ($1,$2,$3,false,true,8) RETURNING id`,[row.currency_id,chain,providerId])).rows[0].id;
    await client.query(`UPDATE wallet_core_test.legacy_currency_chain_codes SET mapped_binding_id=$1
      WHERE currency_id=$2 AND chain_code='btc'`,[binding,row.currency_id]);
  }
}

async function provisionWalletCoreTestDatabase(env = process.env) {
  const pool = await assertSafeWalletCoreTestDatabase(env);
  try {
    const { auditSources, priceSources, walletSources } = await canonicalSources();
    const auditSql = auditSources.map(source =>
      mapSchemaIdentifiers(source, 'admin', 'admin_test'));
    const priceSql = priceSources.map((source) =>
      mapSchemaIdentifiers(source, 'price_conversion', 'price_conversion_test'));
    const walletSql = walletSources.map(mapWalletMigration);
    for (const sql of [...auditSql, ...priceSql, ...walletSql]) assertMappedSql(sql);

    const auditClient=await pool.connect();
    try { await applyMappedAuditBootstrap(auditClient,auditSql); }
    finally { auditClient.release(); }
    for (const sql of priceSql) await pool.query(sql);
    await pool.query(`INSERT INTO price_conversion_test.currencies
      (symbol,name,decimals,kind,status,chain_codes,binance_symbol,viewable)
      VALUES ('USD','US Dollar',2,'FIAT','ACTIVE','{}',NULL,true),
        ('BTC','Bitcoin',8,'CRYPTO','DISABLED',ARRAY['btc'],'BTC',true)`);
    for (const sql of walletSql.slice(0,3)) await pool.query(sql);
    // Runtime gates use the complete deployed layout. Explicit migration tests may request the expand fixture.
    if (env.WALLET_CORE_TEST_LEGACY_LAYOUT!=='true') {
      const client=await pool.connect();
      try { await seedWalletCoreContractFixture(client); for (const sql of walletSql.slice(3)) await client.query(sql); }
      finally { client.release(); }
    }
    await pool.query('CREATE SCHEMA ledger_test');

    const result = await pool.query(`SELECT
      to_regclass('admin_test.admin_audit_events') IS NOT NULL AS audit_ok,
      to_regclass('price_conversion_test.price_providers') IS NOT NULL AS price_ok,
      to_regclass('wallet_core_test.wallet_settings') IS NOT NULL AS wallet_ok,
      (SELECT count(*) = 0 FROM information_schema.tables
        WHERE table_schema = 'ledger_test') AS ledger_empty`);
    if (result.rows.length !== 1 || !result.rows[0]?.audit_ok || !result.rows[0]?.price_ok
      || !result.rows[0]?.wallet_ok || !result.rows[0]?.ledger_empty) {
      throw new Error('Wallet Core prerequisite deployment verification failed');
    }
  } finally {
    await pool.end();
  }
}

module.exports = {
  assertSafeWalletCoreTestDatabase,
  provisionWalletCoreTestDatabase,
  applyWalletCoreTestPreferenceMigration,
  applyWalletCoreTestRuntimeMigration,
  applyWalletCoreTestAuditReconciliationMigration,
  seedWalletCoreContractFixture,
  validateEnvironment,
  validateDockerInspection,
  mapSchemaIdentifiers,
  mapWalletMigration,
  unwrapMigrationTransaction,
  applyMappedAuditBootstrap,
  verifyMappedSql,
  assertMappedSql,
  walletCoreTestDatabase: TEST,
};

if (require.main === module) {
  provisionWalletCoreTestDatabase()
    .then(() => console.log('isolated Wallet Core test database provisioned'))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Wallet Core provisioning failed');
      process.exitCode = 1;
    });
}
