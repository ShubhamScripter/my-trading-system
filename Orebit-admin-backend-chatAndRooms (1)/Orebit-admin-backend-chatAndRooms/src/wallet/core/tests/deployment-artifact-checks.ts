import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {TABLES} from './deployment-fixtures.js';

export async function assertProviderArtifacts(migrationPath:string,schemaPath:string):Promise<void> {
  const sql=await readFile(migrationPath,'utf8'); const schema=await readFile(schemaPath,'utf8');
  const catalogue=/CREATE TABLE wallet_core\.provider_catalogue_currencies \(([\s\S]*?)\n\);/.exec(sql)?.[1];
  assert.ok(catalogue,'provider currency catalogue table is required');
  assert.match(catalogue,/\bis_stake BOOLEAN NOT NULL\b/);
  assert.doesNotMatch(catalogue,/\bis_stake BOOLEAN NOT NULL DEFAULT\b/);
  assert.match(schema,/\bisStake\s+Boolean\s+@map\("is_stake"\)/);
  assert.match(sql,/provider_catalogue_revision BIGINT NOT NULL DEFAULT 0 CHECK \(provider_catalogue_revision >= 0\)/);
  assert.match(schema,/providerCatalogueRevision\s+BigInt\s+@default\(0\)\s+@map\("provider_catalogue_revision"\)/);
}
export async function assertPriceEnumArtifacts(schemaPath:string):Promise<void> {
  const schema=await readFile(schemaPath,'utf8');
  assert.match(schema,/enum CurrencyKind \{[\s\S]*?CRYPTO[\s\S]*?FIAT[\s\S]*?@@schema\("price_conversion"\)/);
  assert.match(schema,/enum CurrencyStatus \{[\s\S]*?ACTIVE[\s\S]*?DISABLED[\s\S]*?@@schema\("price_conversion"\)/);
  assert.match(schema,/kind\s+CurrencyKind\b/);
  assert.match(schema,/pricingStatus\s+CurrencyStatus\s+@map\("pricing_status"\)/);
}

export async function assertExpandArtifacts(migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8');
  const forwardTables = new Set(['wallet_logo_asset_references', 'wallet_logo_assets']);
  for (const table of TABLES.filter((name) => !forwardTables.has(name))) assert.match(sql,
    new RegExp(`CREATE TABLE wallet_core\\.${table}\\b`, 'i'), table);
  assert.match(sql, /ALTER TABLE price_conversion\.currencies RENAME COLUMN status TO pricing_status/i);
  assert.match(sql, /CHECK \(decimals = 18\)/i);
  assert.match(sql, /blockchain_precision[^;]*BETWEEN 0 AND 18/is);
  assert.match(sql, /UNIQUE \(currency_id, chain_id\)/i);
  assert.match(sql, /is_token AND token_contract_address IS NOT NULL/is);
  assert.match(sql, /reconciliation_alert_percent NUMERIC NOT NULL DEFAULT 5\.000/is);
  assert.match(sql, /scale\(reconciliation_alert_percent\) <= 3/i);
  assert.match(sql, /SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD/g);
  assert.match(sql, /draft_guard_key SMALLINT GENERATED ALWAYS AS[\s\S]*configuration_changes_one_draft[\s\S]*DEFERRABLE INITIALLY DEFERRED/i); assert.doesNotMatch(sql, /validate_single_configuration_draft|single_configuration_draft/);
  assert.match(sql, /UNIQUE \(job_name, scheduled_for\)/i);
  assert.match(sql, /after_delist_mode VARCHAR\(32\)/i);
  assert.match(sql, /CASE WHEN currency\.kyc_required AND currency\.access_level::text = 'ALL'/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*10000/is);
  assert.match(sql,
    /CASE WHEN NEW\.kind IN \('HOT','COLD'\)\s+THEN 'LIQUID' ELSE 'STAKING' END/is,
    'HOT and COLD must share the concurrency lock group');
  assert.doesNotMatch(sql, /CREATE TABLE (?:admin|price_conversion)\./i);
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?FUNCTION admin\./i);
  const precisionUpdate = sql.indexOf('UPDATE price_conversion.currencies SET decimals = 18');
  const constraintFlush = sql.indexOf('SET CONSTRAINTS ALL IMMEDIATE', precisionUpdate);
  const statusRename = sql.indexOf('RENAME COLUMN status TO pricing_status');
  assert.ok(precisionUpdate >= 0 && constraintFlush > precisionUpdate
    && statusRename > constraintFlush,
  'deferred Price checks must run before renaming their status dependency');
}

export async function assertPackageArtifacts(moduleRoot: string, TEST_URL: string): Promise<void> {
  const pkg = JSON.parse(await readFile(resolve(moduleRoot, 'package.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(pkg.engines, { node: '>=20.9.0', npm: '>=10.0.0' });
  assert.deepEqual(pkg.dependencies, {
    '@fastify/multipart': '10.1.1', '@nestjs/common': '11.2.3', '@nestjs/core': '11.2.3',
    '@nestjs/platform-fastify': '11.2.3', fastify: '5.12.1', pg: '8.23.0',
    'reflect-metadata': '0.2.2', rxjs: '7.8.2', sharp: '0.35.0', zod: '3.25.76',
  });
  assert.deepEqual(pkg.devDependencies, {
    '@fastify/cookie': '11.1.2', '@nestjs/testing': '11.2.3',
    '@types/node': '22.20.1', '@types/pg': '8.23.1', prisma: '6.19.3',
    tsx: '4.23.12', typescript: '5.9.3',
  });
  assert.deepEqual(pkg.overrides, {
    '@nestjs/platform-fastify': { fastify: '5.12.1' },
    '@prisma/config': { 'deepmerge-ts': '8.0.2' },
  });
  assert.equal(pkg.scripts.test,
    'npm run check && npm run test:docker-config && npm run test:database-safety && '
    + 'npm run test:provision && node --import tsx --test --test-concurrency=1 "tests/*.spec.ts"');
  const tsconfig = JSON.parse(await readFile(resolve(moduleRoot, 'tsconfig.json'), 'utf8'));
  assert.deepEqual(tsconfig.include, ['./*.ts', 'tests/**/*.ts']);
  const env = await readFile(resolve(moduleRoot, '.env.example'), 'utf8');
  assert.deepEqual(env.trim().split(/\r?\n/), [
    'WALLET_CORE_DATABASE_URL=', 'WALLET_CORE_DATABASE_DIRECT_URL=',
    `WALLET_CORE_TEST_DATABASE_URL=${TEST_URL}`, 'WALLET_CORE_TEST_ALLOW_RESET=false',
    'WALLET_CATALOGUE_MAX_CHAINS=100',
    'WALLET_CATALOGUE_MAX_COINS_PER_CHAIN=2000',
    'WALLET_CATALOGUE_MAX_COINS_PER_REFRESH=10000',
    'WALLET_CATALOGUE_MAX_DECODED_PAGE_BYTES=2097152',
    'WALLET_CATALOGUE_MAX_DECODED_REFRESH_BYTES=67108864',
    'WALLET_LOGO_STORAGE_ROOT=', 'WALLET_LOGO_PUBLIC_BASE_URL=',
    'WALLET_WORKER_INSTANCE_ID=',
  ]);
  const compose = await readFile(resolve(moduleRoot, 'docker-compose.test.yml'), 'utf8');
  for (const expected of [
    'name: orebit-wallet-core-test', 'image: postgres:17.6-alpine',
    'container_name: orebit-wallet-core-postgres-test',
    'cluster_name=orebit_wallet_core_test', '127.0.0.1:55435:5432',
  ]) assert.ok(compose.includes(expected), expected);
  assert.doesNotMatch(compose, /volumes:/);
}

export async function assertMigrationArtifacts(moduleRoot: string): Promise<void> {
  const source = await readFile(resolve(moduleRoot, 'provision-test-database.cjs'), 'utf8');
  const audit = source.indexOf('202609030001_global_admin_audit_events');
  const price = source.indexOf('20260831000000_canonical_price_conversion');
  const priceLast = source.indexOf('20260901000013_reference_mutation_guard');
  const wallet = source.indexOf('20260903000000_wallet_core_expand');
  assert.ok(audit >= 0 && price > audit && priceLast > price && wallet > priceLast);
  assert.match(source, /admin_test.*price_conversion_test.*wallet_core_test.*ledger_test/s);
  assert.doesNotMatch(source, /replaceAll\s*\(/);
  assert.match(source, /assertMappedSql|verifyMappedSql/);
  assert.match(source, /DROP SCHEMA IF EXISTS admin_test CASCADE[\s\S]*price_conversion_test[\s\S]*wallet_core_test[\s\S]*ledger_test/i);
}

export async function assertUnmountedArtifacts(moduleRoot: string, adminRoot: string): Promise<void> {
  const [app, routes, openapi, packageText, names] = await Promise.all([
    ...['app.module.ts', 'app.routes.ts'].map((name) => readFile(resolve(adminRoot, 'src', name), 'utf8')),
    readFile(resolve(adminRoot, 'openapi.json'), 'utf8'), readFile(resolve(adminRoot, 'package.json'), 'utf8'), readdir(moduleRoot, { recursive: true })]) as [string, string, string, string, string[]];
  assert.doesNotMatch(app + routes + openapi, /(?:wallet[\\/]core|WalletCoreModule|WalletCoreRoutes|\/v1\/admin\/wallet\/core)/);
  assert.match(String(JSON.parse(packageText).scripts?.['db:migrate']), /migrat/i);
  const authored = names.map(String).filter((name) => /\.(?:ts|cts|mjs)$/.test(name)
    && !/(?:^|[\\/])(?:node_modules|migrations|dist|\.test-dist|\.review-baseline)(?:[\\/]|$)/.test(name));
  for (const name of authored.filter((name) => !/^tests[\\/]/.test(name) && /worker/i.test(name))) assert.doesNotMatch(await readFile(resolve(moduleRoot, name), 'utf8'), /\bsetInterval\s*\(/, name);
  for (const name of authored.filter((name) => !/^tests[\\/]/.test(name))) assert.doesNotMatch(await readFile(resolve(moduleRoot, name), 'utf8'), /CREATE\s+(?:TABLE|FUNCTION)[\s\S]*?\badmin\./i, name);
}
