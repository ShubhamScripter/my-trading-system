import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';

export const OWNERSHIP_ROLES = ['orebit_wallet_core_admin_writer','orebit_wallet_core_user_writer',
  'orebit_wallet_core_lifecycle_writer','orebit_price_conversion_writer'] as const;
export const AUDIT_RUNTIMES = ['orebit_admin_runtime','orebit_wallet_core_user_runtime',
  'orebit_deposit_user_runtime','orebit_admin_audit_history_runtime'] as const;
export async function applyAuditMembershipFixture(client:pg.PoolClient):Promise<void> {
  // The canonical integration harness shares this cluster; isolate only its known test membership.
  // The caller's outer ROLLBACK restores it after the unmodified production role-graph proof.
  if((await client.query(`SELECT 1 FROM pg_roles WHERE rolname='wallet_lifecycle_test_worker'`)).rowCount)
    await client.query('REVOKE orebit_admin_audit_writer FROM wallet_lifecycle_test_worker');
  for (const role of AUDIT_RUNTIMES) {
    await client.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  }
  const source = await readFile(resolve(__dirname,'../../../admin-audits/production-role-memberships.sql'),'utf8');
  // Preserve the canonical template's checks/grants; only map its schema identifiers and regprocedure literals.
  const mapped=source
    .replace(/'admin\./g,"'admin_test.").replace(/'admin'/g,"'admin_test'")
    .replace(/^BEGIN;\s*/,'').replace(/\s*COMMIT;\s*$/,'');
  await client.query(mapped);
}
export async function ownershipSql(): Promise<string> {
  const guard = await import(pathToFileURL(resolve(__dirname,'../provision-test-database.cjs')).href) as {
    mapSchemaIdentifiers(sql:string,from:string,to:string):string;
  };
  let sql = await readFile(resolve(__dirname,'../migrations/20260906000003_wallet_core_contract/migration.sql'),'utf8');
  for (const schema of ['wallet_core','price_conversion']) sql=guard.mapSchemaIdentifiers(sql,schema,`${schema}_test`);
  return sql.replace(/^BEGIN;\s*/,'').replace(/\s*COMMIT;\s*$/,'');
}

/** Disposable seed completion only; callers own a rollback transaction and never commit these rows. */
export async function seedOwnershipBackfill(client:pg.PoolClient):Promise<void> {
  const guard = await import(pathToFileURL(resolve(__dirname,'../provision-test-database.cjs')).href) as {
    seedWalletCoreContractFixture(client:pg.PoolClient):Promise<void>;
  };
  await guard.seedWalletCoreContractFixture(client);
}

export async function applyOwnershipFixture(client:pg.PoolClient):Promise<void> {
  const legacy = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='price_conversion_test' AND table_name='currencies' AND column_name='viewable'`);
  if (!legacy.rowCount) return;
  await seedOwnershipBackfill(client);
  await client.query(await ownershipSql());
}
