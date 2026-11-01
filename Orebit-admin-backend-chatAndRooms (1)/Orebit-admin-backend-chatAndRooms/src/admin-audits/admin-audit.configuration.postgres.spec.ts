import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AdminAuditWriterService } from './admin-audit.writer.service.js';
import { AdminAuditRepository } from './admin-audit.repository.js';
import { ADMIN_AUDIT_CONFIGURATION_RULES } from './admin-audit.configuration.js';
import { ADMIN_AUDIT_SCHEMA_DESCRIPTOR, ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR } from './admin-audit.payloads.js';
import { largeWalletAuditConfig, walletAuditTimestampConfig } from './admin-audit.configuration.fixtures.js';
import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import { scheduledWalletBusinessEvents } from './admin-audit.scheduled-business.fixtures.js';

const connectionString = process.env.WP11_AUDIT_DATABASE_URL;
const enabled = connectionString !== undefined;
if (enabled) {
  const url = new URL(connectionString);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55441');
  assert.equal(url.pathname, '/orebit_wallet_pricing_fixes_20260910');
}
const writer = new AdminAuditWriterService(new AdminAuditRepository());
const id = '01920000-0000-7000-8000-000000000001';
const config = { divergenceThresholdBps: 100, visibleFiatCodes: ['USD','INR'], providers: {
  COINGECKO: { enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
  ALCHEMY: { enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 120 },
  COINMARKETCAP: { enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 300 },
} };
const event = (action = 'SETTINGS.SAVED') => ({ domain: 'PRICE_CONVERSION', action,
  eventKey: 'wp11-audit:' + randomUUID(), actor: { kind: 'ADMIN', actorId: id, sessionId: id, requestId: id, ipAddress: '127.0.0.1', deviceId: 'wp11-test' },
  subject: { type: 'SETTINGS_REVISION', id: '1' }, reason: 'Audit configuration integration test',
  before: { revision: 0, status: 'LIVE', effectiveAt: null, config },
  after: { revision: 1, status: 'DRAFT', effectiveAt: null, config }, metadata: { configurationRevision: 1, configChangeId: id, changelog: 'Test intervals' },
});
async function database(run: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString, application_name: 'wp11-focused-admin-audit' });
  await client.connect();
  try {
    const identity = (await client.query("SELECT current_database() AS db,current_setting('cluster_name') AS cluster")).rows[0];
    assert.equal(identity.db, 'orebit_wallet_pricing_fixes_20260910');
    assert.equal(identity.cluster, 'orebit_wallet_pricing_fixes_20260910');
    await run(client);
  } finally { await client.query('ROLLBACK'); await client.end(); }
}
async function begin(client: pg.Client, role = 'orebit_admin_audit_writer') {
  assert.ok(['orebit_admin_audit_writer','orebit_price_conversion_writer'].includes(role));
  await client.query('BEGIN'); await client.query('SET LOCAL ROLE ' + role);
}
const raw = async (client: pg.Client, value: any) => {
  const system = value.actor.kind === 'SYSTEM';
  const newId = '01920000-0000-7000-8000-' + randomUUID().slice(-12);
  return client.query(`SELECT * FROM admin.append_admin_audit_event_v1($1::uuid,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::inet,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)`,
    [newId,value.eventKey,value.domain,value.action,value.actor.kind,system ? null : id,system ? null : id,system ? null : id,system ? value.actor.runId : null,system ? null : '127.0.0.1',system ? null : 'wp11-test',value.subject.type,value.subject.id,value.reason,value.before === null ? null : JSON.stringify(value.before),value.after === null ? null : JSON.stringify(value.after),JSON.stringify(value.metadata)]);
};

test('DB Pricing persists full ADMIN snapshots and semantically identical retries return one event', { skip: !enabled }, async () => database(async (client) => {
  const input = event(); await begin(client);
  const first = await writer.appendWithTransaction(client, input as never);
  const replay = await writer.appendWithTransaction(client, input as never);
  assert.equal(first.replayed, false); assert.deepEqual(replay, { id: first.id, replayed: true });
  await client.query('RESET ROLE'); await client.query('COMMIT');
  const rows = (await client.query('SELECT before_json,after_json,actor_kind FROM admin.admin_audit_events WHERE event_key=$1', [input.eventKey])).rows;
  assert.equal(rows.length,1); assert.deepEqual(rows[0].before_json,input.before); assert.deepEqual(rows[0].after_json,input.after); assert.equal(rows[0].actor_kind,'ADMIN');
}));

test('DB scheduled SYSTEM Wallet business changes require schedule context and retain complete safe details', { skip: !enabled }, async () => database(async (client) => {
  for(const fixture of scheduledWalletBusinessEvents()) {
    const input={...fixture,eventKey:'wp11-audit:'+randomUUID()};
    await begin(client); await raw(client,input); await client.query('RESET ROLE');
    const row=(await client.query('SELECT actor_kind,run_id,before_json,after_json,metadata_json FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0];
    assert.equal(row.actor_kind,'SYSTEM'); assert.equal(row.run_id,input.actor.runId);
    assert.deepEqual(row.before_json,input.before); assert.deepEqual(row.after_json,input.after); assert.deepEqual(row.metadata_json,input.metadata);
    await client.query('ROLLBACK');
    for(const invalid of [{...input,metadata:{configurationRevision:1}},{...input,metadata:{...input.metadata,scheduledChangeId:'bad-id'}}]) {
      await begin(client); await assert.rejects(()=>raw(client,invalid),(error:any)=>error.code==='22023'&&error.message==='ADMIN_AUDIT_INPUT_INVALID'); await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0].n,0);
    }
  }
}));

test('DB Wallet DTO timestamps preserve minute-only and long fractional precision in nested Audit data', { skip: !enabled }, async () => database(async (client) => {
  for (const instant of ['2026-09-11T12:00Z','2026-09-11T12:00:00.123456789012Z','2026-09-11T12:00:00Z']) {
    const accepted=walletAuditTimestampConfig(instant);
    const input={...event(),domain:'WALLET_CORE',before:null,after:{revision:1,status:'DRAFT',config:accepted},metadata:{configurationRevision:1}};
    await begin(client); await raw(client,input); await client.query('RESET ROLE');
    assert.deepEqual((await client.query('SELECT after_json FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0].after_json,input.after);
    await client.query('ROLLBACK');
  }
  for (const instant of ['2026-02-30T12:00Z','2026-09-11T24:00Z','2026-09-11T12:00:00+00:00','2026-09-11T12:00Z\n']) {
    const accepted=walletAuditTimestampConfig('2026-09-11T12:00:00Z'); accepted.currencies![0]!.listingStartsAt=instant;
    const input={...event(),domain:'WALLET_CORE',before:null,after:{revision:1,status:'DRAFT',config:accepted},metadata:{configurationRevision:1}};
    await begin(client); await assert.rejects(()=>raw(client,input),(error:any)=>error.code==='22023'&&error.message==='ADMIN_AUDIT_INPUT_INVALID'); await client.query('ROLLBACK');
  }
}));

test('DB Pricing SYSTEM apply and reject use the run identity through the Pricing writer capability', { skip: !enabled }, async () => database(async (client) => {
  for (const action of ['SETTINGS.SCHEDULE_APPLIED','SETTINGS.SCHEDULE_REJECTED']) {
    const input = { ...event(action), actor: { kind: 'SYSTEM', runId: randomUUID() }, before: { revision: 1,status: 'SCHEDULED',effectiveAt: null,config }, after: { revision: 1,status: action.endsWith('APPLIED') ? 'LIVE' : 'REJECTED',effectiveAt:null,config } };
    await begin(client,'orebit_price_conversion_writer'); await writer.appendWithTransaction(client,input as never); await client.query('RESET ROLE');
    const row = (await client.query('SELECT run_id,actor_id,after_json FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0];
    assert.equal(row.run_id,input.actor.runId); assert.equal(row.actor_id,null); assert.deepEqual(row.after_json,input.after); await client.query('COMMIT');
  }
}));

test('DB invalid nested fields, invalid actor, missing required config and unknown actions fail safely with no persisted event', { skip: !enabled }, async () => database(async (client) => {
  const unsafe = event() as any; unsafe.after = structuredClone(unsafe.after); unsafe.after.config.providers.COINGECKO.apiKey = 'never-log';
  const missing = event() as any; delete missing.after.config;
  for (const input of [unsafe, missing, { ...event(),action:'SETTINGS.DELETED' }, { ...event(),actor:{kind:'SYSTEM',runId:randomUUID()} }]) {
    await begin(client);
    await assert.rejects(() => raw(client,input), (error: any) => error.code === '22023' && error.message === 'ADMIN_AUDIT_INPUT_INVALID');
    await assert.rejects(() => client.query('SELECT 1'), (error: any) => error.code === '25P02');
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0].n,0);
  }
}));

test('DB Wallet nested configuration exceeds 64KiB without truncation and old scalar events still append', { skip: !enabled }, async () => database(async (client) => {
  const pins = Array.from({length:2000},()=>({subject:'CHAIN',subjectId:id,pinned:true}));
  for (const after of [{ revision:1,status:'DRAFT',config:{providerPins:pins} },{revision:1,status:'DRAFT'}]) {
    const input = {...event(),domain:'WALLET_CORE',before:null,after,metadata:{configurationRevision:1}};
    await begin(client); await writer.appendWithTransaction(client,input as never); await client.query('RESET ROLE'); await client.query('COMMIT');
    assert.deepEqual((await client.query('SELECT after_json FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0].after_json,after);
  }
}));

test('DB Wallet near 16 MiB configuration is retained and over 32 MiB input fails before insertion', { skip: !enabled }, async () => database(async (client) => {
  const walletConfig=largeWalletAuditConfig();
  const input={...event(),domain:'WALLET_CORE',before:null,after:{revision:1,status:'DRAFT',config:walletConfig},metadata:{configurationRevision:1}};
  await begin(client); await writer.appendWithTransaction(client,input as never);
  assert.equal((await raw(client,input)).rows[0].replayed,true);
  await client.query('RESET ROLE');
  const row=(await client.query("SELECT octet_length(after_json::text) AS bytes,after_json #>> '{config,currencies,0,bindings,2,hotWalletAddresses,4599}' AS last FROM admin.admin_audit_events WHERE event_key=$1",[input.eventKey])).rows[0];
  assert.ok(row.bytes>16*1024*1024-65536); assert.equal(row.last,walletConfig.currencies[0]!.bindings[2]!.hotWalletAddresses[4599]);
  await client.query('ROLLBACK');
  const huge={...input,eventKey:'wp11-audit:'+randomUUID(),after:{...input.after,config:{currencies:Array(3).fill(walletConfig.currencies[0])}}};
  await begin(client);
  await assert.rejects(()=>raw(client,huge),(error:any)=>error.code==='22023'&&error.message==='ADMIN_AUDIT_INPUT_INVALID');
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM admin.admin_audit_events WHERE event_key=$1',[huge.eventKey])).rows[0].n,0);
}));

test('DB failed transaction rolls back a prior successful append and conflicting retry cannot silently succeed', { skip: !enabled }, async () => database(async (client) => {
  const input=event(); await begin(client); await writer.appendWithTransaction(client,input as never);
  await assert.rejects(()=>writer.appendWithTransaction(client,{...input,reason:'Different mutation'} as never),(error:any)=>error.code==='23505'&&error.message==='ADMIN_AUDIT_EVENT_KEY_CONFLICT');
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM admin.admin_audit_events WHERE event_key=$1',[input.eventKey])).rows[0].n,0);
}));

test('DB preserves append-only permissions and definer search path', { skip: !enabled }, async () => database(async (client) => {
  const rows=(await client.query("SELECT p.prosecdef,p.proconfig,r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure")).rows;
  assert.equal(rows[0].prosecdef,true); assert.equal(rows[0].owner,'orebit_admin_audit_owner'); assert.ok(rows[0].proconfig.includes('search_path=pg_catalog, admin'));
  for (const permission of ['INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal((await client.query("SELECT has_table_privilege('orebit_admin_audit_writer','admin.admin_audit_events',$1) AS allowed",[permission])).rows[0].allowed,false);
}));

test('DB installed configuration and scalar rules match the TypeScript validator exactly', { skip: !enabled }, async () => database(async (client) => {
  const definition=(await client.query("SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) AS definition")).rows[0].definition as string;
  const rules=JSON.parse(definition.split('$configuration_contract$')[1]!);
  assert.deepEqual(rules,ADMIN_AUDIT_CONFIGURATION_RULES);
  const contract=JSON.parse(definition.split('$admin_audit_contract$')[1]!);
  assert.deepEqual(contract.validators,ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR);
  for (const [domain, actions] of Object.entries(ADMIN_AUDIT_SCHEMA_DESCRIPTOR)) for (const [action, expected] of Object.entries(actions)) {
    const actual=contract.actions.find((item:any)=>item.domain===domain&&item.actions.includes(action));
    assert.ok(actual,domain+'/'+action);
    assert.deepEqual(actual.actors,expected.actors);
    assert.deepEqual(actual.subjects,expected.subject);
    assert.deepEqual(actual.requiredMetadata,expected.required);
    assert.deepEqual(actual.optionalMetadata,expected.optional);
    assert.deepEqual(actual.beforeStatuses,expected.beforeStatuses);
    assert.deepEqual(actual.afterStatuses,expected.afterStatuses);
    assert.deepEqual(actual.before.filter((key:string)=>key!=='config'),expected.constraints?.requiredBefore ?? expected.state);
  }
}));

test('DB malformed Pricing rejection records explicit null target configuration with its identity; missing evidence fails closed', { skip: !enabled }, async () => database(async (client) => {
  const rejected={...event('SETTINGS.SCHEDULE_REJECTED'),actor:{kind:'SYSTEM',runId:randomUUID()},
    before:{revision:1,status:'SCHEDULED',effectiveAt:null,config:null},after:{revision:1,status:'REJECTED',effectiveAt:null,config:null},
    metadata:{configurationRevision:1,configChangeId:id,safeErrorCode:'CONFIGURATION_INVALID'}};
  await begin(client,'orebit_price_conversion_writer'); await raw(client,rejected); await client.query('RESET ROLE');
  assert.deepEqual((await client.query('SELECT after_json FROM admin.admin_audit_events WHERE event_key=$1',[rejected.eventKey])).rows[0].after_json,rejected.after);
  await client.query('ROLLBACK');
  for (const metadata of [{configurationRevision:1,safeErrorCode:'CONFIGURATION_INVALID'},{...rejected.metadata,safeErrorCode:'REVISION_CONFLICT'}]) {
    await begin(client); await assert.rejects(()=>raw(client,{...rejected,metadata}),(error:any)=>error.code==='22023'&&error.message==='ADMIN_AUDIT_INPUT_INVALID'); await client.query('ROLLBACK');
  }
}));

test('DB history bounds the metadata prefix before loading bodies and traverses full large and unknown-size legacy events', { skip: !enabled }, async () => database(async (client) => {
  const walletConfig=largeWalletAuditConfig();
  const subject={type:'SETTINGS_REVISION',id:String(Date.now())};
  const after={revision:1,status:'DRAFT',config:walletConfig};
  const base={...event(),domain:'WALLET_CORE',subject,before:null,after,metadata:{configurationRevision:1}};
  await begin(client);
  await writer.appendWithTransaction(client,base as never);
  await writer.appendWithTransaction(client,{...base,eventKey:'wp11-audit:'+randomUUID()} as never);
  const largest=await writer.appendWithTransaction(client,{...base,eventKey:'wp11-audit:'+randomUUID(),action:'SETTINGS.PUSHED',before:after,after:{...after,status:'LIVE'}} as never);
  await client.query('RESET ROLE');
  const repository=new AdminAuditHistoryRepository({query:client.query.bind(client)} as never);
  const first=await repository.history({domain:'WALLET_CORE',subjectType:subject.type,subjectId:subject.id,limit:100});
  assert.equal(first.items.length,1,'a largest first event is readable but cannot drag more bodies into its page');
  assert.equal(first.items[0]?.id,largest.id); assert.notEqual(first.nextCursor,null);
  const size=(await client.query('SELECT payload_bytes,octet_length(before_json::text)+octet_length(after_json::text)+octet_length(metadata_json::text) AS actual FROM admin.admin_audit_events WHERE id=$1',[largest.id])).rows[0];
  assert.equal(size.payload_bytes,size.actual); assert.ok(size.payload_bytes>33554432);
  // Simulate an untouched pre-size-column event, including an arbitrary valid large payload.
  const legacyId='01920000-0000-7000-8000-'+randomUUID().slice(-12);
  await client.query(`INSERT INTO admin.admin_audit_events(id,event_key,event_hash,domain,action,actor_kind,actor_id,session_id,request_id,run_id,ip_address,device_id,subject_type,subject_id,reason,before_json,after_json,metadata_json,created_at)
    SELECT $1,$2,event_hash,domain,action,actor_kind,actor_id,session_id,request_id,run_id,ip_address,device_id,subject_type,subject_id,reason,before_json,after_json,metadata_json,created_at FROM admin.admin_audit_events WHERE id=$3`,[legacyId,'wp11-audit:'+randomUUID(),largest.id]);
  assert.equal((await client.query('SELECT payload_bytes FROM admin.admin_audit_events WHERE id=$1',[legacyId])).rows[0].payload_bytes,null);
  const expected=(await client.query('SELECT id FROM admin.admin_audit_events WHERE subject_type=$1 AND subject_id=$2 ORDER BY created_at DESC,id DESC',[subject.type,subject.id])).rows.map(row=>row.id);
  const visited:string[]=[]; let cursor:string|undefined;
  do {
    const page=await repository.history({domain:'WALLET_CORE',subjectType:subject.type,subjectId:subject.id,limit:100,...(cursor?{cursor}:{})});
    assert.equal(page.items.length,1);
    assert.deepEqual((page.items[0]!.after as any).config.currencies[0].bindings[2].hotWalletAddresses,walletConfig.currencies[0]!.bindings[2]!.hotWalletAddresses);
    visited.push(...page.items.map(item=>item.id)); cursor=page.nextCursor??undefined;
    assert.ok(visited.length<=expected.length,'cursor must advance');
  } while(cursor);
  assert.deepEqual(visited,expected);
  await client.query('ROLLBACK');
}));
