import assert from 'node:assert/strict';
import test from 'node:test';
import * as payloads from './admin-audit.payloads.js';
import { AdminAuditHistoryRepository } from './admin-audit.history-repository.js';
import { adminAuditHistoryQuerySchema } from './admin-audit.dto.js';
import { largeWalletAuditConfig, walletAuditTimestampConfig } from './admin-audit.configuration.fixtures.js';

const id = '01920000-0000-7000-8000-000000000001';
const config = {
  divergenceThresholdBps: 100, visibleFiatCodes: ['USD', 'INR'],
  providers: {
    COINGECKO: { enabled: true, role: 'PRIMARY', viewEnabled: true, refreshIntervalSeconds: 60 },
    ALCHEMY: { enabled: true, role: 'COMPARISON', viewEnabled: false, refreshIntervalSeconds: 120 },
    COINMARKETCAP: { enabled: false, role: null, viewEnabled: false, refreshIntervalSeconds: 300 },
  },
};
const input = {
  domain: 'PRICE_CONVERSION', action: 'SETTINGS.SAVED', eventKey: 'pricing:configuration:1',
  actor: { kind: 'ADMIN', actorId: id, sessionId: id, requestId: id, ipAddress: '127.0.0.1', deviceId: 'test-device' },
  subject: { type: 'SETTINGS_REVISION', id: '1' }, reason: 'Change provider intervals',
  before: { revision: 0, status: 'LIVE', effectiveAt: null, config },
  after: { revision: 1, status: 'DRAFT', effectiveAt: null, config },
  metadata: { configurationRevision: 1, configChangeId: id, changelog: 'Intervals and fiat selection' },
};
const buildPricing = (value: unknown) => (payloads as unknown as {
  buildPriceConversionAdminAuditEvent(value: unknown): ReturnType<typeof payloads.buildWalletCoreAdminAuditEvent>;
}).buildPriceConversionAdminAuditEvent(value);

for (const instant of ['2026-09-11T12:00Z','2026-09-11T12:00:00.123456789012Z','2026-09-11T12:00:00Z','2026-09-11T12:00:00.123Z']) {
  test('Wallet DTO-to-Audit preserves nested UTC timestamp '+instant, () => {
    const accepted=walletAuditTimestampConfig(instant);
    const wallet={...input,domain:'WALLET_CORE',before:null,after:{revision:1,status:'DRAFT',config:accepted},metadata:{configurationRevision:1}};
    assert.deepEqual(payloads.buildWalletCoreAdminAuditEvent(wallet as never).after,wallet.after);
    const currency=accepted.currencies![0]!;
    const entity={...wallet,action:'CURRENCY.UPDATED',subject:{type:'CURRENCY',id:currency.id},before:{config:currency},after:{config:currency}};
    assert.deepEqual(payloads.buildWalletCoreAdminAuditEvent(entity as never).after,entity.after);
  });
}

test('Nested Wallet UTC audit timestamps reject malformed dates, offsets and controls', () => {
  for (const instant of ['2026-02-30T12:00Z','2026-09-11T24:00Z','2026-09-11T12:61Z','2026-09-11T12:00:60Z','2026-09-11T12:00:00+00:00','2026-09-11T12:00','2026-09-11T12:00:00.1.2Z','2026-09-11T12:00Z\n']) {
    if (!/[\u0000-\u001f\u007f]/.test(instant)) assert.throws(()=>walletAuditTimestampConfig(instant));
    const config=walletAuditTimestampConfig('2026-09-11T12:00:00Z');
    config.currencies![0]!.listingStartsAt=instant;
    assert.throws(()=>payloads.buildWalletCoreAdminAuditEvent({...input,domain:'WALLET_CORE',before:null,after:{revision:1,status:'DRAFT',config},metadata:{configurationRevision:1}} as never),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
  }
});

test('Pricing preserves every nested provider setting and fiat selection', () => {
  const event = buildPricing(input);
  assert.deepEqual(event.after, input.after);
  assert.deepEqual(event.before, input.before);
  assert.deepEqual(event.metadata, input.metadata);
  assert.ok(Object.isFrozen((event.after as any).config.providers.COINGECKO));
});

test('Pricing rejects unsafe nested fields, actions, and actors', () => {
  const unsafe = structuredClone(input) as any;
  unsafe.after.config.providers.COINGECKO.apiKey = 'never-log-me';
  for (const value of [unsafe, { ...input, action: 'SETTINGS.DELETED' },
    { ...input, actor: { kind: 'SYSTEM', runId: id } }]) {
    assert.throws(() => buildPricing(value), /^Error: ADMIN_AUDIT_INPUT_INVALID$/);
  }
});

test('Pricing requires each complete provider, valid fiat codes and bounded interval values', () => {
  for (const mutate of [
    (value: any) => { delete value.after.config.providers.ALCHEMY; },
    (value: any) => { value.after.config.providers.COINGECKO.refreshIntervalSeconds = 0; },
    (value: any) => { value.after.config.providers.COINGECKO.refreshIntervalSeconds = 2147483648; },
    (value: any) => { value.after.config.visibleFiatCodes = ['BTC']; },
    (value: any) => { value.after.config.visibleFiatCodes = Array(46).fill('USD'); },
    (value: any) => { value.metadata.changelog = 'x'.repeat(1001); },
    (value: any) => { value.metadata.configChangeId = null; },
    (value: any) => { value.action = '__proto__'; },
  ]) { const candidate = structuredClone(input); mutate(candidate); assert.throws(() => buildPricing(candidate), /^Error: ADMIN_AUDIT_INPUT_INVALID$/); }
});

test('Malformed scheduled Pricing targets use explicit unavailable config only with the rejected target identity and safe reason', () => {
  const rejected = { ...input, action: 'SETTINGS.SCHEDULE_REJECTED', actor: { kind: 'SYSTEM', runId: id },
    before: { revision:1,status:'SCHEDULED',effectiveAt:null,config:null },
    after: { revision:1,status:'REJECTED',effectiveAt:null,config:null },
    metadata: { configurationRevision:1,configChangeId:id,safeErrorCode:'CONFIGURATION_INVALID' } };
  assert.deepEqual(buildPricing(rejected).after,rejected.after);
  for (const candidate of [
    {...rejected,metadata:{configurationRevision:1,safeErrorCode:'CONFIGURATION_INVALID'}},
    {...rejected,metadata:{...rejected.metadata,safeErrorCode:'REVISION_CONFLICT'}},
    {...rejected,after:{...rejected.after,config}},
    {...rejected,action:'SETTINGS.SCHEDULE_APPLIED',after:{...rejected.after,status:'LIVE'}},
  ]) assert.throws(()=>buildPricing(candidate),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
});

test('Wallet retains complete nested changes beyond the old 64 KiB ceiling', () => {
  const wallet = { ...input, domain: 'WALLET_CORE', before: null,
    metadata: { configurationRevision: 1 },
    after: { revision: 1, status: 'DRAFT', config: { providerPins: Array.from({ length: 2000 }, () => ({ subject: 'CHAIN', subjectId: id, pinned: true })) } } };
  assert.deepEqual(payloads.buildWalletCoreAdminAuditEvent(wallet as never).after, wallet.after);
});

test('Wallet retains a complete configuration near the 16 MiB request ceiling and rejects over 32 MiB', () => {
  const walletConfig = largeWalletAuditConfig();
  const bytes = Buffer.byteLength(JSON.stringify(walletConfig));
  assert.ok(bytes > 16*1024*1024-65536 && bytes < 16*1024*1024);
  const wallet = { ...input, domain: 'WALLET_CORE',before:null,metadata:{configurationRevision:1},after:{revision:1,status:'DRAFT',config:walletConfig} };
  const saved = payloads.buildWalletCoreAdminAuditEvent(wallet as never);
  assert.deepEqual(saved.after,wallet.after);
  const oversized = {...wallet,after:{...wallet.after,config:{currencies:Array(3).fill(walletConfig.currencies[0])}}};
  assert.throws(()=>payloads.buildWalletCoreAdminAuditEvent(oversized as never),/^Error: ADMIN_AUDIT_INPUT_INVALID$/);
});

test('Deposit still rejects nested configuration fields', () => {
  assert.throws(() => payloads.buildDepositAdminAuditEvent({ ...input,
    domain: 'DEPOSIT', before: null, metadata: { configurationRevision: 1 } } as never),
  /^Error: ADMIN_AUDIT_INPUT_INVALID$/);
});

test('Pricing history accepts the domain filter and returns complete nested snapshots', async () => {
  assert.equal(adminAuditHistoryQuerySchema.parse({ domain: 'PRICE_CONVERSION' }).domain, 'PRICE_CONVERSION');
  const repository = new AdminAuditHistoryRepository({ query: async () => ({ rows: [{
    id, event_key: input.eventKey, domain: input.domain, action: input.action,
    actor_kind: 'ADMIN', actor_id: id, session_id: id, request_id: id, run_id: null,
    ip_address: '127.0.0.1', device_id: 'test-device', subject_type: 'SETTINGS_REVISION', subject_id: '1',
    reason: input.reason, before_json: input.before, after_json: input.after,
    metadata_json: input.metadata, created_at: '2026-09-10T12:00:00.000000Z',
  }] }) } as never);
  const page = await repository.history({ domain: 'PRICE_CONVERSION', limit: 1 } as never);
  assert.deepEqual(page.items[0]?.after, input.after);
  assert.equal(page.nextCursor, null);
});

test('Pricing history preserves explicit unavailable malformed target evidence', async () => {
  const after = { revision:1,status:'REJECTED',effectiveAt:null,config:null };
  const repository = new AdminAuditHistoryRepository({ query: async () => ({ rows: [{
    id,event_key:'unavailable-target',domain:'PRICE_CONVERSION',action:'SETTINGS.SCHEDULE_REJECTED',
    actor_kind:'SYSTEM',actor_id:null,session_id:null,request_id:null,run_id:id,ip_address:null,device_id:null,
    subject_type:'SETTINGS_REVISION',subject_id:'1',reason:'Scheduled price configuration rejected',
    before_json:{revision:1,status:'SCHEDULED',effectiveAt:null,config:null},after_json:after,
    metadata_json:{configurationRevision:1,configChangeId:id,safeErrorCode:'CONFIGURATION_INVALID'},created_at:'2026-09-10T12:00:00.000000Z',
  }] }) } as never);
  assert.deepEqual((await repository.history({domain:'PRICE_CONVERSION',limit:1})).items[0]?.after,after);
});

test('Audit history keeps a next cursor when the database byte budget returns fewer complete events than requested', async () => {
  const repository = new AdminAuditHistoryRepository({ query: async () => ({ rows: [{
    id,event_key:'byte-limited-page',domain:'WALLET_CORE',action:'SETTINGS.SAVED',
    actor_kind:'ADMIN',actor_id:id,session_id:id,request_id:id,run_id:null,ip_address:'127.0.0.1',device_id:'test',
    subject_type:'SETTINGS_REVISION',subject_id:'1',reason:'Large configuration',before_json:null,after_json:{revision:1,status:'DRAFT'},
    metadata_json:{configurationRevision:1},created_at:'2026-09-10T12:00:00.000000Z',page_has_more:true,
  }] }) } as never);
  const page=await repository.history({domain:'WALLET_CORE',limit:100});
  assert.equal(page.items.length,1); assert.notEqual(page.nextCursor,null);
  assert.equal('page_has_more' in page.items[0]!,false);
});
