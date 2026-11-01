import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { insertZeroReconciliation,createReconciliationCurrencyFixture,captureReconciliationFixture,
  isolateReconciliationConfiguration } from './reconciliation-price-fixture.js';
import { TABLES, SAFE_ERRORS, INDEX_MANIFEST, insertFailedStakingComponent } from './deployment-fixtures.js';
import {assertPackageArtifacts,assertMigrationArtifacts,assertUnmountedArtifacts,assertExpandArtifacts} from './deployment-artifact-checks.js';
import {assertProviderArtifacts,assertPriceEnumArtifacts} from './deployment-artifact-checks.js';
import {applyOwnershipFixture,OWNERSHIP_ROLES,applyAuditMembershipFixture,AUDIT_RUNTIMES,
  ownershipSql,seedOwnershipBackfill} from './ownership-fixtures.js';
const moduleRoot = resolve(__dirname, '..');
const adminRoot = resolve(moduleRoot, '../../..');
const workspace = resolve(adminRoot, '..');
const userRoot = resolve(workspace, 'orebit-backend/src/wallet/core');
const migrationPath = resolve(moduleRoot,
  'migrations/20260903000000_wallet_core_expand/migration.sql');
const schemaPath = resolve(moduleRoot, 'schema.prisma');
const lockPath = resolve(moduleRoot, 'migrations/migration_lock.toml');
const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
describe('Wallet Core Task 2 static deployment contract', () => {
  it('pins the isolated package, compiler, environment, and Docker identity exactly', async () => { await assertPackageArtifacts(moduleRoot, TEST_URL); });
  it('keeps the immutable original expand schema without copied prerequisite DDL', async () => { await assertExpandArtifacts(migrationPath); });
  it('stores the provider-required blockchain staking capability as a non-null Boolean', async () => { await assertProviderArtifacts(migrationPath,schemaPath); });
  it('models canonical Price enum columns without an implicit text write boundary', async () => { await assertPriceEnumArtifacts(schemaPath); });
  it('closes reconciliation evidence, legacy mapping, and literal query indexes', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const schema = await readFile(schemaPath, 'utf8');
    const safeEnum = /WalletReconciliationSafeErrorCode" AS ENUM \(([^)]*)\)/.exec(sql)?.[1];
    assert.ok(safeEnum);
    assert.deepEqual([...safeEnum.matchAll(/'([^']+)'/g)].map((match) => match[1]), SAFE_ERRORS);
    assert.match(schema, /enum WalletReconciliationSafeErrorCode \{[\s\S]*?INVALID_DECIMAL[\s\S]*?@@schema\("wallet_core"\)/);
    assert.equal((schema.match(/safeErrorCode\s+WalletReconciliationSafeErrorCode\?/g) ?? []).length, 2);
    assert.match(sql, /total_custody_balance = hot_cold_balance \+ staking_balance \+ binance_balance/i);
    assert.match(sql, /validate_reconciliation_component[\s\S]*custody address ownership mismatch/i);
    assert.match(sql, /validate_reconciliation_attempt_set[\s\S]*count\(\*\)[\s\S]*max\(attempt_ordinal\)/i);
    assert.match(sql, /FOREIGN KEY \(mapped_binding_id, currency_id\)[\s\S]*REFERENCES wallet_core\.currencies\(id, currency_id\)/i);
    for (const [name, columns] of Object.entries(INDEX_MANIFEST)) {
      assert.match(sql.replace(/\s+/g, ' '), new RegExp(`${name}[^;]+\\(${columns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'i'), name);
    }
  });
  it('pins prerequisite paths/order and maps only verified schema tokens', async () => { await assertMigrationArtifacts(moduleRoot); });
  it('keeps the complete canonical migration set byte-identical and user migrations verification-only', async () => {
    assert.equal(await hash(schemaPath), await hash(resolve(userRoot, 'schema.prisma')));
    assert.equal(await hash(lockPath), await hash(resolve(userRoot, 'migrations/migration_lock.toml')));
    const directories = async (root: string) => (await readdir(resolve(root, 'migrations'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.deepEqual(await directories(moduleRoot), await directories(userRoot));
    for (const name of await directories(moduleRoot)) assert.equal(await hash(resolve(moduleRoot, 'migrations', name, 'migration.sql')),
      await hash(resolve(userRoot, 'migrations', name, 'migration.sql')));
    await assert.rejects(() => readFile(resolve(userRoot, 'provision-test-database.cjs')));
    const userPackage = JSON.parse(await readFile(resolve(userRoot, 'package.json'), 'utf8'));
    assert.equal('db:migrate' in userPackage.scripts, false);
    const lock = await readFile(lockPath, 'utf8');
    assert.equal(lock.trim(), 'provider = "postgresql"');
  });
  it('keeps Wallet HTTP unmounted, migrations owned, workers one-run, and audit DDL external', async () => { await assertUnmountedArtifacts(moduleRoot, adminRoot); });
});
describe('Wallet Core Task 2 live deployment contract', { skip: !LIVE }, () => {
  let pool: pg.Pool;
  before(async () => {
    const guard = await import(pathToFileURL(resolve(
      __dirname, '../provision-test-database.cjs',
    )).href) as {
      assertSafeWalletCoreTestDatabase(): Promise<pg.Pool>;
    };
    pool = await guard.assertSafeWalletCoreTestDatabase();
  });
  after(async () => { if (pool) await pool.end(); });
  const withRollback = async (work: (client: pg.PoolClient) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  it('creates only the complete Wallet schema and keeps ledger_test empty', async () => {
    const { rows } = await pool.query<{ table_name: string }>(`SELECT table_name
      FROM information_schema.tables WHERE table_schema = 'wallet_core_test'
      ORDER BY table_name`);
    assert.deepEqual(rows.map((row) => row.table_name), [...TABLES]);
    const ledger = await pool.query(`SELECT count(*)::int AS count
      FROM information_schema.tables WHERE table_schema = 'ledger_test'`);
    assert.deepEqual(ledger.rows, [{ count: 0 }]);
    assert.ok((await pool.query(`SELECT to_regclass('admin_test.admin_audit_events') AS relation`))
      .rows[0].relation);
    assert.ok((await pool.query(`SELECT to_regclass('price_conversion_test.price_providers') AS relation`))
      .rows[0].relation);
  });
  it('keeps only canonical identity columns after the final ownership contract', async () => {
    await withRollback(async client => {
    await applyOwnershipFixture(client);
    const columns = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='price_conversion_test' AND table_name='currencies' ORDER BY ordinal_position`);
    assert.deepEqual(columns.rows.map(row => row.column_name).sort(),
      ['id','symbol','name','decimals','kind','pricing_status','auto_disabled','created_at','updated_at'].sort());
    for (const role of OWNERSHIP_ROLES) {
      const actual = await client.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls
        FROM pg_roles WHERE rolname=$1`, [role]);
      assert.deepEqual(actual.rows,[{rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false}]);
    }
    });
  });
  it('rejects the ownership upgrade before changing columns when backfill or bindings are missing', async () => {
    await withRollback(async client => {
      await seedOwnershipBackfill(client);
      const currency=randomUUID();
      await client.query(`INSERT INTO price_conversion_test.currencies(id,symbol,name,decimals,kind,pricing_status)
        VALUES ($1,$2,'Missing setting fixture',18,'CRYPTO','DISABLED')`,[currency,`C${currency.slice(0,8).toUpperCase()}`]);
      await client.query('SAVEPOINT missing_setting');
      const sql=await ownershipSql();
      await assert.rejects(() => client.query(sql),/every currency setting/);
      await client.query('ROLLBACK TO SAVEPOINT missing_setting');
      await client.query(`INSERT INTO wallet_core_test.currency_settings(currency_id) VALUES ($1)`,[currency]);
      await client.query(`UPDATE wallet_core_test.legacy_currency_chain_codes SET mapped_binding_id=NULL WHERE chain_code='btc'`);
      await client.query('SAVEPOINT missing_binding');
      await assert.rejects(() => client.query(sql),/every legacy chain binding/);
      await client.query('ROLLBACK TO SAVEPOINT missing_binding');
    });
  });
  it('applies canonical audit memberships to temporary runtimes and rolls every role back', async () => {
    assert.equal((await pool.query(`SELECT count(*)::int count FROM pg_roles WHERE rolname=ANY($1)`,[AUDIT_RUNTIMES])).rows[0].count,0);
    await withRollback(async client => {
      await applyAuditMembershipFixture(client);
      for (const [index,role] of AUDIT_RUNTIMES.entries()) {
        const result=await client.query(`SELECT
          pg_has_role($1,'orebit_admin_audit_writer','MEMBER') writer,
          pg_has_role($1,'orebit_admin_audit_reader','MEMBER') reader,
          has_function_privilege($1,'admin_test.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)','EXECUTE') append,
          has_table_privilege($1,'admin_test.admin_audit_events','SELECT') read,
          has_table_privilege($1,'admin_test.admin_audit_events','INSERT,UPDATE,DELETE,TRUNCATE') mutate`,[role]);
        assert.deepEqual(Object.values(result.rows[0]),index===3 ? [false,true,false,true,false] : [true,false,true,false,false]);
      }
    });
    assert.equal((await pool.query(`SELECT count(*)::int count FROM pg_roles WHERE rolname=ANY($1)`,[AUDIT_RUNTIMES])).rows[0].count,0);
  });
  it('limits each writer to its owned columns and keeps PUBLIC outside the contract', async () => {
    await withRollback(async client => {
      await applyOwnershipFixture(client);
      const expected = [[true,true,false,false,false,true,false], [false,false,false,true,false,false,false],
        [false,false,false,false,false,false,true], [false,false,true,false,true,false,false]];
      for (const [index,role] of OWNERSHIP_ROLES.entries()) {
        const result = await client.query(`SELECT
          has_column_privilege($1,'price_conversion_test.currencies','name','UPDATE') identity,
          has_column_privilege($1,'price_conversion_test.currencies','pricing_status','UPDATE') enrollment,
          has_column_privilege($1,'price_conversion_test.currencies','auto_disabled','UPDATE') automatic,
          has_table_privilege($1,'wallet_core_test.user_preferences','INSERT') preferences,
          has_table_privilege($1,'price_conversion_test.price_snapshots','INSERT') prices,
          has_column_privilege($1,'wallet_core_test.currency_settings','desired_state','UPDATE') configuration,
          has_function_privilege($1,'wallet_core_test.disable_delisted_pricing(uuid)','EXECUTE') finalizer`,[role]);
        assert.deepEqual(Object.values(result.rows[0]),expected[index],role);
      }
      const exposed = await client.query(`SELECT relation.relname FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace,
        LATERAL aclexplode(relation.relacl) privilege WHERE privilege.grantee=0
        AND namespace.nspname IN ('wallet_core_test','price_conversion_test')`);
      assert.deepEqual(exposed.rows,[]);
    });
  });
  it('requires completed due LOSS under the exact current policy before disabling pricing', async () => {
    await withRollback(async client => {
      await applyOwnershipFixture(client);
      const currency=(await client.query(`SELECT id FROM price_conversion_test.currencies WHERE symbol='BTC'`)).rows[0].id;
      await client.query(`INSERT INTO price_conversion_test.currency_provider_refs(currency_id,provider_id,external_id,symbol)
        SELECT $1,id,'contract-btc-'||code::text,'BTC' FROM price_conversion_test.price_providers ON CONFLICT DO NOTHING`,[currency]);
      await client.query(`UPDATE price_conversion_test.currencies SET pricing_status='ACTIVE' WHERE id=$1`,[currency]);
      const execution=randomUUID(); const deadline=new Date(Date.now()-60000);
      await client.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=1,
        delist_at=$2,after_delist_mode='LEAVE',leave_days=0,after_leave_action='LOSS' WHERE currency_id=$1`,[currency,deadline]);
      await client.query(`INSERT INTO wallet_core_test.delisting_executions
        (id,currency_id,policy_revision,deadline,status) VALUES ($1,$2,1,$3,'RUNNING')`,[execution,currency,deadline]);
      const rejected = async () => {
        await client.query('SAVEPOINT invalid_finalization');
        await assert.rejects(() => client.query(`SELECT wallet_core_test.disable_delisted_pricing($1)`,[execution]),/policy mismatch/);
        await client.query('ROLLBACK TO SAVEPOINT invalid_finalization');
      };
      await rejected();
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='COMPLETED',
        updated_at=clock_timestamp()+interval '1 second' WHERE id=$1`,[execution]);
      await client.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=2 WHERE currency_id=$1`,[currency]);
      await rejected();
      await client.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=1,after_delist_mode=NULL WHERE currency_id=$1`,[currency]);
      await rejected();
      await client.query(`UPDATE wallet_core_test.currency_settings SET after_delist_mode='LEAVE' WHERE currency_id=$1`,[currency]);
      await client.query('SET LOCAL ROLE orebit_wallet_core_lifecycle_writer');
      await client.query(`SELECT wallet_core_test.disable_delisted_pricing($1)`,[execution]);
      assert.equal((await client.query(`SELECT pricing_status FROM price_conversion_test.currencies WHERE id=$1`,[currency])).rows[0].pricing_status,'DISABLED');
      await client.query('RESET ROLE');
    });
  });
  it('requires pristine positive-revision delisting inserts and closed safe reasons', async () => {
    await withRollback(async (client) => {
      const currencyId = (await client.query(`SELECT id FROM price_conversion_test.currencies WHERE symbol='BTC'`)).rows[0].id;
      for (const override of ['policy_revision=0', 'cursor=\'abc\'', 'cursor_ordinal=1', 'processed_count=1',
        'skipped_count=1', 'failed_count=1', "updated_at=now()+interval '1 second'"]) {
        await client.query('SAVEPOINT invalid_execution');
        const [column, value] = override.split('=') as [string,string];
        const fields: Record<string, string> = { policy_revision: '1', cursor: 'NULL', cursor_ordinal: '0',
          processed_count: '0', skipped_count: '0', failed_count: '0', updated_at: 'now()' };
        fields[column] = value;
        await assert.rejects(() => client.query(`INSERT INTO wallet_core_test.delisting_executions
          (id,currency_id,deadline,status,${Object.keys(fields).join(',')})
          VALUES (gen_random_uuid(),$1,now(),'RUNNING',${Object.values(fields).join(',')})`, [currencyId]), override);
        await client.query('ROLLBACK TO SAVEPOINT invalid_execution');
      }
      const id = randomUUID();
      await client.query(`INSERT INTO wallet_core_test.delisting_executions
        (id,currency_id,policy_revision,deadline,status) VALUES ($1,$2,1,now(),'RUNNING')`, [id,currencyId]);
      await client.query('SAVEPOINT invalid_reason');
      await assert.rejects(() => client.query(`UPDATE wallet_core_test.delisting_executions
        SET status='PARTIAL',safe_error_code='raw provider body',updated_at=now()+interval '1 second' WHERE id=$1`, [id]));
      await client.query('ROLLBACK TO SAVEPOINT invalid_reason');
      await client.query(`UPDATE wallet_core_test.delisting_executions SET status='PARTIAL',
        safe_error_code='ACCOUNT_REVIEW_REQUIRED',updated_at=now()+interval '1 second' WHERE id=$1`, [id]);
    });
  });
  it('validates bounded lifecycle alerts and execution ownership in immutable events', async () => {
    await withRollback(async (client) => {
      const currencyId = (await client.query(`SELECT id FROM price_conversion_test.currencies WHERE symbol='BTC'`)).rows[0].id;
      const executionId = randomUUID(); const observedAt = new Date().toISOString();
      await client.query(`INSERT INTO wallet_core_test.delisting_executions
        (id,currency_id,policy_revision,deadline,status) VALUES ($1,$2,1,now(),'RUNNING')`, [executionId,currencyId]);
      for (const [category,payload] of [
        ['PRICE_MAINTENANCE',{currencyId,observedAt,priceReadiness:'UNAVAILABLE'}],
        ['DELISTING_PENDING',{executionId,observedAt,safeErrorCode:'PRICE_UNAVAILABLE'}],
        ['DELISTING_ACCOUNT_REVIEW',{executionId,observedAt,accountId:randomUUID(),ownerId:randomUUID(),
          ownerType:'MERCHANT',bucket:'HOLD',accountStatus:'FROZEN'}],
      ] as const) {
        const id = randomUUID();
        await client.query(`INSERT INTO wallet_core_test.wallet_alerts
          (id,dedupe_key,category,status,currency_id,payload,opened_at)
          VALUES ($1::uuid,$1::text,$2,'ACTIVE',$3,$4,now())`, [id,category,currencyId,payload]);
        await client.query(`INSERT INTO wallet_core_test.wallet_alert_events
          (id,alert_id,category,status,payload) VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3)`, [id,category,payload]);
        for (const invalid of [{...payload,rawBody:'secret'}, {...payload,observedAt:'yesterday'},
          {...payload,...(category==='PRICE_MAINTENANCE' ? {currencyId:randomUUID()}
            : category==='DELISTING_PENDING' ? {safeErrorCode:'provider body'} : {accountStatus:'ACTIVE'})}]) {
          await client.query('SAVEPOINT invalid_alert');
          await assert.rejects(() => client.query(`INSERT INTO wallet_core_test.wallet_alert_events
            (id,alert_id,category,status,payload) VALUES (gen_random_uuid(),$1,$2,'ACTIVE',$3)`, [id,category,invalid]));
          await client.query('ROLLBACK TO SAVEPOINT invalid_alert');
        }
      }
    });
  });
  it('backfills legacy currency policy and precision before lookup-based USD/BTC defaults', async () => {
    const defaults = (await pool.query(`SELECT view_currency.symbol AS view_symbol,
      crypto_currency.symbol AS crypto_symbol
      FROM wallet_core_test.wallet_settings settings
      JOIN price_conversion_test.currencies view_currency
        ON view_currency.id=settings.default_view_currency_id
      JOIN price_conversion_test.currencies crypto_currency
        ON crypto_currency.id=settings.default_crypto_currency_id WHERE settings.id`)).rows[0];
    assert.deepEqual(defaults, { view_symbol: 'USD', crypto_symbol: 'BTC' });
    const btc = (await pool.query(`SELECT currency.decimals, setting.binance_reference,
      setting.view_currency_enabled, legacy.chain_code,
      legacy.blockchain_precision FROM price_conversion_test.currencies currency
      JOIN wallet_core_test.currency_settings setting ON setting.currency_id=currency.id
      JOIN wallet_core_test.legacy_currency_chain_codes legacy ON legacy.currency_id=currency.id
      WHERE currency.symbol='BTC'`)).rows[0];
    assert.deepEqual(btc, { decimals: 18, binance_reference: 'BTC',
      view_currency_enabled: true, chain_code: 'btc', blockchain_precision: 8 });
  });
  it('stores exact threshold defaults and rejects range or scale violations', async () => {
    await withRollback(async (client) => {
      await client.query(`UPDATE wallet_core_test.wallet_settings SET reconciliation_alert_percent=5.000,
        include_treasury=true,include_collection=false,catalogue_mode='ALL' WHERE id`);
      const row = (await client.query(`SELECT reconciliation_alert_percent::text AS threshold,
        include_treasury,include_collection,catalogue_mode::text AS mode
        FROM wallet_core_test.wallet_settings WHERE id`)).rows[0];
      assert.deepEqual(row, { threshold: '5.000', include_treasury: true,
        include_collection: false, mode: 'ALL' });
      for (const value of ['-0.001', '50.001', '1.0001']) {
        await client.query('SAVEPOINT threshold');
        await assert.rejects(() => client.query(`UPDATE wallet_core_test.wallet_settings
          SET reconciliation_alert_percent = $1 WHERE id`, [value]));
        await client.query('ROLLBACK TO SAVEPOINT threshold');
      }
    });
  });

  it('persists provider is_stake as a required Boolean without a database default', async () => {
    const column = (await pool.query(`SELECT is_nullable, column_default, data_type
      FROM information_schema.columns WHERE table_schema='wallet_core_test'
        AND table_name='provider_catalogue_currencies' AND column_name='is_stake'`)).rows[0];
    assert.deepEqual(column, { is_nullable: 'NO', column_default: null, data_type: 'boolean' });
  });

  it('enforces EVM identity, HOT/COLD separation, native staking, and non-EVM case', async () => {
    await withRollback(async (client) => {
      const ids = ['01930000-0000-7000-8000-000000000001',
        '01930000-0000-7000-8000-000000000002'];
      const currencies = ['01930000-0000-7000-8000-000000000003',
        '01930000-0000-7000-8000-000000000004',
        '01930000-0000-7000-8000-000000000007'];
      await client.query(`INSERT INTO wallet_core_test.chains
        (id, provider_chain_id, short_name, name, is_evm)
        VALUES ($1, 900001, 'EVMTEST', 'EVM test', true),
          ($2, 900002, 'CASETEST', 'Case test', false)`, ids);
      await client.query(`INSERT INTO price_conversion_test.currencies
        (id,symbol,name,decimals,kind,pricing_status) VALUES
        ($1,'EVMT','EVM native',18,'CRYPTO','DISABLED'),
        ($2,'CASE','Case coin',18,'CRYPTO','DISABLED'),
        ($3,'TOKN','EVM token',18,'CRYPTO','DISABLED')`, currencies);
      const bindings = ['01930000-0000-7000-8000-000000000005',
        '01930000-0000-7000-8000-000000000006',
        '01930000-0000-7000-8000-000000000008'];
      await client.query(`INSERT INTO wallet_core_test.currencies
        (id,currency_id,chain_id,provider_coin_id,is_token,is_native,
         token_contract_address,blockchain_precision)
        VALUES ($1,$4,$7,900003,false,true,NULL,18),
          ($2,$5,$8,900004,false,true,NULL,8),
          ($3,$6,$7,900005,true,false,'0xToken',18)`,
      [bindings[0], bindings[1], bindings[2], currencies[0], currencies[1],
        currencies[2], ids[0], ids[1]]);
      await client.query(`INSERT INTO wallet_core_test.custody_addresses
        (currency_chain_id,kind,wallet_address,address_identity)
        VALUES ($1,'HOT','  0xAbC  ','0xabc'),($1,'STAKING','0xAbC','0xabc'),
          ($2,'HOT',' AbC ','AbC'),($2,'HOT','abc','abc')`, bindings.slice(0, 2));
      const stored = await client.query(`SELECT wallet_address,address_identity
        FROM wallet_core_test.custody_addresses WHERE currency_chain_id=$1 ORDER BY wallet_address`,
      [bindings[0]]);
      assert.ok(stored.rows.some((row) => row.wallet_address === '0xAbC'
        && row.address_identity === '0xabc'));
      const nonEvm = await client.query(`SELECT wallet_address,address_identity
        FROM wallet_core_test.custody_addresses WHERE currency_chain_id=$1 ORDER BY wallet_address`,
      [bindings[1]]);
      assert.deepEqual(nonEvm.rows, [
        { wallet_address: 'AbC', address_identity: 'AbC' },
        { wallet_address: 'abc', address_identity: 'abc' },
      ]);
      for (const [kind, address, identity] of [
        ['HOT', '0xabc', '0xabc'], ['COLD', '0xABC', '0xabc'],
      ]) {
        await client.query('SAVEPOINT duplicate_address');
        await assert.rejects(() => client.query(`INSERT INTO wallet_core_test.custody_addresses
          (currency_chain_id,kind,wallet_address,address_identity) VALUES ($1,$2,$3,$4)`,
        [bindings[0], kind, address, identity]));
        await client.query('ROLLBACK TO SAVEPOINT duplicate_address');
      }
      await client.query('SAVEPOINT token_staking');
      await assert.rejects(() => client.query(`INSERT INTO wallet_core_test.custody_addresses
        (currency_chain_id,kind,wallet_address,address_identity)
        VALUES ($1,'STAKING','0xTokenStake','0xtokenstake')`, [bindings[2]]));
      await client.query('ROLLBACK TO SAVEPOINT token_staking');
    });
  });

  it('serializes concurrent HOT/COLD inserts and caps each kind independently at 10,000', async () => {
    const chainId = randomUUID();
    const bindingId = randomUUID();
    const providerChainId = String(BigInt(Date.now()) * 1000n + BigInt(process.pid));
    const shortName = `C${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
    const currencyId = (await pool.query(`SELECT id FROM price_conversion_test.currencies
      WHERE symbol='BTC'`)).rows[0].id;
    await pool.query(`INSERT INTO wallet_core_test.chains
      (id,provider_chain_id,short_name,name,is_evm) VALUES ($1,$2,$3,'Concurrency test',false)`,
    [chainId, providerChainId, shortName]);
    await pool.query(`INSERT INTO wallet_core_test.currencies
      (id,currency_id,chain_id,provider_coin_id,is_token,is_native,blockchain_precision)
      VALUES ($1,$2,$3,$4,false,true,18)`,
    [bindingId, currencyId, chainId, providerChainId]);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(`INSERT INTO wallet_core_test.custody_addresses
        (currency_chain_id,kind,wallet_address,address_identity)
        VALUES ($1,'HOT','CaseShared','CaseShared')`, [bindingId]);
      let secondSettled = false;
      const coldInsert = second.query(`INSERT INTO wallet_core_test.custody_addresses
        (currency_chain_id,kind,wallet_address,address_identity)
        VALUES ($1,'COLD','CaseShared','CaseShared')`, [bindingId]);
      void coldInsert.finally(() => { secondSettled = true; }).catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      assert.equal(secondSettled, false, 'COLD insert must wait for the shared LIQUID lock');
      await first.query('COMMIT');
      await assert.rejects(coldInsert, /both HOT and COLD/i);
      await second.query('ROLLBACK');

      await second.query(`UPDATE wallet_core_test.currency_settings SET policy_revision=policy_revision+1 WHERE currency_id=$1`,[currencyId]);
      await second.query(`UPDATE wallet_core_test.custody_addresses SET retired_at=clock_timestamp(),
        retired_revision=(SELECT policy_revision FROM wallet_core_test.currency_settings WHERE currency_id=$2)
        WHERE currency_chain_id=$1 AND retired_at IS NULL`,[bindingId,currencyId]);
      for (const kind of ['HOT', 'COLD', 'STAKING'] as const) {
        await second.query('BEGIN');
        await second.query(`INSERT INTO wallet_core_test.custody_addresses
          (currency_chain_id,kind,wallet_address,address_identity)
          SELECT $1,$2,'Case-'||n,'Case-'||n FROM generate_series(1,10000) n`, [bindingId, kind]);
        assert.equal((await second.query(`SELECT count(*)::int AS count FROM wallet_core_test.custody_addresses
          WHERE currency_chain_id=$1 AND kind=$2 AND retired_at IS NULL`, [bindingId, kind])).rows[0].count, 10000);
        await assert.rejects(() => second.query(`INSERT INTO wallet_core_test.custody_addresses
          (currency_chain_id,kind,wallet_address,address_identity)
          VALUES ($1,$2,'Case-over','Case-over')`, [bindingId, kind]), /limit exceeded/i);
        await second.query('ROLLBACK');
      }
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
      // Keep the committed retired identity as required by the production history contract.
    }
  });

  it('enforces reconciliation snapshots and status semantics at commit', async () => {
    for (const status of ['SUCCESS', 'PARTIAL', 'FAILED'] as const) {
      await withRollback(async (client) => {
        const currencyId=await createReconciliationCurrencyFixture(client);
        await isolateReconciliationConfiguration(client, [currencyId]);
        const runId = status === 'SUCCESS'
          ? '01930000-0000-7000-8000-000000000021'
          : status === 'PARTIAL' ? '01930000-0000-7000-8000-000000000022'
            : '01930000-0000-7000-8000-000000000023';
        await insertZeroReconciliation(client, { runId, currencyId, runStatus: status,
          itemStatus: status === 'SUCCESS' ? 'PARTIAL' : 'COMPLETE',
          reasons: status === 'SUCCESS' ? ['PRICE_UNAVAILABLE'] : [] });
        await assert.rejects(() => client.query('SET CONSTRAINTS ALL IMMEDIATE'));
      });
    }
    for (const [status, itemStatus, reasons] of [
      ['SUCCESS', 'COMPLETE', []], ['PARTIAL', 'PARTIAL', ['TEST_PARTIAL']],
    ] as const) {
      await withRollback(async (client) => {
        const currencyId=await createReconciliationCurrencyFixture(client);
        await isolateReconciliationConfiguration(client, [currencyId]);
        const runId = status === 'SUCCESS'
          ? '01930000-0000-7000-8000-000000000024'
          : '01930000-0000-7000-8000-000000000025';
        await insertZeroReconciliation(client, { runId, currencyId, runStatus: status,
          itemStatus, reasons: itemStatus === 'PARTIAL' ? ['PRICE_UNAVAILABLE'] : reasons });
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
    }
    await withRollback(async (client) => {
      const id='01930000-0000-7000-8000-000000000026';
      await client.query(`UPDATE wallet_core_test.wallet_settings
        SET reconciliation_alert_percent=reconciliation_alert_percent WHERE id`);
      await isolateReconciliationConfiguration(client, []);
      await captureReconciliationFixture(client,id,null,null);
      await client.query(`UPDATE wallet_core_test.wallet_reconciliation_runs SET status='FAILED',
        safe_error_code='LEDGER_UNAVAILABLE',completed_at=clock_timestamp() WHERE id=$1`,[id]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
  it('records a failed native staking component with null provider totals and exact attempt evidence', async () => {
    await withRollback(async (client) => {
      const componentId = await insertFailedStakingComponent(client);
      assert.equal((await client.query(`SELECT wallet_address FROM wallet_core_test.wallet_reconciliation_components
        WHERE id=$1`, [componentId])).rows[0].wallet_address, 'StakeAddress');
      await client.query(`INSERT INTO wallet_core_test.wallet_reconciliation_attempts
        (id,component_id,attempt_ordinal,configured_delay_ms,last_completed_stage,outcome,safe_error_code)
        VALUES (gen_random_uuid(),$1,1,0,'ENCRYPT','FAILED','TIMEOUT')`, [componentId]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });

  it('keeps immutable history append-only and allows only legal configuration transitions', async () => {
    await withRollback(async (client) => {
      const event = '01930000-0000-7000-8000-000000000031';
      await client.query(`INSERT INTO wallet_core_test.state_events
        (id,event_type,subject_type,subject_id,actor_id,payload)
        VALUES ($1,'TEST','CHAIN',$1,$1,'{}')`, [event]);
      await client.query('SAVEPOINT immutable');
      await assert.rejects(() => client.query(`UPDATE wallet_core_test.state_events SET payload='{"x":1}'`));
      await client.query('ROLLBACK TO SAVEPOINT immutable');
      const change = '01930000-0000-7000-8000-000000000032';
      await client.query(`INSERT INTO wallet_core_test.configuration_changes
        (id,revision,status,reason,actor_id,snapshot) VALUES ($1,$2,'DRAFT','test',$1,'{}')`, [change, Date.now()]);
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='SCHEDULED',effective_at=now() WHERE id=$1`, [change]);
      await client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='LIVE',applied_at=now() WHERE id=$1`, [change]);
      const live = (await client.query(`SELECT status::text,effective_at IS NOT NULL AS scheduled,
        applied_at IS NOT NULL AS applied FROM wallet_core_test.configuration_changes WHERE id=$1`,
      [change])).rows[0];
      assert.deepEqual(live, { status: 'LIVE', scheduled: true, applied: true });
      await client.query('SAVEPOINT invalid_transition');
      await assert.rejects(() => client.query(`UPDATE wallet_core_test.configuration_changes
        SET status='DRAFT' WHERE id=$1`, [change]));
      await client.query('ROLLBACK TO SAVEPOINT invalid_transition');
      await client.query('SAVEPOINT config_identity');
      await assert.rejects(() => client.query(`UPDATE wallet_core_test.configuration_changes
        SET snapshot='{"changed":true}' WHERE id=$1`, [change]));
      await client.query('ROLLBACK TO SAVEPOINT config_identity');
    });
  });
});
