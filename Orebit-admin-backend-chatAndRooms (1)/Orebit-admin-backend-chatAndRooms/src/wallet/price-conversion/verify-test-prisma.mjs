import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { validatePriceTestDatabaseEnvironment } = require('./provision-test-database.cjs');
const { connectionString } = validatePriceTestDatabaseEnvironment(process.env);
const executable = resolve('node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
const env = {
  ...process.env,
  PRICE_DATABASE_URL: connectionString,
  PRICE_DATABASE_DIRECT_URL: connectionString,
};

for (const args of [
  ['validate', '--schema', 'schema.test.prisma'],
  ['migrate', 'status', '--schema', 'schema.test.prisma'],
]) {
  const result = spawnSync(executable, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
