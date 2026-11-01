import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import pg from 'pg';

const live = process.env.NODE_ENV === 'test' && Boolean(process.env.WALLET_MEMBERSHIP_TEST_DATABASE_URL);
const canonical = ['orebit_admin_runtime', 'orebit_wallet_core_user_runtime'];
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';

it('rejects excess effective and SET ROLE powers while preserving minimal worker composition', { skip: !live }, async () => {
  const url = new URL(process.env.WALLET_MEMBERSHIP_TEST_DATABASE_URL!);
  assert.equal(url.toString(), 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_reconciliation_test?schema=wallet_core');
  const owner = 'orebit_wallet_core_test_owner';
  const docker = (args: string[], input?: string) => spawnSync('docker', args,
    { input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const inspect = docker(['inspect', '--format', '{{json .Name}} {{json .State.Running}} {{json .NetworkSettings.Ports}}', 'orebit-wallet-core-postgres-test']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /^"\/orebit-wallet-core-postgres-test" true /);
  assert.ok(JSON.parse(inspect.stdout.replace(/^"\/orebit-wallet-core-postgres-test" true /, ''))['5432/tcp']
    .some((port: { HostPort: string }) => port.HostPort === '55435'));
  const psql = (input: string) => docker(['exec', '-i', 'orebit-wallet-core-postgres-test', 'psql', '-X', '-qAt',
    '-U', owner, '-d', 'orebit_wallet_reconciliation_test', '-v', 'ON_ERROR_STOP=1', '-f', '-'], input);
  const server = psql('SELECT system_identifier FROM pg_control_system();');
  assert.equal(server.status, 0, server.stderr);
  const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
  const prefix = 'wallet_membership_probe_' + randomUUID().replaceAll('-', '').slice(0, 10);
  const names = { ledger: prefix + '_ledger', price: prefix + '_price', bridge: prefix + '_bridge', excess: prefix + '_excess' };
  const fixtures = [...canonical, ...Object.values(names)];
  const absent = async () => assert.deepEqual((await db.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [fixtures])).rows, []);
  try {
    const identity = (await db.query(`SELECT current_database() name,current_user owner,inet_server_port() port,
      (SELECT system_identifier::text FROM pg_control_system()) system_id`)).rows[0];
    assert.deepEqual(identity, { name: 'orebit_wallet_reconciliation_test', owner,
      port: 5432, system_id: server.stdout.trim() });
    await absent();
    const schemas = (await db.query(`SELECT to_regclass('wallet_core.delisting_executions')::text execution,
      to_regclass('ledger.ledger_balances')::text balances,to_regclass('admin.admin_audit_events')::text audit`)).rows[0];
    assert.ok(schemas.execution && schemas.balances && schemas.audit);
    const validatorOwner = (await db.query(`SELECT pg_get_userbyid(proowner) name FROM pg_proc
      WHERE oid='ledger.validate_and_apply_journal()'::regprocedure`)).rows[0].name as string;
    assert.notEqual(validatorOwner, owner, 'the test validator must have its separate existing owner');
    const source = await readFile(resolve(__dirname, '../production-role-memberships.sql.template'), 'utf8');
    // Preserve every real psql conditional; replace only the transaction wrapper with rollback.
    const template = source.replace(/^BEGIN;\r?\n/m, '').replace(/^COMMIT;\r?\n/m, '');
    const setup = `BEGIN;
      CREATE ROLE orebit_admin_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      CREATE ROLE orebit_wallet_core_user_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      CREATE ROLE ${identifier(names.ledger)} NOLOGIN INHERIT;
      CREATE ROLE ${identifier(names.price)} LOGIN INHERIT;
      CREATE ROLE ${identifier(names.bridge)} NOLOGIN NOINHERIT;
      CREATE ROLE ${identifier(names.excess)} NOLOGIN NOINHERIT;
      GRANT USAGE ON SCHEMA ledger,price_conversion TO ${identifier(names.ledger)};
      GRANT SELECT ON ledger.ledger_accounts,ledger.ledger_journals,ledger.ledger_postings,
        ledger.ledger_balances,ledger.ledger_journal_seals TO ${identifier(names.ledger)};
      GRANT INSERT ON ledger.ledger_accounts,ledger.ledger_journals,ledger.ledger_postings TO ${identifier(names.ledger)};
      GRANT UPDATE(status) ON ledger.ledger_accounts TO ${identifier(names.ledger)};
      GRANT EXECUTE ON FUNCTION price_conversion.resolve_money_batch_for_ledger(uuid[]) TO ${identifier(names.ledger)};`;
    const sealGrant = `GRANT UPDATE(status,currency_count,warning_count,safe_error_code,completed_at)
      ON wallet_core.wallet_reconciliation_runs TO orebit_wallet_core_user_runtime;`;
    const cases = [
      { name: 'Admin writer supplied as Ledger capability', ledger: 'orebit_wallet_core_admin_writer', extra: '', accepted: false },
      { name: 'minimal Ledger capability', extra: '', accepted: true },
      { name: 'Admin preexisting balance writer', extra: 'GRANT UPDATE(balance) ON ledger.ledger_balances TO orebit_admin_runtime;', accepted: false },
      { name: 'Admin SET-only indirect balance writer', extra: `GRANT UPDATE(balance) ON ledger.ledger_balances TO ${identifier(names.excess)};
        GRANT ${identifier(names.excess)} TO orebit_admin_runtime WITH INHERIT FALSE, SET TRUE;`, accepted: false },
      { name: 'Admin preexisting Price writer', extra: 'GRANT orebit_price_conversion_writer TO orebit_admin_runtime;', accepted: false },
      { name: 'Admin preexisting audit reader', extra: 'GRANT orebit_admin_audit_reader TO orebit_admin_runtime;', accepted: false },
      { name: 'SET-only indirect balance writer', extra: `GRANT UPDATE ON ledger.ledger_balances TO ${identifier(names.excess)};
        GRANT ${identifier(names.excess)} TO ${identifier(names.bridge)} WITH INHERIT FALSE, SET TRUE;
        GRANT ${identifier(names.bridge)} TO ${identifier(names.ledger)} WITH INHERIT FALSE, SET TRUE;`, accepted: false },
      { name: 'SET-only indirect validator owner', extra: `GRANT ${identifier(validatorOwner)} TO ${identifier(names.bridge)} WITH INHERIT FALSE, SET TRUE;
        GRANT ${identifier(names.bridge)} TO ${identifier(names.ledger)} WITH INHERIT FALSE, SET TRUE;`, accepted: false },
      { name: 'Price overlaps user runtime', price: 'orebit_wallet_core_user_runtime', extra: '', accepted: false },
      { name: 'Price SET-only reaches Ledger capability', extra: `GRANT ${identifier(names.ledger)} TO ${identifier(names.price)} WITH INHERIT FALSE, SET TRUE;`, accepted: false },
      { name: 'preexisting user balance column privilege', extra: 'GRANT UPDATE(balance) ON ledger.ledger_balances TO orebit_wallet_core_user_runtime;', accepted: false },
      { name: 'exact reconciliation seal fields', extra: sealGrant, accepted: true, seal: true },
      { name: 'seal plus immutable capture revision', extra: `${sealGrant}
        GRANT UPDATE(applied_configuration_revision) ON wallet_core.wallet_reconciliation_runs TO orebit_wallet_core_user_runtime;`, accepted: false },
      { name: 'broad reconciliation run UPDATE', extra:
        'GRANT UPDATE ON wallet_core.wallet_reconciliation_runs TO orebit_wallet_core_user_runtime;', accepted: false },
    ];
    for (const scenario of cases) {
      const result = psql(`\\set price_runtime_role '${scenario.price ?? names.price}'
        \\set ledger_posting_role '${scenario.ledger ?? names.ledger}'
        ${setup}\n${scenario.extra}\n${template}
        SELECT 'WORKER_RIGHTS:' || has_table_privilege('orebit_wallet_core_user_runtime','ledger.ledger_postings','INSERT')
          || ':' || has_table_privilege('orebit_wallet_core_user_runtime','wallet_core.user_preferences','INSERT')
          || ':' || has_column_privilege('orebit_wallet_core_user_runtime','price_conversion.currencies','name','UPDATE')
          || ':' || has_table_privilege('orebit_wallet_core_user_runtime','ledger.ledger_balances','UPDATE');
        SELECT 'SEAL_RIGHTS:' || string_agg(attname,',' ORDER BY attname)
          FROM pg_attribute WHERE attrelid='wallet_core.wallet_reconciliation_runs'::regclass
            AND attnum>0 AND NOT attisdropped
            AND has_column_privilege('orebit_wallet_core_user_runtime',attrelid,attnum,'UPDATE');
        ROLLBACK;`);
      await absent();
      if (scenario.accepted) {
        assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}\n${result.stdout}`);
        assert.match(result.stdout, /WORKER_RIGHTS:true:true:false:false/);
        if (scenario.seal) assert.match(result.stdout,
          /SEAL_RIGHTS:completed_at,currency_count,safe_error_code,status,warning_count\r?\n/);
      } else {
        assert.notEqual(result.status, 0, `${scenario.name} returned success: ${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout + result.stderr, /isolated|capabilit|separat|privilege|overlap/i, scenario.name);
      }
    }
  } finally { await absent(); await db.end(); }
});
