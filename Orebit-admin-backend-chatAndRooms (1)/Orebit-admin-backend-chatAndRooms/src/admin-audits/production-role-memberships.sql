BEGIN;

DO $runtime_roles$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'orebit_admin_runtime',
      'orebit_wallet_core_user_runtime',
      'orebit_deposit_user_runtime',
      'orebit_admin_audit_history_runtime'
    ]) AS expected(name)
    LEFT JOIN pg_roles actual ON actual.rolname = expected.name
    WHERE actual.oid IS NULL OR NOT actual.rolcanlogin OR NOT actual.rolinherit
      OR actual.rolsuper OR actual.rolcreatedb OR actual.rolcreaterole
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_ROLE_INVALID';
  END IF;
END;
$runtime_roles$;

DO $role_graph_before$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname IN (
        'orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader'
      )
      OR granted.rolname = 'orebit_admin_audit_owner'
      OR (granted.rolname = 'orebit_admin_audit_writer' AND member.rolname NOT IN (
        'orebit_admin_runtime','orebit_wallet_core_user_runtime','orebit_deposit_user_runtime'
      ))
      OR (granted.rolname = 'orebit_admin_audit_reader'
        AND member.rolname <> 'orebit_admin_audit_history_runtime')
      OR (granted.rolname IN ('orebit_admin_audit_writer','orebit_admin_audit_reader')
        AND (membership.admin_option OR NOT membership.inherit_option OR NOT membership.set_option))
  ) OR EXISTS (
    WITH RECURSIVE audit_members(root, member, depth) AS (
      SELECT membership.roleid, membership.member, 1
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE granted.rolname IN (
        'orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader'
      )
      UNION ALL
      SELECT audit_members.root, membership.member, audit_members.depth + 1
      FROM audit_members
      JOIN pg_auth_members membership ON membership.roleid = audit_members.member
    )
    SELECT 1 FROM audit_members WHERE depth > 1
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_ROLE_GRAPH_INVALID';
  END IF;
END;
$role_graph_before$;

GRANT orebit_admin_audit_writer TO orebit_admin_runtime;
GRANT orebit_admin_audit_writer TO orebit_wallet_core_user_runtime;
GRANT orebit_admin_audit_writer TO orebit_deposit_user_runtime;
GRANT orebit_admin_audit_reader TO orebit_admin_audit_history_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_admin_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_wallet_core_user_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_deposit_user_runtime;
REVOKE orebit_admin_audit_writer FROM orebit_admin_audit_history_runtime;

DO $role_graph_after$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname IN (
        'orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader'
      )
      OR granted.rolname = 'orebit_admin_audit_owner'
      OR (granted.rolname = 'orebit_admin_audit_writer' AND member.rolname NOT IN (
        'orebit_admin_runtime','orebit_wallet_core_user_runtime','orebit_deposit_user_runtime'
      ))
      OR (granted.rolname = 'orebit_admin_audit_reader'
        AND member.rolname <> 'orebit_admin_audit_history_runtime')
      OR (granted.rolname IN ('orebit_admin_audit_writer','orebit_admin_audit_reader')
        AND (membership.admin_option OR NOT membership.inherit_option OR NOT membership.set_option))
  ) OR EXISTS (
    WITH RECURSIVE audit_members(root, member, depth) AS (
      SELECT membership.roleid, membership.member, 1
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      WHERE granted.rolname IN (
        'orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader'
      )
      UNION ALL
      SELECT audit_members.root, membership.member, audit_members.depth + 1
      FROM audit_members
      JOIN pg_auth_members membership ON membership.roleid = audit_members.member
    )
    SELECT 1 FROM audit_members WHERE depth > 1
  ) OR (
    SELECT count(*)
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    WHERE granted.rolname IN (
      'orebit_admin_audit_owner','orebit_admin_audit_writer','orebit_admin_audit_reader'
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_ROLE_GRAPH_INVALID';
  END IF;
END;
$role_graph_after$;

DO $effective_capabilities$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('orebit_admin_runtime', true, false),
      ('orebit_wallet_core_user_runtime', true, false),
      ('orebit_deposit_user_runtime', true, false),
      ('orebit_admin_audit_history_runtime', false, true)
    ) AS expected(role_name, can_append, can_select)
    WHERE has_function_privilege(
        expected.role_name,
        'admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)',
        'EXECUTE'
      ) IS DISTINCT FROM expected.can_append
      OR has_table_privilege(
        expected.role_name, 'admin.admin_audit_events', 'SELECT'
      ) IS DISTINCT FROM expected.can_select
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'INSERT')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'UPDATE')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'DELETE')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'TRUNCATE')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'TRIGGER')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'REFERENCES')
      OR has_table_privilege(expected.role_name, 'admin.admin_audit_events', 'MAINTAIN')
      OR has_schema_privilege(expected.role_name, 'admin', 'CREATE')
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_CAPABILITY_INVALID';
  END IF;
END;
$effective_capabilities$;

DO $set_reachable_capabilities$
BEGIN
  IF EXISTS (
    WITH RECURSIVE expected(role_name, can_append, can_select) AS (
      VALUES
        ('orebit_admin_runtime', true, false),
        ('orebit_wallet_core_user_runtime', true, false),
        ('orebit_deposit_user_runtime', true, false),
        ('orebit_admin_audit_history_runtime', false, true)
    ), reachable(runtime_name, can_append, can_select, role_oid) AS (
      SELECT expected.role_name, expected.can_append, expected.can_select, roles.oid
      FROM expected
      JOIN pg_roles roles ON roles.rolname = expected.role_name
      UNION
      SELECT reachable.runtime_name, reachable.can_append, reachable.can_select,
        membership.roleid
      FROM reachable
      JOIN pg_auth_members membership ON membership.member = reachable.role_oid
      WHERE membership.set_option
    )
    SELECT 1
    FROM reachable
    JOIN pg_roles reached ON reached.oid = reachable.role_oid
    WHERE reached.rolsuper OR reached.rolcreatedb OR reached.rolcreaterole
      OR reached.rolbypassrls
      OR has_schema_privilege(reached.oid, 'admin', 'CREATE')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'INSERT')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'UPDATE')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'DELETE')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'TRUNCATE')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'TRIGGER')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'REFERENCES')
      OR has_table_privilege(reached.oid, 'admin.admin_audit_events', 'MAINTAIN')
      OR (NOT reachable.can_select
        AND has_table_privilege(reached.oid, 'admin.admin_audit_events', 'SELECT'))
      OR (NOT reachable.can_append AND has_function_privilege(
        reached.oid,
        'admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)',
        'EXECUTE'
      ))
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_CAPABILITY_INVALID';
  END IF;
END;
$set_reachable_capabilities$;

COMMIT;
