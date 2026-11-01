const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const pg = require('pg');

const audit = 'admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)';
const resolver = 'price_conversion.resolve_money_batch_for_ledger(uuid[])';
const templatePath = resolve(__dirname, '../production-role-memberships.sql.template');
const roleTest = (name, run) => test(name, {
  skip: process.env.WP11_ROLE_TEMPLATE_DATABASE_URL === undefined,
}, run);

// Execute the exact permission branch, not a rewritten Ledger-dependent bootstrap.
function guardSql() {
  const source = readFileSync(templatePath, 'utf8').replaceAll('\r\n', '\n');
  const start = '  SELECT 1 FROM reachable reached JOIN pg_proc function ON true';
  const end = '\n  UNION ALL\n  SELECT 1 FROM roots root';
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'canonical SECURITY DEFINER guard branch must exist');
  assert.equal(source.indexOf(start, from + start.length), -1, 'guard branch must be unique');
  return `WITH reachable(kind,role_oid) AS (
    VALUES ('price'::text,'orebit_price_conversion_writer'::regrole::oid)
  ) SELECT count(*)::int AS violations FROM (${source.slice(from,to)}) rejected`;
}

async function violations(client) {
  return (await client.query(guardSql())).rows[0].violations;
}

async function functionState(client) {
  return (await client.query(`SELECT oid::text,proowner::text,proacl::text
    FROM pg_proc WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid`,
  [audit,resolver])).rows;
}

async function rollbackProbe(run) {
  assert.equal(process.env.WP11_ROLE_TEMPLATE_ALLOW_ROLLBACK_ACL, 'true');
  const url = new URL(process.env.WP11_ROLE_TEMPLATE_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55441');
  assert.equal(url.pathname, '/orebit_wallet_pricing_fixes_20260910');
  assert.equal(url.username, 'orebit_wallet_pricing_fixes_owner');
  const client = new pg.Client({connectionString:url.href});
  await client.connect();
  let before;
  try {
    assert.deepEqual((await client.query(`SELECT current_database() AS database,
      current_user AS effective_user,session_user AS login_user,
      current_setting('cluster_name') AS cluster,inet_server_port() AS port`)).rows[0], {
      database:'orebit_wallet_pricing_fixes_20260910',
      effective_user:'orebit_wallet_pricing_fixes_owner',
      login_user:'orebit_wallet_pricing_fixes_owner',
      cluster:'orebit_wallet_pricing_fixes_20260910',port:5432,
    });
    before = await functionState(client);
    assert.equal(before.length,2);
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    await run(client);
  } finally {
    try {
      await client.query('ROLLBACK');
      if (before) assert.deepEqual(await functionState(client),before,
        'every probe must restore both function owners and exact ACLs');
    } finally { await client.end(); }
  }
}

roleTest('the exact price guard accepts approved revision and Audit helper capabilities', () => rollbackProbe(async client => {
  const access = (await client.query(`SELECT
    has_function_privilege('orebit_price_conversion_writer',
      'price_conversion.current_price_config_revision()','EXECUTE') AS revision,
    has_function_privilege('orebit_price_conversion_writer',$1,'EXECUTE') AS audit`,[audit])).rows[0];
  assert.deepEqual(access,{revision:true,audit:true});
  assert.equal(await violations(client),0,'approved Pricing Audit helper must not violate the role template');
}));

roleTest('the price guard still rejects an additional non-allowlisted SECURITY DEFINER function', () => rollbackProbe(async client => {
  const before = await violations(client);
  await client.query(`GRANT EXECUTE ON FUNCTION ${resolver} TO orebit_price_conversion_writer`);
  assert.equal(await violations(client),before+1,
    'an additional resolver grant must produce its own rejected capability');
}));

for (const [name,mutation] of [
  ['PUBLIC execute',`GRANT EXECUTE ON FUNCTION ${audit} TO PUBLIC`],
  ['delegable execute',`GRANT EXECUTE ON FUNCTION ${audit} TO orebit_price_conversion_writer WITH GRANT OPTION`],
  ['wrong function owner',`ALTER FUNCTION ${audit} OWNER TO orebit_wallet_pricing_fixes_owner`],
]) roleTest(`the price Audit exception rejects ${name}`, () => rollbackProbe(async client => {
  await client.query(mutation);
  assert.ok(await violations(client)>0,'unsafe Audit owner/ACL must remain rejected');
}));
