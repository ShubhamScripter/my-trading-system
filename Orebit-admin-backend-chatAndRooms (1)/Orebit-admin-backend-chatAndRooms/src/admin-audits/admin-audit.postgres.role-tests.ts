import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  append,
  asRole,
  rejectsSqlState,
  settingsInput,
  type LiveTestContext,
} from './admin-audit.postgres.fixtures.js';

export function registerAdminAuditRoleTests(context: LiveTestContext) {
  it('applies only the exact validated runtime memberships and capabilities', async () => {
    const memberships = await context.pool
      .query(`SELECT member.rolname AS member, granted.rolname AS granted
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE member.rolname IN ('orebit_admin_runtime','orebit_wallet_core_user_runtime',
        'orebit_deposit_user_runtime','orebit_admin_audit_history_runtime')
        AND granted.rolname IN ('orebit_admin_audit_writer','orebit_admin_audit_reader')
      ORDER BY member.rolname, granted.rolname`);
    assert.deepEqual(memberships.rows, [
      { member: 'orebit_admin_audit_history_runtime', granted: 'orebit_admin_audit_reader' },
      { member: 'orebit_admin_runtime', granted: 'orebit_admin_audit_writer' },
      { member: 'orebit_deposit_user_runtime', granted: 'orebit_admin_audit_writer' },
      { member: 'orebit_wallet_core_user_runtime', granted: 'orebit_admin_audit_writer' },
    ]);

    const runtimeRoles = await context.pool.query(`SELECT rolname, rolcanlogin, rolinherit,
        rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles
      WHERE rolname IN ('orebit_admin_runtime','orebit_wallet_core_user_runtime',
        'orebit_deposit_user_runtime','orebit_admin_audit_history_runtime')
      ORDER BY rolname`);
    assert.equal(runtimeRoles.rows.length, 4);
    for (const role of runtimeRoles.rows) {
      assert.deepEqual(role, {
        rolname: role.rolname,
        rolcanlogin: true,
        rolinherit: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
    }

    const membershipOptions = await context.pool.query(`SELECT member.rolname AS member,
        granted.rolname AS granted, membership.admin_option, membership.inherit_option,
        membership.set_option
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE granted.rolname IN ('orebit_admin_audit_owner','orebit_admin_audit_writer',
        'orebit_admin_audit_reader')
      ORDER BY member.rolname, granted.rolname`);
    assert.deepEqual(membershipOptions.rows, [
      {
        member: 'orebit_admin_audit_history_runtime',
        granted: 'orebit_admin_audit_reader',
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
      {
        member: 'orebit_admin_runtime',
        granted: 'orebit_admin_audit_writer',
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
      {
        member: 'orebit_deposit_user_runtime',
        granted: 'orebit_admin_audit_writer',
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
      {
        member: 'orebit_wallet_core_user_runtime',
        granted: 'orebit_admin_audit_writer',
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
    ]);

    const contaminations = [
      {
        add: 'GRANT orebit_admin_audit_owner TO orebit_admin_audit_history_runtime',
        remove: 'REVOKE orebit_admin_audit_owner FROM orebit_admin_audit_history_runtime',
      },
      {
        add: 'GRANT orebit_admin_audit_reader TO orebit_admin_audit_public_probe',
        remove: 'REVOKE orebit_admin_audit_reader FROM orebit_admin_audit_public_probe',
      },
      {
        add: 'GRANT orebit_admin_runtime TO orebit_admin_audit_public_probe',
        remove: 'REVOKE orebit_admin_runtime FROM orebit_admin_audit_public_probe',
      },
      {
        add: 'GRANT orebit_admin_audit_writer TO orebit_admin_runtime WITH ADMIN OPTION',
        remove: 'REVOKE orebit_admin_audit_writer FROM orebit_admin_runtime',
      },
    ];
    for (const [index, contamination] of contaminations.entries()) {
      await context.pool.query(contamination.add);
      try {
        await rejectsSqlState(
          () => context.pool.query(context.membershipSql),
          'P0001',
          /ADMIN_AUDIT_RUNTIME_ROLE_GRAPH_INVALID/,
          `production membership contamination ${index}`,
        );
      } finally {
        await context.pool.query(contamination.remove);
        await context.pool.query(context.membershipSql);
      }
    }

    await context.pool.query(context.membershipSql);
    const rerunMemberships = await context.pool.query(`SELECT count(*)::int AS count
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE granted.rolname IN ('orebit_admin_audit_owner','orebit_admin_audit_writer',
        'orebit_admin_audit_reader')`);
    assert.deepEqual(rerunMemberships.rows, [{ count: 4 }]);

    for (const role of [
      'orebit_admin_runtime',
      'orebit_wallet_core_user_runtime',
      'orebit_deposit_user_runtime',
    ]) {
      const input = settingsInput();
      const result = await asRole(context.pool, role, (client) => append(client, input));
      assert.deepEqual(result.rows, [{ audit_event_id: input.id, replayed: false }]);
      await rejectsSqlState(
        () =>
          asRole(context.pool, role, (client) =>
            client.query('SELECT * FROM admin.admin_audit_events'),
          ),
        '42501',
      );
      await rejectsSqlState(
        () =>
          asRole(context.pool, role, (client) =>
            client.query('DELETE FROM admin.admin_audit_events'),
          ),
        '42501',
      );
    }
    await asRole(context.pool, 'orebit_admin_audit_history_runtime', (client) =>
      client.query('SELECT * FROM admin.admin_audit_events'),
    );
    await rejectsSqlState(
      () =>
        asRole(context.pool, 'orebit_admin_audit_history_runtime', (client) =>
          append(client, settingsInput()),
        ),
      '42501',
    );

    await context.pool.query('ALTER ROLE orebit_admin_runtime NOINHERIT');
    try {
      await rejectsSqlState(
        () => context.pool.query(context.membershipSql),
        'P0001',
        /ADMIN_AUDIT_RUNTIME_ROLE_INVALID/,
      );
    } finally {
      await context.pool.query('ALTER ROLE orebit_admin_runtime INHERIT');
      await context.pool.query(context.membershipSql);
    }
  });

  it('fails closed when unrelated parent roles expand effective runtime audit capabilities', async () => {
    const writerRoles = [
      'orebit_admin_runtime',
      'orebit_wallet_core_user_runtime',
      'orebit_deposit_user_runtime',
    ] as const;
    const contaminations = [
      ...writerRoles.flatMap((runtime) => [
        { runtime, expected: 'orebit_admin_audit_writer', parent: 'pg_write_all_data' },
        { runtime, expected: 'orebit_admin_audit_writer', parent: 'pg_read_all_data' },
        {
          runtime,
          expected: 'orebit_admin_audit_writer',
          parent: 'orebit_admin_audit_schema_creator',
        },
      ]),
      {
        runtime: 'orebit_admin_audit_history_runtime',
        expected: 'orebit_admin_audit_reader',
        parent: 'pg_write_all_data',
      },
      {
        runtime: 'orebit_admin_audit_history_runtime',
        expected: 'orebit_admin_audit_reader',
        parent: 'orebit_admin_audit_function_executor',
      },
      {
        runtime: 'orebit_admin_audit_history_runtime',
        expected: 'orebit_admin_audit_reader',
        parent: 'orebit_admin_audit_schema_creator',
      },
    ];

    for (const contamination of contaminations) {
      await context.pool.query(`REVOKE ${contamination.expected} FROM ${contamination.runtime}`);
      await context.pool.query(`GRANT ${contamination.parent} TO ${contamination.runtime}`);
      try {
        await rejectsSqlState(
          () => context.pool.query(context.membershipSql),
          'P0001',
          /ADMIN_AUDIT_RUNTIME_CAPABILITY_INVALID/,
          `${contamination.parent} must not expand ${contamination.runtime}`,
        );
        const rolledBack = await context.pool.query(
          `SELECT NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = $1 AND member.rolname = $2
        ) AS missing`,
          [contamination.expected, contamination.runtime],
        );
        assert.deepEqual(rolledBack.rows, [{ missing: true }]);
      } finally {
        await context.pool.query(`REVOKE ${contamination.parent} FROM ${contamination.runtime}`);
        await context.pool.query(context.membershipSql);
      }
    }

    for (const runtime of [...writerRoles, 'orebit_admin_audit_history_runtime']) {
      await context.pool.query(`GRANT orebit_admin_audit_harmless_parent TO ${runtime}`);
    }
    try {
      await context.pool.query(context.membershipSql);
      await context.pool.query(context.membershipSql);
    } finally {
      for (const runtime of [...writerRoles, 'orebit_admin_audit_history_runtime']) {
        await context.pool.query(`REVOKE orebit_admin_audit_harmless_parent FROM ${runtime}`);
      }
    }

    const effective = await context.pool.query(`SELECT role_name,
        has_function_privilege(role_name,
          'admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)',
          'EXECUTE') AS can_append,
        has_table_privilege(role_name, 'admin.admin_audit_events', 'SELECT') AS can_select,
        has_table_privilege(role_name, 'admin.admin_audit_events', 'INSERT') AS can_insert,
        has_table_privilege(role_name, 'admin.admin_audit_events', 'UPDATE') AS can_update,
        has_table_privilege(role_name, 'admin.admin_audit_events', 'DELETE') AS can_delete,
        has_table_privilege(role_name, 'admin.admin_audit_events', 'TRUNCATE') AS can_truncate,
        has_schema_privilege(role_name, 'admin', 'CREATE') AS can_create
      FROM unnest(ARRAY[
        'orebit_admin_runtime','orebit_wallet_core_user_runtime',
        'orebit_deposit_user_runtime','orebit_admin_audit_history_runtime'
      ]) role_name ORDER BY role_name`);
    assert.deepEqual(effective.rows, [
      {
        role_name: 'orebit_admin_audit_history_runtime',
        can_append: false,
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_create: false,
      },
      {
        role_name: 'orebit_admin_runtime',
        can_append: true,
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_create: false,
      },
      {
        role_name: 'orebit_deposit_user_runtime',
        can_append: true,
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_create: false,
      },
      {
        role_name: 'orebit_wallet_core_user_runtime',
        can_append: true,
        can_select: false,
        can_insert: false,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_create: false,
      },
    ]);
  });

  it('rejects powerful roles reachable only through PostgreSQL SET membership paths', async () => {
    const cases = [
      {
        runtime: 'orebit_admin_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'GRANT INSERT ON admin.admin_audit_events TO orebit_admin_audit_set_parent',
        cleanup: 'REVOKE INSERT ON admin.admin_audit_events FROM orebit_admin_audit_set_parent',
      },
      {
        runtime: 'orebit_wallet_core_user_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'GRANT TRIGGER ON admin.admin_audit_events TO orebit_admin_audit_set_parent',
        cleanup: 'REVOKE TRIGGER ON admin.admin_audit_events FROM orebit_admin_audit_set_parent',
      },
      {
        runtime: 'orebit_deposit_user_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'GRANT REFERENCES ON admin.admin_audit_events TO orebit_admin_audit_set_parent',
        cleanup: 'REVOKE REFERENCES ON admin.admin_audit_events FROM orebit_admin_audit_set_parent',
      },
      {
        runtime: 'orebit_admin_audit_history_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'GRANT MAINTAIN ON admin.admin_audit_events TO orebit_admin_audit_set_parent',
        cleanup: 'REVOKE MAINTAIN ON admin.admin_audit_events FROM orebit_admin_audit_set_parent',
      },
      {
        runtime: 'orebit_admin_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'GRANT pg_write_all_data TO orebit_admin_audit_set_parent',
        cleanup: 'REVOKE pg_write_all_data FROM orebit_admin_audit_set_parent',
      },
      {
        runtime: 'orebit_wallet_core_user_runtime',
        parent: 'orebit_admin_audit_schema_creator',
        prepare: 'SELECT 1',
        cleanup: 'SELECT 1',
      },
      {
        runtime: 'orebit_admin_audit_history_runtime',
        parent: 'orebit_admin_audit_function_executor',
        prepare: 'SELECT 1',
        cleanup: 'SELECT 1',
      },
      {
        runtime: 'orebit_admin_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'ALTER ROLE orebit_admin_audit_set_parent SUPERUSER',
        cleanup: 'ALTER ROLE orebit_admin_audit_set_parent NOSUPERUSER',
      },
      {
        runtime: 'orebit_wallet_core_user_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'ALTER ROLE orebit_admin_audit_set_parent CREATEDB',
        cleanup: 'ALTER ROLE orebit_admin_audit_set_parent NOCREATEDB',
      },
      {
        runtime: 'orebit_deposit_user_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'ALTER ROLE orebit_admin_audit_set_parent CREATEROLE',
        cleanup: 'ALTER ROLE orebit_admin_audit_set_parent NOCREATEROLE',
      },
      {
        runtime: 'orebit_admin_audit_history_runtime',
        parent: 'orebit_admin_audit_set_parent',
        prepare: 'ALTER ROLE orebit_admin_audit_set_parent BYPASSRLS',
        cleanup: 'ALTER ROLE orebit_admin_audit_set_parent NOBYPASSRLS',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const expected =
        testCase.runtime === 'orebit_admin_audit_history_runtime'
          ? 'orebit_admin_audit_reader'
          : 'orebit_admin_audit_writer';
      await context.pool.query(`REVOKE ${expected} FROM ${testCase.runtime}`);
      await context.pool.query(testCase.prepare);
      await context.pool.query(
        `GRANT ${testCase.parent} TO ${testCase.runtime} WITH INHERIT FALSE`,
      );
      await context.pool.query(`GRANT ${testCase.parent} TO ${testCase.runtime} WITH SET TRUE`);
      try {
        const path = await context.pool.query(
          `SELECT membership.inherit_option, membership.set_option
          FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = $1 AND member.rolname = $2`,
          [testCase.parent, testCase.runtime],
        );
        assert.deepEqual(path.rows, [{ inherit_option: false, set_option: true }]);
        await rejectsSqlState(
          () => context.pool.query(context.membershipSql),
          'P0001',
          /ADMIN_AUDIT_RUNTIME_CAPABILITY_INVALID/,
          `SET-only reachable capability ${index}`,
        );
        const rolledBack = await context.pool.query(
          `SELECT NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = $1 AND member.rolname = $2
        ) AS missing`,
          [expected, testCase.runtime],
        );
        assert.deepEqual(rolledBack.rows, [{ missing: true }]);
      } finally {
        await context.pool.query(`REVOKE ${testCase.parent} FROM ${testCase.runtime}`);
        await context.pool.query(testCase.cleanup);
        await context.pool.query(context.membershipSql);
      }
    }
  });

  it('rejects direct TRIGGER, REFERENCES, and MAINTAIN privileges and rolls back grants', async () => {
    const cases = [
      { runtime: 'orebit_admin_runtime', privilege: 'TRIGGER' },
      { runtime: 'orebit_wallet_core_user_runtime', privilege: 'REFERENCES' },
      { runtime: 'orebit_deposit_user_runtime', privilege: 'MAINTAIN' },
    ];
    for (const testCase of cases) {
      await context.pool.query(`REVOKE orebit_admin_audit_writer FROM ${testCase.runtime}`);
      await context.pool.query(
        `GRANT ${testCase.privilege} ON admin.admin_audit_events TO ${testCase.runtime}`,
      );
      try {
        await rejectsSqlState(
          () => context.pool.query(context.membershipSql),
          'P0001',
          /ADMIN_AUDIT_RUNTIME_CAPABILITY_INVALID/,
          `direct ${testCase.privilege} must fail closed`,
        );
        const rolledBack = await context.pool.query(
          `SELECT NOT EXISTS (
          SELECT 1 FROM pg_auth_members membership
          JOIN pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = 'orebit_admin_audit_writer' AND member.rolname = $1
        ) AS missing`,
          [testCase.runtime],
        );
        assert.deepEqual(rolledBack.rows, [{ missing: true }]);
      } finally {
        await context.pool.query(
          `REVOKE ${testCase.privilege} ON admin.admin_audit_events FROM ${testCase.runtime}`,
        );
        await context.pool.query(context.membershipSql);
      }
    }
  });
}
