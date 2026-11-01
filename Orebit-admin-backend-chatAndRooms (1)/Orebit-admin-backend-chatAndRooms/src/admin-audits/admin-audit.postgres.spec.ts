import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe } from 'node:test';

import { registerAdminAuditActionMatrixTests } from './admin-audit.postgres.action-matrix-tests.js';
import { registerAdminAuditActionRuleTests } from './admin-audit.postgres.action-rule-tests.js';
import { type LiveTestContext, type PoolLike } from './admin-audit.postgres.fixtures.js';
import { loadGuard, registerAdminAuditGuardTests } from './admin-audit.postgres.guard-tests.js';
import { registerAdminAuditPayloadLimitTests } from './admin-audit.postgres.payload-limit-tests.js';
import { registerAdminAuditPayloadValidationTests } from './admin-audit.postgres.payload-validation-tests.js';
import { registerAdminAuditPersistenceTests } from './admin-audit.postgres.persistence-tests.js';
import { registerAdminAuditRoleTests } from './admin-audit.postgres.role-tests.js';
import { registerAdminAuditSchemaTests } from './admin-audit.postgres.schema-tests.js';

registerAdminAuditGuardTests();

const LIVE_DATABASE_TESTS =
  process.env.NODE_ENV === 'test' &&
  process.env.ADMIN_AUDIT_TEST_ALLOW_RESET === 'true' &&
  Boolean(process.env.ADMIN_AUDIT_TEST_DATABASE_URL);
describe('global admin audit PostgreSQL contract', { skip: !LIVE_DATABASE_TESTS }, () => {
  let pool: PoolLike;
  let migrationSql: string;
  let membershipSql: string;
  const context: LiveTestContext = {
    get pool() {
      return pool;
    },
    get migrationSql() {
      return migrationSql;
    },
    get membershipSql() {
      return membershipSql;
    },
  };

  before(async () => {
    const assertSafeAdminAuditTestDatabase = await loadGuard();
    pool = await assertSafeAdminAuditTestDatabase(process.env);
    await pool.query('DROP SCHEMA IF EXISTS admin CASCADE');
    migrationSql = await readFile(
      resolve(__dirname, 'migrations/202609030001_global_admin_audit_events/migration.sql'),
      'utf8',
    );
    await pool.query(migrationSql);
    const reconciliationMigrationSql = await readFile(
      resolve(__dirname, 'migrations/20260906000001_reconciliation_inactive_null/migration.sql'),
      'utf8',
    );
    await pool.query(reconciliationMigrationSql);

    await pool.query(`DO $test_roles$
      BEGIN
        IF to_regrole('orebit_admin_audit_public_probe') IS NULL THEN
          CREATE ROLE orebit_admin_audit_public_probe NOLOGIN;
        END IF;
        IF to_regrole('orebit_admin_runtime') IS NULL THEN
          CREATE ROLE orebit_admin_runtime LOGIN PASSWORD 'local_admin_audit_test_only';
        END IF;
        IF to_regrole('orebit_wallet_core_user_runtime') IS NULL THEN
          CREATE ROLE orebit_wallet_core_user_runtime LOGIN PASSWORD 'local_wallet_audit_test_only';
        END IF;
        IF to_regrole('orebit_deposit_user_runtime') IS NULL THEN
          CREATE ROLE orebit_deposit_user_runtime LOGIN PASSWORD 'local_deposit_audit_test_only';
        END IF;
        IF to_regrole('orebit_admin_audit_history_runtime') IS NULL THEN
          CREATE ROLE orebit_admin_audit_history_runtime LOGIN PASSWORD 'local_history_audit_test_only';
        END IF;
        IF to_regrole('orebit_admin_audit_graph_group') IS NULL THEN
          CREATE ROLE orebit_admin_audit_graph_group NOLOGIN;
        END IF;
        IF to_regrole('orebit_admin_audit_graph_admin') IS NULL THEN
          CREATE ROLE orebit_admin_audit_graph_admin NOLOGIN CREATEROLE;
        END IF;
        IF to_regrole('orebit_admin_audit_schema_creator') IS NULL THEN
          CREATE ROLE orebit_admin_audit_schema_creator NOLOGIN;
        END IF;
        IF to_regrole('orebit_admin_audit_function_executor') IS NULL THEN
          CREATE ROLE orebit_admin_audit_function_executor NOLOGIN;
        END IF;
        IF to_regrole('orebit_admin_audit_harmless_parent') IS NULL THEN
          CREATE ROLE orebit_admin_audit_harmless_parent NOLOGIN;
        END IF;
        IF to_regrole('orebit_admin_audit_set_parent') IS NULL THEN
          CREATE ROLE orebit_admin_audit_set_parent NOLOGIN;
        END IF;
      END;
      $test_roles$;
      ALTER ROLE orebit_admin_audit_public_probe NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
      ALTER ROLE orebit_wallet_core_user_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
      ALTER ROLE orebit_deposit_user_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
      ALTER ROLE orebit_admin_audit_history_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
      ALTER ROLE orebit_admin_audit_graph_group NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_audit_graph_admin NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_audit_schema_creator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_audit_function_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_audit_harmless_parent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      ALTER ROLE orebit_admin_audit_set_parent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      REVOKE orebit_admin_audit_writer, orebit_admin_audit_reader FROM orebit_admin_audit_public_probe;
      GRANT CREATE ON SCHEMA admin TO orebit_admin_audit_schema_creator;
      GRANT EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(
        uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
      ) TO orebit_admin_audit_function_executor;
    `);
    membershipSql = await readFile(resolve(__dirname, 'production-role-memberships.sql'), 'utf8');
    await pool.query(membershipSql);
  });

  after(async () => {
    if (!pool) return;
    try {
      await pool.query(`
        REVOKE orebit_admin_audit_owner, orebit_admin_audit_writer, orebit_admin_audit_reader
          FROM orebit_admin_audit_public_probe, orebit_admin_audit_graph_group,
            orebit_admin_audit_history_runtime, orebit_admin_runtime,
            orebit_wallet_core_user_runtime, orebit_deposit_user_runtime;
        REVOKE orebit_admin_audit_graph_group FROM orebit_admin_audit_public_probe;
        REVOKE orebit_admin_audit_graph_admin
          FROM orebit_admin_audit_owner, orebit_admin_audit_writer, orebit_admin_audit_reader;
        REVOKE pg_write_all_data, pg_read_all_data, orebit_admin_audit_schema_creator,
          orebit_admin_audit_function_executor, orebit_admin_audit_harmless_parent,
          orebit_admin_audit_set_parent
          FROM orebit_admin_runtime, orebit_wallet_core_user_runtime,
            orebit_deposit_user_runtime, orebit_admin_audit_history_runtime;
        REVOKE pg_write_all_data FROM orebit_admin_audit_set_parent;
        REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_set_parent,
          orebit_admin_runtime, orebit_wallet_core_user_runtime,
          orebit_deposit_user_runtime, orebit_admin_audit_history_runtime;
        ALTER ROLE orebit_admin_audit_set_parent NOLOGIN NOSUPERUSER NOCREATEDB
          NOCREATEROLE NOINHERIT NOBYPASSRLS;
        REVOKE CREATE ON SCHEMA admin FROM orebit_admin_audit_schema_creator;
        REVOKE EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(
          uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
        ) FROM orebit_admin_audit_function_executor;
        DROP ROLE IF EXISTS orebit_admin_audit_graph_group;
        DROP ROLE IF EXISTS orebit_admin_audit_graph_admin;
        DROP ROLE IF EXISTS orebit_admin_audit_schema_creator;
        DROP ROLE IF EXISTS orebit_admin_audit_function_executor;
        DROP ROLE IF EXISTS orebit_admin_audit_harmless_parent;
        DROP ROLE IF EXISTS orebit_admin_audit_set_parent;
      `);
    } finally {
      await pool.end();
    }
  });

  registerAdminAuditSchemaTests(context);
  registerAdminAuditRoleTests(context);
  registerAdminAuditActionMatrixTests(context);
  registerAdminAuditActionRuleTests(context);
  registerAdminAuditPayloadValidationTests(context);
  registerAdminAuditPayloadLimitTests(context);
  registerAdminAuditPersistenceTests(context);
});
