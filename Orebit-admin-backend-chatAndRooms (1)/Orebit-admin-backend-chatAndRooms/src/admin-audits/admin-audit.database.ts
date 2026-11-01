import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';

const LOGIN = 'orebit_admin_audit_history_runtime';
const APPEND_FUNCTION = [
  'admin.append_admin_audit_event_v1(',
  'uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)',
].join('');

function configuration(): pg.PoolConfig {
  const connectionString = process.env.ADMIN_AUDIT_READER_DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('ADMIN_AUDIT_READER_DATABASE_URL is required');
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('ADMIN_AUDIT_READER_DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('ADMIN_AUDIT_READER_DATABASE_URL must use PostgreSQL');
  }
  if (
    decodeURIComponent(url.username) !== LOGIN
    || url.searchParams.getAll('schema').length !== 1
    || url.searchParams.get('schema') !== 'admin'
  ) {
    throw new Error(
      'ADMIN_AUDIT_READER_DATABASE_URL must authenticate the history runtime with schema=admin',
    );
  }
  return {
    connectionString,
    application_name: 'orebit-admin-audit-reader',
    max: 4,
    options: '-c search_path=admin',
  };
}

type CapabilityRow = {
  session_ok: boolean;
  schema_ok: boolean;
  table_ok: boolean;
  membership_ok: boolean;
  can_select: boolean;
  forbidden_role: boolean;
  can_mutate: boolean;
  can_create: boolean;
  can_append: boolean;
};

const CAPABILITY_SQL = [
  'WITH RECURSIVE reachable AS (',
  'SELECT role.oid, role.rolname, role.rolsuper, role.rolcreatedb,',
  'role.rolcreaterole, role.rolbypassrls FROM pg_roles role',
  'WHERE role.rolname = current_user',
  'UNION',
  'SELECT granted.oid, granted.rolname, granted.rolsuper, granted.rolcreatedb,',
  'granted.rolcreaterole, granted.rolbypassrls FROM reachable child',
  'JOIN pg_auth_members membership ON membership.member = child.oid',
  'AND (membership.inherit_option OR membership.set_option)',
  'JOIN pg_roles granted ON granted.oid = membership.roleid',
  '), capabilities AS (',
  'SELECT bool_or(role.rolsuper OR role.rolcreatedb OR role.rolcreaterole',
  'OR role.rolbypassrls) AS forbidden_role,',
  'bool_or(',
  "has_table_privilege(role.rolname, 'admin.admin_audit_events', 'INSERT')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'UPDATE')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'DELETE')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'TRUNCATE')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'TRIGGER')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'REFERENCES')",
  "OR has_table_privilege(role.rolname, 'admin.admin_audit_events', 'MAINTAIN')",
  ') AS can_mutate,',
  "bool_or(has_schema_privilege(role.rolname, 'admin', 'CREATE')) AS can_create,",
  "bool_or(has_function_privilege(role.rolname, $1, 'EXECUTE')) AS can_append",
  'FROM reachable role',
  ') SELECT',
  'session_user = $2 AND current_user = $2 AS session_ok,',
  "current_schema() = 'admin' AS schema_ok,",
  "to_regclass('admin.admin_audit_events') = 'admin.admin_audit_events'::regclass AS table_ok,",
  'EXISTS (SELECT 1 FROM pg_auth_members membership',
  'JOIN pg_roles member ON member.oid = membership.member',
  'JOIN pg_roles granted ON granted.oid = membership.roleid',
  'WHERE member.rolname = $2',
  "AND granted.rolname = 'orebit_admin_audit_reader'",
  'AND NOT membership.admin_option AND membership.inherit_option',
  'AND membership.set_option) AS membership_ok,',
  "has_table_privilege(current_user, 'admin.admin_audit_events', 'SELECT') AS can_select,",
  'capabilities.* FROM capabilities',
].join('\n');

@Injectable()
export class AdminAuditDatabase extends pg.Pool
implements OnModuleInit, OnModuleDestroy {
  private closed = false;

  constructor() {
    super(configuration());
  }

  async onModuleInit(): Promise<void> {
    try {
      const { rows } = await this.query<CapabilityRow>(
        CAPABILITY_SQL,
        [APPEND_FUNCTION, LOGIN],
      );
      const row = rows[0];
      if (
        rows.length !== 1
        || !row?.session_ok
        || !row.schema_ok
        || !row.table_ok
        || !row.membership_ok
        || !row.can_select
        || row.forbidden_role
        || row.can_mutate
        || row.can_create
        || row.can_append
      ) throw new Error('ADMIN_AUDIT_READER_CAPABILITY_INVALID');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.end();
  }
}
