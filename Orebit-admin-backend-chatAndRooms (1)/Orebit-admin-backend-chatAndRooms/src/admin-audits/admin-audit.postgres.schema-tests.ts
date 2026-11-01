import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  UUID7_A,
  append,
  asRole,
  rejectsSqlState,
  settingsInput,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditSchemaTests(context: LiveTestContext) {
  it('creates only the canonical table, exact columns, indexes, roles, and hardened append function', async () => {
    const tables = await context.pool.query(`SELECT tablename FROM pg_tables
      WHERE schemaname = 'admin' ORDER BY tablename`);
    assert.deepEqual(tables.rows, [{ tablename: 'admin_audit_events' }]);

    const columns = await context.pool
      .query(`SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'admin' AND table_name = 'admin_audit_events'
      ORDER BY ordinal_position`);
    assert.deepEqual(
      columns.rows.map((row) => ({
        column_name: row.column_name,
        data_type: row.data_type,
        character_maximum_length: row.character_maximum_length,
        is_nullable: row.is_nullable,
      })),
      [
        { column_name: 'id', data_type: 'uuid', character_maximum_length: null, is_nullable: 'NO' },
        {
          column_name: 'event_key',
          data_type: 'character varying',
          character_maximum_length: 200,
          is_nullable: 'NO',
        },
        {
          column_name: 'event_hash',
          data_type: 'character',
          character_maximum_length: 64,
          is_nullable: 'NO',
        },
        {
          column_name: 'domain',
          data_type: 'character varying',
          character_maximum_length: 32,
          is_nullable: 'NO',
        },
        {
          column_name: 'action',
          data_type: 'character varying',
          character_maximum_length: 96,
          is_nullable: 'NO',
        },
        {
          column_name: 'actor_kind',
          data_type: 'character varying',
          character_maximum_length: 16,
          is_nullable: 'NO',
        },
        {
          column_name: 'actor_id',
          data_type: 'uuid',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'session_id',
          data_type: 'uuid',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'request_id',
          data_type: 'uuid',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'run_id',
          data_type: 'uuid',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'ip_address',
          data_type: 'inet',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'device_id',
          data_type: 'character varying',
          character_maximum_length: 128,
          is_nullable: 'YES',
        },
        {
          column_name: 'subject_type',
          data_type: 'character varying',
          character_maximum_length: 64,
          is_nullable: 'NO',
        },
        {
          column_name: 'subject_id',
          data_type: 'character varying',
          character_maximum_length: 128,
          is_nullable: 'NO',
        },
        {
          column_name: 'reason',
          data_type: 'character varying',
          character_maximum_length: 500,
          is_nullable: 'NO',
        },
        {
          column_name: 'before_json',
          data_type: 'jsonb',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'after_json',
          data_type: 'jsonb',
          character_maximum_length: null,
          is_nullable: 'YES',
        },
        {
          column_name: 'metadata_json',
          data_type: 'jsonb',
          character_maximum_length: null,
          is_nullable: 'NO',
        },
        {
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          character_maximum_length: null,
          is_nullable: 'NO',
        },
      ],
    );
    assert.match(String(columns.rows.at(-1)?.column_default), /now\(\)/);

    const indexes = await context.pool.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'admin' AND tablename = 'admin_audit_events' ORDER BY indexname`);
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      [
        'admin_audit_events_actor_created_idx',
        'admin_audit_events_created_idx',
        'admin_audit_events_domain_action_created_idx',
        'admin_audit_events_event_key_key',
        'admin_audit_events_pkey',
        'admin_audit_events_run_created_idx',
        'admin_audit_events_subject_created_idx',
      ],
    );

    const roles = await context.pool
      .query(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
      FROM pg_roles WHERE rolname IN ('orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader')
      ORDER BY rolname`);
    assert.equal(roles.rows.length, 3);
    for (const role of roles.rows) {
      assert.deepEqual(role, {
        rolname: role.rolname,
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
      });
    }

    const fn = await context.pool.query(`SELECT p.prosecdef, p.proconfig,
        pg_get_userbyid(p.proowner) AS owner, pg_get_function_identity_arguments(p.oid) AS args,
        pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'admin' AND p.proname = 'append_admin_audit_event_v1'`);
    assert.equal(fn.rows.length, 1);
    const functionMetadata = fn.rows[0];
    assert.ok(functionMetadata);
    assert.equal(functionMetadata.prosecdef, true);
    assert.deepEqual(functionMetadata.proconfig, ['search_path=pg_catalog, admin']);
    assert.equal(functionMetadata.owner, 'orebit_admin_audit_owner');
    assert.equal(
      functionMetadata.args,
      'p_id uuid, p_event_key text, p_domain text, p_action text, p_actor_kind text, p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_run_id uuid, p_ip_address inet, p_device_id text, p_subject_type text, p_subject_id text, p_reason text, p_before_json jsonb, p_after_json jsonb, p_metadata_json jsonb',
    );
    const definition = String(functionMetadata.definition);
    const eventKeyAssignment = definition.indexOf('v_event_key text :=');
    assert.ok(eventKeyAssignment >= 0);
    const afterEventKeyAssignment = definition.slice(
      definition.indexOf(';', eventKeyAssignment) + 1,
    );
    assert.doesNotMatch(afterEventKeyAssignment, /\bp_event_key\b/);
    assert.match(afterEventKeyAssignment, /VALUES \(\s*p_id, v_event_key,/);
    assert.match(afterEventKeyAssignment, /WHERE event_key = v_event_key/);
  });

  it('fails a migration rerun closed on contaminated audit-role graphs and remains atomic and one-time', async () => {
    await context.pool.query(`
      REVOKE orebit_admin_audit_writer FROM orebit_admin_runtime,
        orebit_wallet_core_user_runtime, orebit_deposit_user_runtime;
      REVOKE orebit_admin_audit_reader FROM orebit_admin_audit_history_runtime;
    `);
    try {
      const contaminations = [
        {
          add: 'GRANT orebit_admin_audit_writer TO orebit_admin_audit_public_probe',
          remove: 'REVOKE orebit_admin_audit_writer FROM orebit_admin_audit_public_probe',
        },
        {
          add: `GRANT orebit_admin_audit_reader TO orebit_admin_audit_graph_group;
            GRANT orebit_admin_audit_graph_group TO orebit_admin_audit_public_probe`,
          remove: `REVOKE orebit_admin_audit_graph_group FROM orebit_admin_audit_public_probe;
            REVOKE orebit_admin_audit_reader FROM orebit_admin_audit_graph_group`,
        },
        {
          add: 'GRANT orebit_admin_audit_owner TO orebit_admin_audit_public_probe WITH ADMIN OPTION',
          remove: 'REVOKE orebit_admin_audit_owner FROM orebit_admin_audit_public_probe',
        },
        {
          add: 'GRANT orebit_admin_audit_graph_admin TO orebit_admin_audit_writer',
          remove: 'REVOKE orebit_admin_audit_graph_admin FROM orebit_admin_audit_writer',
        },
        {
          add: 'ALTER ROLE orebit_admin_audit_reader CREATEROLE',
          remove: 'ALTER ROLE orebit_admin_audit_reader NOCREATEROLE',
        },
      ];
      for (const [index, contamination] of contaminations.entries()) {
        await context.pool.query(contamination.add);
        try {
          await rejectsSqlState(
            () => context.pool.query(context.migrationSql),
            'P0001',
            /ADMIN_AUDIT_ROLE_GRAPH_INVALID/,
            `migration role-graph contamination ${index}`,
          );
        } finally {
          await context.pool.query(contamination.remove);
        }
      }

      await context.pool.query('GRANT USAGE ON SCHEMA admin TO PUBLIC');
      try {
        await rejectsSqlState(
          () => context.pool.query(context.migrationSql),
          '42P07',
          undefined,
          'the migration is deliberately one-time under the migration ledger',
        );
        const atomic = await context.pool.query(`SELECT
          has_schema_privilege('orebit_admin_audit_public_probe', 'admin', 'USAGE') AS public_usage,
          to_regclass('admin.admin_audit_events') IS NOT NULL AS table_survived`);
        assert.deepEqual(atomic.rows, [{ public_usage: true, table_survived: true }]);
      } finally {
        await context.pool.query('REVOKE ALL ON SCHEMA admin FROM PUBLIC');
      }
    } finally {
      await context.pool.query(context.membershipSql);
    }
  });

  it('enforces the group-role privilege matrix and immutable owner boundary', async () => {
    const writerInput = settingsInput();
    const writerResult = await asRole(context.pool, 'orebit_admin_audit_writer', (client) =>
      append(client, writerInput),
    );
    assert.deepEqual(writerResult.rows, [{ audit_event_id: writerInput.id, replayed: false }]);

    for (const sql of [
      'SELECT * FROM admin.admin_audit_events',
      `INSERT INTO admin.admin_audit_events (id) VALUES ('${UUID7_A}')`,
      'UPDATE admin.admin_audit_events SET reason = reason',
      'DELETE FROM admin.admin_audit_events',
      'TRUNCATE admin.admin_audit_events',
    ]) {
      await rejectsSqlState(
        () => asRole(context.pool, 'orebit_admin_audit_writer', (client) => client.query(sql)),
        '42501',
      );
    }

    await asRole(context.pool, 'orebit_admin_audit_reader', (client) =>
      client.query('SELECT * FROM admin.admin_audit_events'),
    );
    await rejectsSqlState(
      () =>
        asRole(context.pool, 'orebit_admin_audit_reader', (client) =>
          append(client, settingsInput()),
        ),
      '42501',
    );
    for (const sql of [
      `INSERT INTO admin.admin_audit_events (id) VALUES ('${UUID7_A}')`,
      'UPDATE admin.admin_audit_events SET reason = reason',
      'DELETE FROM admin.admin_audit_events',
      'TRUNCATE admin.admin_audit_events',
    ]) {
      await rejectsSqlState(
        () => asRole(context.pool, 'orebit_admin_audit_reader', (client) => client.query(sql)),
        '42501',
      );
    }

    await rejectsSqlState(
      () =>
        asRole(context.pool, 'orebit_admin_audit_public_probe', (client) =>
          client.query('SELECT * FROM admin.admin_audit_events'),
        ),
      '42501',
    );
    await rejectsSqlState(
      () =>
        asRole(context.pool, 'orebit_admin_audit_public_probe', (client) =>
          append(client, settingsInput()),
        ),
      '42501',
    );

    for (const sql of [
      'UPDATE admin.admin_audit_events SET reason = reason',
      'DELETE FROM admin.admin_audit_events',
      'TRUNCATE admin.admin_audit_events',
    ]) {
      await rejectsSqlState(
        () => asRole(context.pool, 'orebit_admin_audit_owner', (client) => client.query(sql)),
        '55000',
        /ADMIN_AUDIT_IMMUTABLE/,
        `owner immutability: ${sql}`,
      );
    }

    const schemaPrivileges = await context.pool.query(`SELECT role_name,
        has_schema_privilege(role_name, 'admin', 'USAGE') AS can_use,
        has_schema_privilege(role_name, 'admin', 'CREATE') AS can_create
      FROM unnest(ARRAY['orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader']) role_name`);
    for (const row of schemaPrivileges.rows) {
      assert.equal(row.can_use, true);
      assert.equal(row.can_create, false);
    }
  });
}
