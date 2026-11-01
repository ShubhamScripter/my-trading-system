import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const TEST_DATABASE = 'orebit_admin_audit_test';
const TEST_CONTAINER = 'orebit-admin-audit-postgres-test';
const TEST_CLUSTER = 'orebit_admin_audit_test';
const TEST_HOST = '127.0.0.1';
const TEST_HOST_PORT = 55_434;
const INTERNAL_POSTGRES_PORT = 5_432;

const SERVER_IDENTITY_SQL = `SELECT current_database() AS "currentDatabase",
       current_setting('cluster_name') AS "clusterName",
       inet_server_addr()::text AS "serverAddress",
       inet_server_port() AS "serverPort"`;

function parsePostgresUrl(value, name) {
  if (!value) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must use PostgreSQL`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error(`${name} must include a database name`);
  return { url, database };
}

function normalizedHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' ? TEST_HOST : value;
}

function endpoint(url, database) {
  return {
    host: normalizedHost(url.hostname),
    port: Number(url.port || INTERNAL_POSTGRES_PORT),
    database,
  };
}

function assertDockerInspection(inspection) {
  const container = Array.isArray(inspection) ? inspection[0] : undefined;
  const bindings = container?.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    container?.Name !== `/${TEST_CONTAINER}`
    || container?.State?.Running !== true
    || !Array.isArray(bindings)
    || bindings.length !== 1
    || bindings[0]?.HostIp !== TEST_HOST
    || bindings[0]?.HostPort !== String(TEST_HOST_PORT)
  ) {
    throw new Error(`Docker must expose only ${TEST_CONTAINER} at ${TEST_HOST}:${TEST_HOST_PORT}`);
  }
}

async function inspectDedicatedDockerContainer() {
  const { stdout } = await execFileAsync('docker', ['inspect', TEST_CONTAINER]);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Docker inspection for ${TEST_CONTAINER} returned invalid JSON`);
  }
}

async function connectPool(connectionString) {
  return new pg.Pool({ connectionString });
}

export async function assertSafeAdminAuditTestDatabase(
  env = process.env,
  connect = connectPool,
  inspectDocker = inspectDedicatedDockerContainer,
) {
  if (env.NODE_ENV !== 'test') throw new Error('NODE_ENV must be test');
  if (env.ADMIN_AUDIT_TEST_ALLOW_RESET !== 'true') {
    throw new Error('ADMIN_AUDIT_TEST_ALLOW_RESET=true is required');
  }

  const test = parsePostgresUrl(env.ADMIN_AUDIT_TEST_DATABASE_URL, 'ADMIN_AUDIT_TEST_DATABASE_URL');
  const runtime = parsePostgresUrl(env.DATABASE_URL, 'DATABASE_URL');
  const directRuntime = parsePostgresUrl(env.DATABASE_DIRECT_URL, 'DATABASE_DIRECT_URL');
  const testEndpoint = endpoint(test.url, test.database);
  const schemas = test.url.searchParams.getAll('schema');

  if (
    test.url.hostname !== TEST_HOST
    || testEndpoint.port !== TEST_HOST_PORT
    || test.database !== TEST_DATABASE
    || schemas.length !== 1
    || schemas[0] !== 'admin'
  ) {
    throw new Error('ADMIN_AUDIT_TEST_DATABASE_URL must target the dedicated admin test database');
  }

  for (const [name, candidate] of [
    ['DATABASE_URL', endpoint(runtime.url, runtime.database)],
    ['DATABASE_DIRECT_URL', endpoint(directRuntime.url, directRuntime.database)],
  ]) {
    if (['127.0.0.1', '::1'].includes(candidate.host) && candidate.port === TEST_HOST_PORT) {
      throw new Error(`${name} must not use the dedicated admin audit test host port`);
    }
    if (
      candidate.host === testEndpoint.host
      && candidate.port === testEndpoint.port
      && candidate.database === testEndpoint.database
    ) {
      throw new Error(`${name} must not target the dedicated admin audit test database`);
    }
  }

  const inspection = await inspectDocker();
  assertDockerInspection(inspection);

  const pool = await connect(test.url.toString());
  try {
    const result = await pool.query(SERVER_IDENTITY_SQL);
    const identity = result.rows[0];
    if (
      identity?.currentDatabase !== TEST_DATABASE
      || identity?.clusterName !== TEST_CLUSTER
      || !identity?.serverAddress
      || Number(identity?.serverPort) !== INTERNAL_POSTGRES_PORT
    ) {
      throw new Error('connected server is not the dedicated admin audit test cluster');
    }
    console.log(`[admin-audit-test] container=${TEST_CONTAINER} database=${identity.currentDatabase} cluster=${identity.clusterName} server=${identity.serverAddress}:${identity.serverPort}`);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export const adminAuditTestDatabase = {
  TEST_DATABASE,
  TEST_CONTAINER,
  TEST_CLUSTER,
  TEST_HOST,
  TEST_HOST_PORT,
};
